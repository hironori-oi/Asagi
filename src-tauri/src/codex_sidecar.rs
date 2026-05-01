//! Codex CLI sidecar (`codex app-server --listen stdio`) との JSON-RPC 2.0 通信。
//!
//! **本ファイルは Phase 0 POC（DEC-018-010）通過後に本実装する**。
//! 現在は API シグネチャと「POC 待ち」表明のスタブ実装のみを提供する。
//!
//! 移植元: app/poc/02-app-server-jsonrpc.ts / 03-chat-1turn.ts / 04-image-input.ts
//! 関連設計: dev-v0.1.0-scaffold-design.md § 6.2

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Codex sidecar ハンドル。
///
/// POC 通過後に `tokio::process::Child` と stdin/stdout pipe を保持する。
pub struct CodexSidecarHandle {
    pub project_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnInput {
    pub text: String,
    /// Base64 エンコード済 PNG/BMP 画像（POC #4 結果次第で field 名確定）
    pub images: Vec<String>,
}

impl CodexSidecarHandle {
    /// Codex CLI を spawn して JSON-RPC 2.0 ハンドシェイクを行う。
    ///
    /// **POC 通過後実装**。POC で確定した method 名 / params 構造を
    /// ここにハードコードする（憶測実装禁止）。
    pub async fn spawn(_project_id: &str, _cwd: &Path) -> Result<Self> {
        unimplemented!("[POC pending: AS-110/AS-120 で実装]")
    }

    /// `thread/start` → `turn/start` を 1 セットで送信し、
    /// notification stream を Tauri Event として emit する。
    pub async fn send_turn(&self, _input: TurnInput) -> Result<()> {
        unimplemented!("[POC pending: AS-122 / AS-123 で実装]")
    }

    /// 進行中のターンを cancel する。
    pub async fn cancel(&self) -> Result<()> {
        unimplemented!("[POC pending: AS-123 で実装]")
    }

    /// graceful shutdown。プロセスに SIGTERM 相当 → 強制 kill フォールバック。
    pub async fn shutdown(self) -> Result<()> {
        unimplemented!("[POC pending: AS-121 で実装]")
    }
}
