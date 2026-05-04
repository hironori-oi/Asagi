//! Multi-Sidecar Manager (AS-134 / DEC-018-025)。
//!
//! Project ごとに独立した Codex sidecar を `HashMap<ProjectId, ...>` で
//! 保持する。Slack 風 ProjectRail (DEC-018-006 軸 C) の Rust 側基盤。
//!
//! # 同時起動上限 (DEC-018-025)
//!
//! `MAX_CONCURRENT_SIDECARS = 6`。リサーチ v2 RAs-17 (third-party OAuth で 429
//! quota exceeded、openai-python issue #2951) を踏まえ、Sumi の 8 から保守的に
//! 6 に下方修正。実運用で 6 を超えるケースが顕在化したら個別判断。

use anyhow::{anyhow, bail, Result};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tokio::sync::{broadcast, RwLock};
use tokio::task::JoinHandle;

use super::contract::{
    ENV_SIDECAR_IDLE_REAPER_INTERVAL_MS, ENV_SIDECAR_IDLE_THRESHOLD_MS,
    SIDECAR_IDLE_REAPER_INTERVAL_SECS, SIDECAR_IDLE_THRESHOLD_SECS,
};
use super::retry::{RetryPolicy, SpawnAttempt};
use super::{
    create_sidecar, CodexNotification, CodexRequest, CodexResponse, CodexSidecar, SidecarMode,
};

pub type ProjectId = String;

/// `spawn_for_with_retry` で「retry 不能」と判定する error 文字列の prefix。
///
/// `MaxConcurrentSidecarsReached` (DEC-018-025) は容量上限到達なので
/// 何回 retry しても同じ結果になる → 即 fail。
pub const ERR_PREFIX_NON_RETRYABLE_MAX_CONCURRENT: &str = "Max concurrent sidecars";

/// `MultiSidecarManager::spawn_for_with_retry` のエラー判定ヘルパ。
///
/// `false` を返すケース:
///   - "Max concurrent sidecars" 由来 (容量上限、retry 無意味)
///
/// それ以外（binary 解決失敗 / Permission denied / I/O error 等）は `true`。
pub fn is_retryable_spawn_error(err: &anyhow::Error) -> bool {
    let msg = format!("{err:#}");
    !msg.contains(ERR_PREFIX_NON_RETRYABLE_MAX_CONCURRENT)
}

/// Multi-Sidecar 同時起動上限。
///
/// DEC-018-025: Sumi の 8 → 6 に保守的下方修正。
/// 根拠はリサーチ v2 RAs-17 (third-party OAuth quota exceeded リスク強化)。
pub const MAX_CONCURRENT_SIDECARS: usize = 6;

/// Multi-Sidecar 管理。
///
/// DEC-018-045 QW3 (AS-202.1): sidecar ごとに `last_activity_at` を SystemTime で
/// 追跡し、idle reaper task が threshold (既定 30 分) 超えのものを自動 shutdown する。
pub struct MultiSidecarManager {
    sidecars: Arc<RwLock<HashMap<ProjectId, Box<dyn CodexSidecar>>>>,
    /// project ごとの最終 activity 時刻（send_request / spawn_for で更新）
    last_activity: Arc<RwLock<HashMap<ProjectId, SystemTime>>>,
    /// idle reaper task の handle（Drop で abort）
    reaper_handle: std::sync::Mutex<Option<JoinHandle<()>>>,
}

impl Default for MultiSidecarManager {
    fn default() -> Self {
        Self::new()
    }
}

impl MultiSidecarManager {
    pub fn new() -> Self {
        Self {
            sidecars: Arc::new(RwLock::new(HashMap::new())),
            last_activity: Arc::new(RwLock::new(HashMap::new())),
            reaper_handle: std::sync::Mutex::new(None),
        }
    }

    /// `last_activity` を `now` に touch する。
    async fn touch_activity(&self, project_id: &str) {
        let mut act = self.last_activity.write().await;
        act.insert(project_id.to_string(), SystemTime::now());
    }

