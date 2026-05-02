//! JSON-RPC 2.0 メッセージ型 (AS-131 / DEC-018-023)。
//!
//! Codex `app-server` (DEC-018-009) との line-delimited JSON-RPC 2.0 通信に
//! 用いる serde 型定義。
//!
//! **DEC-018-023 適用**: Real Codex app-server (LSP-style protocol) に完全準拠した
//! method 名 / event 名 / 高レベル型を定義する。mock 実装は内部応答のみ
//! 決定論的スタブとし、API surface は Real と同一に保つ（リサーチ v2 § 4 P-1〜P-2）。
//!
//! # 必須ハンドシェイク (LSP-style)
//!
//!   1. Client → Server: `initialize` request
//!      params: `{ clientInfo: { name, title, version },
//!                 capabilities: { experimentalApi, optOutNotificationMethods } }`
//!   2. Server → Client: result `{ userAgent, codexHome, platformFamily, platformOs }`
//!   3. Client → Server: `initialized` notification (id 無し)
//!   4. これ以降に thread/start, turn/start, account/read 等を呼び出し可能
//!
//! # method 最小集合 (Asagi v0.1.0 〜 v1.0.0)
//!
//!   - Handshake : `initialize`, `initialized`
//!   - Account   : `account/read`, `account/login/start`, `account/login/cancel`,
//!                 `account/logout`, `account/rateLimits/read`
//!   - Thread    : `thread/start`, `thread/resume`, `thread/list`, `thread/read`
//!   - Turn      : `turn/start`, `turn/steer`, `turn/interrupt`
//!   - Model     : `model/list`
//!
//! # Notification 最小集合
//!
//!   - thread/started, thread/status/changed
//!   - turn/started, turn/completed
//!   - item/started, item/completed
//!   - item/agentMessage/delta              (assistant streaming の正解)
//!   - item/reasoning/textDelta             (thinking token streaming)
//!   - item/commandExecution/requestApproval, item/fileChange/requestApproval
//!   - account/updated, account/rateLimits/updated

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;

/// JSON-RPC 2.0 リクエスト ID。
/// 仕様上は string | number | null だが Asagi 内では文字列に正規化する。
pub type RequestId = String;

/// JSON-RPC 2.0 protocol version 文字列定数。
pub const JSONRPC_VERSION: &str = "2.0";

// ---------------------------------------------------------------
// Request / Response / Notification 基本型
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
// Method 定数 (Real Codex app-server 準拠 / DEC-018-023 / リサーチ v2 § 4 P-1)
// ---------------------------------------------------------------

pub mod method {
    // Handshake (LSP-style)
    pub const INITIALIZE: &str = "initialize";
    /// notification (id 無しで送信)
    pub const INITIALIZED: &str = "initialized";

    // Account / Auth
    pub const ACCOUNT_READ: &str = "account/read";
    pub const ACCOUNT_LOGIN_START: &str = "account/login/start";
    pub const ACCOUNT_LOGIN_CANCEL: &str = "account/login/cancel";
    pub const ACCOUNT_LOGOUT: &str = "account/logout";
    pub const ACCOUNT_RATE_LIMITS_READ: &str = "account/rateLimits/read";

    // Thread
    pub const THREAD_START: &str = "thread/start";
    pub const THREAD_RESUME: &str = "thread/resume";
    pub const THREAD_LIST: &str = "thread/list";
    pub const THREAD_READ: &str = "thread/read";

    // Turn
    pub const TURN_START: &str = "turn/start";
    pub const TURN_STEER: &str = "turn/steer";
    pub const TURN_INTERRUPT: &str = "turn/interrupt";

    // Model
    pub const MODEL_LIST: &str = "model/list";
}

// ---------------------------------------------------------------
// Notification 定数 (Real 準拠 / DEC-018-023 / リサーチ v2 § 4 P-1)
// ---------------------------------------------------------------

pub mod event {
    // Thread lifecycle
    pub const THREAD_STARTED: &str = "thread/started";
    pub const THREAD_STATUS_CHANGED: &str = "thread/status/changed";

    // Turn lifecycle
    pub const TURN_STARTED: &str = "turn/started";
    pub const TURN_COMPLETED: &str = "turn/completed";

    // Item streaming
    pub const ITEM_STARTED: &str = "item/started";
    pub const ITEM_COMPLETED: &str = "item/completed";
    pub const ITEM_AGENT_MESSAGE_DELTA: &str = "item/agentMessage/delta";
    pub const ITEM_REASONING_TEXT_DELTA: &str = "item/reasoning/textDelta";

    // Approvals
    pub const ITEM_COMMAND_EXEC_REQUEST_APPROVAL: &str =
        "item/commandExecution/requestApproval";
    pub const ITEM_FILE_CHANGE_REQUEST_APPROVAL: &str =
        "item/fileChange/requestApproval";

    // Account
    pub const ACCOUNT_UPDATED: &str = "account/updated";
    pub const ACCOUNT_RATE_LIMITS_UPDATED: &str = "account/rateLimits/updated";
}

// ---------------------------------------------------------------
// 高レベル param / result 型 (DEC-018-023 / リサーチ v2 § 4 P-2)
// ---------------------------------------------------------------

