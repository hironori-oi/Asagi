//! JSON-RPC 2.0 メッセージ型 (AS-131)。
//!
//! Codex `app-server` (DEC-018-009) との line-delimited JSON-RPC 2.0 通信に
//! 用いる serde 型定義。Phase 0 POC で確定した実 schema は Real impl 側で
//! ハードコードする方針だが、ここでは「Asagi が想定する最小集合」を
//! 安定 IF として固定する。
//!
//! メソッド最小集合:
//!   - `codex/login`        : サブスク OAuth 起動
//!   - `codex/chat`         : 1 ターン送信（streaming notification 付き）
//!   - `codex/cancel`       : 進行中 turn の中断
//!   - `codex/status`       : sidecar 自体の生存 / モデル / プラン情報
//!   - `codex/imagePaste`   : base64 画像受領 → ハッシュ返却（POC#4 雛形）
//!
//! Notification:
//!   - `codex/event/assistant_message_delta` : ストリーミングトークン
//!   - `codex/event/done`                    : ターン完了
//!   - `codex/event/error`                   : 進行中エラー

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

/// JSON-RPC 2.0 リクエスト ID。
/// 仕様上は string | number | null だが Asagi 内では文字列に正規化する。
pub type RequestId = String;

/// JSON-RPC 2.0 protocol version 文字列定数。
pub const JSONRPC_VERSION: &str = "2.0";

// ---------------------------------------------------------------
// Request / Response
// ---------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexRequest {
    pub jsonrpc: String,
    pub id: RequestId,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<JsonValue>,
}

impl CodexRequest {
    pub fn new(id: impl Into<String>, method: impl Into<String>, params: Option<JsonValue>) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_string(),
            id: id.into(),
            method: method.into(),
            params,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexResponse {
    pub jsonrpc: String,
    pub id: RequestId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<CodexError>,
}

impl CodexResponse {
    pub fn ok(id: impl Into<String>, result: JsonValue) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_string(),
            id: id.into(),
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: impl Into<String>, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_string(),
            id: id.into(),
            result: None,
            error: Some(CodexError {
                code,
                message: message.into(),
                data: None,
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexError {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<JsonValue>,
}

// ---------------------------------------------------------------
// Notification (server -> client, no id)
// ---------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<JsonValue>,
}

impl CodexNotification {
    pub fn new(method: impl Into<String>, params: Option<JsonValue>) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_string(),
            method: method.into(),
            params,
        }
    }
}

// ---------------------------------------------------------------
// Method 定数
// ---------------------------------------------------------------

pub mod method {
    pub const LOGIN: &str = "codex/login";
    pub const CHAT: &str = "codex/chat";
    pub const CANCEL: &str = "codex/cancel";
    pub const STATUS: &str = "codex/status";
    pub const IMAGE_PASTE: &str = "codex/imagePaste";
}

pub mod event {
    pub const ASSISTANT_MESSAGE_DELTA: &str = "codex/event/assistant_message_delta";
    pub const DONE: &str = "codex/event/done";
    pub const ERROR: &str = "codex/event/error";
}

// ---------------------------------------------------------------
// 高レベル params / result 型（mock / TS 共有のため）
// ---------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatParams {
    pub session_id: String,
    pub content: String,
    #[serde(default)]
    pub images: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResult {
    pub message_id: String,
    pub full_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantMessageDeltaParams {
    pub session_id: String,
    pub message_id: String,
    pub delta: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoneParams {
    pub session_id: String,
    pub message_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusResult {
    pub alive: bool,
    pub model: String,
    pub plan: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginResult {
    pub ok: bool,
    pub user: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImagePasteParams {
    pub base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImagePasteResult {
    pub sha256: String,
    pub bytes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CancelParams {
    pub session_id: String,
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn roundtrip_request() {
        let req = CodexRequest::new(
            "req-1",
            method::CHAT,
            Some(json!({"session_id": "s1", "content": "hi"})),
        );
        let s = serde_json::to_string(&req).unwrap();
        let back: CodexRequest = serde_json::from_str(&s).unwrap();
        assert_eq!(back.method, "codex/chat");
        assert_eq!(back.id, "req-1");
        assert_eq!(back.jsonrpc, "2.0");
    }

    #[test]
    fn roundtrip_response_ok() {
        let resp = CodexResponse::ok("req-1", json!({"alive": true}));
        let s = serde_json::to_string(&resp).unwrap();
        let back: CodexResponse = serde_json::from_str(&s).unwrap();
        assert!(back.result.is_some());
        assert!(back.error.is_none());
    }

    #[test]
    fn roundtrip_response_err() {
        let resp = CodexResponse::err("req-1", -32601, "method not found");
        let s = serde_json::to_string(&resp).unwrap();
        let back: CodexResponse = serde_json::from_str(&s).unwrap();
        assert!(back.result.is_none());
        assert_eq!(back.error.unwrap().code, -32601);
    }

    #[test]
    fn roundtrip_notification() {
        let n = CodexNotification::new(
            event::ASSISTANT_MESSAGE_DELTA,
            Some(json!({"session_id": "s1", "message_id": "m1", "delta": "tok"})),
        );
        let s = serde_json::to_string(&n).unwrap();
        let back: CodexNotification = serde_json::from_str(&s).unwrap();
        assert_eq!(back.method, event::ASSISTANT_MESSAGE_DELTA);
    }
}