    /// idle threshold (秒)。env が設定されていればそちらを優先。
    fn resolve_idle_threshold() -> Duration {
        std::env::var(ENV_SIDECAR_IDLE_THRESHOLD_MS)
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|v| *v > 0)
            .map(Duration::from_millis)
            .unwrap_or_else(|| Duration::from_secs(SIDECAR_IDLE_THRESHOLD_SECS))
    }

    /// idle reaper の poll 間隔。env 優先。
    fn resolve_reaper_interval() -> Duration {
        std::env::var(ENV_SIDECAR_IDLE_REAPER_INTERVAL_MS)
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|v| *v > 0)
            .map(Duration::from_millis)
            .unwrap_or_else(|| Duration::from_secs(SIDECAR_IDLE_REAPER_INTERVAL_SECS))
    }

    /// 1 回 sweep を行う pure async 関数。test からも直接呼べる。
    /// idle と判定された project_id のリストを返す（呼び出し側で event emit に使用）。
    pub async fn idle_sweep_once(&self, threshold: Duration) -> Vec<ProjectId> {
        let now = SystemTime::now();
        let to_shutdown: Vec<ProjectId> = {
            let act = self.last_activity.read().await;
            let map = self.sidecars.read().await;
            let mut targets = Vec::new();
            for pid in map.keys() {
                let last = act.get(pid).copied().unwrap_or(now);
                if let Ok(elapsed) = now.duration_since(last) {
                    if elapsed >= threshold {
                        targets.push(pid.clone());
                    }
                }
            }
            targets
        };
        for pid in &to_shutdown {
            // shutdown 失敗しても他を止めない（best-effort）
            let _ = self.shutdown(pid).await;
        }
        to_shutdown
    }

    /// idle reaper task を起動する（冪等）。Drop で abort される。
    ///
    /// production: 1 分間隔で全 sidecar の last_activity をチェックし、
    /// 30 分超 idle なら shutdown する。
    /// test: `ASAGI_SIDECAR_IDLE_THRESHOLD_MS` / `ASAGI_SIDECAR_IDLE_REAPER_INTERVAL_MS`
    /// で短縮可能。
    ///
    /// `on_idle_shutdown` callback は idle 判定で shutdown された project_id ごとに
    /// 呼ばれる（Tauri event emit に使用）。
    pub fn start_idle_reaper<F>(self: &Arc<Self>, on_idle_shutdown: F) -> bool
    where
        F: Fn(&str) + Send + Sync + 'static,
    {
        let mut handle_slot = self.reaper_handle.lock().unwrap();
        if handle_slot.is_some() {
            return false; // 既に起動済み
        }
        let threshold = Self::resolve_idle_threshold();
        let interval = Self::resolve_reaper_interval();
        // Weak で持つことで reaper が manager を生かし続けないようにする（Drop 経路保証）
        let me = Arc::downgrade(self);
        let cb = Arc::new(on_idle_shutdown);
        let handle = tokio::spawn(async move {
            // 起動直後に少し待ってから loop に入る
            tokio::time::sleep(Duration::from_millis(50)).await;
            loop {
                let Some(strong) = me.upgrade() else {
                    // manager が drop された → reaper も終了
                    break;
                };
                let killed = strong.idle_sweep_once(threshold).await;
                for pid in &killed {
                    cb(pid);
                }
                drop(strong); // sleep 中は弱参照に戻す
                tokio::time::sleep(interval).await;
            }
        });
        *handle_slot = Some(handle);
        true
    }

    /// idle reaper を停止する。冪等。
    pub fn stop_idle_reaper(&self) {
        let mut handle_slot = self.reaper_handle.lock().unwrap();
        if let Some(h) = handle_slot.take() {
            h.abort();
        }
    }

    /// 指定 project_id の sidecar を spawn し start() する。
    /// 既に存在する場合は何もしない (冪等)。
    /// 既存数が `MAX_CONCURRENT_SIDECARS` を満たしている状態で
    /// **新規** project への spawn が来た場合は error を返す (DEC-018-025)。
    ///
    /// 返り値:
    ///   - `Ok(true)`  = 新規に sidecar を生成・start した（呼び出し側は
    ///     notification pump task など 1 回限りの後処理を実行してよい）
    ///   - `Ok(false)` = 既存 sidecar があったため no-op（後処理スキップ）
    ///
    /// この区別は AS-UX-FIX-A (DEC-018-039 W1) で発覚した、
    /// 「冪等 spawn 呼び出しのたびに pump task が二重起動 → 1 delta が
    /// 複数 Tauri event として emit される」バグの修正に使用される。
    pub async fn spawn_for(
        &self,
        project_id: impl Into<String>,
        mode: SidecarMode,
    ) -> Result<bool> {
        let pid = project_id.into();
        self.spawn_for_with_factory(&pid, &mut || Ok(create_sidecar(mode, pid.clone())))
            .await
    }

    /// `spawn_for` 内部実装。factory が返した sidecar を `start()` してから insert する。
    /// テスト時には factory を inject することで決定論的な失敗注入が可能。
    async fn spawn_for_with_factory(
        &self,
        project_id: &str,
        factory: &mut (dyn FnMut() -> Result<Box<dyn CodexSidecar>> + Send),
    ) -> Result<bool> {
        let mut map = self.sidecars.write().await;
        if map.contains_key(project_id) {
            return Ok(false);
        }
        if map.len() >= MAX_CONCURRENT_SIDECARS {
            bail!(
                "Max concurrent sidecars ({}) reached",
                MAX_CONCURRENT_SIDECARS
            );
        }
        let mut sc = factory()?;
        sc.start().await?;
        map.insert(project_id.to_string(), sc);
        // QW3 (AS-202.1): spawn 直後を初回 activity として記録
        drop(map); // 順序: sidecars write lock を先に解放してから last_activity を取る
        let mut act = self.last_activity.write().await;
        act.insert(project_id.to_string(), SystemTime::now());
        Ok(true)
    }

    /// DEC-018-045 QW2 (AS-201.2): outer retry layer 付きの spawn。
    ///
    /// `spawn_for` を `policy.max_retries` 回まで再試行する。試行ごとに
    /// `on_attempt(SpawnAttempt)` callback が呼ばれ（Tauri event 発火等に使用）、
    /// 成功時は `Ok(true|false)` を返却（既存 `spawn_for` 契約を踏襲）。
    ///
    /// 戻り値:
    ///   - `Ok(true)`  = 新規生成、`Ok(false)` = 既存 sidecar (no-op)
    ///   - `Err(e)`    = `max_retries` 全失敗 or non-retryable error
    ///
    /// non-retryable な error（`MaxConcurrentSidecarsReached`）は即 fail し
    /// retry しない（`is_retryable_spawn_error` で判定）。
    pub async fn spawn_for_with_retry(
        &self,
        project_id: impl Into<String>,
        mode: SidecarMode,
        policy: RetryPolicy,
        on_attempt: impl Fn(SpawnAttempt) + Send + Sync,
    ) -> Result<bool> {
        let pid = project_id.into();
        self.spawn_for_with_retry_factory(&pid, policy, on_attempt, &mut || {
            Ok(create_sidecar(mode, pid.clone()))
        })
        .await
    }

    /// `spawn_for_with_retry` 内部実装。テスト時は factory に失敗注入を仕込める。
    async fn spawn_for_with_retry_factory(
        &self,
        project_id: &str,
        policy: RetryPolicy,
        on_attempt: impl Fn(SpawnAttempt) + Send + Sync,
        factory: &mut (dyn FnMut() -> Result<Box<dyn CodexSidecar>> + Send),
    ) -> Result<bool> {
        let mut last_sleep_ms = 0u64;
        let mut last_error: Option<String> = None;
        // attempt は 1-based。max_retries=3 のとき attempt は 1, 2, 3 を試す。
        for attempt in 1..=policy.max_retries {
            // 試行前 callback。attempt=1 では last_error=None, next_sleep_ms=直前 sleep
            on_attempt(SpawnAttempt {
                attempt,
                max_retries: policy.max_retries,
                last_error: last_error.clone(),
                next_sleep_ms: None,
                success: false,
            });
            match self.spawn_for_with_factory(project_id, factory).await {
                Ok(created) => {
                    // AS-HOTFIX-QW6 (DEC-018-047 ⑫): 成功通知を 1 回送出する。
                    // frontend `useSpawnRetry` はこれを受けて 'retrying' status を
                    // 'idle' に reset する（「再接続中… (1/3)」バッジ消失）。
                    // attempt=1 で初回成功した時にも送るため、retry 不要なケースでも
                    // バッジは一瞬出てすぐ消える挙動になる（実害なし、UI で気付けない）。
                    on_attempt(SpawnAttempt {
                        attempt,
                        max_retries: policy.max_retries,
                        last_error: None,
                        next_sleep_ms: None,
                        success: true,
                    });
                    return Ok(created);
                }
                Err(e) => {
                    if !is_retryable_spawn_error(&e) {
                        // 即 fail（callback で error 通知済）
                        return Err(e);
                    }
                    last_error = Some(format!("{e:#}"));
                    if attempt >= policy.max_retries {
                        // 最終試行も失敗 → max retries exceeded で抜ける
                        on_attempt(SpawnAttempt {
                            attempt,
                            max_retries: policy.max_retries,
                            last_error: last_error.clone(),
                            next_sleep_ms: None,
                            success: false,
                        });
                        bail!(
                            "spawn_for_with_retry exhausted {} attempts: {}",
                            policy.max_retries,
                            last_error.unwrap_or_default()
                        );
                    }
                    // 次回試行までの backoff sleep
                    let sleep_ms = policy.next_sleep_ms(last_sleep_ms);
                    last_sleep_ms = sleep_ms;
                    on_attempt(SpawnAttempt {
                        attempt,
                        max_retries: policy.max_retries,
                        last_error: last_error.clone(),
                        next_sleep_ms: Some(sleep_ms),
                        success: false,
                    });
                    tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
                }
            }
        }
        // 通常はここに来ない (loop の中で return するため)
        bail!(
            "spawn_for_with_retry: exited without success ({} attempts)",
            policy.max_retries
        )
    }

    /// 指定 project_id の sidecar を経由して request を送信する。
    pub async fn send_request(&self, project_id: &str, req: CodexRequest) -> Result<CodexResponse> {
        let resp = {
            let map = self.sidecars.read().await;
            let sc = map
                .get(project_id)
                .ok_or_else(|| anyhow!("no sidecar for project_id: {project_id}"))?;
            sc.send_request(req).await
        };
        // QW3 (AS-202.1): 成否に関わらず activity 更新（人間が触っている事実が大事）
        self.touch_activity(project_id).await;
        resp
    }

    /// QW3 (AS-202.1): 指定 project の sidecar が active（reaper 対象外）かどうか。
    /// AS-202.2 lazy spawn の判定に使う：`is_alive` & `is_active` の両方が true なら
    /// そのまま再利用、false なら spawn し直す。
    pub async fn is_active(&self, project_id: &str) -> bool {
        let map = self.sidecars.read().await;
        map.contains_key(project_id)
    }

    /// notification を購読する。sidecar 未起動なら error。
    pub async fn subscribe(
        &self,
        project_id: &str,
    ) -> Result<broadcast::Receiver<CodexNotification>> {
        let map = self.sidecars.read().await;
        let sc = map
            .get(project_id)
            .ok_or_else(|| anyhow!("no sidecar for project_id: {project_id}"))?;
        Ok(sc.subscribe_events())
    }

    /// alive チェック。
    pub async fn is_alive(&self, project_id: &str) -> bool {
        let map = self.sidecars.read().await;
        map.get(project_id).map(|s| s.is_alive()).unwrap_or(false)
    }

    /// 個別 shutdown。HashMap からも除去する。
    pub async fn shutdown(&self, project_id: &str) -> Result<()> {
        let removed = {
            let mut map = self.sidecars.write().await;
            map.remove(project_id)
        };
        // last_activity からも除去（QW3 AS-202.1）
        {
            let mut act = self.last_activity.write().await;
            act.remove(project_id);
        }
        if let Some(mut sc) = removed {
            sc.shutdown().await?;
        }
        Ok(())
    }

    /// 全 sidecar を shutdown する（アプリ終了時想定）。
    pub async fn shutdown_all(&self) -> Result<()> {
        let mut map = self.sidecars.write().await;
        let keys: Vec<String> = map.keys().cloned().collect();
        for k in keys {
            if let Some(mut sc) = map.remove(&k) {
                let _ = sc.shutdown().await; // 1 つの失敗で他を止めない
            }
        }
        drop(map);
        // last_activity も全消去
        let mut act = self.last_activity.write().await;
        act.clear();
        Ok(())
    }

    /// 現在 active な project_id 一覧。
    pub async fn list_active(&self) -> Vec<String> {
        let map = self.sidecars.read().await;
        map.keys().cloned().collect()
    }
}

