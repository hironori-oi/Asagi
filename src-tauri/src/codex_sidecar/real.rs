//! Real Codex sidecar 実装 (AS-130)。
//!
//! **本ファイルは Phase 0 POC（DEC-018-010）通過後に本実装する。**
//!
//! # 起動コマンド (DEC-018-009)
//!
//! ```text
//! tokio::process::Command::new("codex")
//!     .arg("app-server")
//!     .arg("--listen")
//!     .arg("stdio")
//! ```
//!
//! # 必須ハンドシェイク (LSP-style, リサーチ v2 § 3.2 で確定)
//!
//! 1. spawn 後の最初のリクエストは必ず `initialize`
//!    params: `{ clientInfo: { name, title, version },
//!               capabilities: { experimentalApi: false, optOutNotificationMethods: [...] } }`
//! 2. 受領した `InitializeResult` を保存（userAgent / codexHome / platformOs）
//! 3. `initialized` notification を送信（id 無し）
//! 4. これ以降に `thread/start`, `turn/start`, `account/read` 等を呼び出し可能
//!
//! 未 initialize の状態で他 method を呼ぶと Real CLI から `"Not initialized"`
//! エラーが返る。重複 initialize は `"Already initialized"`。
//!
//! # 推奨 opt-out (Phase 1)
//!
//! Phase 1 では実装負荷削減のため、以下の notification を opt out:
//!   - `item/reasoning/textDelta`
//!   - `item/reasoning/summaryTextDelta`
//!   - `item/commandExecution/outputDelta`
//!   - `item/fileChange/outputDelta`
//!   - `fuzzyFileSearch/sessionUpdated`
//!   - `serverRequest/resolved`
//!
//! # codex-app-server バイナリ単体配布の検討 (DEC-018-024)
//!
//! 0.128.0 から `codex-app-server` 単体のリリース成果物が公開された。
//! `codex` 本体（〜200MB）ではなく `codex-app-server`（〜80MB 想定）のみを
//! Tauri リソースに同梱する選択肢が生まれた。M1 末に決裁予定。
//!
//! # 実装すべき項目
//!
//! 1. `start()`:
//!    - `tokio::process::Command::new("codex").arg("app-server").arg("--listen").arg("stdio")` で spawn
//!    - stdout reader task (line-delimited JSON parse → id 振分 + notification broadcast)
//!    - stderr reader task (tracing::warn に転送)
//!    - `crate::process::jobobject::WinJobObject::create()` + `assign_pid(child.id())`
//!    - `initialize` request → result 保存 → `initialized` notification 送信
//!
//! 2. `send_request()`:
//!    - `RequestId` (UUID) 生成
//!    - `pending: Arc<Mutex<HashMap<RequestId, oneshot::Sender<CodexResponse>>>>` に登録
//!    - stdin に line-delimited JSON 書き込み + flush
//!    - `oneshot::Receiver` を await（タイムアウト付き、デフォルト 60s）
//!
//! 3. `shutdown()`:
//!    - 全 active turn に `turn/interrupt` 送信（並列）
//!    - stdin close
//!    - `child.kill()` を 1.5s 後に保険発動
//!    - `WinJobObject` Drop で確実に子の子まで kill

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
    //   initialize_result: Option<InitializeResult>,
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
        // TODO(POC通過後):
        //   1. codex app-server を spawn
        //   2. reader task を起動 (notification は broadcast へ)
        //   3. initialize request 送信 → InitializeResult 保存
        //   4. initialized notification 送信
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
        // TODO(POC通過後): turn/interrupt 全 turn → wait → kill (WinJobObject Drop でも確実)
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
