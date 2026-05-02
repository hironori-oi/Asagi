//! Codex sidecar Tauri commands (AS-134 / DEC-018-023)。
//!
//! Multi-Sidecar 経由で project 単位の sidecar を起動・送信・shutdown する。
//! mock mode では Codex CLI を一切呼ばずに完結する。
//!
//! # Tauri event 命名 (DEC-018-023)
//!
//! Real Codex app-server の event 名を `agent:{projectId}:` prefix で wrap して emit:
//!   - `agent:{projectId}:item/agentMessage/delta`
//!   - `agent:{projectId}:turn/started`
//!   - `agent:{projectId}:turn/completed`
//!   - `agent:{projectId}:item/started`
//!   - `agent:{projectId}:item/completed`
//!   - `agent:{projectId}:thread/started`
//!   - `agent:{projectId}:thread/status/changed`
//!   - `agent:{projectId}:account/updated`
//!   - その他は `agent:{projectId}:<method>` を素通し
//!
//! Tauri v2 の event 名バリデーション (`tauri::event::event_name::is_event_name_valid`)
//! は `[a-zA-Z0-9-_:/]+` を許容するため `/` を含む event 名を直接 emit 可能。

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::{AppHandle, Emitter, Runtime};

use crate::codex_sidecar::auth_watchdog::AuthState;
use crate::codex_sidecar::mock::make_turn_start_request;
use crate::codex_sidecar::protocol::{
    method, CodexNotification, ThreadStartResult, TurnStartResult,
};
use crate::codex_sidecar::{CodexRequest, SidecarMode};
use crate::AppState;

/// Multi-Sidecar 起動。同一 project_id への重複呼び出しは no-op。
#[tauri::command]
pub async fn agent_spawn_sidecar<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<(), String> {
    let mode = SidecarMode::from_env();
    state
        .multi
        .spawn_for(project_id.clone(), mode)
        .await
        .map_err(|e| format!("spawn_for failed: {e:#}"))?;

    // notification を Tauri Event に転送する pump task を起動
    let multi = state.multi.clone();
    let pid = project_id.clone();
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut rx = match multi.subscribe(&pid).await {
            Ok(r) => r,
            Err(e) => {
                tracing::error!("subscribe failed for {pid}: {e:#}");
                return;
            }
        };
        loop {
            match rx.recv().await {
                Ok(n) => {
                    forward_notification(&app_handle, &pid, &n);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("notification lagged for {pid}, dropped {n}");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    tracing::info!("notification stream closed for {pid}");
                    break;
                }
            }
        }
    });

    Ok(())
}

fn forward_notification<R: Runtime>(app: &AppHandle<R>, project_id: &str, n: &CodexNotification) {
    // Tauri v2 event 名は `[a-zA-Z0-9-_:/]+` 許容。Real method 名 `item/agentMessage/delta` 等を
    // そのまま prefix `agent:{project_id}:` 配下に emit する。
    let event_name = format!("agent:{project_id}:{}", n.method);
    if let Err(e) = app.emit(&event_name, n.params.clone()) {
        tracing::warn!("emit {event_name} failed: {e}");
    }
}

