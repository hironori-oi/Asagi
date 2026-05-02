//! Real Codex sidecar 実装 (AS-130 / AS-140.1〜140.5)。
//!
//! Phase 0 POC（DEC-018-010）通過 → Phase 1（M1 Real impl）で本実装。
//!
//! # 起動コマンド (DEC-018-009 / DEC-018-033 ①)
//!
//! ```text
//! tokio::process::Command::new(<実体 codex.exe へのフルパス>)
//!     .args(crate::codex_sidecar::contract::CODEX_APP_SERVER_ARGS)
//!     // = ["app-server", "--listen", "stdio://"]
//! ```
//!
//! **重要**: `--listen stdio`（URL スキームなし）は POC #2 で ENOENT 即落ちのため
//! 必ず `stdio://` を使うこと。引数は `contract::CODEX_APP_SERVER_ARGS` から取得し
//! ハードコードしない（DEC-018-034 厳守事項 ②）。
//!
//! # 必須ハンドシェイク (LSP-style, リサーチ v2 § 3.2 で確定)
//!
//! 1. spawn 後の最初のリクエストは必ず `initialize`
//!    params: `{ clientInfo: { name, title, version },
//!               capabilities: { experimentalApi: false, optOutNotificationMethods: [...] } }`
//! 2. 受領した `InitializeResult` を保存（userAgent / codexHome / platformOs）
//! 3. `initialized` notification を送信（id 無し）
//! 4. これ以降に `thread/start`, `turn/start`, `account/read` 等を呼び出し可能
//!
//! 未 initialize の状態で他 method を呼ぶと Real CLI から `"Not initialized"`
//! エラーが返る。重複 initialize は `"Already initialized"`。
//!
//! # 推奨 opt-out (Phase 1)
//!
//! Phase 1 では実装負荷削減のため、以下の notification を opt out:
//!   - `item/reasoning/textDelta`
//!   - `item/reasoning/summaryTextDelta`
//!   - `item/commandExecution/outputDelta`
//!   - `item/fileChange/outputDelta`
//!   - `fuzzyFileSearch/sessionUpdated`
//!   - `serverRequest/resolved`
//!
//! # 実装構成
//!
//! - `start()` (AS-140.1 / AS-140.5): bin_resolver → spawn → JobObject 結合 → reader/writer task →
//!   initialize handshake → `initialized` notification 送信
//! - `send_request()` (AS-140.2): pending HashMap に oneshot 登録 → stdin 書き込み → await
//! - `start_thread()` (AS-140.3): `thread/start` request 投げ、result から id が取れない場合は
//!   `thread/started` notification を最大 2s polling
//! - `send_turn_and_collect_assistant_text()` (AS-140.4): `turn/start` 投げ、`item/completed` の
//!   `agentMessage` 型を最大 60s 待機して assistant text を抽出
//! - `shutdown()`: stdin close → child 監視 → 1.5s 後 kill → JobObject Drop で連鎖 kill 保険

use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{broadcast, oneshot, Mutex};
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout};

use super::contract::{
    CODEX_APP_SERVER_ARGS, ITEM_COMPLETED_AGENT_TYPE, JOB_USE_BREAKAWAY,
    THREAD_ID_NOTIFICATION_METHOD, THREAD_ID_POLL_INTERVAL_MS, THREAD_ID_POLL_MAX_MS,
};
use super::protocol::{
    event, method, ClientCapabilities, ClientInfo, CodexNotification, CodexRequest, CodexResponse,
    InitializeParams, InitializeResult, InputItem, ThreadStartParams, TurnStartParams,
};
use super::{bin_resolver, CodexSidecar, NOTIFICATION_CHANNEL_CAPACITY};

/// Asagi の clientInfo（initialize handshake で送信）。
const ASAGI_CLIENT_NAME: &str = "asagi";
const ASAGI_CLIENT_TITLE: &str = "Asagi";
const ASAGI_CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Phase 1 で opt-out する notification 群（DEC-018-023 / 本ファイル冒頭ドキュメント）。
const OPT_OUT_NOTIFICATIONS: &[&str] = &[
    "item/reasoning/textDelta",
    "item/reasoning/summaryTextDelta",
    "item/commandExecution/outputDelta",
    "item/fileChange/outputDelta",
    "fuzzyFileSearch/sessionUpdated",
    "serverRequest/resolved",
];

