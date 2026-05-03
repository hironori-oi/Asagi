//! Mock Codex sidecar 実装 (AS-130 / DEC-018-023)。
//!
//! 完全に in-process で動作する決定論的 mock。Codex CLI も OpenAI API も
//! 一切呼び出さない。dev / 自動テスト用。
//!
//! **DEC-018-023 適用**: Real Codex app-server (LSP-style) の API surface に完全準拠。
//! method 名 / event 名 / 高レベル型は Real と同一。内部応答は決定論的スタブ。
//!
//! # mock 挙動
//!
//!   - `initialize`             → handshake ハンドラに遷移、`InitializeResult` を返す
//!   - `initialized`            → notification (id 無し)、handshake 完了
//!   - 未 initialize の他 method → JSON-RPC error -32002 "Not initialized"
//!   - 重複 initialize          → JSON-RPC error -32603 "Already initialized"
//!   - `account/read`           → `{ account: { type: "chatgpt", planType: "mock-pro-5x" }, requiresOpenaiAuth: false }`
//!   - `account/login/start`    → `{ authUrl: "http://localhost:1455/mock", loginId: "mock-login-1" }`
//!   - `model/list`             → mock model 一覧
//!   - `thread/start`           → `{ thread: { id, ephemeral: true, ... } }`
//!   - `turn/start`             → 即 `{ turn: { id, status: "inProgress" } }` を返却 →
//!     バックグラウンドで 50ms × 10 トークンの
//!     `item/agentMessage/delta` 通知 →
//!     `turn/completed` notification で終端
//!   - `turn/interrupt`         → `{}` 即 success

use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;
use tokio::time::{sleep, Duration};

use super::protocol::{
    event, method, AccountInfo, AccountReadResult, ClientCapabilities, ClientInfo,
    CodexNotification, CodexRequest, CodexResponse, InitializeParams, InitializeResult, InputItem,
    ItemAgentMessageDeltaParams, RateLimitBucket, ThreadInfo, ThreadStartParams, ThreadStartResult,
    TurnCompletedParams, TurnInfo, TurnStartParams, TurnStartResult,
};
use super::{CodexSidecar, NOTIFICATION_CHANNEL_CAPACITY};

/// Mock 用モデル名 / プラン名 / ユーザー名。
pub const MOCK_MODEL: &str = "gpt-mock-5.5";
pub const MOCK_PLAN: &str = "mock-pro-5x";
pub const MOCK_USER: &str = "mock-user@example.com";

/// 1 turn で流すトークン数。
pub const MOCK_CHAT_TOKEN_COUNT: usize = 10;

/// トークン間 delay (ms)。
pub const MOCK_CHAT_TOKEN_DELAY_MS: u64 = 50;

/// mock app-server の応答テンプレート（全 token を結合した完成形）。
pub const MOCK_RESPONSE_TEMPLATE: &str = "mock app-server からの応答です（モデル: gpt-mock-5.5）";

/// Item ID prefix。
const ITEM_ID_PREFIX: &str = "mock-item-";
/// Thread ID prefix。
const THREAD_ID_PREFIX: &str = "mock-thread-";
/// Turn ID prefix。
const TURN_ID_PREFIX: &str = "mock-turn-";

/// Custom JSON-RPC error code 群（mock）。
const ERR_NOT_INITIALIZED: i32 = -32002;
const ERR_ALREADY_INITIALIZED: i32 = -32003;
const ERR_INVALID_PARAMS: i32 = -32602;
const ERR_METHOD_NOT_FOUND: i32 = -32601;

/// 1 turn の応答テキストを 10 トークンに分割した配列を返す。
/// 末尾の空白の有無含めて決定論的。
pub fn mock_response_tokens() -> Vec<String> {
    // テンプレートを文字数で 10 等分する（chars 単位）
    let chars: Vec<char> = MOCK_RESPONSE_TEMPLATE.chars().collect();
    let total = chars.len();
    let n = MOCK_CHAT_TOKEN_COUNT;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let start = i * total / n;
        let end = (i + 1) * total / n;
        out.push(chars[start..end].iter().collect());
    }
    out
}

/// DEC-018-026 ① C: 現在ストリーム中の turn を `turn/interrupt` で
/// 即座に終端できるよう、turn_id ごとに「中断要求済み」フラグを保持する。
/// `turn/start` の background task が各 token 送出ループで参照し、
/// flag = true なら delta loop を抜けて `turn/completed { status: "interrupted" }` を発火する。
type RunningTurns = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

