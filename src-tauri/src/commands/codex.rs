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

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::{AppHandle, Emitter, Runtime};

use crate::codex_sidecar::auth_watchdog::AuthState;
use crate::codex_sidecar::contract::{
    AGENT_LAZY_SPAWN_EVENT_SUFFIX, AGENT_SPAWN_RETRY_EVENT_SUFFIX,
};
use crate::codex_sidecar::mock::make_turn_start_request;
use crate::codex_sidecar::multi::MultiSidecarManager;
use crate::codex_sidecar::protocol::{
    method, CodexNotification, ThreadStartResult, TurnStartResult,
};
use crate::codex_sidecar::retry::{RetryPolicy, SpawnAttempt};
use crate::codex_sidecar::{CodexRequest, SidecarMode};
use crate::AppState;

/// DEC-018-045 QW2 (AS-201.3): retry 試行 1 回ぶんの event payload。
///
/// frontend `SpawnAttemptEvent` (`schemas.ts`) と camelCase で 1:1 対応。
/// `agent:{projectId}:spawn-retry` で emit される。
///
/// AS-HOTFIX-QW6 (DEC-018-047 ⑫): `success` を追加。retry loop が成功で終了した
/// ときに 1 回だけ true で emit され、frontend `useSpawnRetry` はこれを受けて
/// 「再接続中… (1/3)」バッジを `'idle'` に reset する。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnAttemptEventPayload {
    pub attempt: usize,
    pub max_retries: usize,
    pub last_error: Option<String>,
    pub next_sleep_ms: Option<u64>,
    /// AS-HOTFIX-QW6: 成功通知フラグ。`true` のとき UI 側はバッジを消す。
    pub success: bool,
}

impl From<SpawnAttempt> for SpawnAttemptEventPayload {
    fn from(a: SpawnAttempt) -> Self {
        Self {
            attempt: a.attempt,
            max_retries: a.max_retries,
            last_error: a.last_error,
            next_sleep_ms: a.next_sleep_ms,
            success: a.success,
        }
    }
}

/// Multi-Sidecar 起動。同一 project_id への重複呼び出しは no-op。
///
/// AS-144 / DEC-018-036: モードは `AppState.current_sidecar_mode` から読む。
/// 起動時は env (`ASAGI_SIDECAR_MODE`) で初期化されるが、UI から
/// `agent_set_sidecar_mode` で切替された後は最新値が使われる
/// （既存 sidecar は再 spawn まで現行モード継続、additive 切替）。
///
/// AS-UX-FIX-A / DEC-018-039 W1: notification → Tauri Event 転送 pump task は
/// `spawn_for` が **新規生成 (Ok(true))** を返したときのみ起動する。
/// React StrictMode 下では `useEffect` が dev で 2 回 mount されるため、
/// `void codex.spawn()` も 2 回呼ばれる。以前は spawn_for が冪等 no-op で
/// あっても無条件に pump task を生成していたため、同一 broadcast::Sender に
/// 2 つの subscriber 経路ができ、1 つの `item/agentMessage/delta` 通知が
/// 2 回 emit されて UI 側で各 token が二重表示される深刻なバグが発生していた。
/// （症状: `mockmock app app-ser-server ver` のような interleaved duplication。）
#[tauri::command]
pub async fn agent_spawn_sidecar<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<(), String> {
    let mode = *state.current_sidecar_mode.read().await;

    // DEC-018-045 QW2 (AS-201.3): outer retry layer 経由で spawn する。
    // retry 試行ごとに `agent:{projectId}:spawn-retry` event を emit し、
    // ChatStatusBadge で「再接続中… (試行 N/3)」表示に使う。
    let pid_for_cb = project_id.clone();
    let app_for_cb = app.clone();
    let on_attempt = move |a: SpawnAttempt| {
        let event_name = format!("agent:{pid_for_cb}:{}", AGENT_SPAWN_RETRY_EVENT_SUFFIX);
        let payload: SpawnAttemptEventPayload = a.into();
        if let Err(e) = app_for_cb.emit(&event_name, payload) {
            tracing::warn!("emit {event_name} failed: {e}");
        }
    };

    let newly_created = state
        .multi
        .spawn_for_with_retry(project_id.clone(), mode, RetryPolicy::default(), on_attempt)
        .await
        .map_err(|e| format!("spawn_for_with_retry failed: {e:#}"))?;

    if !newly_created {
        // 既存 sidecar に対する重複 spawn — pump task は既に走っているので
        // 二重起動を回避するためここで return（DEC-018-039 W1 fix）。
        tracing::debug!("agent_spawn_sidecar: existing sidecar for {project_id}, pump task reused");
        return Ok(());
    }

    // notification を Tauri Event に転送する pump task を起動（新規 sidecar に 1 個だけ）
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

/// DEC-018-045 QW3 (AS-202.2): lazy spawn event の payload。
/// `agent:{projectId}:lazy-spawn` で emit され、UI に「自動再接続中」表示を出させる。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LazySpawnEventPayload {
    pub project_id: String,
    pub reason: &'static str,
}