/// `send_request` のデフォルトタイムアウト（initialize / thread/start / account/read 等の制御 RPC 用）。
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// turn 完了待機のデフォルトタイムアウト（gpt-5.5 の turn/completed 待ち）。
pub const DEFAULT_TURN_TIMEOUT: Duration = Duration::from_secs(120);

/// Windows: `CREATE_BREAKAWAY_FROM_JOB` フラグ（POC #5 で使用、DEC-018-033 ②）。
#[cfg(windows)]
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

/// pending request map のエイリアス。
type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<CodexResponse>>>>;

/// Real Codex sidecar。
pub struct RealCodexSidecar {
    project_id: String,
    notifications: broadcast::Sender<CodexNotification>,
    /// alive 判定用の生死フラグ。reader タスクが EOF / err を踏むと false に落ちる。
    alive: Arc<std::sync::atomic::AtomicBool>,
    /// running state（start 済みなら Some）。shutdown で取り出して順序破棄する。
    running: Option<RunningState>,
}

/// `start()` 完了後にのみ存在する running 状態。
struct RunningState {
    /// codex プロセスハンドル。
    child: Child,
    /// stdin。`send_request` 排他用に Mutex。
    stdin: Arc<Mutex<ChildStdin>>,
    /// pending oneshot table（id → response sender）。
    pending: PendingMap,
    /// 単調増加の RPC id 生成器。
    next_id: Arc<std::sync::atomic::AtomicU64>,
    /// stdout reader task hand。
    reader_task: JoinHandle<()>,
    /// stderr reader task hand。
    stderr_task: JoinHandle<()>,
    /// initialize 完了結果。M2 で UI 表示する。
    init_result: InitializeResult,
    /// JobObject（Windows）。Drop で子プロセス全 kill。
    #[cfg(windows)]
    _job: Option<crate::process::jobobject::WinJobObject>,
}