#[derive(Clone)]
pub struct MockCodexSidecar {
    project_id: String,
    notifications: broadcast::Sender<CodexNotification>,
    started: Arc<AtomicBool>,
    initialized: Arc<AtomicBool>,
    item_seq: Arc<AtomicU64>,
    thread_seq: Arc<AtomicU64>,
    turn_seq: Arc<AtomicU64>,
    /// DEC-018-026 ① C: ストリーム中の turn 状態。
    running_turns: RunningTurns,
}

impl MockCodexSidecar {
    pub fn new(project_id: String) -> Self {
        let (tx, _) = broadcast::channel(NOTIFICATION_CHANNEL_CAPACITY);
        Self {
            project_id,
            notifications: tx,
            started: Arc::new(AtomicBool::new(false)),
            initialized: Arc::new(AtomicBool::new(false)),
            item_seq: Arc::new(AtomicU64::new(0)),
            thread_seq: Arc::new(AtomicU64::new(0)),
            turn_seq: Arc::new(AtomicU64::new(0)),
            running_turns: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    fn next_item_id(&self) -> String {
        let n = self.item_seq.fetch_add(1, Ordering::SeqCst);
        format!("{ITEM_ID_PREFIX}{n}")
    }

    fn next_thread_id(&self) -> String {
        let n = self.thread_seq.fetch_add(1, Ordering::SeqCst);
        format!("{THREAD_ID_PREFIX}{n}")
    }

    fn next_turn_id(&self) -> String {
        let n = self.turn_seq.fetch_add(1, Ordering::SeqCst);
        format!("{TURN_ID_PREFIX}{n}")
    }

    /// `initialize` ハンドシェイクハンドラ (P-3)。
    fn handle_initialize(&self, id: String, _params: InitializeParams) -> CodexResponse {
        if self.initialized.load(Ordering::SeqCst) {
            return CodexResponse::err(id, ERR_ALREADY_INITIALIZED, "Already initialized");
        }
        // initialized notification を待たずに最初の result を返す。
        // 実際の handshake 完了は後続の `initialized` notification で行う。
        let result = InitializeResult {
            user_agent: format!(
                "mock-codex-app-server/0.0.1 (asagi-mock; project={})",
                self.project_id
            ),
            codex_home: "~/.codex-mock".into(),
            platform_family: "mock".into(),
            platform_os: std::env::consts::OS.into(),
        };
        CodexResponse::ok(
            id,
            serde_json::to_value(result).expect("serialize init result"),
        )
    }

    /// `turn/start` ハンドラ。即 `inProgress` を返却 → 別タスクで delta + completed を流す。
    /// DEC-018-026 ① C: running_turns に cancel flag を登録し、delta loop で監視する。
    async fn handle_turn_start(&self, id: String, params: TurnStartParams) -> CodexResponse {
        let turn_id = self.next_turn_id();
        let item_id = self.next_item_id();

        // 中断 flag を登録
        let cancel_flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = self.running_turns.lock() {
            map.insert(turn_id.clone(), cancel_flag.clone());
        }

        // バックグラウンドで streaming
        let notif = self.notifications.clone();
        let turn_id_for_task = turn_id.clone();
        let item_id_for_task = item_id.clone();
        let thread_id = params.thread_id.clone();
        let cancel_flag_for_task = cancel_flag.clone();
        let running_turns_for_task = self.running_turns.clone();
        tokio::spawn(async move {
            // turn/started
            let _ = notif.send(CodexNotification::new(
                event::TURN_STARTED,
                Some(json!({
                    "turn": {
                        "id": turn_id_for_task,
                        "status": "inProgress",
                        "items": [],
                        "error": null,
                    },
                    "threadId": thread_id,
                })),
            ));
            // item/started (agentMessage)
            let _ = notif.send(CodexNotification::new(
                event::ITEM_STARTED,
                Some(json!({
                    "item": {
                        "type": "agentMessage",
                        "id": item_id_for_task,
                    },
                    "threadId": thread_id,
                    "turnId": turn_id_for_task,
                })),
            ));
            // 10 トークンの delta、各送出前に cancel flag を確認
            let mut interrupted = false;
            for tok in mock_response_tokens() {
                if cancel_flag_for_task.load(Ordering::SeqCst) {
                    interrupted = true;
                    break;
                }
                let _ = notif.send(CodexNotification::new(
                    event::ITEM_AGENT_MESSAGE_DELTA,
                    Some(
                        serde_json::to_value(ItemAgentMessageDeltaParams {
                            item_id: item_id_for_task.clone(),
                            delta: tok,
                        })
                        .expect("serialize delta"),
                    ),
                ));
                sleep(Duration::from_millis(MOCK_CHAT_TOKEN_DELAY_MS)).await;
            }
            // item/completed
            let _ = notif.send(CodexNotification::new(
                event::ITEM_COMPLETED,
                Some(json!({
                    "item": {
                        "type": "agentMessage",
                        "id": item_id_for_task,
                        "text": MOCK_RESPONSE_TEMPLATE,
                        "phase": if interrupted { "interrupted" } else { "final_answer" },
                    },
                    "threadId": thread_id,
                    "turnId": turn_id_for_task,
                })),
            ));
            // turn/completed (interrupted の場合は status を切替)
            let final_status = if interrupted {
                "interrupted"
            } else {
                "completed"
            };
            let _ = notif.send(CodexNotification::new(
                event::TURN_COMPLETED,
                Some(
                    serde_json::to_value(TurnCompletedParams {
                        turn: TurnInfo {
                            id: turn_id_for_task.clone(),
                            status: final_status.into(),
                            items: vec![],
                            error: None,
                        },
                    })
                    .expect("serialize turn/completed"),
                ),
            ));
            // running_turns から削除
            if let Ok(mut map) = running_turns_for_task.lock() {
                map.remove(&turn_id_for_task);
            }
        });

        CodexResponse::ok(
            id,
            serde_json::to_value(TurnStartResult {
                turn: TurnInfo {
                    id: turn_id,
                    status: "inProgress".into(),
                    items: vec![],
                    error: None,
                },
            })
            .expect("serialize turn/start result"),
        )
    }

    /// DEC-018-026 ① C: `turn/interrupt` ハンドラ。
    /// turnId 指定があればその turn の cancel flag を立てる。
    /// 指定なし or 不明な turnId なら現在 running 中の **全** turn を中断する。
    fn handle_turn_interrupt(&self, params: Option<JsonValue>) {
        let turn_id_opt = params
            .as_ref()
            .and_then(|p| p.get("turnId"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let map = match self.running_turns.lock() {
            Ok(m) => m,
            Err(_) => return,
        };
        match turn_id_opt {
            Some(tid) if !tid.is_empty() => {
                if let Some(flag) = map.get(&tid) {
                    flag.store(true, Ordering::SeqCst);
                }
            }
            _ => {
                // turnId 未指定: 全 running turn を cancel
                for flag in map.values() {
                    flag.store(true, Ordering::SeqCst);
                }
            }
        }
    }

    /// in-process で 1 リクエストを処理する（mock_server からも共有利用）。
    pub async fn dispatch_request(&self, req: CodexRequest) -> CodexResponse {
        let id = req.id.clone();
        let m = req.method.as_str();

        // initialize は initialized 前にも処理可能
        if m == method::INITIALIZE {
            let params: InitializeParams = match req.params {
                Some(p) => match serde_json::from_value(p) {
                    Ok(v) => v,
                    Err(e) => {
                        return CodexResponse::err(
                            id,
                            ERR_INVALID_PARAMS,
                            format!("invalid initialize params: {e}"),
                        );
                    }
                },
                None => {
                    // 寛容化: clientInfo 等を空で受け入れる
                    InitializeParams {
                        client_info: ClientInfo {
                            name: "unknown".into(),
                            title: "unknown".into(),
                            version: "0.0.0".into(),
                        },
                        capabilities: ClientCapabilities::default(),
                    }
                }
            };
            return self.handle_initialize(id, params);
        }

        // initialized 前は他 method を受けない
        if !self.initialized.load(Ordering::SeqCst) {
            return CodexResponse::err(
                id,
                ERR_NOT_INITIALIZED,
                format!("Not initialized: send `initialize` then `initialized` notification before `{m}`"),
            );
        }

        match m {
            method::ACCOUNT_READ => {
                // DEC-018-028 QW1 (F3 Auth Watchdog): mock を「契約サーバ」として
                // 環境変数で挙動切替可能にする。Real 切替時は CLI が同等の状態を
                // 返却するため Asagi 側の watchdog コードは無修正で済む。
                if std::env::var("ASAGI_MOCK_FAIL_ACCOUNT_READ")
                    .ok()
                    .as_deref()
                    == Some("1")
                {
                    return CodexResponse::err(
                        id,
                        -32099,
                        "mock account/read forced failure (ASAGI_MOCK_FAIL_ACCOUNT_READ=1)",
                    );
                }
                let force_reauth =
                    std::env::var("ASAGI_MOCK_FORCE_REAUTH").ok().as_deref() == Some("1");
                // F2 Rate Limit Dashboard (AS-201) で再利用される 2 bucket のうち
                // ダミー値を Account にも露出。Real CLI 同様に欠落も許容する。
                let mut by_id: std::collections::HashMap<String, RateLimitBucket> =
                    std::collections::HashMap::new();
                by_id.insert(
                    "5h_messages".into(),
                    RateLimitBucket {
                        used: 12,
                        limit: 80,
                        resets_at: 1_727_040_000,
                    },
                );
                by_id.insert(
                    "weekly_messages".into(),
                    RateLimitBucket {
                        used: 4,
                        limit: 1500,
                        resets_at: 1_727_308_800,
                    },
                );

                let account = if force_reauth {
                    None
                } else {
                    Some(AccountInfo {
                        account_type: "chatgpt".into(),
                        email: Some(MOCK_USER.into()),
                        plan_type: Some(MOCK_PLAN.into()),
                        rate_limits_by_limit_id: Some(by_id),
                    })
                };
                // DEC-018-045 QW1 (AS-200.1): expiry を mock からも返す。
                // default は now + 1h（warning に入らない）、
                // ASAGI_MOCK_EXPIRY_IN_SECS=N で N 秒後に短縮可能 (test / smoke 用)。
                // ASAGI_MOCK_FORCE_NO_EXPIRY=1 で expiry 自体を None で返す
                // (CLI が expiry を返さない fail-soft シナリオの再現、AS-200.2 test)。
                let force_no_expiry = std::env::var("ASAGI_MOCK_FORCE_NO_EXPIRY")
                    .map(|v| v == "1")
                    .unwrap_or(false);
                let expiry_in_secs: i64 = std::env::var("ASAGI_MOCK_EXPIRY_IN_SECS")
                    .ok()
                    .and_then(|v| v.parse::<i64>().ok())
                    .unwrap_or(60 * 60);
                let now_unix = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                let access_expiry = if force_reauth || force_no_expiry {
                    None
                } else {
                    Some(now_unix + expiry_in_secs)
                };
                let refresh_expiry = if force_reauth || force_no_expiry {
                    None
                } else {
                    // refresh は 30 日先（リサーチ § 3.1 推定の上限）
                    Some(now_unix + 30 * 24 * 60 * 60)
                };
                CodexResponse::ok(
                    id,
                    serde_json::to_value(AccountReadResult {
                        account,
                        requires_openai_auth: force_reauth,
                        access_token_expires_at: access_expiry,
                        refresh_token_expires_at: refresh_expiry,
                    })
                    .expect("serialize account/read"),
                )
            }
            method::ACCOUNT_LOGIN_START => CodexResponse::ok(
                id,
                json!({
                    "authUrl": "http://localhost:1455/mock-oauth",
                    "loginId": "mock-login-1",
                }),
            ),
            method::ACCOUNT_LOGIN_CANCEL => CodexResponse::ok(id, json!({})),
            method::ACCOUNT_LOGOUT => CodexResponse::ok(id, json!({})),
            method::ACCOUNT_RATE_LIMITS_READ => {
                // F2 (AS-201) 先行: 2 bucket + resets_at を返す mock。Real CLI も
                // 同 schema で返却するため Asagi 側 dashboard 実装は本 fixture で
                // 開発できる (DEC-018-029)。
                let mut by_id: std::collections::HashMap<String, RateLimitBucket> =
                    std::collections::HashMap::new();
                by_id.insert(
                    "5h_messages".into(),
                    RateLimitBucket {
                        used: 12,
                        limit: 80,
                        resets_at: 1_727_040_000,
                    },
                );
                by_id.insert(
                    "weekly_messages".into(),
                    RateLimitBucket {
                        used: 4,
                        limit: 1500,
                        resets_at: 1_727_308_800,
                    },
                );
                CodexResponse::ok(
                    id,
                    serde_json::json!({
                        "rateLimits": {"used": 42, "limit": 500},
                        "rateLimitsByLimitId": by_id,
                    }),
                )
            }
            method::MODEL_LIST => CodexResponse::ok(
                id,
                json!({
                    "models": [
                        {"id": MOCK_MODEL, "displayName": "GPT Mock 5.5"},
                        {"id": "gpt-mock-5", "displayName": "GPT Mock 5"},
                        {"id": "o4-mock-mini", "displayName": "o4 Mock mini"},
                    ]
                }),
            ),
            method::THREAD_START => {
                let _params: ThreadStartParams = match req.params {
                    Some(p) => match serde_json::from_value(p) {
                        Ok(v) => v,
                        Err(e) => {
                            return CodexResponse::err(
                                id,
                                ERR_INVALID_PARAMS,
                                format!("invalid thread/start params: {e}"),
                            );
                        }
                    },
                    None => {
                        return CodexResponse::err(
                            id,
                            ERR_INVALID_PARAMS,
                            "thread/start params required",
                        );
                    }
                };
                let thread_id = self.next_thread_id();
                CodexResponse::ok(
                    id,
                    serde_json::to_value(ThreadStartResult {
                        thread: ThreadInfo {
                            id: thread_id,
                            preview: None,
                            ephemeral: true,
                            model_provider: "openai-mock".into(),
                            created_at: "2026-05-02T00:00:00Z".into(),
                        },
                    })
                    .expect("serialize thread/start result"),
                )
            }
            method::THREAD_RESUME => CodexResponse::ok(
                id,
                json!({"thread": {"id": format!("{}resumed", THREAD_ID_PREFIX), "ephemeral": false}}),
            ),
            method::THREAD_LIST => CodexResponse::ok(id, json!({"data": [], "nextCursor": null})),
            method::THREAD_READ => CodexResponse::ok(
                id,
                json!({"thread": {"id": "mock-thread-0", "ephemeral": true, "status": "idle"}}),
            ),
            method::TURN_START => {
                let params: TurnStartParams = match req.params {
                    Some(p) => match serde_json::from_value(p) {
                        Ok(v) => v,
                        Err(e) => {
                            return CodexResponse::err(
                                id,
                                ERR_INVALID_PARAMS,
                                format!("invalid turn/start params: {e}"),
                            );
                        }
                    },
                    None => {
                        return CodexResponse::err(
                            id,
                            ERR_INVALID_PARAMS,
                            "turn/start params required",
                        );
                    }
                };
                self.handle_turn_start(id, params).await
            }
            method::TURN_INTERRUPT => {
                // DEC-018-026 ① C: in-process broadcast 経路の cancel flag を立てる
                self.handle_turn_interrupt(req.params.clone());
                CodexResponse::ok(id, json!({}))
            }
            method::TURN_STEER => CodexResponse::ok(id, json!({"turnId": "mock-turn-steered"})),
            other => CodexResponse::err(
                id,
                ERR_METHOD_NOT_FOUND,
                format!("method not found: {other}"),
            ),
        }
    }

    /// `initialized` notification を mock 内部で受領した時に呼ぶ。
    /// in-process では send_request 経路で notification は来ないため、
    /// 以下のいずれかで呼ぶ:
    ///   - mock_server.rs (stdio): notification を受信したら呼ぶ
    ///   - in-process client: send_request 直後に手動で呼ぶ
    pub fn mark_initialized(&self) {
        self.initialized.store(true, Ordering::SeqCst);
    }

    /// 内部状態確認（テスト用）。
    pub fn is_initialized(&self) -> bool {
        self.initialized.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl CodexSidecar for MockCodexSidecar {
    async fn start(&mut self) -> Result<()> {
        self.started.store(true, Ordering::SeqCst);
        // in-process 利用では Asagi 内部で initialize handshake を内包する。
        // mock の利便性のため start() 内で initialize → mark_initialized() まで自動で行う。
        // mock_server (stdio) 経由の場合は client が明示的に initialize/initialized を送る。
        let init_params = InitializeParams {
            client_info: ClientInfo {
                name: "asagi-internal".into(),
                title: "Asagi (in-process)".into(),
                version: "0.0.1".into(),
            },
            capabilities: ClientCapabilities::default(),
        };
        let init_req = CodexRequest::new(
            "init-internal",
            method::INITIALIZE,
            Some(serde_json::to_value(init_params).expect("serialize internal initialize")),
        );
        let _ = self.dispatch_request(init_req).await;
        self.mark_initialized();
        Ok(())
    }

    async fn send_request(&self, req: CodexRequest) -> Result<CodexResponse> {
        if !self.started.load(Ordering::SeqCst) {
            return Ok(CodexResponse::err(
                req.id.clone(),
                -32099,
                "sidecar not started",
            ));
        }
        Ok(self.dispatch_request(req).await)
    }

    fn subscribe_events(&self) -> broadcast::Receiver<CodexNotification> {
        self.notifications.subscribe()
    }

    async fn shutdown(&mut self) -> Result<()> {
        self.started.store(false, Ordering::SeqCst);
        self.initialized.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn is_alive(&self) -> bool {
        self.started.load(Ordering::SeqCst)
    }
}

/// thread/start を mock に投げて thread_id を取り出すヘルパー。
pub async fn mock_start_thread(s: &MockCodexSidecar, model: &str) -> String {
    let req = CodexRequest::new(
        "req-thread-start",
        method::THREAD_START,
        Some(json!({"model": model})),
    );
    let resp = s.send_request(req).await.expect("send thread/start");
    let r: ThreadStartResult = serde_json::from_value(resp.result.expect("thread/start result"))
        .expect("decode thread/start");
    r.thread.id
}

/// `turn/start` 用 CodexRequest を組み立てるヘルパー（テスト便利）。
pub fn make_turn_start_request(id: &str, thread_id: &str, content: &str) -> CodexRequest {
    CodexRequest::new(
        id,
        method::TURN_START,
        Some(
            serde_json::to_value(TurnStartParams {
                thread_id: thread_id.to_string(),
                input: vec![InputItem::Text {
                    text: content.to_string(),
                }],
                model: None,
                effort: None,
            })
            .expect("serialize turn/start params"),
        ),
    )
}

#[allow(dead_code)]
fn _unused_json_marker(_v: JsonValue) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_sidecar::env_test_lock;

    /// DEC-018-045 QW1 (AS-200.1) / AS-CLEAN-06 → AS-200.2 で `codex_sidecar::env_test_lock`
    /// に統一。auth_watchdog 等の env 操作 test と process 横断で直列化する。
    /// 旧 `ENV_TEST_LOCK()` 名は wrapper として維持し、参照箇所の差分を最小化する。
    #[allow(non_snake_case)]
    pub(super) fn ENV_TEST_LOCK() -> &'static std::sync::Mutex<()> {
        env_test_lock()
    }

    #[tokio::test]
    async fn mock_initialize_returns_result() {
        let s = MockCodexSidecar::new("p1".into());
        let req = CodexRequest::new(
            "init-1",
            method::INITIALIZE,
            Some(json!({
                "clientInfo": {"name": "asagi", "title": "Asagi", "version": "0.0.1"},
                "capabilities": {"experimentalApi": false, "optOutNotificationMethods": []}
            })),
        );
        let resp = s.dispatch_request(req).await;
        assert!(resp.error.is_none(), "initialize must succeed");
        let r: InitializeResult =
            serde_json::from_value(resp.result.unwrap()).expect("decode initialize result");
        assert!(r.user_agent.contains("mock-codex-app-server"));
    }

    #[tokio::test]
    async fn mock_rejects_method_before_initialized() {
        let s = MockCodexSidecar::new("p1".into());
        // initialize 前に thread/start を送る
        let req = CodexRequest::new(
            "req-1",
            method::THREAD_START,
            Some(json!({"model": MOCK_MODEL})),
        );
        let resp = s.dispatch_request(req).await;
        assert!(resp.error.is_some(), "must fail before initialize");
        let err = resp.error.unwrap();
        assert_eq!(err.code, ERR_NOT_INITIALIZED);
        assert!(err.message.contains("Not initialized"));
    }

    #[tokio::test]
    async fn mock_rejects_double_initialize() {
        let s = MockCodexSidecar::new("p1".into());
        let req = || {
            CodexRequest::new(
                "init-x",
                method::INITIALIZE,
                Some(json!({
                    "clientInfo": {"name": "a", "title": "A", "version": "0"},
                    "capabilities": {}
                })),
            )
        };
        let r1 = s.dispatch_request(req()).await;
        assert!(r1.error.is_none());
        s.mark_initialized();
        let r2 = s.dispatch_request(req()).await;
        assert!(r2.error.is_some());
        assert_eq!(r2.error.unwrap().code, ERR_ALREADY_INITIALIZED);
    }

    #[tokio::test]
    async fn mock_account_read_after_initialized() {
        // env を触る test と process 横断で直列化（AS-200.2）
        let _g = ENV_TEST_LOCK().lock().unwrap_or_else(|p| p.into_inner());
        // 他 test の残留を防御的に除去
        std::env::remove_var("ASAGI_MOCK_FORCE_REAUTH");
        std::env::remove_var("ASAGI_MOCK_FORCE_NO_EXPIRY");
        std::env::remove_var("ASAGI_MOCK_EXPIRY_IN_SECS");
        std::env::remove_var("ASAGI_MOCK_FAIL_ACCOUNT_READ");

        let mut s = MockCodexSidecar::new("p1".into());
        s.start().await.unwrap();
        let req = CodexRequest::new("a-1", method::ACCOUNT_READ, None);
        let resp = s.send_request(req).await.unwrap();
        let r: AccountReadResult = serde_json::from_value(resp.result.unwrap()).unwrap();
        let acc = r.account.unwrap();
        assert_eq!(acc.account_type, "chatgpt");
        assert_eq!(acc.plan_type.as_deref(), Some(MOCK_PLAN));
        assert!(!r.requires_openai_auth);

        // DEC-018-045 QW1 (AS-200.1): expiry が同梱されること。
        // default は now + 60min なので、now + 30min < expiry < now + 65min。
        let expiry = r
            .access_token_expires_at
            .expect("expiry must be present in mock");
        let now_unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        assert!(
            expiry > now_unix + 30 * 60 && expiry <= now_unix + 65 * 60,
            "expiry must be ~60min ahead: now={now_unix} expiry={expiry}"
        );
        // refresh は 30 日先
        let refresh = r.refresh_token_expires_at.expect("refresh expiry mock");
        assert!(refresh > now_unix + 25 * 24 * 60 * 60);
    }

    /// DEC-018-045 QW1 (AS-200.1): force_reauth でも expiry は None で返ることを確認。
    /// （account=None, requires=true なので watchdog 側は RequiresReauth に遷移し、
    /// expiry warning logic は走らない fail-soft 経路を担保。）
    #[tokio::test]
    async fn mock_account_read_force_reauth_returns_none_expiry() {
        let _g = ENV_TEST_LOCK().lock().unwrap_or_else(|p| p.into_inner());
        // 他 test の残留を防御的に除去
        std::env::remove_var("ASAGI_MOCK_FORCE_NO_EXPIRY");
        std::env::remove_var("ASAGI_MOCK_EXPIRY_IN_SECS");
        std::env::remove_var("ASAGI_MOCK_FAIL_ACCOUNT_READ");
        std::env::set_var("ASAGI_MOCK_FORCE_REAUTH", "1");
        let mut s = MockCodexSidecar::new("p-noexp".into());
        s.start().await.unwrap();
        let req = CodexRequest::new("a-2", method::ACCOUNT_READ, None);
        let resp = s.send_request(req).await.unwrap();
        let r: AccountReadResult = serde_json::from_value(resp.result.unwrap()).unwrap();
        std::env::remove_var("ASAGI_MOCK_FORCE_REAUTH");
        assert!(r.requires_openai_auth);
        assert!(r.account.is_none());
        assert!(r.access_token_expires_at.is_none());
        assert!(r.refresh_token_expires_at.is_none());
    }

    /// DEC-018-045 QW1 (AS-200.1): ASAGI_MOCK_EXPIRY_IN_SECS で短縮可能。
    #[tokio::test]
    async fn mock_account_read_supports_short_expiry_via_env() {
        let _g = ENV_TEST_LOCK().lock().unwrap_or_else(|p| p.into_inner());
        // 他 test の残留を防御的に除去
        std::env::remove_var("ASAGI_MOCK_FORCE_REAUTH");
        std::env::remove_var("ASAGI_MOCK_FORCE_NO_EXPIRY");
        std::env::remove_var("ASAGI_MOCK_FAIL_ACCOUNT_READ");
        std::env::set_var("ASAGI_MOCK_EXPIRY_IN_SECS", "120");
        let mut s = MockCodexSidecar::new("p-shortexp".into());
        s.start().await.unwrap();
        let req = CodexRequest::new("a-3", method::ACCOUNT_READ, None);
        let resp = s.send_request(req).await.unwrap();
        let r: AccountReadResult = serde_json::from_value(resp.result.unwrap()).unwrap();
        std::env::remove_var("ASAGI_MOCK_EXPIRY_IN_SECS");
        let expiry = r.access_token_expires_at.unwrap();
        let now_unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        // ~120 秒先（多少のジッタ許容）
        assert!(expiry >= now_unix + 60 && expiry <= now_unix + 180);
    }

    #[tokio::test]
    async fn mock_thread_start_returns_thread_id() {
        let mut s = MockCodexSidecar::new("p1".into());
        s.start().await.unwrap();
        let tid = mock_start_thread(&s, MOCK_MODEL).await;
        assert!(tid.starts_with(THREAD_ID_PREFIX));
    }

    #[tokio::test]
    async fn mock_turn_start_streams_then_completes() {
        let mut s = MockCodexSidecar::new("p1".into());
        s.start().await.unwrap();

        // subscribe BEFORE turn/start so we don't miss notifications
        let mut rx = s.subscribe_events();

        let tid = mock_start_thread(&s, MOCK_MODEL).await;
        let req = make_turn_start_request("req-1", &tid, "hello");
        let resp = s.send_request(req).await.unwrap();
        // 即時 inProgress
        assert!(resp.error.is_none());
        let r: TurnStartResult = serde_json::from_value(resp.result.unwrap()).unwrap();
        assert_eq!(r.turn.status, "inProgress");

        let mut deltas = 0usize;
        let mut got_completed = false;
        let mut concat = String::new();
        loop {
            match tokio::time::timeout(Duration::from_secs(3), rx.recv()).await {
                Ok(Ok(n)) => {
                    if n.method == event::ITEM_AGENT_MESSAGE_DELTA {
                        deltas += 1;
                        if let Some(p) = n.params {
                            if let Some(d) = p.get("delta").and_then(|v| v.as_str()) {
                                concat.push_str(d);
                            }
                        }
                    } else if n.method == event::TURN_COMPLETED {
                        got_completed = true;
                        break;
                    }
                }
                _ => break,
            }
        }
        assert_eq!(deltas, MOCK_CHAT_TOKEN_COUNT);
        assert!(got_completed, "turn/completed must arrive");
        assert_eq!(concat, MOCK_RESPONSE_TEMPLATE);
    }

    #[tokio::test]
    async fn mock_unknown_method_returns_error() {
        let mut s = MockCodexSidecar::new("p1".into());
        s.start().await.unwrap();
        let req = CodexRequest::new("req-x", "no/such/method", None);
        let resp = s.send_request(req).await.unwrap();
        assert!(resp.error.is_some());
        assert_eq!(resp.error.unwrap().code, ERR_METHOD_NOT_FOUND);
    }

    #[test]
    fn mock_response_tokens_concat_equals_template() {
        let toks = mock_response_tokens();
        assert_eq!(toks.len(), MOCK_CHAT_TOKEN_COUNT);
        let joined: String = toks.into_iter().collect();
        assert_eq!(joined, MOCK_RESPONSE_TEMPLATE);
    }

    /// DEC-018-026 ① C: turn/interrupt が delta loop を即時終端し、
    /// turn/completed が `status: "interrupted"` で発火することを保証する。
    #[tokio::test]
    async fn mock_turn_interrupt_terminates_streaming_with_interrupted_status() {
        let mut s = MockCodexSidecar::new("p-int".into());
        s.start().await.unwrap();

        let mut rx = s.subscribe_events();
        let tid = mock_start_thread(&s, MOCK_MODEL).await;
        let req = make_turn_start_request("req-int-1", &tid, "long task");
        let resp = s.send_request(req).await.unwrap();
        assert!(resp.error.is_none());
        let r: TurnStartResult = serde_json::from_value(resp.result.unwrap()).unwrap();
        let turn_id = r.turn.id.clone();

        // 1 token だけ受け取って即 interrupt を投げる
        // (token delay は 50ms なので 30ms 待って interrupt)
        sleep(Duration::from_millis(30)).await;

        let interrupt_req = CodexRequest::new(
            "req-int-2",
            method::TURN_INTERRUPT,
            Some(json!({"threadId": tid, "turnId": turn_id})),
        );
        let interrupt_resp = s.send_request(interrupt_req).await.unwrap();
        assert!(interrupt_resp.error.is_none(), "interrupt must succeed");

        // turn/completed を待ち、interrupted で終端することを確認
        let mut got_interrupted = false;
        let mut deltas = 0usize;
        for _ in 0..50 {
            match tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
                Ok(Ok(n)) => {
                    if n.method == event::ITEM_AGENT_MESSAGE_DELTA {
                        deltas += 1;
                    }
                    if n.method == event::TURN_COMPLETED {
                        if let Some(p) = n.params {
                            let status = p
                                .get("turn")
                                .and_then(|t| t.get("status"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            if status == "interrupted" {
                                got_interrupted = true;
                            }
                        }
                        break;
                    }
                }
                _ => break,
            }
        }
        assert!(
            got_interrupted,
            "turn/completed must arrive with status=interrupted"
        );
        // interrupted なので 10 token 全部は流れていないはず
        assert!(
            deltas < MOCK_CHAT_TOKEN_COUNT,
            "interrupted: must emit fewer than {} deltas, got {}",
            MOCK_CHAT_TOKEN_COUNT,
            deltas
        );
    }
}
