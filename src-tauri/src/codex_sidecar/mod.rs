//! Codex sidecar 統合モジュール (AS-130)。
//!
//! `codex app-server --listen stdio` (DEC-018-009) との JSON-RPC 2.0 通信層を
//! trait で抽象化し、Real / Mock を切り替え可能にする。
//!
//! # 切替方法
//!
//! 環境変数 `ASAGI_SIDECAR_MODE` で実装を選択:
//!   - `mock` (default in dev) ... `MockCodexSidecar` (本物の Codex CLI 不要)
//!   - `real`                  ... `RealCodexSidecar` (Phase 0 POC 通過後に実装)
//!
//! # 構成 (DEC-018-022)
//!
//! ```text
//!   protocol.rs     ... JSON-RPC 2.0 メッセージ型
//!   real.rs         ... RealCodexSidecar (TODO 構造のみ、POC 後実装)
//!   mock.rs         ... MockCodexSidecar (決定論的 mock、in-process)
//!   mock_server.rs  ... stdio JSON-RPC mock app-server (cargo run --bin)
//!   multi.rs        ... MultiSidecarManager (HashMap<ProjectId, Box<dyn ...>>)
//! ```

use anyhow::Result;
use async_trait::async_trait;
use std::str::FromStr;
use tokio::sync::broadcast;

pub mod mock;
pub mod mock_server;
pub mod multi;
pub mod protocol;
pub mod real;

pub use protocol::{CodexNotification, CodexRequest, CodexResponse};

/// Mock notification stream のチャンネル容量。
/// 1 ターンあたり数十イベントなので 256 で十分。
pub const NOTIFICATION_CHANNEL_CAPACITY: usize = 256;

/// Sidecar 実装モード。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarMode {
    Real,
    Mock,
}

impl SidecarMode {
    /// 環境変数 `ASAGI_SIDECAR_MODE` から解決。
    /// dev デフォルト = Mock、未設定でも Mock。
    /// Real impl は Phase 0 POC 通過まで panic するため、明示的に指定された
    /// 場合のみ Real を返す。
    pub fn from_env() -> Self {
        std::env::var("ASAGI_SIDECAR_MODE")
            .ok()
            .and_then(|v| Self::from_str(&v).ok())
            .unwrap_or(Self::Mock)
    }
}

impl FromStr for SidecarMode {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "real" => Ok(Self::Real),
            "mock" => Ok(Self::Mock),
            other => Err(format!("unknown ASAGI_SIDECAR_MODE: {other}")),
        }
    }
}

/// Codex sidecar の共通 IF。
///
/// 1 sidecar = 1 project に対応する。
#[async_trait]
pub trait CodexSidecar: Send + Sync {
    /// プロセス spawn / ハンドシェイク。
    async fn start(&mut self) -> Result<()>;

    /// JSON-RPC 2.0 リクエストを送信し、対応する response を待つ。
    async fn send_request(&self, req: CodexRequest) -> Result<CodexResponse>;

    /// notification の broadcast を購読する。
    /// 各 subscriber は独立に最新のイベントを受け取る。
    fn subscribe_events(&self) -> broadcast::Receiver<CodexNotification>;

    /// graceful shutdown。プロセスが残留しないこと。
    async fn shutdown(&mut self) -> Result<()>;

    /// プロセスが alive かどうか。
    fn is_alive(&self) -> bool;
}

/// Sidecar ファクトリ。
///
/// project_id を受け取って mode に応じた実装を返す。
/// `start()` は呼び出し側で別途実行する。
pub fn create_sidecar(mode: SidecarMode, project_id: impl Into<String>) -> Box<dyn CodexSidecar> {
    let project_id = project_id.into();
    match mode {
        SidecarMode::Mock => Box::new(mock::MockCodexSidecar::new(project_id)),
        SidecarMode::Real => Box::new(real::RealCodexSidecar::new(project_id)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_mode_from_str() {
        assert_eq!(SidecarMode::from_str("mock").unwrap(), SidecarMode::Mock);
        assert_eq!(SidecarMode::from_str("MOCK").unwrap(), SidecarMode::Mock);
        assert_eq!(SidecarMode::from_str("real").unwrap(), SidecarMode::Real);
        assert!(SidecarMode::from_str("invalid").is_err());
    }

    #[test]
    fn sidecar_mode_from_env_defaults_to_mock() {
        // SAFETY: テスト中で env を一時的に外す。並列テスト時は serial_test を
        // 検討すべきだが、現状は単独 process 内で十分。
        std::env::remove_var("ASAGI_SIDECAR_MODE");
        assert_eq!(SidecarMode::from_env(), SidecarMode::Mock);
    }
}