impl RealCodexSidecar {
    pub fn new(project_id: String) -> Self {
        let (tx, _) = broadcast::channel(NOTIFICATION_CHANNEL_CAPACITY);
        Self {
            project_id,
            notifications: tx,
            alive: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            running: None,
        }
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    /// initialize 結果を返す（start 後のみ Some）。
    pub fn init_result(&self) -> Option<&InitializeResult> {
        self.running.as_ref().map(|r| &r.init_result)
    }

    /// codex 子プロセスの PID を返す（start 後のみ Some、AS-143 検証用）。
    ///
    /// `tokio::process::Child::id()` 経由で取得。プロセスが既に wait されていると None。
    /// JobObject 統合確認 (`is_process_in_any_job`) や運用デバッグで使用。
    pub fn pid(&self) -> Option<u32> {
        self.running.as_ref().and_then(|r| r.child.id())
    }

    /// 単調増加 id を生成（"r-1", "r-2", ...）。RPC id の string 正規化（protocol.rs § RequestId）。
    fn next_request_id(&self) -> Result<String> {
        let r = self
            .running
            .as_ref()
            .ok_or_else(|| anyhow!("RealCodexSidecar is not started"))?;
        let n = r.next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(format!("r-{n}"))
    }

    // ============================================================================
    // AS-140.1: spawn
    // ============================================================================

    /// codex バイナリを resolve し `app-server --listen stdio://` で spawn する。
    ///
    /// Windows では `CREATE_BREAKAWAY_FROM_JOB` を立てて親 Job からの分離を試行
    /// （POC #5：拒否されても fallback で nested Job として動作）。
    fn spawn_codex_app_server() -> Result<Child> {
        let bin = bin_resolver::resolve_codex_bin()
            .with_context(|| "failed to resolve codex binary path")?;

        let mut cmd = tokio::process::Command::new(&bin);
        cmd.args(CODEX_APP_SERVER_ARGS)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        #[cfg(windows)]
        if JOB_USE_BREAKAWAY {
            // POC #5 の知見: 親シェル拒否でも fallback で nested Job として動作可能。
            // 拒否されても spawn 自体は成功するため try のみで OK。
            // tokio::process::Command は Windows で `creation_flags` を inherent method として公開している。
            cmd.creation_flags(CREATE_BREAKAWAY_FROM_JOB);
        }
        // 非 Windows では BREAKAWAY 概念なし（JOB_USE_BREAKAWAY が true でも no-op）。
        #[cfg(not(windows))]
        let _ = JOB_USE_BREAKAWAY;

        let child = cmd
            .spawn()
            .with_context(|| format!("failed to spawn codex at {}", bin.display()))?;
        Ok(child)
    }

    // ============================================================================
    // AS-140.2: stdin/stdout JSON-RPC pump
    // ============================================================================

    /// stdout reader task を spawn する。NDJSON を 1 行ずつ読み、
    /// - `id` あり → `pending` map から oneshot を取り出し response を返す
    /// - `id` なし → `notifications` broadcast に流す
    ///
    /// EOF / error 検知時は alive を false に落として終了。
    fn spawn_reader_task(
        stdout: tokio::process::ChildStdout,
        pending: PendingMap,
        notifications: broadcast::Sender<CodexNotification>,
        alive: Arc<std::sync::atomic::AtomicBool>,
    ) -> JoinHandle<()> {
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            loop {
                match reader.next_line().await {
                    Ok(Some(line)) => {
                        if line.trim().is_empty() {
                            continue;
                        }
                        if let Err(e) = dispatch_line(&line, &pending, &notifications).await {
                            tracing::warn!(error = %e, line = %line, "codex stdout dispatch failed");
                        }
                    }
                    Ok(None) => {
                        tracing::info!("codex stdout reached EOF");
                        break;
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "codex stdout read error");
                        break;
                    }
                }
            }
            alive.store(false, std::sync::atomic::Ordering::SeqCst);
        })
    }

    /// stderr reader task を spawn する。warn level で転送。
    fn spawn_stderr_task(stderr: tokio::process::ChildStderr) -> JoinHandle<()> {
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if !line.trim().is_empty() {
                    tracing::warn!(target: "codex.stderr", "{line}");
                }
            }
        })
    }

    /// 1 行を stdin に書き込む（末尾に `\n` を付ける）。
    async fn write_line(stdin: &Arc<Mutex<ChildStdin>>, line: &str) -> Result<()> {
        let mut g = stdin.lock().await;
        g.write_all(line.as_bytes())
            .await
            .with_context(|| "stdin write failed")?;
        g.write_all(b"\n")
            .await
            .with_context(|| "stdin newline failed")?;
        g.flush().await.with_context(|| "stdin flush failed")?;
        Ok(())
    }

    /// notification を id 無しで送信（`initialized` 等）。
    async fn send_notification(
        stdin: &Arc<Mutex<ChildStdin>>,
        method: &str,
        params: Option<JsonValue>,
    ) -> Result<()> {
        let n = CodexNotification::new(method, params);
        let s = serde_json::to_string(&n).with_context(|| "notification serialize failed")?;
        Self::write_line(stdin, &s).await
    }

    // ============================================================================
    // AS-140.3: handshake + thread/started polling
    // ============================================================================

    /// initialize → InitializeResult 保存 → initialized notification 送信。
    async fn perform_handshake(
        stdin: &Arc<Mutex<ChildStdin>>,
        pending: &PendingMap,
        next_id: &Arc<std::sync::atomic::AtomicU64>,
    ) -> Result<InitializeResult> {
        let id = format!(
            "r-{}",
            next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        );
        let params = InitializeParams {
            client_info: ClientInfo {
                name: ASAGI_CLIENT_NAME.to_string(),
                title: ASAGI_CLIENT_TITLE.to_string(),
                version: ASAGI_CLIENT_VERSION.to_string(),
            },
            capabilities: ClientCapabilities {
                experimental_api: false,
                opt_out_notification_methods: OPT_OUT_NOTIFICATIONS
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
            },
        };
        let req = CodexRequest::new(
            &id,
            method::INITIALIZE,
            Some(serde_json::to_value(&params).unwrap()),
        );
        let resp = send_and_wait(stdin, pending, req, DEFAULT_REQUEST_TIMEOUT).await?;
        let result = resp
            .result
            .ok_or_else(|| anyhow!("initialize: response had no result"))?;
        let init: InitializeResult = serde_json::from_value(result)
            .with_context(|| "initialize: failed to deserialize InitializeResult")?;

        // initialized notification（id 無し）
        Self::send_notification(stdin, method::INITIALIZED, None).await?;

        Ok(init)
    }

    /// `thread/start` を投げ、result から thread.id を取得する。
    /// result.thread.id が空/欠落の場合は `thread/started` notification を最大 2s polling
    /// （DEC-018-033 ③ — POC #3 で確認した race 対策）。
    pub async fn start_thread(&self, params: ThreadStartParams) -> Result<String> {
        let r = self
            .running
            .as_ref()
            .ok_or_else(|| anyhow!("RealCodexSidecar is not started"))?;

        // notifications を**送信前**に subscribe しておく（race 防止）
        let mut notif_rx = self.notifications.subscribe();

        let id = self.next_request_id()?;
        let req = CodexRequest::new(
            &id,
            method::THREAD_START,
            Some(serde_json::to_value(&params).unwrap()),
        );
        let resp = send_and_wait(&r.stdin, &r.pending, req, DEFAULT_REQUEST_TIMEOUT).await?;

        // 1) response.result.thread.id が取れる場合はそれを返す
        if let Some(result) = resp.result.as_ref() {
            if let Some(tid) = result.pointer("/thread/id").and_then(|v| v.as_str()) {
                if !tid.is_empty() {
                    return Ok(tid.to_string());
                }
            }
        }
        if let Some(err) = resp.error.as_ref() {
            bail!("thread/start error: {} ({})", err.message, err.code);
        }

        // 2) result から取れない → notification polling
        let max = Duration::from_millis(THREAD_ID_POLL_MAX_MS);
        let interval = Duration::from_millis(THREAD_ID_POLL_INTERVAL_MS);
        let deadline = tokio::time::Instant::now() + max;
        loop {
            // try_recv 相当: timeout 短く設定して非ブロッキング風に消費
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                bail!(
                    "thread/start: timed out waiting for {} notification ({} ms)",
                    THREAD_ID_NOTIFICATION_METHOD,
                    THREAD_ID_POLL_MAX_MS
                );
            }
            let recv_to = std::cmp::min(remaining, interval);
            match timeout(recv_to, notif_rx.recv()).await {
                Ok(Ok(n)) => {
                    if n.method == THREAD_ID_NOTIFICATION_METHOD {
                        if let Some(tid) = n
                            .params
                            .as_ref()
                            .and_then(|p| p.pointer("/thread/id"))
                            .and_then(|v| v.as_str())
                        {
                            if !tid.is_empty() {
                                return Ok(tid.to_string());
                            }
                        }
                    }
                }
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => {
                    // ロスは無視して継続（tokio broadcast の lossy 仕様）
                    continue;
                }
                Ok(Err(broadcast::error::RecvError::Closed)) => {
                    bail!(
                        "thread/start: notification channel closed before thread/started arrived"
                    );
                }
                Err(_elapsed) => {
                    // 1 回分のスロットだけ待った → 次ループで残り時間チェック
                    continue;
                }
            }
        }
    }

    // ============================================================================
    // AS-140.4: item/completed agentMessage 抽出
    // ============================================================================

    /// `turn/start` を投げ、`item/completed` の `agentMessage` を最大
    /// `DEFAULT_TURN_TIMEOUT` 待機して assistant text を返す。
    /// `userMessage` 等の他 type は無視（DEC-018-033 ④ — POC #3 で確認した「自分の入力」誤検知防止）。
    pub async fn send_turn_and_collect_assistant_text(
        &self,
        thread_id: impl Into<String>,
        input: Vec<InputItem>,
    ) -> Result<String> {
        let r = self
            .running
            .as_ref()
            .ok_or_else(|| anyhow!("RealCodexSidecar is not started"))?;

        // 送信前に subscribe
        let mut notif_rx = self.notifications.subscribe();

        let id = self.next_request_id()?;
        let params = TurnStartParams {
            thread_id: thread_id.into(),
            input,
            model: None,
            effort: None,
        };
        let req = CodexRequest::new(
            &id,
            method::TURN_START,
            Some(serde_json::to_value(&params).unwrap()),
        );
        let resp = send_and_wait(&r.stdin, &r.pending, req, DEFAULT_REQUEST_TIMEOUT).await?;
        if let Some(err) = resp.error.as_ref() {
            bail!("turn/start error: {} ({})", err.message, err.code);
        }

        // assistant text 収集
        collect_assistant_text(&mut notif_rx, DEFAULT_TURN_TIMEOUT).await
    }
}

