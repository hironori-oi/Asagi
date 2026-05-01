//! stdio JSON-RPC 2.0 mock app-server (AS-132 / DEC-018-023)。
//!
//! `cargo run --bin mock-codex-app-server` で単体起動可能。
//! 標準入力から line-delimited JSON-RPC を読み、標準出力に line-delimited
//! JSON-RPC を返す。Real Codex `codex app-server --listen stdio` と同じ
//! ハンドシェイク仕様を再現する「契約サーバ」。
//!
//! # ハンドシェイク (LSP-style, P-3)
//!
//!   1. 起動直後は **ready notification を流さない** (Real に存在しない挙動)
//!   2. クライアントから `initialize` request 受信 → `InitializeResult` 返却
//!   3. クライアントから `initialized` notification 受信 → handshake 完了
//!   4. これ以降に他 method を accept する。未 initialize で他 method を受けたら -32002
//!   5. 二度目の `initialize` には -32603 "Already initialized"
//!
//! # 応答内容
//!
//! `mock::MockCodexSidecar::dispatch_request` を共有利用。
//! ただし `turn/start` は in-process broadcast ではなく stdout に直接
//! line-delimited JSON で書き出す必要があるため、本ファイル内で再実装する。

use anyhow::Result;
use serde_json::{json, Value as JsonValue};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::{sleep, Duration};

use super::mock::{
    mock_response_tokens, MockCodexSidecar, MOCK_CHAT_TOKEN_DELAY_MS, MOCK_RESPONSE_TEMPLATE,
};
use super::protocol::{event, method, CodexNotification, CodexRequest, CodexResponse};

/// stdio mock server 起動。
///
/// 1 行 1 message の line-delimited JSON。
pub async fn run_stdio_server() -> Result<()> {
    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin).lines();

    // Real 準拠: 起動直後 notification は流さない。
    // ハンドシェイクは client 起点で行う。

    let sidecar = MockCodexSidecar::new("stdio-mock-server".into());
    let mut turn_seq: u64 = 0;
    let mut item_seq: u64 = 0;

    while let Some(line) = reader.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // notification (id 無し) も同じ JSON 形状なので、まず Value で受けて分岐
        let raw: JsonValue = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                let err = CodexResponse::err(
                    "<parse-error>",
                    -32700,
                    format!("parse error: {e}"),
                );
                write_message(&mut stdout, &serde_json::to_value(err)?).await?;
                continue;
            }
        };

        // notification: id field が無い
        if raw.get("id").is_none() {
            let m = raw.get("method").and_then(|v| v.as_str()).unwrap_or("");
            if m == method::INITIALIZED {
                sidecar.mark_initialized();
            }
            // 他の notification は無視 (LSP 風: client → server notification を
            // mock app-server は subscribe しない)
            continue;
        }

        // request
        let req: CodexRequest = match serde_json::from_value(raw) {
            Ok(r) => r,
            Err(e) => {
                let err = CodexResponse::err(
                    "<parse-error>",
                    -32600,
                    format!("invalid request: {e}"),
                );
                write_message(&mut stdout, &serde_json::to_value(err)?).await?;
                continue;
            }
        };

        let id = req.id.clone();

        // turn/start のみ stdout streaming のため特別扱い、
        // それ以外は MockCodexSidecar に委譲
        if req.method == method::TURN_START && sidecar.is_initialized() {
            // 即 inProgress 返却 → 別タスクで delta + completed
            turn_seq += 1;
            item_seq += 1;
            let turn_id = format!("mock-turn-{turn_seq}");
            let item_id = format!("mock-item-{item_seq}");
            let thread_id = req
                .params
                .as_ref()
                .and_then(|p| p.get("threadId"))
                .and_then(|v| v.as_str())
                .unwrap_or("mock-thread-stdio")
                .to_string();

            let resp = CodexResponse::ok(
                id,
                json!({
                    "turn": {
                        "id": turn_id,
                        "status": "inProgress",
                        "items": [],
                        "error": null,
                    }
                }),
            );
            write_message(&mut stdout, &serde_json::to_value(resp)?).await?;

            // turn/started notification
            write_message(
                &mut stdout,
                &serde_json::to_value(CodexNotification::new(
                    event::TURN_STARTED,
                    Some(json!({
                        "turn": {
                            "id": turn_id,
                            "status": "inProgress",
                            "items": [],
                            "error": null,
                        },
                        "threadId": thread_id,
                    })),
                ))?,
            )
            .await?;
            // item/started
            write_message(
                &mut stdout,
                &serde_json::to_value(CodexNotification::new(
                    event::ITEM_STARTED,
                    Some(json!({
                        "item": {"type": "agentMessage", "id": item_id},
                        "threadId": thread_id,
                        "turnId": turn_id,
                    })),
                ))?,
            )
            .await?;
            // 10 token delta
            for tok in mock_response_tokens() {
                let n = CodexNotification::new(
                    event::ITEM_AGENT_MESSAGE_DELTA,
                    Some(json!({
                        "itemId": item_id,
                        "delta": tok,
                    })),
                );
                write_message(&mut stdout, &serde_json::to_value(n)?).await?;
                sleep(Duration::from_millis(MOCK_CHAT_TOKEN_DELAY_MS)).await;
            }
            // item/completed
            write_message(
                &mut stdout,
                &serde_json::to_value(CodexNotification::new(
                    event::ITEM_COMPLETED,
                    Some(json!({
                        "item": {
                            "type": "agentMessage",
                            "id": item_id,
                            "text": MOCK_RESPONSE_TEMPLATE,
                            "phase": "final_answer",
                        },
                        "threadId": thread_id,
                        "turnId": turn_id,
                    })),
                ))?,
            )
            .await?;
            // turn/completed
            write_message(
                &mut stdout,
                &serde_json::to_value(CodexNotification::new(
                    event::TURN_COMPLETED,
                    Some(json!({
                        "turn": {
                            "id": turn_id,
                            "status": "completed",
                            "items": [],
                            "error": null,
                        }
                    })),
                ))?,
            )
            .await?;
            continue;
        }

        // 他は MockCodexSidecar に委譲
        let resp = sidecar.dispatch_request(req).await;
        write_message(&mut stdout, &serde_json::to_value(resp)?).await?;
    }
    Ok(())
}

async fn write_message(stdout: &mut tokio::io::Stdout, v: &JsonValue) -> Result<()> {
    let mut buf = serde_json::to_vec(v)?;
    buf.push(b'\n');
    stdout.write_all(&buf).await?;
    stdout.flush().await?;
    Ok(())
}