/// AS-HOTFIX-QW4 (DEC-018-046 carryover): lazy spawn パターンを共通化する helper。
///
/// **目的**: sidecar が居ないときに JSON-RPC を投げると "no sidecar for project_id"
/// で fail する問題を、全 user-facing entrypoint で同一の保護で覆う。
///
/// **抽出元**: `agent_send_message_v2` (chat 送信) で先行実装されていた lazy spawn
/// fallback。AS-HOTFIX-QW4 で `auth_open_login` (再ログイン CTA) にも同じ保護を
/// 適用する必要が出たため、両方が同じバグの再現を生まないよう helper 化した。
///
/// **動作**:
///   1. `multi.is_active(pid)` が `false` のときのみ以下を実行（true なら no-op で即 return）
///   2. `agent:{pid}:lazy-spawn` event を 1 回 emit (UI に「自動再接続中」状態を出させる)
///   3. retry 試行ごとに `agent:{pid}:spawn-retry` を emit
///   4. `multi.spawn_for_with_retry(...)` で再接続を試みる（既定 RetryPolicy）
///   5. **新規生成**された場合（`Ok(true)`）のみ notification pump task を起動
///      （冪等 spawn の二重 pump 起動を回避: AS-UX-FIX-A / DEC-018-039 W1 と同根の対策）
///
/// **failure mode**:
///   - `spawn_for_with_retry` が `Err` → `"lazy spawn failed: ..."` で `Err` を返す
///   - 呼び出し側はこの Err を user 向け toast / log に流す責務を負う
async fn ensure_sidecar_with_lazy_spawn<R: Runtime>(
    app: AppHandle<R>,
    multi: Arc<MultiSidecarManager>,
    mode: SidecarMode,
    project_id: String,
    reason: &'static str,
) -> Result<(), String> {
    if multi.is_active(&project_id).await {
        return Ok(());
    }

    // (2) lazy-spawn event を 1 回 emit
    let lazy_event = format!("agent:{project_id}:{}", AGENT_LAZY_SPAWN_EVENT_SUFFIX);
    let payload = LazySpawnEventPayload {
        project_id: project_id.clone(),
        reason,
    };
    if let Err(e) = app.emit(&lazy_event, payload) {
        tracing::warn!("emit {lazy_event} failed: {e}");
    }

    // (3) retry callback: spawn-retry event
    let pid_for_cb = project_id.clone();
    let app_for_cb = app.clone();
    let on_attempt = move |a: SpawnAttempt| {
        let event_name = format!("agent:{pid_for_cb}:{}", AGENT_SPAWN_RETRY_EVENT_SUFFIX);
        let payload: SpawnAttemptEventPayload = a.into();
        if let Err(e) = app_for_cb.emit(&event_name, payload) {
            tracing::warn!("emit {event_name} failed: {e}");
        }
    };

    // (4) spawn (retry policy default)
    let newly_created = multi
        .spawn_for_with_retry(project_id.clone(), mode, RetryPolicy::default(), on_attempt)
        .await
        .map_err(|e| format!("lazy spawn failed: {e:#}"))?;

    // (5) newly_created なら notification pump task を起動
    if newly_created {
        let multi_for_pump = multi.clone();
        let pid_for_pump = project_id.clone();
        let app_for_pump = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut rx = match multi_for_pump.subscribe(&pid_for_pump).await {
                Ok(r) => r,
                Err(e) => {
                    tracing::error!("lazy spawn subscribe failed for {pid_for_pump}: {e:#}");
                    return;
                }
            };
            loop {
                match rx.recv().await {
                    Ok(n) => forward_notification(&app_for_pump, &pid_for_pump, &n),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(
                            "lazy spawn notification lagged for {pid_for_pump}, dropped {n}"
                        );
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        tracing::info!("lazy spawn notification stream closed for {pid_for_pump}");
                        break;
                    }
                }
            }
        });
    }

    Ok(())
}

