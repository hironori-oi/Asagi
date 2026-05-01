//! Multi-Sidecar Architecture。
//!
//! Project ごとに独立した Codex sidecar プロセスを管理する。
//! **Phase 0 POC 通過後に本実装**（DEC-018-014）。
//!
//! M1 では `project_id = "default"` 固定で 1 sidecar に絞る。
//! M2 AS-210 で `HashMap<projectId, Arc<CodexSidecarHandle>>` を本格化。
//!
//! 関連: dev-v0.1.0-scaffold-design.md § 1.5

use anyhow::Result;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::codex_sidecar::CodexSidecarHandle;

#[derive(Default)]
pub struct MultiSidecar {
    handles: Mutex<HashMap<String, Arc<CodexSidecarHandle>>>,
}

impl MultiSidecar {
    pub fn new() -> Self {
        Self::default()
    }

    /// 既存の sidecar を返すか、なければ新規 spawn。
    /// **POC 通過後実装**。
    pub async fn get_or_spawn(
        &self,
        _project_id: &str,
        _cwd: &Path,
    ) -> Result<Arc<CodexSidecarHandle>> {
        let _guard = self.handles.lock().await;
        unimplemented!("[POC pending: AS-121 / AS-210 で実装]")
    }

    /// 指定 project の sidecar を停止して破棄する。
    pub async fn shutdown(&self, _project_id: &str) -> Result<()> {
        unimplemented!("[POC pending: AS-121 で実装]")
    }

    /// アプリ終了時に全 sidecar を破棄する。
    pub async fn shutdown_all(&self) -> Result<()> {
        unimplemented!("[POC pending: AS-121 で実装]")
    }
}