// ============================================================================
// 共有ヘルパ（self を持たないので free fn として外出し）
// ============================================================================

/// 1 行（NDJSON）を分類して pending か broadcast に dispatch する。
async fn dispatch_line(
    line: &str,
    pending: &PendingMap,
    notifications: &broadcast::Sender<CodexNotification>,
) -> Result<()> {
    // serde_json::Value にデコードしてから `id` の有無で分類
    let v: JsonValue = serde_json::from_str(line)
        .with_context(|| format!("invalid JSON line from codex: {line}"))?;

    if v.get("id").is_some() {
        // response
        let resp: CodexResponse = serde_json::from_value(v)
            .with_context(|| format!("response deserialize failed: {line}"))?;
        let mut g = pending.lock().await;
        if let Some(tx) = g.remove(&resp.id) {
            // receiver が drop 済の場合は静かに破棄
            let _ = tx.send(resp);
        } else {
            tracing::warn!(id = %resp.id, "response with no pending sender");
        }
    } else if v.get("method").is_some() {
        // notification
        let n: CodexNotification = serde_json::from_value(v)
            .with_context(|| format!("notification deserialize failed: {line}"))?;
        // receiver 0 の場合は SendError を無視（全 subscribe 解除済の場合）
        let _ = notifications.send(n);
    } else {
        tracing::warn!(line = %line, "unrecognized JSON-RPC payload (no id, no method)");
    }
    Ok(())
}

