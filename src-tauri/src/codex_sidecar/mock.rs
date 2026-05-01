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
//!                                バックグラウンドで 50ms × 10 トークンの
//!                                `item/agentMessage/delta` 通知 →
//!                                `turn/completed` notification で終端
//!   - `turn/interrupt`         → `{}` 即 success

use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast;
use tokio::time::{sleep, Duration};

use super::protocol::{
    event, method, AccountInfo, AccountReadResult, ClientCapabilities, ClientInfo,
    CodexNotification, CodexRequest, CodexResponse, InitializeParams, InitializeResult,
    InputItem, ItemAgentMessageDeltaParams, ThreadInfo, ThreadStartParams, ThreadStartResult,
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
pub const MOCK_RESPONSE_TEMPLATE: &str =
    "mock app-server からの応答です（モデル: gpt-mock-5.5）";

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

#[derive(Clone)]
pub struct MockCodexSidecar {
    project_id: String,
    notifications: broadcast::Sender<CodexNotification>,
    started: Arc<AtomicBool>,
    initialized: Arc<AtomicBool>,
    item_seq: Arc<AtomicU64>,
    thread_seq: Arc<AtomicU64>,
    turn_seq: Arc<AtomicU64>,
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
            user_agent: format!("mock-codex-app-server/0.0.1 (asagi-mock; project={})", self.project_id),
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
    async fn handle_turn_start(&self, id: String, params: TurnStartParams) -> CodexResponse {
        let turn_id = self.next_turn_id();
        let item_id = self.next_item_id();

        // バックグラウンドで streaming
        let notif = self.notifications.clone();
        let turn_id_for_task = turn_id.clone();
        let item_id_for_task = item_id.clone();
        let thread_id = params.thread_id.clone();
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
            // 10 トークンの delta
            for tok in mock_response_tokens() {
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
                        "phase": "final_answer",
                    },
                    "threadId": thread_id,
                    "turnId": turn_id_for_task,
                })),
            ));
            // turn/completed
            let _ = notif.send(CodexNotification::new(
                event::TURN_COMPLETED,
                Some(
                    serde_json::to_value(TurnCompletedParams {
                        turn: TurnInfo {
                            id: turn_id_for_task,
                            status: "completed".into(),
                            items: vec![],
                            error: None,
                        },
                    })
                    .expect("serialize turn/completed"),
                ),
            ));
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
            method::ACCOUNT_READ => CodexResponse::ok(
                id,
                serde_json::to_value(AccountReadResult {
                    account: Some(AccountInfo {
                        account_type: "chatgpt".into(),
                        email: Some(MOCK_USER.into()),
                        plan_type: Some(MOCK_PLAN.into()),
                    }),
                    requires_openai_auth: false,
                })
                .expect("serialize account/read"),
            ),
            method::ACCOUNT_LOGIN_START => CodexResponse::ok(
                id,
                json!({
                    "authUrl": "http://localhost:1455/mock-oauth",
                    "loginId": "mock-login-1",
                }),
            ),
            method::ACCOUNT_LOGIN_CANCEL => CodexResponse::ok(id, json!({})),
            method::ACCOUNT_LOGOUT => CodexResponse::ok(id, json!({})),
            method::ACCOUNT_RATE_LIMITS_READ => CodexResponse::ok(
                id,
                json!({
                    "rateLimits": {"used": 42, "limit": 500},
                    "rateLimitsByLimitId": {},
                }),
            ),
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
            method::TURN_INTERRUPT => CodexResponse::ok(id, json!({})),
            method::TURN_STEER => CodexResponse::ok(
                id,
                json!({"turnId": "mock-turn-steered"}),
            ),
            other => CodexResponse::err(id, ERR_METHOD_NOT_FOUND, format!("method not found: {other}")),
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
        let mut s = MockCodexSidecar::new("p1".into());
        s.start().await.unwrap();
        let req = CodexRequest::new("a-1", method::ACCOUNT_READ, None);
        let resp = s.send_request(req).await.unwrap();
        let r: AccountReadResult = serde_json::from_value(resp.result.unwrap()).unwrap();
        let acc = r.account.unwrap();
        assert_eq!(acc.account_type, "chatgpt");
        assert_eq!(acc.plan_type.as_deref(), Some(MOCK_PLAN));
        assert!(!r.requires_openai_auth);
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
}
