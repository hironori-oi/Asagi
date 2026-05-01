//! Multi-Sidecar Manager (AS-134)。
//!
//! Project ごとに独立した Codex sidecar を `HashMap<ProjectId, ...>` で
//! 保持する。Slack 風 ProjectRail (DEC-018-006 軸 C) の Rust 側基盤。
//!
//! 現状は mock 中心の dry-run。Real impl は POC 通過後に有効化。

use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

use super::{create_sidecar, CodexNotification, CodexRequest, CodexResponse, CodexSidecar, SidecarMode};

pub type ProjectId = String;

/// Multi-Sidecar 管理。
pub struct MultiSidecarManager {
    sidecars: Arc<RwLock<HashMap<ProjectId, Box<dyn CodexSidecar>>>>,
}

impl Default for MultiSidecarManager {
    fn default() -> Self {
        Self::new()
    }
}

impl MultiSidecarManager {
    pub fn new() -> Self {
        Self {
            sidecars: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 指定 project_id の sidecar を spawn し start() する。既に存在する場合は何もしない。
    pub async fn spawn_for(&self, project_id: impl Into<String>, mode: SidecarMode) -> Result<()> {
        let pid = project_id.into();
        let mut map = self.sidecars.write().await;
        if map.contains_key(&pid) {
            return Ok(());
        }
        let mut sc = create_sidecar(mode, pid.clone());
        sc.start().await?;
        map.insert(pid, sc);
        Ok(())
    }

    /// 指定 project_id の sidecar を経由して request を送信する。
    pub async fn send_request(
        &self,
        project_id: &str,
        req: CodexRequest,
    ) -> Result<CodexResponse> {
        let map = self.sidecars.read().await;
        let sc = map
            .get(project_id)
            .ok_or_else(|| anyhow!("no sidecar for project_id: {project_id}"))?;
        sc.send_request(req).await
    }

    /// notification を購読する。sidecar 未起動なら error。
    pub async fn subscribe(&self, project_id: &str) -> Result<broadcast::Receiver<CodexNotification>> {
        let map = self.sidecars.read().await;
        let sc = map
            .get(project_id)
            .ok_or_else(|| anyhow!("no sidecar for project_id: {project_id}"))?;
        Ok(sc.subscribe_events())
    }

    /// alive チェック。
    pub async fn is_alive(&self, project_id: &str) -> bool {
        let map = self.sidecars.read().await;
        map.get(project_id).map(|s| s.is_alive()).unwrap_or(false)
    }

    /// 個別 shutdown。HashMap からも除去する。
    pub async fn shutdown(&self, project_id: &str) -> Result<()> {
        let mut map = self.sidecars.write().await;
        if let Some(mut sc) = map.remove(project_id) {
            sc.shutdown().await?;
        }
        Ok(())
    }

    /// 全 sidecar を shutdown する（アプリ終了時想定）。
    pub async fn shutdown_all(&self) -> Result<()> {
        let mut map = self.sidecars.write().await;
        let keys: Vec<String> = map.keys().cloned().collect();
        for k in keys {
            if let Some(mut sc) = map.remove(&k) {
                let _ = sc.shutdown().await; // 1 つの失敗で他を止めない
            }
        }
        Ok(())
    }

    /// 現在 active な project_id 一覧。
    pub async fn list_active(&self) -> Vec<String> {
        let map = self.sidecars.read().await;
        map.keys().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_sidecar::mock::make_chat_request;
    use crate::codex_sidecar::protocol::{event, ChatResult};

    #[tokio::test]
    async fn multi_sidecar_three_projects_isolated() {
        let mgr = MultiSidecarManager::new();

        for pid in ["proj-a", "proj-b", "proj-c"] {
            mgr.spawn_for(pid, SidecarMode::Mock).await.unwrap();
        }

        let mut active = mgr.list_active().await;
        active.sort();
        assert_eq!(active, vec!["proj-a", "proj-b", "proj-c"]);
        for pid in ["proj-a", "proj-b", "proj-c"] {
            assert!(mgr.is_alive(pid).await);
        }

        // 各 project へ独立に送信。subscribe を spawn 後・send 前に取る。
        for pid in ["proj-a", "proj-b", "proj-c"] {
            let mut rx = mgr.subscribe(pid).await.unwrap();
            // 起動 ready notification を捨てる（既に流れている可能性）
            // broadcast は tx 後の subscribe には届かないが、念のため try_recv
            while rx.try_recv().is_ok() {}

            let req = make_chat_request("req-1", &format!("sess-{pid}"), "hi");
            let resp = mgr.send_request(pid, req).await.unwrap();
            assert!(resp.error.is_none(), "project {pid} should succeed");
            let result: ChatResult = serde_json::from_value(resp.result.unwrap()).unwrap();
            assert!(result.full_text.starts_with("tok-0"));

            // delta + done が流れたか確認（既に消費済みでも try_recv で残ってる分を回収）
            let mut got_done = false;
            while let Ok(n) = rx.try_recv() {
                if n.method == event::DONE {
                    got_done = true;
                }
            }
            // chat handler が DONE を最後に送るので必ずある
            assert!(got_done, "DONE notification must arrive for {pid}");
        }

        // shutdown_all
        mgr.shutdown_all().await.unwrap();
        assert!(mgr.list_active().await.is_empty());
        for pid in ["proj-a", "proj-b", "proj-c"] {
            assert!(!mgr.is_alive(pid).await);
        }
    }

    #[tokio::test]
    async fn spawn_is_idempotent() {
        let mgr = MultiSidecarManager::new();
        mgr.spawn_for("p1", SidecarMode::Mock).await.unwrap();
        mgr.spawn_for("p1", SidecarMode::Mock).await.unwrap();
        assert_eq!(mgr.list_active().await.len(), 1);
    }

    #[tokio::test]
    async fn send_to_unknown_project_is_error() {
        let mgr = MultiSidecarManager::new();
        let req = make_chat_request("req-1", "sess", "hi");
        assert!(mgr.send_request("nope", req).await.is_err());
    }

    #[tokio::test]
    async fn shutdown_individual_removes_from_map() {
        let mgr = MultiSidecarManager::new();
        mgr.spawn_for("p1", SidecarMode::Mock).await.unwrap();
        mgr.spawn_for("p2", SidecarMode::Mock).await.unwrap();
        mgr.shutdown("p1").await.unwrap();
        let active = mgr.list_active().await;
        assert_eq!(active, vec!["p2".to_string()]);
    }
}