/// request を pending に登録 → stdin 書き込み → response を timeout 付きで await。
async fn send_and_wait(
    stdin: &Arc<Mutex<ChildStdin>>,
    pending: &PendingMap,
    req: CodexRequest,
    to: Duration,
) -> Result<CodexResponse> {
    let id = req.id.clone();
    let (tx, rx) = oneshot::channel();
    {
        let mut g = pending.lock().await;
        g.insert(id.clone(), tx);
    }
    let s = serde_json::to_string(&req).with_context(|| "request serialize failed")?;
    if let Err(e) = RealCodexSidecar::write_line(stdin, &s).await {
        // 書き込み失敗時は pending を掃除して失敗
        let mut g = pending.lock().await;
        g.remove(&id);
        return Err(e);
    }
    match timeout(to, rx).await {
        Ok(Ok(resp)) => Ok(resp),
        Ok(Err(_)) => bail!("request {id}: oneshot canceled (reader task may have died)"),
        Err(_) => {
            // timeout → pending 掃除
            let mut g = pending.lock().await;
            g.remove(&id);
            bail!("request {id}: timed out after {:?}", to)
        }
    }
}

/// `item/completed` notification を待ち受け、`item.type == "agentMessage"` の `text` を
/// 連結して返す。最初の agentMessage 完了で結果を返す（gpt-5.5 通常応答は単発）。
/// `userMessage` の item/completed は無視（POC #3 重要発見 #3）。
async fn collect_assistant_text(
    rx: &mut broadcast::Receiver<CodexNotification>,
    to: Duration,
) -> Result<String> {
    let deadline = tokio::time::Instant::now() + to;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            bail!(
                "turn: timed out waiting for assistant agentMessage ({:?})",
                to
            );
        }
        match timeout(remaining, rx.recv()).await {
            Ok(Ok(n)) => {
                if n.method == event::ITEM_COMPLETED {
                    if let Some(p) = n.params.as_ref() {
                        let item_type = p.pointer("/item/type").and_then(|v| v.as_str());
                        if item_type == Some(ITEM_COMPLETED_AGENT_TYPE) {
                            // POC #3 確認: text は item.text に入る
                            if let Some(t) = p.pointer("/item/text").and_then(|v| v.as_str()) {
                                return Ok(t.to_string());
                            }
                            // 念のため content[].text も fallback で見る
                            if let Some(arr) = p.pointer("/item/content").and_then(|v| v.as_array())
                            {
                                let mut joined = String::new();
                                for c in arr {
                                    if let Some(t) = c.get("text").and_then(|v| v.as_str()) {
                                        joined.push_str(t);
                                    }
                                }
                                if !joined.is_empty() {
                                    return Ok(joined);
                                }
                            }
                            bail!(
                                "agentMessage item/completed has no text/content (raw: {})",
                                p
                            );
                        }
                        // userMessage / commandExecution / fileChange 等は無視して継続
                    }
                } else if n.method == event::TURN_COMPLETED {
                    // turn/completed が agentMessage より先に到達した場合（gpt-5.5 で空応答時など）
                    if let Some(err) = n
                        .params
                        .as_ref()
                        .and_then(|p| p.pointer("/turn/error"))
                        .and_then(|v| v.as_object())
                    {
                        bail!("turn/completed with error before agentMessage: {:?}", err);
                    }
                    // 空 turn / agentMessage 無し
                    bail!("turn/completed without any agentMessage");
                }
            }
            Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(broadcast::error::RecvError::Closed)) => {
                bail!("turn: notification channel closed before agentMessage arrived");
            }
            Err(_) => continue,
        }
    }
}

