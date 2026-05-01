//! Mock Codex sidecar 実装 (AS-130)。
//!
//! 完全に in-process で動作する決定論的 mock。Codex CLI も OpenAI API も
//! 一切呼び出さない。dev / 自動テスト用。
//!
//! # mock 挙動
//!
//! - `codex/login`      → 即 success `{ ok: true, user: "mock-user" }`
//! - `codex/chat`       → 50ms ごとに 10 トークン分の delta notification を流し、最終 response を返す
//! - `codex/cancel`     → 即 success
//! - `codex/status`     → `{ alive, model: "gpt-mock-5.5", plan: "mock-pro-5x" }`
//! - `codex/imagePaste` → base64 を decode して SHA-256 を返す

use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::broadcast;
use tokio::time::{sleep, Duration};

use super::protocol::{
    event, method, AssistantMessageDeltaParams, ChatParams, ChatResult, CodexNotification,
    CodexRequest, CodexResponse, DoneParams, ImagePasteParams, ImagePasteResult, LoginResult,
    StatusResult,
};
use super::{CodexSidecar, NOTIFICATION_CHANNEL_CAPACITY};

/// Mock 用モデル名 / プラン名。
pub const MOCK_MODEL: &str = "gpt-mock-5.5";
pub const MOCK_PLAN: &str = "mock-pro-5x";
pub const MOCK_USER: &str = "mock-user";

/// 1 chat ターンで流すトークン数。
pub const MOCK_CHAT_TOKEN_COUNT: usize = 10;

/// トークン間 delay。
pub const MOCK_CHAT_TOKEN_DELAY_MS: u64 = 50;

/// Mock 用 message_id 連番カウンタ用 prefix。
const MESSAGE_ID_PREFIX: &str = "mock-msg-";

#[derive(Clone)]
pub struct MockCodexSidecar {
    project_id: String,
    notifications: broadcast::Sender<CodexNotification>,
    started: Arc<AtomicBool>,
    msg_seq: Arc<AtomicU64>,
}

