//! ChatGPT サブスク OAuth フロー（Codex CLI の `codex login` を spawn）。
//!
//! **Phase 0 POC #1 通過後に本実装**（DEC-018-010 / 014）。
//! Asagi は OAuth トークンに直接触らず、`~/.codex/auth.json` の mtime watch のみ行う
//! （DEC-018-009 / リサーチ § 6.2）。
//!
//! 関連: dev-v0.1.0-scaffold-design.md § 6.1

use anyhow::Result;
use std::path::PathBuf;

/// `codex` バイナリのパスを解決する（PATH 上にあること前提）。
/// **POC 通過後実装**。
pub fn find_codex_binary() -> Result<PathBuf> {
    unimplemented!("[POC pending: AS-110 で実装]")
}

/// `~/.codex/auth.json` のパスを返す。
/// Codex CLI が排他管理するファイル。Asagi は read/write しない。
pub fn auth_json_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codex").join("auth.json"))
}

/// `codex login` を `tauri-plugin-shell` で spawn し、ブラウザを開かせる。
/// 認証完了は auth.json mtime の変化で検出する。
/// **POC 通過後実装**。
pub async fn start_login() -> Result<()> {
    unimplemented!("[POC pending: AS-110 で実装]")
}

/// 現在の認証状態を返す（auth.json 存在 + mtime ベース）。
pub fn auth_status() -> AuthStatus {
    match auth_json_path() {
        Some(path) if path.exists() => AuthStatus::SignedIn,
        _ => AuthStatus::SignedOut,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthStatus {
    SignedIn,
    SignedOut,
    Unknown,
}
