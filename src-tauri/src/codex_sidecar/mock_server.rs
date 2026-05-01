//! stdio JSON-RPC 2.0 mock app-server (AS-132)。
//!
//! `cargo run --bin mock-codex-app-server` で単体起動可能。
//! 標準入力から line-delimited JSON-RPC を読み、標準出力に line-delimited
//! JSON-RPC を返す。Real impl 完成後に Codex 実 CLI を差し替え可能か
//! 検証するための「契約サーバ」として機能する。
//!
//! ハンドラ実装は `mock::MockCodexSidecar::dispatch_request` を共有する。
//! 唯一の違いは:
//!   - in-process では broadcast::Sender 経由で notification を流すが
//!   - stdio では stdout に直接 line-delimited JSON で書き出す
//!
//! そのため chat の delta 配信は本ファイル内で再実装する。

use anyhow::Result;
use serde_json::{json, Value as JsonValue};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::{sleep, Duration};

use super::mock::{
    MOCK_CHAT_TOKEN_COUNT, MOCK_CHAT_TOKEN_DELAY_MS, MOCK_MODEL, MOCK_PLAN, MOCK_USER,
};
use super::protocol::{event, method, CodexNotification, CodexRequest, CodexResponse};

/// stdio mock server 起動。
///
/// `tokio::main` から直接呼び出す想定。1 行 1 message の line-delimited JSON。
pub async fn run_stdio_server() -> Result<()> {
    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin).lines();

    // 起動 ready notification を最初に流す
    write_message(
        &mut stdout,
        &serde_json::to_value(CodexNotification::new(
            "codex/event/ready",
            Some(json!({"server": "mock-codex-app-server"})),
        ))?,
    )
    .await?;

    let mut msg_seq: u64 = 0;

    while let Some(line) = reader.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let req: CodexRequest = match serde_json::from_str(line) {
            Ok(r) => r,
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

        let id = req.id.clone();

        match req.method.as_str() {
            method::LOGIN => {
                let resp = CodexResponse::ok(
                    id,
                    json!({"ok": true, "user": MOCK_USER}),
                );
                write_message(&mut stdout, &serde_json::to_value(resp)?).await?;
            }
            method::STATUS => {
                let resp = CodexResponse::ok(
                    id,
                    json!({"alive": true, "model": MOCK_MODEL, "plan": MOCK_PLAN}),
                );
                write_message(&mut stdout, &serde_json::to_value(resp)?).await?;
            }
            method::CANCEL => {
                let resp = CodexResponse::ok(id, json!({"cancelled": true}));
                write_message(&mut stdout, &serde_json::to_value(resp)?).await?;
            }
            method::CHAT => {
                msg_seq += 1;
                let message_id = format!("mock-msg-{msg_seq}");
                let session_id = req
                    .params
                    .as_ref()
                    .and_then(|p| p.get("session_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("default")
                    .to_string();

                let mut full = String::new();
                for i in 0..MOCK_CHAT_TOKEN_COUNT {
                    let token = format!("tok-{i} ");
                    full.push_str(&token);
                    let n = CodexNotification::new(
                        event::ASSISTANT_MESSAGE_DELTA,
                        Some(json!({
                            "session_id": session_id,
                            "message_id": message_id,
                            "delta": token,
                        })),
                    );
                    write_message(&mut stdout, &serde_json::to_value(n)?).await?;
                    sleep(Duration::from_millis(MOCK_CHAT_TOKEN_DELAY_MS)).await;
                }
                let done = CodexNotification::new(
                    event::DONE,
                    Some(json!({
                        "session_id": session_id,
                        "message_id": message_id,
                    })),
                );
                write_message(&mut stdout, &serde_json::to_value(done)?).await?;

                let resp = CodexResponse::ok(
                    id,
                    json!({
                        "message_id": message_id,
                        "full_text": full,
                    }),
                );
                write_message(&mut stdout, &serde_json::to_value(resp)?).await?;
            }
            method::IMAGE_PASTE => {
                let b64 = req
                    .params
                    .as_ref()
                    .and_then(|p| p.get("base64"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                use base64::Engine as _;
                match base64::engine::general_purpose::STANDARD.decode(b64) {
                    Ok(bytes) => {
                        let mut h = Sha256::new();
                        h.update(&bytes);
                        let mut hex = String::with_capacity(64);
                        for b in h.finalize() {
                            hex.push_str(&format!("{:02x}", b));
                        }
                        let resp = CodexResponse::ok(
                            id,
                            json!({"sha256": hex, "bytes": bytes.len() as u32}),
                        );
                        write_message(&mut stdout, &serde_json::to_value(resp)?).await?;
                    }
                    Err(e) => {
                        let resp =
                            CodexResponse::err(id, -32602, format!("base64 decode: {e}"));
                        write_message(&mut stdout, &serde_json::to_value(resp)?).await?;
                    }
                }
            }
            other => {
                let resp = CodexResponse::err(id, -32601, format!("method not found: {other}"));
                write_message(&mut stdout, &serde_json::to_value(resp)?).await?;
            }
        }
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