#[derive(Debug, Deserialize)]
pub struct AgentSendMessageArgs {
    pub project_id: String,
    pub content: String,
    /// Real protocol では thread_id を chat 連続性のために再利用する。
    /// 省略時は内部で thread/start を 1 回行って新規 id を取得し、
    /// 以降は呼び出し側で保持する。
    #[serde(default)]
    pub thread_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AgentSendMessageResult {
    pub thread_id: String,
    pub turn_id: String,
}

/// turn 1 ターン開始。Real protocol に準拠して
/// 1. thread_id 未指定なら thread/start
/// 2. turn/start 即時 inProgress を取得
/// 3. thread_id / turn_id を返却
///
/// streaming token は events 経由で `agent:{projectId}:item/agentMessage/delta` で受信。
#[tauri::command]
pub async fn agent_send_message_v2(
    state: tauri::State<'_, AppState>,
    args: AgentSendMessageArgs,
) -> Result<AgentSendMessageResult, String> {
    // 1. thread_id 解決
    let thread_id = if let Some(tid) = args.thread_id.clone() {
        tid
    } else {
        let req_id = format!("req-{}", uuid::Uuid::new_v4());
        let req = CodexRequest::new(
            req_id,
            method::THREAD_START,
            Some(serde_json::json!({"model": "gpt-mock-5.5"})),
        );
        let resp = state
            .multi
            .send_request(&args.project_id, req)
            .await
            .map_err(|e| format!("thread/start failed: {e:#}"))?;
        if let Some(err) = resp.error {
            return Err(format!("thread/start error: {} ({})", err.message, err.code));
        }
        let r: ThreadStartResult = serde_json::from_value(resp.result.ok_or("empty")?)
            .map_err(|e| format!("decode thread/start: {e}"))?;
        r.thread.id
    };

    // 2. turn/start
    let req_id = format!("req-{}", uuid::Uuid::new_v4());
    let req = make_turn_start_request(&req_id, &thread_id, &args.content);
    let resp = state
        .multi
        .send_request(&args.project_id, req)
        .await
        .map_err(|e| format!("turn/start failed: {e:#}"))?;
    if let Some(err) = resp.error {
        return Err(format!("turn/start error: {} ({})", err.message, err.code));
    }
    let result_value: JsonValue = resp.result.ok_or_else(|| "empty result".to_string())?;
    let r: TurnStartResult =
        serde_json::from_value(result_value).map_err(|e| format!("decode turn/start: {e}"))?;
    Ok(AgentSendMessageResult {
        thread_id,
        turn_id: r.turn.id,
    })
}

#[tauri::command]
pub async fn agent_shutdown_sidecar(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<(), String> {
    state
        .multi
        .shutdown(&project_id)
        .await
        .map_err(|e| format!("shutdown failed: {e:#}"))
}

#[tauri::command]
pub async fn agent_list_sidecars(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.multi.list_active().await)
}

/// `account/read` 経由で sidecar の account / plan 情報を取得する。
#[tauri::command]
pub async fn agent_status(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<JsonValue, String> {
    let req_id = format!("req-{}", uuid::Uuid::new_v4());
    let req = CodexRequest::new(req_id, method::ACCOUNT_READ, None);
    let resp = state
        .multi
        .send_request(&project_id, req)
        .await
        .map_err(|e| format!("account/read failed: {e:#}"))?;
    if let Some(err) = resp.error {
        return Err(format!("codex error: {} ({})", err.message, err.code));
    }
    Ok(resp.result.unwrap_or(JsonValue::Null))
}

#[derive(Debug, Deserialize)]
pub struct AgentInterruptArgs {
    pub project_id: String,
    /// Real protocol では threadId 必須。mock では省略可。
    #[serde(default)]
    pub thread_id: Option<String>,
    /// Real protocol では turnId 任意。
    #[serde(default)]
    pub turn_id: Option<String>,
}

/// DEC-018-026 ① C: 現在ストリーム中の turn を即座に中断する。
///
/// Real Codex app-server `turn/interrupt` の呼び出し規約:
///   params: `{ threadId: string, turnId?: string }`
///
/// mock 実装では state machine で「現在 streaming 中の turn」を保持し、
/// `turn/interrupt` 受信で stream task を terminate flag で落として
/// `turn/completed` を `interrupted` 状態で発火する。
#[tauri::command]
pub async fn agent_interrupt(
    state: tauri::State<'_, AppState>,
    args: AgentInterruptArgs,
) -> Result<(), String> {
    let req_id = format!("req-{}", uuid::Uuid::new_v4());
    let mut params = serde_json::Map::new();
    if let Some(tid) = &args.thread_id {
        params.insert("threadId".into(), JsonValue::String(tid.clone()));
    } else {
        // Real protocol 上は threadId 必須だが、mock は許容するため空文字を入れて
        // 形だけ揃える。Real impl 切替時に上位 (use-codex hook) が threadId を
        // 必ず保持するように修正済み。
        params.insert("threadId".into(), JsonValue::String(String::new()));
    }
    if let Some(turn_id) = &args.turn_id {
        params.insert("turnId".into(), JsonValue::String(turn_id.clone()));
    }
    let req = CodexRequest::new(
        req_id,
        method::TURN_INTERRUPT,
        Some(JsonValue::Object(params)),
    );
    let resp = state
        .multi
        .send_request(&args.project_id, req)
        .await
        .map_err(|e| format!("turn/interrupt failed: {e:#}"))?;
    if let Some(err) = resp.error {
        return Err(format!("codex error: {} ({})", err.message, err.code));
    }
    Ok(())
}

// ---------------------------------------------------------------------
// DEC-018-028 QW1 (F3 Auth Watchdog) Tauri commands
// ---------------------------------------------------------------------

/// Watchdog start (idempotent)。lib.rs setup() で起動するが、
/// 環境変数 `ASAGI_AUTH_WATCHDOG_DISABLED=1` で抑止された場合に
/// 後から UI 操作で起動できるようにも開放する。
#[tauri::command]
pub async fn auth_watchdog_start(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.auth_watchdog.write().await;
    if let Some(w) = guard.as_mut() {
        w.start();
    }
    Ok(())
}

/// Watchdog stop (idempotent)。
#[tauri::command]
pub async fn auth_watchdog_stop(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.auth_watchdog.write().await;
    if let Some(w) = guard.as_mut() {
        w.stop();
    }
    Ok(())
}

/// 即時 1 回 polling を実行。UI の「今すぐ確認」ボタンから呼ぶ。
/// 結果は `auth:{projectId}:state_changed` event で通知される。
#[tauri::command]
pub async fn auth_watchdog_force_check(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<(), String> {
    let guard = state.auth_watchdog.read().await;
    let w = guard
        .as_ref()
        .ok_or_else(|| "AuthWatchdog not initialized".to_string())?;
    w.force_check_now(&project_id)
        .await
        .map_err(|e| format!("force_check failed: {e:#}"))
}

/// 現在の AuthState を取得 (UI 起動時の seed)。未 polled の場合は Unknown。
#[tauri::command]
pub async fn auth_watchdog_get_state(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<AuthState, String> {
    let guard = state.auth_watchdog.read().await;
    let w = guard
        .as_ref()
        .ok_or_else(|| "AuthWatchdog not initialized".to_string())?;
    Ok(w.get_state(&project_id).await)
}
