//! Real Codex sidecar 実装 (AS-130)。
//!
//! **本ファイルは Phase 0 POC（DEC-018-010）通過後に本実装する。**
//! POC 通過時点で確定している以下の挙動を実装する:
//!
//! 1. `tokio::process::Command::new("codex").arg("app-server").arg("--listen").arg("stdio")` で spawn
//! 2. stdin/stdout を line-delimited JSON-RPC 2.0 として読み書き
//! 3. id-correlation table (`HashMap<RequestId, oneshot::Sender<CodexResponse>>`) で
//!    `send_request` の future を解決
//! 4. id 無し message は notification として `broadcast::Sender` に流す
//! 5. プロセスを `process::jobobject::WinJobObject` に AssignProcessToJob して
//!    親 (Asagi) 終了時に確実に kill されるようにする
//! 6. `shutdown()` で `codex/cancel` 全 session 送信 → SIGTERM → 1.5s wait → kill

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use tokio::sync::broadcast;

use super::{CodexNotification, CodexRequest, CodexResponse, CodexSidecar, NOTIFICATION_CHANNEL_CAPACITY};

/// Real Codex sidecar (POC 通過後実装)。
pub struct RealCodexSidecar {
    project_id: String,
    notifications: broadcast::Sender<CodexNotification>,
    // POC 通過後に追加する fields:
    //   child: Option<tokio::process::Child>,
    //   stdin: Option<tokio::process::ChildStdin>,
    //   pending: Arc<Mutex<HashMap<RequestId, oneshot::Sender<CodexResponse>>>>,
    //   reader_task: Option<JoinHandle<()>>,
    //   job: Option<crate::process::jobobject::WinJobObject>,
}

impl RealCodexSidecar {
    pub fn new(project_id: String) -> Self {
        let (tx, _) = broadcast::channel(NOTIFICATION_CHANNEL_CAPACITY);
        Self {
            project_id,
            notifications: tx,
        }
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }
}

#[async_trait]
impl CodexSidecar for RealCodexSidecar {
    async fn start(&mut self) -> Result<()> {
        // TODO(POC通過後): codex app-server を spawn し reader task を起動。
        // POC で確定する事項:
        //   - コマンド名 / 引数 (`codex app-server --listen stdio` 想定)
        //   - 起動 readiness signal の有無 (例: 起動完了 notification)
        //   - WinJobObject 紐付けタイミング (CreateProcess 直後 / spawn 後どちら)
        Err(anyhow!(
            "RealCodexSidecar::start is not yet implemented (Phase 0 POC pending: DEC-018-010 / AS-115/AS-118/AS-121)"
        ))
    }

    async fn send_request(&self, _req: CodexRequest) -> Result<CodexResponse> {
        // TODO(POC通過後): pending table に oneshot sender を登録 → stdin に書き込み → await
        Err(anyhow!(
            "RealCodexSidecar::send_request is not yet implemented (Phase 0 POC pending)"
        ))
    }

    fn subscribe_events(&self) -> broadcast::Receiver<CodexNotification> {
        self.notifications.subscribe()
    }

    async fn shutdown(&mut self) -> Result<()> {
        // TODO(POC通過後): cancel 全 session → wait → kill (WinJobObject Drop でも確実)
        Err(anyhow!(
            "RealCodexSidecar::shutdown is not yet implemented (Phase 0 POC pending)"
        ))
    }

    fn is_alive(&self) -> bool {
        // TODO(POC通過後): child.try_wait() で判定
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn real_sidecar_returns_pending_error_until_poc() {
        let mut s = RealCodexSidecar::new("p1".into());
        let r = s.start().await;
        assert!(r.is_err(), "real sidecar must be unimplemented until POC");
        let msg = format!("{}", r.unwrap_err());
        assert!(msg.contains("POC pending"), "error message must signal POC gate: {msg}");
    }
}