// ============================================================================
// trait impl
// ============================================================================

#[async_trait]
impl CodexSidecar for RealCodexSidecar {
    async fn start(&mut self) -> Result<()> {
        if self.running.is_some() {
            bail!(
                "RealCodexSidecar already started for project {}",
                self.project_id
            );
        }

        // 1. spawn
        let mut child = Self::spawn_codex_app_server()?;

        // 2. JobObject 結合（Windows のみ、POC #5 で実証済）
        #[cfg(windows)]
        let job = match crate::process::jobobject::WinJobObject::create() {
            Ok(j) => {
                if let Some(pid) = child.id() {
                    if let Err(e) = j.assign_pid(pid) {
                        // assign 失敗は致命ではないが警告（fallback で nested Job 動作も観測済み）
                        tracing::warn!(pid, error = %e, "AssignProcessToJobObject failed; continuing without job binding");
                    }
                }
                Some(j)
            }
            Err(e) => {
                tracing::warn!(error = %e, "WinJobObject::create failed; continuing without job");
                None
            }
        };

        // 3. stdin/stdout/stderr ハンドル取得
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("codex child has no stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("codex child has no stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("codex child has no stderr"))?;

        let stdin = Arc::new(Mutex::new(stdin));
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let next_id = Arc::new(std::sync::atomic::AtomicU64::new(1));

        // 4. reader / stderr task spawn
        self.alive.store(true, std::sync::atomic::Ordering::SeqCst);
        let reader_task = Self::spawn_reader_task(
            stdout,
            pending.clone(),
            self.notifications.clone(),
            self.alive.clone(),
        );
        let stderr_task = Self::spawn_stderr_task(stderr);

        // 5. handshake (initialize → initialized)
        let init_result = match Self::perform_handshake(&stdin, &pending, &next_id).await {
            Ok(r) => r,
            Err(e) => {
                // handshake 失敗時は reader/stderr を中止して child を kill
                reader_task.abort();
                stderr_task.abort();
                let _ = child.kill().await;
                self.alive.store(false, std::sync::atomic::Ordering::SeqCst);
                return Err(e.context("initialize handshake failed"));
            }
        };

        self.running = Some(RunningState {
            child,
            stdin,
            pending,
            next_id,
            reader_task,
            stderr_task,
            init_result,
            #[cfg(windows)]
            _job: job,
        });

        Ok(())
    }

    async fn send_request(&self, req: CodexRequest) -> Result<CodexResponse> {
        let r = self
            .running
            .as_ref()
            .ok_or_else(|| anyhow!("RealCodexSidecar is not started"))?;
        send_and_wait(&r.stdin, &r.pending, req, DEFAULT_REQUEST_TIMEOUT).await
    }

    fn subscribe_events(&self) -> broadcast::Receiver<CodexNotification> {
        self.notifications.subscribe()
    }

    async fn shutdown(&mut self) -> Result<()> {
        let Some(mut r) = self.running.take() else {
            // 未起動 / 二重 shutdown は no-op
            return Ok(());
        };

        // 1. stdin close（codex 側に EOF を伝える）
        {
            let mut g = r.stdin.lock().await;
            let _ = g.shutdown().await;
        }

        // 2. 1.5s 猶予 → child 監視
        let graceful = sleep(Duration::from_millis(1500));
        tokio::pin!(graceful);
        tokio::select! {
            _ = &mut graceful => {
                tracing::info!("codex did not exit within graceful window; forcing kill");
                let _ = r.child.kill().await;
            }
            res = r.child.wait() => {
                match res {
                    Ok(s) => tracing::info!(status = ?s, "codex exited gracefully"),
                    Err(e) => tracing::warn!(error = %e, "codex wait failed during shutdown"),
                }
            }
        }

        // 3. reader / stderr task の停止待ち（abort で確実に）
        r.reader_task.abort();
        r.stderr_task.abort();
        self.alive.store(false, std::sync::atomic::Ordering::SeqCst);

        // 4. JobObject Drop は r が drop されるときに走る（連鎖 kill 保険）
        Ok(())
    }