// --- Initialize handshake ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitializeParams {
    #[serde(rename = "clientInfo")]
    pub client_info: ClientInfo,
    pub capabilities: ClientCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientInfo {
    pub name: String,
    pub title: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ClientCapabilities {
    #[serde(rename = "experimentalApi", default)]
    pub experimental_api: bool,
    #[serde(rename = "optOutNotificationMethods", default)]
    pub opt_out_notification_methods: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitializeResult {
    #[serde(rename = "userAgent")]
    pub user_agent: String,
    #[serde(rename = "codexHome")]
    pub codex_home: String,
    #[serde(rename = "platformFamily")]
    pub platform_family: String,
    #[serde(rename = "platformOs")]
    pub platform_os: String,
}

// --- Thread ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadStartParams {
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(rename = "approvalPolicy", skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<JsonValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadStartResult {
    pub thread: ThreadInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadInfo {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(default)]
    pub ephemeral: bool,
    #[serde(rename = "modelProvider", default)]
    pub model_provider: String,
    #[serde(rename = "createdAt", default)]
    pub created_at: String,
}

// --- Turn ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InputItem {
    Text { text: String },
    Image { url: String },
    LocalImage { path: String },
    Skill { name: String, path: String },
    Mention { name: String, path: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnStartParams {
    /// Real schema 準拠: thread/start で取得した id を必須で渡す。
    #[serde(rename = "threadId")]
    pub thread_id: String,
    pub input: Vec<InputItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnStartResult {
    pub turn: TurnInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnInfo {
    pub id: String,
    /// "inProgress" | "completed" | "interrupted"
    pub status: String,
    #[serde(default)]
    pub items: Vec<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnInterruptParams {
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "turnId", default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

// --- Notifications: streaming ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemAgentMessageDeltaParams {
    #[serde(rename = "itemId")]
    pub item_id: String,
    pub delta: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnCompletedParams {
    pub turn: TurnInfo,
}

// --- Account ---

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AccountReadParams {
    #[serde(rename = "refreshToken", default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountReadResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<AccountInfo>,
    #[serde(rename = "requiresOpenaiAuth", default)]
    pub requires_openai_auth: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountInfo {
    /// "apikey" | "chatgpt" | "chatgptAuthTokens"
    #[serde(rename = "type")]
    pub account_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(rename = "planType", default, skip_serializing_if = "Option::is_none")]
    pub plan_type: Option<String>,
    /// DEC-018-028 QW1 / DEC-018-029 (F2 Rate Limit Dashboard 先行定義)。
    /// `account/rateLimits/read.rateLimitsByLimitId` の型を Account 側にも露出して
    /// `account/read` レスポンスでの限定的な情報共有も許容する (Real CLI 仕様の
    /// 互換最大化、リサーチ § 1.1 + § 4.2)。
    #[serde(rename = "rateLimitsByLimitId", default, skip_serializing_if = "Option::is_none")]
    pub rate_limits_by_limit_id: Option<HashMap<String, RateLimitBucket>>,
}

/// DEC-018-028 QW1 / DEC-018-029: F2 Rate Limit Dashboard 用 bucket 型を
/// QW1 段階で先行定義する。理由:
///   - リサーチ「主要発見 #2」で確定した「2 bucket (5h_messages + weekly_messages)
///     を同時カウント」仕様を**型レベルで一度だけ表現**しておくことで、F2 着手時
///     (AS-201) の実装が「`rateLimitsByLimitId` を読んで UI に流し込む」だけで
///     済む状態にする (Quick Win 設計の連鎖効果)。
///   - `account/read` と `account/rateLimits/read` の双方が同型を返却し得るため、
///     共通型を別箇所に切り出す (重複定義回避)。
///
/// 想定 schema (リサーチ v2 § 1.1 + DEC-018-029):
/// ```json
/// {
///   "5h_messages":     { "used": 12, "limit": 80,   "resets_at": 1727040000 },
///   "weekly_messages": { "used": 4,  "limit": 1500, "resets_at": 1727308800 }
/// }
/// ```
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RateLimitBucket {
    pub used: u64,
    pub limit: u64,
    /// Unix epoch seconds (リサーチ § 1.1 確定: resetsAt は seconds-precision)。
    #[serde(rename = "resets_at", alias = "resetsAt")]
    pub resets_at: i64,
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
            method::TURN_START,
            Some(json!({"threadId": "t1", "input": [{"type": "text", "text": "hi"}]})),
        );
        let s = serde_json::to_string(&req).unwrap();
        let back: CodexRequest = serde_json::from_str(&s).unwrap();
        assert_eq!(back.method, "turn/start");
        assert_eq!(back.id, "req-1");
        assert_eq!(back.jsonrpc, "2.0");
    }

    #[test]
    fn roundtrip_response_ok() {
        let resp = CodexResponse::ok("req-1", json!({"thread": {"id": "t1"}}));
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
            event::ITEM_AGENT_MESSAGE_DELTA,
            Some(json!({"itemId": "i1", "delta": "tok"})),
        );
        let s = serde_json::to_string(&n).unwrap();
        let back: CodexNotification = serde_json::from_str(&s).unwrap();
        assert_eq!(back.method, event::ITEM_AGENT_MESSAGE_DELTA);
    }

    #[test]
    fn input_item_text_serializes_with_type_tag() {
        let it = InputItem::Text { text: "hello".into() };
        let v = serde_json::to_value(it).unwrap();
        assert_eq!(v["type"], "text");
        assert_eq!(v["text"], "hello");
    }

    #[test]
    fn input_item_local_image_serializes_camel_case() {
        let it = InputItem::LocalImage { path: "C:/img.png".into() };
        let v = serde_json::to_value(it).unwrap();
        assert_eq!(v["type"], "localImage");
        assert_eq!(v["path"], "C:/img.png");
    }

    #[test]
    fn initialize_params_roundtrip() {
        let p = InitializeParams {
            client_info: ClientInfo {
                name: "asagi".into(),
                title: "Asagi".into(),
                version: "0.0.1".into(),
            },
            capabilities: ClientCapabilities::default(),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["clientInfo"]["name"], "asagi");
        assert_eq!(v["capabilities"]["experimentalApi"], false);
        let back: InitializeParams = serde_json::from_value(v).unwrap();
        assert_eq!(back.client_info.title, "Asagi");
    }
}