impl MockCodexSidecar {
    pub fn new(project_id: String) -> Self {
        let (tx, _) = broadcast::channel(NOTIFICATION_CHANNEL_CAPACITY);
        Self {
            project_id,
            notifications: tx,
            started: Arc::new(AtomicBool::new(false)),
            msg_seq: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    fn next_message_id(&self) -> String {
        let n = self.msg_seq.fetch_add(1, Ordering::SeqCst);
        format!("{MESSAGE_ID_PREFIX}{n}")
    }

    /// `codex/chat` ハンドラ。
    /// streaming で N トークン分の delta を notification として流し、最後に response を返す。
    async fn handle_chat(&self, id: String, params: ChatParams) -> CodexResponse {
        let message_id = self.next_message_id();
        let mut full_text = String::new();

        for i in 0..MOCK_CHAT_TOKEN_COUNT {
            let token = format!("tok-{i} ");
            full_text.push_str(&token);
            let n = CodexNotification::new(
                event::ASSISTANT_MESSAGE_DELTA,
                Some(
                    serde_json::to_value(AssistantMessageDeltaParams {
                        session_id: params.session_id.clone(),
                        message_id: message_id.clone(),
                        delta: token,
                    })
                    .expect("serialize delta"),
                ),
            );
            // broadcast::send は subscriber が居ないと Err になるが、
            // mock 仕様上は無視して進めて良い。
            let _ = self.notifications.send(n);
            sleep(Duration::from_millis(MOCK_CHAT_TOKEN_DELAY_MS)).await;
        }

        // done notification
        let done = CodexNotification::new(
            event::DONE,
            Some(
                serde_json::to_value(DoneParams {
                    session_id: params.session_id.clone(),
                    message_id: message_id.clone(),
                })
                .expect("serialize done"),
            ),
        );
        let _ = self.notifications.send(done);

        CodexResponse::ok(
            id,
            serde_json::to_value(ChatResult {
                message_id,
                full_text,
            })
            .expect("serialize chat result"),
        )
    }

    /// in-process で 1 リクエストを処理する（mock_server からも共有利用）。
    pub async fn dispatch_request(&self, req: CodexRequest) -> CodexResponse {
        let id = req.id.clone();
        match req.method.as_str() {
            method::LOGIN => CodexResponse::ok(
                id,
                serde_json::to_value(LoginResult {
                    ok: true,
                    user: MOCK_USER.into(),
                })
                .expect("serialize login"),
            ),
            method::STATUS => CodexResponse::ok(
                id,
                serde_json::to_value(StatusResult {
                    alive: true,
                    model: MOCK_MODEL.into(),
                    plan: MOCK_PLAN.into(),
                })
                .expect("serialize status"),
            ),
            method::CANCEL => CodexResponse::ok(id, json!({"cancelled": true})),
            method::CHAT => {
                let params: ChatParams = match req.params {
                    Some(p) => match serde_json::from_value(p) {
                        Ok(v) => v,
                        Err(e) => {
                            return CodexResponse::err(
                                id,
                                -32602,
                                format!("invalid chat params: {e}"),
                            );
                        }
                    },
                    None => {
                        return CodexResponse::err(id, -32602, "chat params required");
                    }
                };
                self.handle_chat(id, params).await
            }
            method::IMAGE_PASTE => {
                let params: ImagePasteParams = match req.params {
                    Some(p) => match serde_json::from_value(p) {
                        Ok(v) => v,
                        Err(e) => {
                            return CodexResponse::err(
                                id,
                                -32602,
                                format!("invalid imagePaste params: {e}"),
                            );
                        }
                    },
                    None => {
                        return CodexResponse::err(id, -32602, "imagePaste params required");
                    }
                };
                use base64::Engine as _;
                let bytes = match base64::engine::general_purpose::STANDARD.decode(&params.base64) {
                    Ok(b) => b,
                    Err(e) => {
                        return CodexResponse::err(id, -32602, format!("base64 decode: {e}"));
                    }
                };
                let mut hasher = Sha256::new();
                hasher.update(&bytes);
                let hash = hex_encode(&hasher.finalize());
                CodexResponse::ok(
                    id,
                    serde_json::to_value(ImagePasteResult {
                        sha256: hash,
                        bytes: bytes.len() as u32,
                    })
                    .expect("serialize image paste"),
                )
            }
            other => CodexResponse::err(id, -32601, format!("method not found: {other}")),
        }
    }
}

#[async_trait]
impl CodexSidecar for MockCodexSidecar {
    async fn start(&mut self) -> Result<()> {
        self.started.store(true, Ordering::SeqCst);
        // 起動 ready notification を流しておくと TS 側が同期しやすい
        let _ = self.notifications.send(CodexNotification::new(
            "codex/event/ready",
            Some(json!({"project_id": self.project_id})),
        ));
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
        Ok(())
    }

    fn is_alive(&self) -> bool {
        self.started.load(Ordering::SeqCst)
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// JSON value (param ヘルパー、テスト便利)。
pub fn make_chat_request(id: &str, session_id: &str, content: &str) -> CodexRequest {
    CodexRequest::new(
        id,
        method::CHAT,
        Some(
            serde_json::to_value(ChatParams {
                session_id: session_id.into(),
                content: content.into(),
                images: vec![],
            })
            .expect("serialize chat params"),
        ),
    )
}

#[allow(dead_code)]
fn _unused_json_marker(_v: JsonValue) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mock_login() {
        let mut s = MockCodexSidecar::new("p1".into());
        s.start().await.unwrap();
        let req = CodexRequest::new("req-1", method::LOGIN, None);
        let resp = s.send_request(req).await.unwrap();
        assert!(resp.error.is_none());
        let result: LoginResult = serde_json::from_value(resp.result.unwrap()).unwrap();
        assert!(result.ok);
        assert_eq!(result.user, MOCK_USER);
    }

    #[tokio::test]
    async fn mock_status() {
        let mut s = MockCodexSidecar::new("p1".into());
        s.start().await.unwrap();
        let req = CodexRequest::new("req-1", method::STATUS, None);
        let resp = s.send_request(req).await.unwrap();
        let result: StatusResult = serde_json::from_value(resp.result.unwrap()).unwrap();
        assert!(result.alive);
        assert_eq!(result.model, MOCK_MODEL);
    }

    #[tokio::test]
    async fn mock_chat_streams_then_responds() {
        let mut s = MockCodexSidecar::new("p1".into());
        s.start().await.unwrap();

        // subscribe BEFORE sending so we don't miss notifications
        let mut rx = s.subscribe_events();

        let req = make_chat_request("req-1", "session-A", "hello");
        let send_task = {
            let s = s.clone();
            tokio::spawn(async move { s.send_request(req).await })
        };

        let mut deltas = 0;
        let mut got_done = false;
        while let Ok(n) = rx.recv().await {
            if n.method == event::ASSISTANT_MESSAGE_DELTA {
                deltas += 1;
            } else if n.method == event::DONE {
                got_done = true;
                break;
            }
        }
        assert!(got_done);
        assert_eq!(deltas, MOCK_CHAT_TOKEN_COUNT);

        let resp = send_task.await.unwrap().unwrap();
        let result: ChatResult = serde_json::from_value(resp.result.unwrap()).unwrap();
        assert!(result.full_text.starts_with("tok-0"));
        assert!(result.message_id.starts_with(MESSAGE_ID_PREFIX));
    }

    #[tokio::test]
    async fn mock_unknown_method_returns_error() {
        let mut s = MockCodexSidecar::new("p1".into());
        s.start().await.unwrap();
        let req = CodexRequest::new("req-x", "no/such/method", None);
        let resp = s.send_request(req).await.unwrap();
        assert!(resp.error.is_some());
        assert_eq!(resp.error.unwrap().code, -32601);
    }

    #[tokio::test]
    async fn mock_image_paste_hash_is_deterministic() {
        let mut s = MockCodexSidecar::new("p1".into());
        s.start().await.unwrap();
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"hello-asagi");
        let req = CodexRequest::new(
            "req-1",
            method::IMAGE_PASTE,
            Some(json!({"base64": b64})),
        );
        let resp = s.send_request(req).await.unwrap();
        let result: ImagePasteResult = serde_json::from_value(resp.result.unwrap()).unwrap();
        // SHA-256("hello-asagi") を事前計算
        let mut h = Sha256::new();
        h.update(b"hello-asagi");
        let expected = hex_encode(&h.finalize());
        assert_eq!(result.sha256, expected);
        assert_eq!(result.bytes, b"hello-asagi".len() as u32);
    }
}