/// turn 1 ターン開始。Real protocol に準拠して
/// 1. thread_id 未指定なら thread/start
/// 2. turn/start 即時 inProgress を取得
/// 3. thread_id / turn_id を返却
///
/// streaming token は events 経由で `agent:{projectId}:item/agentMessage/delta` で受信。
///
/// # DEC-018-045 QW3 (AS-202.2): lazy spawn fallback
///
/// idle reaper / 明示的 shutdown / 起動失敗等で sidecar が居ない場合、
/// `spawn_for_with_retry` を実行して再接続を試みてから request を送る。
/// その間 `agent:{projectId}:lazy-spawn` event を 1 回だけ emit して
/// UI に「自動再接続中」状態を表示させる。
#[tauri::command]
pub async fn agent_send_message_v2<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    args: AgentSendMessageArgs,
) -> Result<AgentSendMessageResult, String> {
    // 0. lazy spawn: sidecar が居なければ自動再接続（QW3 AS-202.2）
    //    AS-HOTFIX-QW4 (DEC-018-046 carryover): `ensure_sidecar_with_lazy_spawn` helper に
    //    抽出済み。`auth_open_login` でも同じ保護を共有する。
    let mode = *state.current_sidecar_mode.read().await;
    ensure_sidecar_with_lazy_spawn(
        app.clone(),
        state.multi.clone(),
        mode,
        args.project_id.clone(),
        "sidecar_inactive",
    )
    .await?;

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
            return Err(format!(
                "thread/start error: {} ({})",
                err.message, err.code
            ));
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

/// DEC-018-045 QW1 (AS-200.3): 再ログインを開始する。
///
/// 1) **lazy spawn fallback** (AS-HOTFIX-QW4): sidecar が居なければ
///    `ensure_sidecar_with_lazy_spawn` で再接続を試みる
///    （idle reaper kill / 起動失敗後でも CTA が即時 fail しないよう保護）
/// 2) 対象 project の sidecar に `account/login/start` を投げ、`authUrl` を取得
/// 3) `tauri_plugin_shell::open_url` で既定ブラウザで開く
/// 4) 成功 / 失敗のいずれも UI 側に Result で返却
///
/// 使い方: warning toast / re-login modal の「再ログイン」ボタンから呼ぶ。
/// Watchdog 自体は別 task で polling 継続中なので、ログイン完了後 5 分以内に
/// `Authenticated(warning=false)` への遷移 event が自動で emit される。
///
/// # AS-HOTFIX-QW4 (DEC-018-046 carryover)
///
/// 当初実装は `multi.send_request` を直接叩いていたため、idle reaper が
/// sidecar を kill した直後に「再ログイン」CTA を押すと
/// `"no sidecar for project_id: ..."` エラーが出て CTA そのものが死ぬ
/// 連鎖が発生した（M-1 smoke で 8 連 console error として観測）。
/// `agent_send_message_v2` と同じ helper で lazy spawn を共有して根絶。
#[tauri::command]
pub async fn auth_open_login<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;

    // 1) lazy spawn fallback (AS-HOTFIX-QW4): sidecar が居なければ自動再接続
    let mode = *state.current_sidecar_mode.read().await;
    ensure_sidecar_with_lazy_spawn(
        app.clone(),
        state.multi.clone(),
        mode,
        project_id.clone(),
        "auth_relogin",
    )
    .await?;

    // 2) account/login/start を投げる
    let req_id = format!("auth-open-login-{}", uuid::Uuid::new_v4());
    let req = CodexRequest::new(req_id, method::ACCOUNT_LOGIN_START, None);
    let resp = state
        .multi
        .send_request(&project_id, req)
        .await
        .map_err(|e| format!("account/login/start rpc error: {e:#}"))?;
    if let Some(err) = resp.error {
        return Err(format!(
            "account/login/start codex error {}: {}",
            err.code, err.message
        ));
    }
    let result = resp
        .result
        .ok_or_else(|| "account/login/start returned empty result".to_string())?;
    let auth_url = result
        .get("authUrl")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "account/login/start: authUrl missing".to_string())?
        .to_string();

    // 2) 既定ブラウザで authUrl を開く。
    //    `tauri-plugin-opener` への移行は M2 後段で別タスクとして扱う
    //    （24h 限度内で新規 dep 追加禁止 strict req）。
    #[allow(deprecated)]
    app.shell()
        .open(&auth_url, None)
        .map_err(|e| format!("open authUrl failed: {e}"))?;

    Ok(())
}

// ---------------------------------------------------------------------
// AS-144 / DEC-018-036: Sidecar mode runtime switch
// ---------------------------------------------------------------------

/// Sidecar mode 文字列形式。frontend と TS 型 (`'mock' | 'real'`) で一致。
fn mode_to_str(m: SidecarMode) -> &'static str {
    match m {
        SidecarMode::Mock => "mock",
        SidecarMode::Real => "real",
    }
}

#[derive(Debug, Deserialize)]
pub struct SetSidecarModeArgs {
    /// `"mock"` または `"real"`。それ以外は Err。
    pub mode: String,
}