/// QW3 (AS-202.1): Drop で reaper task を abort する（leak 防止）。
///
/// `Arc<Self>` 経由で reaper が clone されているため、`Arc` の strong count が 0 に
/// 到達するのは reaper task も含めて全参照が消えた時。Drop 内で `abort()` を呼ぶことで
/// reaper task の参照が落ちる前に確実に停止する経路を提供する。
impl Drop for MultiSidecarManager {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.reaper_handle.lock() {
            if let Some(h) = slot.take() {
                h.abort();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_sidecar::mock::make_turn_start_request;
    use crate::codex_sidecar::protocol::{event, TurnStartResult};

    #[tokio::test]
    async fn multi_sidecar_three_projects_isolated() {
        let mgr = MultiSidecarManager::new();

        for pid in ["proj-a", "proj-b", "proj-c"] {
            mgr.spawn_for(pid, SidecarMode::Mock).await.unwrap();
        }

        let mut active = mgr.list_active().await;
        active.sort();
        assert_eq!(active, vec!["proj-a", "proj-b", "proj-c"]);
        for pid in ["proj-a", "proj-b", "proj-c"] {
            assert!(mgr.is_alive(pid).await);
        }

        // 各 project へ独立に thread/start → turn/start を送信。
        // subscribe を spawn 後・send 前に取る。
        for pid in ["proj-a", "proj-b", "proj-c"] {
            let mut rx = mgr.subscribe(pid).await.unwrap();
            // 既存 notification を捨てる
            while rx.try_recv().is_ok() {}

            // thread/start
            // multi 経由で thread/start を投げて id を取得するため少し冗長になるが、
            // mock が in-process のため共有構造体ヘルパーは使えない。
            // ここは直接 send_request で thread/start → turn/start。
            let tid = {
                let req = crate::codex_sidecar::CodexRequest::new(
                    "thread-start-1",
                    crate::codex_sidecar::protocol::method::THREAD_START,
                    Some(serde_json::json!({"model": "gpt-mock-5.5"})),
                );
                let resp = mgr.send_request(pid, req).await.unwrap();
                let r: crate::codex_sidecar::protocol::ThreadStartResult =
                    serde_json::from_value(resp.result.unwrap()).unwrap();
                r.thread.id
            };

            let req = make_turn_start_request("req-1", &tid, "hi");
            let resp = mgr.send_request(pid, req).await.unwrap();
            assert!(
                resp.error.is_none(),
                "project {pid} turn/start should succeed"
            );
            let r: TurnStartResult = serde_json::from_value(resp.result.unwrap()).unwrap();
            assert_eq!(r.turn.status, "inProgress");

            // turn/completed 待ち
            let mut got_completed = false;
            for _ in 0..200 {
                match tokio::time::timeout(std::time::Duration::from_secs(3), rx.recv()).await {
                    Ok(Ok(n)) => {
                        if n.method == event::TURN_COMPLETED {
                            got_completed = true;
                            break;
                        }
                    }
                    _ => break,
                }
            }
            assert!(
                got_completed,
                "TURN_COMPLETED notification must arrive for {pid}"
            );
        }

        // shutdown_all
        mgr.shutdown_all().await.unwrap();
        assert!(mgr.list_active().await.is_empty());
        for pid in ["proj-a", "proj-b", "proj-c"] {
            assert!(!mgr.is_alive(pid).await);
        }
    }

    #[tokio::test]
    async fn spawn_is_idempotent() {
        let mgr = MultiSidecarManager::new();
        // 1 回目は新規 → true
        let first = mgr.spawn_for("p1", SidecarMode::Mock).await.unwrap();
        assert!(first, "first spawn must report newly-created");
        // 2 回目は冪等 no-op → false
        let second = mgr.spawn_for("p1", SidecarMode::Mock).await.unwrap();
        assert!(!second, "duplicate spawn must report no-op (false)");
        assert_eq!(mgr.list_active().await.len(), 1);
    }

    #[tokio::test]
    async fn send_to_unknown_project_is_error() {
        let mgr = MultiSidecarManager::new();
        let req = make_turn_start_request("req-1", "tid", "hi");
        assert!(mgr.send_request("nope", req).await.is_err());
    }

    #[tokio::test]
    async fn shutdown_individual_removes_from_map() {
        let mgr = MultiSidecarManager::new();
        mgr.spawn_for("p1", SidecarMode::Mock).await.unwrap();
        mgr.spawn_for("p2", SidecarMode::Mock).await.unwrap();
        mgr.shutdown("p1").await.unwrap();
        let active = mgr.list_active().await;
        assert_eq!(active, vec!["p2".to_string()]);
    }

    #[tokio::test]
    async fn spawn_respects_max_concurrent_limit() {
        let mgr = MultiSidecarManager::new();
        for i in 0..MAX_CONCURRENT_SIDECARS {
            mgr.spawn_for(format!("proj-{i}"), SidecarMode::Mock)
                .await
                .unwrap();
        }
        assert_eq!(mgr.list_active().await.len(), MAX_CONCURRENT_SIDECARS);
        // 7 個目は失敗
        let r = mgr.spawn_for("proj-overflow", SidecarMode::Mock).await;
        assert!(r.is_err(), "must reject when at limit");
        let msg = format!("{:#}", r.unwrap_err());
        assert!(
            msg.contains("Max concurrent sidecars"),
            "error must mention limit: {msg}"
        );
        assert!(
            msg.contains("6"),
            "error must include constant value 6: {msg}"
        );

        // 既存 project への重複 spawn は no-op、limit 超過にカウントしない
        mgr.spawn_for("proj-0", SidecarMode::Mock).await.unwrap();
    }

    // -----------------------------------------------------------------
    // DEC-018-045 QW2 (AS-201.2): spawn_for_with_retry tests
    // -----------------------------------------------------------------

    use crate::codex_sidecar::mock::MockCodexSidecar;
    use crate::codex_sidecar::retry::SpawnAttempt;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// 失敗回数を制御できる factory を生成する helper。
    /// `fail_count` 回までは Err、それ以降は Mock を返す。
    fn make_failing_factory(
        project_id: &str,
        fail_count: usize,
        attempts: Arc<AtomicUsize>,
    ) -> impl FnMut() -> Result<Box<dyn CodexSidecar>> + use<'_> {
        let pid = project_id.to_string();
        move || {
            let n = attempts.fetch_add(1, Ordering::SeqCst) + 1;
            if n <= fail_count {
                bail!("synthetic spawn failure attempt {n}");
            }
            Ok(Box::new(MockCodexSidecar::new(pid.clone())) as Box<dyn CodexSidecar>)
        }
    }