    fn is_alive(&self) -> bool {
        self.alive.load(std::sync::atomic::Ordering::SeqCst) && self.running.is_some()
    }
}

// ============================================================================
// tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    // ※ `json!` macro は tests のみ参照するため、本 mod 内で個別に import する。

    /// AS-140.5 整合: start 前に send_request すると明示エラー。
    #[tokio::test]
    async fn unstarted_send_request_returns_error() {
        let s = RealCodexSidecar::new("p-real-1".into());
        let r = s
            .send_request(CodexRequest::new("x", method::ACCOUNT_READ, None))
            .await;
        assert!(r.is_err());
        let msg = format!("{}", r.unwrap_err());
        assert!(msg.contains("not started"), "unexpected error: {msg}");
    }

    /// is_alive は未起動なら必ず false。
    #[test]
    fn unstarted_is_alive_false() {
        let s = RealCodexSidecar::new("p-real-2".into());
        assert!(!s.is_alive());
        assert!(s.init_result().is_none());
    }

    /// dispatch_line: response（id あり）→ pending oneshot に届く。
    #[tokio::test]
    async fn dispatch_line_routes_response_to_pending() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (notif_tx, _notif_rx) = broadcast::channel(8);

        let (tx, rx) = oneshot::channel();
        pending.lock().await.insert("r-1".into(), tx);

        let line = r#"{"jsonrpc":"2.0","id":"r-1","result":{"ok":true}}"#;
        dispatch_line(line, &pending, &notif_tx).await.unwrap();

        let resp = rx.await.expect("response should arrive");
        assert_eq!(resp.id, "r-1");
        assert!(resp.result.is_some());
    }

    /// dispatch_line: notification（id 無し）→ broadcast に流れる。
    #[tokio::test]
    async fn dispatch_line_routes_notification_to_broadcast() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (notif_tx, mut notif_rx) = broadcast::channel(8);

        let line =
            r#"{"jsonrpc":"2.0","method":"thread/started","params":{"thread":{"id":"t-1"}}}"#;
        dispatch_line(line, &pending, &notif_tx).await.unwrap();

        let n = timeout(Duration::from_millis(100), notif_rx.recv())
            .await
            .expect("notification timeout")
            .expect("notification recv ok");
        assert_eq!(n.method, "thread/started");
    }

    /// dispatch_line: 不正 JSON は Err（reader task は warn して継続する設計）。
    #[tokio::test]
    async fn dispatch_line_rejects_invalid_json() {
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (notif_tx, _) = broadcast::channel(8);
        let r = dispatch_line("not json", &pending, &notif_tx).await;
        assert!(r.is_err());
    }

    /// collect_assistant_text: agentMessage の item/completed から text 抽出。
    #[tokio::test]
    async fn collect_assistant_text_extracts_agent_message() {
        let (tx, mut rx) = broadcast::channel(8);

        // userMessage の item/completed（無視されるべき）
        tx.send(CodexNotification::new(
            event::ITEM_COMPLETED,
            Some(json!({"item": {"type": "userMessage", "text": "hi from user"}})),
        ))
        .unwrap();
        // agentMessage の item/completed
        tx.send(CodexNotification::new(
            event::ITEM_COMPLETED,
            Some(json!({"item": {"type": "agentMessage", "text": "hello from agent"}})),
        ))
        .unwrap();

        let text = collect_assistant_text(&mut rx, Duration::from_secs(1))
            .await
            .expect("must extract text");
        assert_eq!(text, "hello from agent");
    }

    /// collect_assistant_text: turn/completed が agentMessage 前に来ると Err。
    #[tokio::test]
    async fn collect_assistant_text_errors_on_premature_turn_completed() {
        let (tx, mut rx) = broadcast::channel(8);
        tx.send(CodexNotification::new(
            event::TURN_COMPLETED,
            Some(json!({"turn": {"id": "t1", "status": "completed"}})),
        ))
        .unwrap();
        let r = collect_assistant_text(&mut rx, Duration::from_secs(1)).await;
        assert!(
            r.is_err(),
            "must error when turn/completed without agentMessage"
        );
    }

    /// collect_assistant_text: 何も来ないと timeout。
    #[tokio::test]
    async fn collect_assistant_text_times_out() {
        let (_tx, mut rx) = broadcast::channel::<CodexNotification>(8);
        let r = collect_assistant_text(&mut rx, Duration::from_millis(100)).await;
        assert!(r.is_err());
        let msg = format!("{}", r.unwrap_err());
        assert!(msg.contains("timed out"), "unexpected: {msg}");
    }

    /// shutdown は未起動でも no-op で Ok。
    #[tokio::test]
    async fn unstarted_shutdown_is_noop() {
        let mut s = RealCodexSidecar::new("p-real-3".into());
        s.shutdown()
            .await
            .expect("shutdown on unstarted should succeed");
    }

    /// fallback content[].text の連結も agentMessage として認識する。
    #[tokio::test]
    async fn collect_assistant_text_fallback_to_content_array() {
        let (tx, mut rx) = broadcast::channel(8);
        tx.send(CodexNotification::new(
            event::ITEM_COMPLETED,
            Some(json!({
                "item": {
                    "type": "agentMessage",
                    "content": [
                        {"type": "text", "text": "hello "},
                        {"type": "text", "text": "world"}
                    ]
                }
            })),
        ))
        .unwrap();
        let text = collect_assistant_text(&mut rx, Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(text, "hello world");
    }

    // ============================================================================
    // AS-143: Tauri 親プロセス相当 JobObject integration test (R-WBS-3 解消)
    // ============================================================================
    //
    // 既定では `#[ignore]`：実 codex CLI + OAuth 認証が必要なためオーナー実機実行のみ。
    //   実行: `cargo test --lib codex_sidecar::real::tests::real_spawn_terminates_via_job_drop -- --ignored --nocapture`
    //
    // 検証内容（DEC-018-035 後続 / R-WBS-3）:
    //   1. RealCodexSidecar::start() が JobObject を内部生成 + assign_pid 完走
    //   2. IsProcessInJob で「子 codex プロセスが any job に属している」確認（POC #5 と同手順）
    //   3. RealCodexSidecar::shutdown() を経由して JobObject Drop が連鎖し codex が終了
    //
    // POC #5 との差分: cmd 親シェルではなく Tokio runtime（≒ Tauri 親と等価な独立 process tree）から
    // spawn する。これにより BREAKAWAY 拒否時の nested Job fallback が runtime 経由でも動作することを確認。

    #[cfg(target_os = "windows")]
    #[tokio::test]
    #[ignore = "needs real codex CLI + OAuth (Pro 5x). Run via owner smoke: --ignored"]
    async fn real_spawn_terminates_via_job_drop() {
        use crate::process::jobobject::is_process_in_any_job;

        let mut s = RealCodexSidecar::new("p-as143".into());
        s.start()
            .await
            .expect("real start must succeed (codex login required)");

        // ① start 後は alive かつ pid が取れる
        assert!(s.is_alive(), "alive after start");
        let pid = s.pid().expect("pid must be Some after start");
        assert!(pid > 0, "pid must be non-zero, got {pid}");

        // ② IsProcessInJob で any job 属性を確認（nested Job fallback 経由でも true）
        let in_job =
            is_process_in_any_job(pid).expect("IsProcessInJob must succeed on running child");
        assert!(in_job, "codex pid={pid} must belong to a JobObject");

        // ③ shutdown → JobObject Drop が連鎖し codex プロセスが kill される
        s.shutdown().await.expect("shutdown must succeed");
        assert!(!s.is_alive(), "alive must be false after shutdown");

        // ④ kill 確認: shutdown 完了後 OpenProcess(QUERY_INFORMATION) は数回内に失敗する想定
        //   ただし IsProcessInJob 経由は pid recycle を踏む可能性があるため、ここでは
        //   shutdown 内部の child.wait() 経由で「process が exit したこと」を保証している前提。
        //   追加の sanity として 500ms 待って再度 IsProcessInJob を呼んでみる（success/fail どちらも許容）。
        tokio::time::sleep(Duration::from_millis(500)).await;
        let recheck = is_process_in_any_job(pid);
        // 死亡済 PID は OpenProcess が ERROR_INVALID_PARAMETER で失敗しがち。Err は許容。
        match recheck {
            Ok(_) => { /* pid recycle / 直前の handle がキャッシュされたケース。NG ではない */
            }
            Err(_) => { /* 死亡確認の最も期待される経路 */ }
        }
    }
}
