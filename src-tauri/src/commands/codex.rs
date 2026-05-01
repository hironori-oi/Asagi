//! Codex sidecar Tauri commands (AS-134)。
//!
//! Multi-Sidecar 経由で project 単位の sidecar を起動・送信・shutdown する。
//! mock mode では Codex CLI を一切呼ばずに完結する。
//!
//! Tauri event:
//!   - `agent:{projectId}:assistant_message_delta`
//!   - `agent:{projectId}:done`
//!   - `agent:{projectId}:status`
//!   - `agent:{projectId}:error`

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::{AppHandle, Emitter, Runtime};

use crate::codex_sidecar::mock::make_chat_request;
use crate::codex_sidecar::protocol::{event as ev, method, ChatResult, CodexNotification};
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
    let event_name = match n.method.as_str() {
        ev::ASSISTANT_MESSAGE_DELTA => format!("agent:{project_id}:assistant_message_delta"),
        ev::DONE => format!("agent:{project_id}:done"),
        ev::ERROR => format!("agent:{project_id}:error"),
        "codex/event/ready" => format!("agent:{project_id}:ready"),
        other => format!("agent:{project_id}:status:{}", other.replace('/', "_")),
    };
    if let Err(e) = app.emit(&event_name, n.params.clone()) {
        tracing::warn!("emit {event_name} failed: {e}");
    }
}

#[derive(Debug, Deserialize)]
pub struct AgentSendMessageArgs {
    pub project_id: String,
    pub content: String,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AgentSendMessageResult {
    pub message_id: String,
    pub full_text: String,
}

/// chat 1 ターン送信。response の `full_text` を返す。
#[tauri::command]
pub async fn agent_send_message_v2(
    state: tauri::State<'_, AppState>,
    args: AgentSendMessageArgs,
) -> Result<AgentSendMessageResult, String> {
    let req_id = format!("req-{}", uuid::Uuid::new_v4());
    let session_id = args
        .session_id
        .clone()
        .unwrap_or_else(|| format!("sess-{}", args.project_id));
    let req = make_chat_request(&req_id, &session_id, &args.content);

    let resp = state
        .multi
        .send_request(&args.project_id, req)
        .await
        .map_err(|e| format!("send_request failed: {e:#}"))?;
    if let Some(err) = resp.error {
        return Err(format!("codex error: {} ({})", err.message, err.code));
    }
    let result_value: JsonValue = resp
        .result
        .ok_or_else(|| "empty result".to_string())?;
    let result: ChatResult =
        serde_json::from_value(result_value).map_err(|e| format!("decode result: {e}"))?;
    Ok(AgentSendMessageResult {
        message_id: result.message_id,
        full_text: result.full_text,
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

/// status 取得（mock では即返却）。
#[tauri::command]
pub async fn agent_status(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<JsonValue, String> {
    let req_id = format!("req-{}", uuid::Uuid::new_v4());
    let req = CodexRequest::new(req_id, method::STATUS, None);
    let resp = state
        .multi
        .send_request(&project_id, req)
        .await
        .map_err(|e| format!("status failed: {e:#}"))?;
    if let Some(err) = resp.error {
        return Err(format!("codex error: {} ({})", err.message, err.code));
    }
    Ok(resp.result.unwrap_or(JsonValue::Null))
}
