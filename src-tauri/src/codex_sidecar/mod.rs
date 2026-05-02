//! Codex sidecar 統合モジュール (AS-130)。
//!
//! `codex app-server --listen stdio://` (DEC-018-009 / DEC-018-033 ①) との
//! JSON-RPC 2.0 通信層を trait で抽象化し、Real / Mock を切り替え可能にする。
//! 起動引数 / 諸 schema 文字列は `contract` モジュールに集約（DEC-018-033 / DEC-018-034）。
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

pub mod auth;
pub mod auth_watchdog;
pub mod bin_resolver;
pub mod contract;
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
    /// - 未設定 / unknown → `Mock`（dev / 自動テスト既定）
    /// - `"real"` → `Real`（Phase 1 (M1 Real impl) / AS-140 完了以降）
    /// - `"mock"` → `Mock`
    ///
    /// **Phase 1 移行**: AS-140.0〜140.5 完了により Real impl は POC pending を脱した。
    /// オーナー実機 smoke は `ASAGI_SIDECAR_MODE=real` を export して起動することで実施可能。
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

    /// AS-140.5: Real mode を指定すると factory が RealCodexSidecar を返す。
    /// （start() を呼ばない範囲 ＝ codex プロセス無しでも安全に検証可能）
    #[test]
    fn create_sidecar_with_real_mode_returns_unstarted_real() {
        let sc = create_sidecar(SidecarMode::Real, "p-factory-real");
        // 未 start なら必ず is_alive == false（実装契約）
        assert!(!sc.is_alive());
    }

    #[test]
    fn create_sidecar_with_mock_mode_returns_unstarted_mock() {
        let sc = create_sidecar(SidecarMode::Mock, "p-factory-mock");
        assert!(!sc.is_alive());
    }
}
