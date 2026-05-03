//! Tauri command handlers。
//!
//! Frontend (`src/lib/tauri/invoke.ts`) からの `invoke()` 呼出に対応する。
//! Codex 統合系コマンドは Phase 0 POC 通過まで「POC pending」エラーを返す。

use crate::auth::{self, AuthStatus};
use crate::message::{self, MessageRow};
use crate::session::{self, SessionRow};
use crate::settings::{SettingKey, STORE_FILE};
use crate::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

// AS-134: Codex sidecar 系コマンドは別 module に集約
// `tauri::generate_handler!` macro は `pub use` 経由の re-export を
// 解決できないため、lib.rs では `commands::codex::xxx` で参照する。
pub mod codex;
// AS-UX-05: shallow filesystem listing for Sidebar Files tab
pub mod fs;

/// SQLite 初期化を再実行する（debug 用）。
#[tauri::command]
pub fn db_init(state: tauri::State<AppState>) -> Result<(), String> {
    let mut guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = crate::db::init_database().map_err(|e| format!("{e:#}"))?;
    *guard = Some(conn);
    Ok(())
}

// AS-CLEAN-11 (DEC-018-043): Tauri frontend は invoke args に camelCase
// (`projectId` / `sessionId` 等) を送信する規約のため、本 module の全 *Args
// struct に `#[serde(rename_all = "camelCase")]` を統一適用する。
// 未指定だと session 一覧 / message CRUD が常時 None / 空表示になる
// (発覚: 2026-05-03 owner smoke、SessionsTab に「DB 未接続」誤表示)。
// commands/codex.rs は別 convention (sidecar-client.ts が snake_case 送信)
// のため本 module のみ修正、codex.rs 統一は AS-CLEAN-13 (M1.1 backlog) で実施。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
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
pub fn delete_session(state: tauri::State<AppState>, args: SessionIdArgs) -> Result<(), String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("database not initialized")?;
    session::delete(conn, &args.id).map_err(|e| format!("{e:#}"))
}

// --------------------------------------------------------------------
// Message CRUD（AS-117）
// --------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMessageArgs {
    pub session_id: String,
    pub role: String,
    pub content: String,
}

