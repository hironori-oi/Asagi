//! Multi-Sidecar Manager (AS-134 / DEC-018-025)。
//!
//! Project ごとに独立した Codex sidecar を `HashMap<ProjectId, ...>` で
//! 保持する。Slack 風 ProjectRail (DEC-018-006 軸 C) の Rust 側基盤。
//!
//! # 同時起動上限 (DEC-018-025)
//!
//! `MAX_CONCURRENT_SIDECARS = 6`。リサーチ v2 RAs-17 (third-party OAuth で 429
//! quota exceeded、openai-python issue #2951) を踏まえ、Sumi の 8 から保守的に
//! 6 に下方修正。実運用で 6 を超えるケースが顕在化したら個別判断。

use anyhow::{anyhow, bail, Result};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

use super::{
    create_sidecar, CodexNotification, CodexRequest, CodexResponse, CodexSidecar, SidecarMode,
};

pub type ProjectId = String;

/// Multi-Sidecar 同時起動上限。
///
/// DEC-018-025: Sumi の 8 → 6 に保守的下方修正。
/// 根拠はリサーチ v2 RAs-17 (third-party OAuth quota exceeded リスク強化)。
pub const MAX_CONCURRENT_SIDECARS: usize = 6;

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

    /// 指定 project_id の sidecar を spawn し start() する。
    /// 既に存在する場合は何もしない (冪等)。
    /// 既存数が `MAX_CONCURRENT_SIDECARS` を満たしている状態で
    /// **新規** project への spawn が来た場合は error を返す (DEC-018-025)。
    ///
    /// 返り値:
    ///   - `Ok(true)`  = 新規に sidecar を生成・start した（呼び出し側は
    ///     notification pump task など 1 回限りの後処理を実行してよい）
    ///   - `Ok(false)` = 既存 sidecar があったため no-op（後処理スキップ）
    ///
    /// この区別は AS-UX-FIX-A (DEC-018-039 W1) で発覚した、
    /// 「冪等 spawn 呼び出しのたびに pump task が二重起動 → 1 delta が
    /// 複数 Tauri event として emit される」バグの修正に使用される。
    pub async fn spawn_for(
        &self,
        project_id: impl Into<String>,
        mode: SidecarMode,
    ) -> Result<bool> {
        let pid = project_id.into();
        let mut map = self.sidecars.write().await;
        if map.contains_key(&pid) {
            return Ok(false);
        }
        if map.len() >= MAX_CONCURRENT_SIDECARS {
            bail!(
                "Max concurrent sidecars ({}) reached",
                MAX_CONCURRENT_SIDECARS
            );
        }
        let mut sc = create_sidecar(mode, pid.clone());
        sc.start().await?;
        map.insert(pid, sc);
        Ok(true)
    }

    /// 指定 project_id の sidecar を経由して request を送信する。
    pub async fn send_request(&self, project_id: &str, req: CodexRequest) -> Result<CodexResponse> {
        let map = self.sidecars.read().await;
        let sc = map
            .get(project_id)
            .ok_or_else(|| anyhow!("no sidecar for project_id: {project_id}"))?;
        sc.send_request(req).await
    }

    /// notification を購読する。sidecar 未起動なら error。
    pub async fn subscribe(
        &self,
        project_id: &str,
    ) -> Result<broadcast::Receiver<CodexNotification>> {
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
    use crate::codex_sidecar::mock::make_turn_start_request;
    use crate::codex_sidecar::protocol::{event, TurnStartResult};

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

        // 各 project へ独立に thread/start → turn/start を送信。
        // subscribe を spawn 後・send 前に取る。
        for pid in ["proj-a", "proj-b", "proj-c"] {
            let mut rx = mgr.subscribe(pid).await.unwrap();
            // 既存 notification を捨てる
            while rx.try_recv().is_ok() {}

            // thread/start
            // multi 経由で thread/start を投げて id を取得するため少し冗長になるが、
            // mock が in-process のため共有構造体ヘルパーは使えない。
            // ここは直接 send_request で thread/start → turn/start。
            let tid = {
                let req = crate::codex_sidecar::CodexRequest::new(
                    "thread-start-1",
                    crate::codex_sidecar::protocol::method::THREAD_START,
                    Some(serde_json::json!({"model": "gpt-mock-5.5"})),
                );
                let resp = mgr.send_request(pid, req).await.unwrap();
                let r: crate::codex_sidecar::protocol::ThreadStartResult =
                    serde_json::from_value(resp.result.unwrap()).unwrap();
                r.thread.id
            };

            let req = make_turn_start_request("req-1", &tid, "hi");
            let resp = mgr.send_request(pid, req).await.unwrap();
            assert!(
                resp.error.is_none(),
                "project {pid} turn/start should succeed"
            );
            let r: TurnStartResult = serde_json::from_value(resp.result.unwrap()).unwrap();
            assert_eq!(r.turn.status, "inProgress");

            // turn/completed 待ち
            let mut got_completed = false;
            for _ in 0..200 {
                match tokio::time::timeout(std::time::Duration::from_secs(3), rx.recv()).await {
                    Ok(Ok(n)) => {
                        if n.method == event::TURN_COMPLETED {
                            got_completed = true;
                            break;
                        }
                    }
                    _ => break,
                }
            }
            assert!(
                got_completed,
                "TURN_COMPLETED notification must arrive for {pid}"
            );
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
        // 1 回目は新規 → true
        let first = mgr.spawn_for("p1", SidecarMode::Mock).await.unwrap();
        assert!(first, "first spawn must report newly-created");
        // 2 回目は冪等 no-op → false
        let second = mgr.spawn_for("p1", SidecarMode::Mock).await.unwrap();
        assert!(!second, "duplicate spawn must report no-op (false)");
        assert_eq!(mgr.list_active().await.len(), 1);
    }

    #[tokio::test]
    async fn send_to_unknown_project_is_error() {
        let mgr = MultiSidecarManager::new();
        let req = make_turn_start_request("req-1", "tid", "hi");
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

    #[tokio::test]
    async fn spawn_respects_max_concurrent_limit() {
        let mgr = MultiSidecarManager::new();
        for i in 0..MAX_CONCURRENT_SIDECARS {
            mgr.spawn_for(format!("proj-{i}"), SidecarMode::Mock)
                .await
                .unwrap();
        }
        assert_eq!(mgr.list_active().await.len(), MAX_CONCURRENT_SIDECARS);
        // 7 個目は失敗
        let r = mgr.spawn_for("proj-overflow", SidecarMode::Mock).await;
        assert!(r.is_err(), "must reject when at limit");
        let msg = format!("{:#}", r.unwrap_err());
        assert!(
            msg.contains("Max concurrent sidecars"),
            "error must mention limit: {msg}"
        );
        assert!(
            msg.contains("6"),
            "error must include constant value 6: {msg}"
        );

        // 既存 project への重複 spawn は no-op、limit 超過にカウントしない
        mgr.spawn_for("proj-0", SidecarMode::Mock).await.unwrap();
    }
}