    /// AS-201.2 DoD ②-1: 1 回目失敗 → 2 回目成功で Ok(true) + on_attempt 2 回 callback。
    #[tokio::test]
    async fn retry_succeeds_on_second_attempt() {
        let mgr = MultiSidecarManager::new();
        let policy = RetryPolicy::for_test(); // base=10, cap=100, max=3
        let attempts = Arc::new(AtomicUsize::new(0));
        let mut factory = make_failing_factory("p-r1", 1, attempts.clone());

        let cb_count = Arc::new(AtomicUsize::new(0));
        let cb_count_clone = cb_count.clone();
        let on_attempt = move |a: SpawnAttempt| {
            // attempt=1 で失敗 callback (sleep 通知含む)、attempt=2 で再試行 callback。
            cb_count_clone.fetch_add(1, Ordering::SeqCst);
            assert!(a.attempt >= 1 && a.attempt <= a.max_retries);
        };

        let result = mgr
            .spawn_for_with_retry_factory("p-r1", policy, on_attempt, &mut factory)
            .await
            .unwrap();
        assert!(result, "newly created sidecar must return true");
        assert_eq!(attempts.load(Ordering::SeqCst), 2, "factory called twice");
        // callback は最低 2 回呼ばれる: (start of attempt 1) + (sleep notice) + (start of attempt 2)
        assert!(
            cb_count.load(Ordering::SeqCst) >= 2,
            "on_attempt must be called at least twice"
        );
    }