#[tauri::command]
pub fn create_message(
    state: tauri::State<AppState>,
    args: CreateMessageArgs,
) -> Result<String, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("database not initialized")?;
    message::create(conn, &args.session_id, &args.role, &args.content).map_err(|e| format!("{e:#}"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListMessagesArgs {
    pub session_id: String,
}

#[tauri::command]
pub fn list_messages(
    state: tauri::State<AppState>,
    args: ListMessagesArgs,
) -> Result<Vec<MessageRow>, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("database not initialized")?;
    message::list(conn, &args.session_id).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn count_messages(
    state: tauri::State<AppState>,
    args: ListMessagesArgs,
) -> Result<u32, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("database not initialized")?;
    message::count(conn, &args.session_id).map_err(|e| format!("{e:#}"))
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

/// 旧 agent_send_message。互換のため残置（M1 既存呼出側）。
/// 新規実装は `agent_send_message_v2`（commands/codex.rs）。
/// mock mode では mock sidecar を即時 spawn → thread/start → turn/start →
/// item/agentMessage/delta + turn/completed を待ち、最終応答テキストを返す。
#[tauri::command]
pub async fn agent_send_message(
    state: tauri::State<'_, AppState>,
    args: AgentSendMessageArgs,
) -> Result<String, String> {
    use crate::codex_sidecar::mock::{make_turn_start_request, MOCK_RESPONSE_TEMPLATE};
    use crate::codex_sidecar::protocol::{event, method, ThreadStartResult};
    use crate::codex_sidecar::{CodexRequest, SidecarMode};

    let mode = SidecarMode::from_env();
    state
        .multi
        .spawn_for(args.project_id.clone(), mode)
        .await
        .map_err(|e| format!("spawn_for failed: {e:#}"))?;

    // notification subscribe を turn/start 前に取得しておく
    let mut rx = state
        .multi
        .subscribe(&args.project_id)
        .await
        .map_err(|e| format!("subscribe failed: {e:#}"))?;

    // thread/start
    let req = CodexRequest::new(
        format!("req-{}", uuid::Uuid::new_v4()),
        method::THREAD_START,
        Some(serde_json::json!({"model": "gpt-mock-5.5"})),
    );
    let resp = state
        .multi
        .send_request(&args.project_id, req)
        .await
        .map_err(|e| format!("thread/start failed: {e:#}"))?;
    if let Some(err) = resp.error {
        return Err(format!(
            "thread/start error: {} ({})",
            err.message, err.code
        ));
    }
    let r: ThreadStartResult = serde_json::from_value(resp.result.ok_or("empty")?)
        .map_err(|e| format!("decode thread/start: {e}"))?;
    let thread_id = r.thread.id;

    // turn/start
    let req_id = format!("req-{}", uuid::Uuid::new_v4());
    let req = make_turn_start_request(&req_id, &thread_id, &args.text);
    let resp = state
        .multi
        .send_request(&args.project_id, req)
        .await
        .map_err(|e| format!("turn/start failed: {e:#}"))?;
    if let Some(err) = resp.error {
        return Err(format!("turn/start error: {} ({})", err.message, err.code));
    }

    // turn/completed まで待ち、delta を結合する
    let mut full = String::new();
    while let Ok(Ok(n)) = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await {
        if n.method == event::ITEM_AGENT_MESSAGE_DELTA {
            if let Some(p) = n.params {
                if let Some(d) = p.get("delta").and_then(|v| v.as_str()) {
                    full.push_str(d);
                }
            }
        } else if n.method == event::TURN_COMPLETED {
            break;
        }
    }
    if full.is_empty() {
        // 通信失敗時のフォールバック (mock 完成形を返す)
        full = MOCK_RESPONSE_TEMPLATE.to_string();
    }
    Ok(full)
}

#[tauri::command]
pub async fn agent_cancel(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<(), String> {
    use crate::codex_sidecar::protocol::method;
    use crate::codex_sidecar::CodexRequest;
    let req_id = format!("req-{}", uuid::Uuid::new_v4());
    // Real protocol では turn/interrupt は threadId/turnId 必須だが、
    // 互換維持のため mock では省略可とする (mock 側は params 無視)。
    let req = CodexRequest::new(
        req_id,
        method::TURN_INTERRUPT,
        Some(serde_json::json!({"threadId": format!("mock-thread-of-{project_id}")})),
    );
    let resp = state
        .multi
        .send_request(&project_id, req)
        .await
        .map_err(|e| format!("turn/interrupt failed: {e:#}"))?;
    if let Some(err) = resp.error {
        return Err(format!("codex error: {} ({})", err.message, err.code));
    }
    Ok(())
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

// --------------------------------------------------------------------
// Settings 永続化 (AS-META-06) — tauri-plugin-store wrapper
//
// 設計:
//   - JSON ファイルストア。`~/.asagi/settings.json` 相当 (Tauri の app data dir 配下)
//   - キーは `SettingKey` enum で集約
//   - 値は serde_json::Value で何でも入る
//   - 既知キー以外も書き込めるが、`list_settings` では既知キーのみ返す
// --------------------------------------------------------------------

/// 1 設定値を取得。未設定の場合は `null` を返す (Option<JsonValue> を JSON null に)。
#[tauri::command]
pub fn get_setting<R: Runtime>(app: AppHandle<R>, key: String) -> Result<JsonValue, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    Ok(store.get(&key).unwrap_or(JsonValue::Null))
}

#[derive(Debug, Deserialize)]
pub struct SetSettingArgs {
    pub key: String,
    pub value: JsonValue,
}

/// 1 設定値を保存。即時 disk flush までは plugin の auto save 任せ。
#[tauri::command]
pub fn set_setting<R: Runtime>(app: AppHandle<R>, args: SetSettingArgs) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(&args.key, args.value);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// 既知キー全件を取得。未設定キーは `null` で返す。
#[tauri::command]
pub fn list_settings<R: Runtime>(app: AppHandle<R>) -> Result<HashMap<String, JsonValue>, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let mut out: HashMap<String, JsonValue> = HashMap::new();
    for key in SettingKey::all() {
        let k = key.as_str().to_string();
        let v = store.get(&k).unwrap_or(JsonValue::Null);
        out.insert(k, v);
    }
    Ok(out)
}

// ---------------------------------------------------------------------
// AS-142: image paste 経路 (DEC-018-033 ② / PM § 2.3 DoD ⑧)
// ---------------------------------------------------------------------

/// クリップボード画像を取得し、`turn/start` input 配列に push 可能な
/// `{type:"image", url:"data:image/png;base64,..."}` JSON 部品を返す。
///
/// schema 文字列は `crate::codex_sidecar::contract::IMAGE_INPUT_TYPE` /
/// `IMAGE_URL_FIELD` から import される (ハードコード禁止 / DEC-018-034)。
///
/// # 戻り値
///   - `Ok(JsonValue)` ... `{type, url}` の JSON object
///   - `Err(String)` ... NoImage / Empty / Unsupported / ClipboardError 等の
///                       human-readable メッセージ (frontend が toast 表示する想定)
#[tauri::command]
pub fn paste_clipboard_image() -> Result<JsonValue, String> {
    crate::image_paste::paste_clipboard_image_as_input_part().map_err(|e| e.to_string())
}