#[derive(Debug, Serialize)]
pub struct SidecarModeResult {
    pub mode: &'static str,
}

/// 現在の sidecar mode を返す。UI 起動時の seed 用。
///
/// 起動直後は `ASAGI_SIDECAR_MODE` 環境変数（未設定なら `mock`）。
/// `agent_set_sidecar_mode` で UI から切替後は最新値。
#[tauri::command]
pub async fn agent_get_sidecar_mode(
    state: tauri::State<'_, AppState>,
) -> Result<SidecarModeResult, String> {
    let m = *state.current_sidecar_mode.read().await;
    Ok(SidecarModeResult {
        mode: mode_to_str(m),
    })
}

/// Sidecar mode を runtime で切替える（mock <-> real）。
///
/// 既存 sidecar は触らない（再 spawn まで現行モードで継続動作）。
/// 切替後の新規 `agent_spawn_sidecar` から新モードが反映される。
/// UI から「全 project shutdown → mode 変更 → spawn」のフローで完全切替可能。
#[tauri::command]
pub async fn agent_set_sidecar_mode(
    state: tauri::State<'_, AppState>,
    args: SetSidecarModeArgs,
) -> Result<SidecarModeResult, String> {
    use std::str::FromStr;
    let new_mode =
        SidecarMode::from_str(&args.mode).map_err(|e| format!("invalid sidecar mode: {e}"))?;
    {
        let mut w = state.current_sidecar_mode.write().await;
        *w = new_mode;
    }
    tracing::info!(
        "sidecar mode switched to {} (existing sidecars unchanged until re-spawn)",
        mode_to_str(new_mode)
    );
    Ok(SidecarModeResult {
        mode: mode_to_str(new_mode),
    })
}

// ---------------------------------------------------------------------
// AS-144 / DEC-018-036 unit tests
// ---------------------------------------------------------------------
//
// Tauri command 関数本体は `tauri::State` を要求するため直接呼び出しテストが
// 困難。代わりに sidecar mode runtime 切替の wiring を `AppState` レベルで
// 検証することで、command 経路の健全性 (state 読み書き / mode_to_str /
// SidecarMode::from_str) を担保する。
#[cfg(test)]
mod tests {
    use super::*;
    use crate::AppState;

    #[test]
    fn mode_to_str_round_trips_via_from_str() {
        use std::str::FromStr;
        for &m in &[SidecarMode::Mock, SidecarMode::Real] {
            let s = mode_to_str(m);
            let parsed = SidecarMode::from_str(s).expect("round trip");
            assert_eq!(parsed, m, "mode_to_str/from_str must round-trip");
        }
    }

    #[tokio::test]
    async fn appstate_default_initializes_sidecar_mode_from_env() {
        // SAFETY: 並列テストでの env 競合を避けるため、ここで明示的に解除。
        std::env::remove_var("ASAGI_SIDECAR_MODE");
        let s = AppState::default();
        let m = *s.current_sidecar_mode.read().await;
        assert_eq!(m, SidecarMode::Mock, "default must be Mock when env unset");
    }

    #[tokio::test]
    async fn runtime_mode_switch_updates_appstate() {
        // 起動時 Mock → real に切替 → 元に戻す、を AppState 直接操作で検証。
        // command 関数本体は tauri::State<...> 抽出のため直叩き不可、
        // 内部 wiring (state.write().await + read().await) を検査する。
        std::env::remove_var("ASAGI_SIDECAR_MODE");
        let s = AppState::default();
        assert_eq!(*s.current_sidecar_mode.read().await, SidecarMode::Mock);

        // mock → real
        {
            let mut w = s.current_sidecar_mode.write().await;
            *w = SidecarMode::Real;
        }
        assert_eq!(*s.current_sidecar_mode.read().await, SidecarMode::Real);

        // real → mock fallback (additive 切替の保証)
        {
            let mut w = s.current_sidecar_mode.write().await;
            *w = SidecarMode::Mock;
        }
        assert_eq!(*s.current_sidecar_mode.read().await, SidecarMode::Mock);
    }

    #[test]
    fn set_sidecar_mode_args_accepts_lower_and_upper_case() {
        use std::str::FromStr;
        // SidecarMode::from_str (mod.rs) は ascii_lowercase 経由で
        // 大小文字混在を許容する仕様。command の入力 surface としても
        // この契約に依存することを test で固定。
        for s in &["mock", "MOCK", "Mock", "real", "REAL", "Real"] {
            assert!(SidecarMode::from_str(s).is_ok(), "must accept: {s}");
        }
        for s in &["", "stub", "MockReal"] {
            assert!(SidecarMode::from_str(s).is_err(), "must reject: {s}");
        }
    }
}