    /// AS-201.2 DoD ②-2: 3 回連続失敗で Err（max retries exceeded）+ callback 3 回以上。
    #[tokio::test]
    async fn retry_exhausts_after_max_attempts() {
        let mgr = MultiSidecarManager::new();
        let policy = RetryPolicy::for_test(); // max=3
        let attempts = Arc::new(AtomicUsize::new(0));
        // 5 回失敗するように仕込む（max_retries=3 を超える）
        let mut factory = make_failing_factory("p-r2", 5, attempts.clone());

        let cb_count = Arc::new(AtomicUsize::new(0));
        let cb_count_clone = cb_count.clone();
        let on_attempt = move |_: SpawnAttempt| {
            cb_count_clone.fetch_add(1, Ordering::SeqCst);
        };

        let r = mgr
            .spawn_for_with_retry_factory("p-r2", policy, on_attempt, &mut factory)
            .await;
        assert!(r.is_err(), "must fail after exhausting retries");
        let msg = format!("{:#}", r.unwrap_err());
        assert!(
            msg.contains("exhausted"),
            "error must mention exhaustion: {msg}"
        );
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            3,
            "factory called exactly max_retries times"
        );
        assert!(cb_count.load(Ordering::SeqCst) >= 3);
    }

    /// AS-201.2 DoD ②-3: MaxConcurrentSidecarsReached は即 fail（retry なし）。
    #[tokio::test]
    async fn retry_does_not_retry_max_concurrent() {
        let mgr = MultiSidecarManager::new();
        // capacity を埋める
        for i in 0..MAX_CONCURRENT_SIDECARS {
            mgr.spawn_for(format!("cap-{i}"), SidecarMode::Mock)
                .await
                .unwrap();
        }
        let policy = RetryPolicy::for_test();
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_clone = attempts.clone();
        let on_attempt = move |_: SpawnAttempt| {
            attempts_clone.fetch_add(1, Ordering::SeqCst);
        };
        let r = mgr
            .spawn_for_with_retry("cap-overflow", SidecarMode::Mock, policy, on_attempt)
            .await;
        assert!(r.is_err(), "must fail at capacity");
        let msg = format!("{:#}", r.unwrap_err());
        assert!(
            msg.contains("Max concurrent sidecars"),
            "must surface MaxConcurrent error: {msg}"
        );
        // callback は 1 回（試行開始通知）のみ。retry 通知なし。
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            1,
            "must NOT retry on non-retryable error"
        );
    }

    /// AS-201.2 DoD ②-4: AlreadyExists (= 既存 sidecar) は即 Ok(false) 返却（retry なし）。
    ///
    /// AS-HOTFIX-QW6 (DEC-018-047 ⑫): 成功 callback が追加されたため、callback 回数は
    /// 2 回（試行開始 + success 通知）になる。retry は一切発生しないことを確認する。
    #[tokio::test]
    async fn retry_returns_false_for_existing_sidecar_without_retry() {
        let mgr = MultiSidecarManager::new();
        // 既存 sidecar を作る
        mgr.spawn_for("p-exist", SidecarMode::Mock).await.unwrap();

        let policy = RetryPolicy::for_test();
        let events: Arc<std::sync::Mutex<Vec<SpawnAttempt>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let events_clone = events.clone();
        let on_attempt = move |a: SpawnAttempt| {
            events_clone.lock().unwrap().push(a);
        };
        let result = mgr
            .spawn_for_with_retry("p-exist", SidecarMode::Mock, policy, on_attempt)
            .await
            .unwrap();
        assert!(!result, "existing sidecar must return false (no-op)");
        // QW6: callback は 2 回（試行開始 + success）
        let recorded = events.lock().unwrap();
        assert_eq!(recorded.len(), 2);
        assert!(!recorded[0].success, "first event must be attempt start");
        assert!(recorded[1].success, "second event must be success");
        assert!(recorded[1].last_error.is_none());
        assert!(recorded[1].next_sleep_ms.is_none());
    }

    /// AS-HOTFIX-QW6 (DEC-018-047 ⑫): 成功時に success=true の callback が
    /// 1 回だけ送出されることを確認する（「再接続中… (1/3)」消失の根拠）。
    #[tokio::test]
    async fn retry_emits_success_event_after_recovery() {
        let mgr = MultiSidecarManager::new();
        let policy = RetryPolicy::for_test(); // base=10, cap=100, max=3
        let attempts = Arc::new(AtomicUsize::new(0));
        // 1 回失敗 → 2 回目成功
        let mut factory = make_failing_factory("p-qw6", 1, attempts.clone());

        let events: Arc<std::sync::Mutex<Vec<SpawnAttempt>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let events_clone = events.clone();
        let on_attempt = move |a: SpawnAttempt| {
            events_clone.lock().unwrap().push(a);
        };

        let result = mgr
            .spawn_for_with_retry_factory("p-qw6", policy, on_attempt, &mut factory)
            .await
            .unwrap();
        assert!(result, "must create on second attempt");

        let recorded = events.lock().unwrap();
        // success=true の event が ちょうど 1 回だけ送出されていること
        let success_events: Vec<&SpawnAttempt> = recorded.iter().filter(|a| a.success).collect();
        assert_eq!(
            success_events.len(),
            1,
            "exactly one success event must be emitted: {:?}",
            recorded
        );
        let success = success_events[0];
        assert_eq!(success.attempt, 2, "success on attempt 2");
        assert!(success.last_error.is_none());
        assert!(success.next_sleep_ms.is_none());
        // success event は callback 列の最後にあること（呼び出し側 hook の順序保証）
        assert!(
            recorded.last().unwrap().success,
            "success event must be last"
        );
    }

    // -----------------------------------------------------------------
    // DEC-018-045 QW3 (AS-202.1): idle reaper tests
    // -----------------------------------------------------------------

    /// AS-202.1 DoD ①: idle 30 分超 sidecar は idle_sweep_once で除去される。
    /// last_activity を直接巻き戻して threshold 超過状態を作る（時間操作不要）。
    #[tokio::test]
    async fn idle_sweep_removes_stale_sidecar() {
        let mgr = MultiSidecarManager::new();
        mgr.spawn_for("p-idle", SidecarMode::Mock).await.unwrap();
        assert!(mgr.is_alive("p-idle").await);

        // last_activity を 1 時間前に巻き戻す（threshold=30 分超過）
        {
            let mut act = mgr.last_activity.write().await;
            act.insert(
                "p-idle".to_string(),
                SystemTime::now() - Duration::from_secs(60 * 60),
            );
        }

        let killed = mgr
            .idle_sweep_once(Duration::from_secs(SIDECAR_IDLE_THRESHOLD_SECS))
            .await;
        assert_eq!(killed, vec!["p-idle".to_string()]);
        assert!(!mgr.is_alive("p-idle").await);
        // last_activity からも除去されている
        let act = mgr.last_activity.read().await;
        assert!(!act.contains_key("p-idle"));
    }

    /// AS-202.1 DoD ②: send_request 後は last_activity_at が更新され reaper の対象から外れる。
    #[tokio::test]
    async fn send_request_resets_idle_activity() {
        let mgr = MultiSidecarManager::new();
        mgr.spawn_for("p-fresh", SidecarMode::Mock).await.unwrap();

        // 一旦古くする
        {
            let mut act = mgr.last_activity.write().await;
            act.insert(
                "p-fresh".to_string(),
                SystemTime::now() - Duration::from_secs(60 * 60),
            );
        }

        // thread/start を 1 回送って activity を更新
        let req = crate::codex_sidecar::CodexRequest::new(
            "thread-start-r1",
            crate::codex_sidecar::protocol::method::THREAD_START,
            Some(serde_json::json!({"model": "gpt-mock-5.5"})),
        );
        let _ = mgr.send_request("p-fresh", req).await.unwrap();

        // 直後に sweep しても対象外であること
        let killed = mgr
            .idle_sweep_once(Duration::from_secs(SIDECAR_IDLE_THRESHOLD_SECS))
            .await;
        assert!(
            killed.is_empty(),
            "fresh sidecar must NOT be reaped: killed={killed:?}"
        );
        assert!(mgr.is_alive("p-fresh").await);
    }

    /// AS-202.1 DoD ③: 複数 sidecar のうち idle のみ shutdown、active は維持。
    #[tokio::test]
    async fn idle_sweep_partitions_idle_and_active() {
        let mgr = MultiSidecarManager::new();
        mgr.spawn_for("p-old", SidecarMode::Mock).await.unwrap();
        mgr.spawn_for("p-new", SidecarMode::Mock).await.unwrap();

        {
            let mut act = mgr.last_activity.write().await;
            // old: 2 時間前
            act.insert(
                "p-old".to_string(),
                SystemTime::now() - Duration::from_secs(2 * 60 * 60),
            );
            // new: たった今（明示）
            act.insert("p-new".to_string(), SystemTime::now());
        }

        let mut killed = mgr
            .idle_sweep_once(Duration::from_secs(SIDECAR_IDLE_THRESHOLD_SECS))
            .await;
        killed.sort();
        assert_eq!(killed, vec!["p-old".to_string()]);
        assert!(!mgr.is_alive("p-old").await);
        assert!(mgr.is_alive("p-new").await);
    }

    /// 補助: start_idle_reaper の冪等性 + Weak 経由で Drop 後に loop が終了すること。
    /// 厳密な「task が abort された」の観測は難しいので二重起動拒否のみを検証する。
    #[tokio::test]
    async fn start_idle_reaper_is_idempotent() {
        let mgr = Arc::new(MultiSidecarManager::new());
        let started = mgr.start_idle_reaper(|_| {});
        assert!(started, "first start must succeed");
        let again = mgr.start_idle_reaper(|_| {});
        assert!(!again, "second start must be no-op");
        mgr.stop_idle_reaper();
        // stop 後は再び起動できる
        let restarted = mgr.start_idle_reaper(|_| {});
        assert!(restarted, "restart after stop must succeed");
        mgr.stop_idle_reaper();
    }
}
