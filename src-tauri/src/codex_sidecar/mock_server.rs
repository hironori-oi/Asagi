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
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};

use super::mock::{
    mock_response_tokens, MockCodexSidecar, MOCK_CHAT_TOKEN_DELAY_MS, MOCK_RESPONSE_TEMPLATE,
};
use super::protocol::{event, method, CodexNotification, CodexRequest, CodexResponse};

/// 出力 channel の payload は 1 行分の JSON message。
type OutMsg = JsonValue;

/// stdio mock server 起動。
///
/// 1 行 1 message の line-delimited JSON。
///
/// DEC-018-026 ① C: turn/start を別 task で streaming するため、
/// 出力は mpsc channel で集約する単一 writer task に統合。
/// 入力 loop は read 専念。これにより turn/interrupt を turn/start streaming と
/// 並行に受信できる。
pub async fn run_stdio_server() -> Result<()> {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin).lines();

    // 単一 writer task
    let (out_tx, mut out_rx) = mpsc::channel::<OutMsg>(64);
    let writer_task = tokio::spawn(async move {
        let mut stdout = stdout;
        while let Some(v) = out_rx.recv().await {
            if let Err(e) = write_message(&mut stdout, &v).await {
                eprintln!("[mock_server] write_message error: {e}");
                break;
            }
        }
    });

    // Real 準拠: 起動直後 notification は流さない。

    let sidecar = MockCodexSidecar::new("stdio-mock-server".into());
    let mut turn_seq: u64 = 0;
    let mut item_seq: u64 = 0;

    // DEC-018-026 ① C: stdio mock の running turn 状態。
    // turn/interrupt 受信で flag を立てる → turn/start spawn 内 loop が break。
    let running_turns: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    while let Some(line) = reader.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // notification (id 無し) も同じ JSON 形状なので、まず Value で受けて分岐
        let raw: JsonValue = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                let err = CodexResponse::err("<parse-error>", -32700, format!("parse error: {e}"));
                let _ = out_tx.send(serde_json::to_value(err)?).await;
                continue;
            }
        };

        // notification: id field が無い
        if raw.get("id").is_none() {
            let m = raw.get("method").and_then(|v| v.as_str()).unwrap_or("");
            if m == method::INITIALIZED {
                sidecar.mark_initialized();
            }
            // 他の notification は無視
            continue;
        }

        // request
        let req: CodexRequest = match serde_json::from_value(raw) {
            Ok(r) => r,
            Err(e) => {
                let err =
                    CodexResponse::err("<parse-error>", -32600, format!("invalid request: {e}"));
                let _ = out_tx.send(serde_json::to_value(err)?).await;
                continue;
            }
        };

        let id = req.id.clone();

        // turn/interrupt: running turn の cancel flag を立てる
        if req.method == method::TURN_INTERRUPT {
            let turn_id_opt = req
                .params
                .as_ref()
                .and_then(|p| p.get("turnId"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if let Ok(map) = running_turns.lock() {
                match turn_id_opt {
                    Some(tid) if !tid.is_empty() => {
                        if let Some(flag) = map.get(&tid) {
                            flag.store(true, Ordering::SeqCst);
                        }
                    }
                    _ => {
                        for flag in map.values() {
                            flag.store(true, Ordering::SeqCst);
                        }
                    }
                }
            }
            let resp = CodexResponse::ok(id, json!({}));
            let _ = out_tx.send(serde_json::to_value(resp)?).await;
            continue;
        }

        // turn/start: 別 task で streaming + cancel 監視
        if req.method == method::TURN_START && sidecar.is_initialized() {
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
            let _ = out_tx.send(serde_json::to_value(resp)?).await;

            let cancel_flag = Arc::new(AtomicBool::new(false));
            if let Ok(mut map) = running_turns.lock() {
                map.insert(turn_id.clone(), cancel_flag.clone());
            }
            let out_tx_task = out_tx.clone();
            let running_turns_task = running_turns.clone();
            let turn_id_for_task = turn_id.clone();
            let item_id_for_task = item_id.clone();
            let thread_id_for_task = thread_id.clone();
            tokio::spawn(async move {
                let _ = out_tx_task
                    .send(
                        serde_json::to_value(CodexNotification::new(
                            event::TURN_STARTED,
                            Some(json!({
                                "turn": {
                                    "id": turn_id_for_task,
                                    "status": "inProgress",
                                    "items": [],
                                    "error": null,
                                },
                                "threadId": thread_id_for_task,
                            })),
                        ))
                        .unwrap_or(JsonValue::Null),
                    )
                    .await;
                let _ = out_tx_task
                    .send(
                        serde_json::to_value(CodexNotification::new(
                            event::ITEM_STARTED,
                            Some(json!({
                                "item": {"type": "agentMessage", "id": item_id_for_task},
                                "threadId": thread_id_for_task,
                                "turnId": turn_id_for_task,
                            })),
                        ))
                        .unwrap_or(JsonValue::Null),
                    )
                    .await;
                let mut interrupted = false;
                for tok in mock_response_tokens() {
                    if cancel_flag.load(Ordering::SeqCst) {
                        interrupted = true;
                        break;
                    }
                    let n = CodexNotification::new(
                        event::ITEM_AGENT_MESSAGE_DELTA,
                        Some(json!({
                            "itemId": item_id_for_task,
                            "delta": tok,
                        })),
                    );
                    let _ = out_tx_task
                        .send(serde_json::to_value(n).unwrap_or(JsonValue::Null))
                        .await;
                    sleep(Duration::from_millis(MOCK_CHAT_TOKEN_DELAY_MS)).await;
                }
                let _ = out_tx_task
                    .send(
                        serde_json::to_value(CodexNotification::new(
                            event::ITEM_COMPLETED,
                            Some(json!({
                                "item": {
                                    "type": "agentMessage",
                                    "id": item_id_for_task,
                                    "text": MOCK_RESPONSE_TEMPLATE,
                                    "phase": if interrupted { "interrupted" } else { "final_answer" },
                                },
                                "threadId": thread_id_for_task,
                                "turnId": turn_id_for_task,
                            })),
                        ))
                        .unwrap_or(JsonValue::Null),
                    )
                    .await;
                let final_status = if interrupted {
                    "interrupted"
                } else {
                    "completed"
                };
                let _ = out_tx_task
                    .send(
                        serde_json::to_value(CodexNotification::new(
                            event::TURN_COMPLETED,
                            Some(json!({
                                "turn": {
                                    "id": turn_id_for_task,
                                    "status": final_status,
                                    "items": [],
                                    "error": null,
                                }
                            })),
                        ))
                        .unwrap_or(JsonValue::Null),
                    )
                    .await;
                if let Ok(mut map) = running_turns_task.lock() {
                    map.remove(&turn_id_for_task);
                }
            });
            continue;
        }

        // 他は MockCodexSidecar に委譲
        let resp = sidecar.dispatch_request(req).await;
        let _ = out_tx.send(serde_json::to_value(resp)?).await;
    }

    drop(out_tx);
    let _ = writer_task.await;
    Ok(())
}

async fn write_message(stdout: &mut tokio::io::Stdout, v: &JsonValue) -> Result<()> {
    let mut buf = serde_json::to_vec(v)?;
    buf.push(b'\n');
    stdout.write_all(&buf).await?;
    stdout.flush().await?;
    Ok(())
}
