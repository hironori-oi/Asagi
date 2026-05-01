//! Tauri command handlers。
//!
//! Frontend (`src/lib/tauri/invoke.ts`) からの `invoke()` 呼出に対応する。
//! Codex 統合系コマンドは Phase 0 POC 通過まで「POC pending」エラーを返す。

use crate::auth::{self, AuthStatus};
use crate::session::{self, SessionRow};
use crate::AppState;
use serde::{Deserialize, Serialize};

/// SQLite 初期化を再実行する（debug 用）。
#[tauri::command]
pub fn db_init(state: tauri::State<AppState>) -> Result<(), String> {
    let mut guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = crate::db::init_database().map_err(|e| format!("{e:#}"))?;
    *guard = Some(conn);
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct CreateSessionArgs {
    pub title: String,
    #[serde(default = "default_project")]
    pub project_id: String,
}

fn default_project() -> String {
    "default".to_string()
}

#[tauri::command]
pub fn create_session(
    state: tauri::State<AppState>,
    args: CreateSessionArgs,
) -> Result<String, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("database not initialized")?;
    session::create(conn, &args.title, &args.project_id).map_err(|e| format!("{e:#}"))
}

#[derive(Debug, Deserialize)]
pub struct ListSessionsArgs {
    #[serde(default)]
    pub project_id: Option<String>,
}

#[tauri::command]
pub fn list_sessions(
    state: tauri::State<AppState>,
    args: ListSessionsArgs,
) -> Result<Vec<SessionRow>, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("database not initialized")?;
    session::list(conn, args.project_id.as_deref()).map_err(|e| format!("{e:#}"))
}

#[derive(Debug, Deserialize)]
pub struct SessionIdArgs {
    pub id: String,
}

#[tauri::command]
pub fn get_session(
    state: tauri::State<AppState>,
    args: SessionIdArgs,
) -> Result<Option<SessionRow>, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("database not initialized")?;
    session::get(conn, &args.id).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn delete_session(
    state: tauri::State<AppState>,
    args: SessionIdArgs,
) -> Result<(), String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("database not initialized")?;
    session::delete(conn, &args.id).map_err(|e| format!("{e:#}"))
}

// --------------------------------------------------------------------
// Codex 統合コマンド (Phase 0 POC 通過まで pending)
// --------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct PocPendingError {
    pub message: &'static str,
    pub gate: &'static str,
}

const POC_PENDING: PocPendingError = PocPendingError {
    message: "Codex 統合コマンドは Phase 0 POC 通過後に有効化されます",
    gate: "DEC-018-010 / DEC-018-014",
};

#[tauri::command]
pub fn auth_login_start() -> Result<(), PocPendingError> {
    Err(POC_PENDING)
}

#[tauri::command]
pub fn auth_status() -> Result<AuthStatus, String> {
    Ok(auth::auth_status())
}

#[derive(Debug, Deserialize)]
pub struct AgentSendMessageArgs {
    pub project_id: String,
    pub text: String,
    #[serde(default)]
    pub images: Vec<String>,
}

#[tauri::command]
pub fn agent_send_message(_args: AgentSendMessageArgs) -> Result<(), PocPendingError> {
    Err(POC_PENDING)
}

#[tauri::command]
pub fn agent_cancel(_project_id: String) -> Result<(), PocPendingError> {
    Err(POC_PENDING)
}

// --------------------------------------------------------------------
// Codex 統合 IF 定義（AS-112: フロント開発支援のためのモック値返却 / 未実装スタブ）
//
// 実 API 呼出は Phase 0 POC 通過後に AS-115 / AS-118 で実装する。
// ここは「型と Tauri command 名」を確定させ、フロント開発を進められる状態にすること
// が目的（DEC-018-014 ハイブリッド運用）。
// --------------------------------------------------------------------

/// Codex CLI の `codex login` を起動する OAuth フロー。
/// **POC 通過後実装**（AS-115）。
#[tauri::command]
pub fn codex_login() -> Result<(), String> {
    unimplemented!("[POC pending: AS-115 で実装]")
}

#[derive(Debug, Deserialize)]
pub struct CodexSendMessageArgs {
    pub project_id: String,
    pub text: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub images: Vec<String>,
}

/// Codex sidecar にメッセージを送信し、streaming で応答を返す。
/// **POC 通過後実装**（AS-118 / AS-122）。
#[tauri::command]
pub fn codex_send_message(_args: CodexSendMessageArgs) -> Result<(), String> {
    unimplemented!("[POC pending: AS-118 で実装]")
}

/// Codex 利用可能モデル一覧を取得する。
/// v0.1.0 ではフロント開発支援のためにモック値を返却する。
/// 本実装では Codex CLI から `models/list` 相当を取得する想定（AS-118）。
#[tauri::command]
pub fn codex_get_models() -> Result<Vec<String>, String> {
    Ok(vec![
        "gpt-5.5-codex".to_string(),
        "gpt-5-codex".to_string(),
        "o4-mini".to_string(),
    ])
}

/// Codex プラン残枠情報。
#[derive(Debug, Clone, Serialize)]
pub struct CodexQuota {
    pub used: u32,
    pub limit: u32,
    pub plan: String,
}

/// Codex プランの利用枠を取得する。
/// v0.1.0 ではフロント開発支援のためにモック値を返却する。
/// 本実装では ChatGPT サブスク API から取得する想定（AS-118 以降、リサーチで枠 API 仕様を確定）。
#[tauri::command]
pub fn codex_get_quota() -> Result<CodexQuota, String> {
    Ok(CodexQuota {
        used: 42,
        limit: 500,
        plan: "Pro 5x".to_string(),
    })
}
