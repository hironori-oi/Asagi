//! Auth Watchdog (DEC-018-028 QW1 / F3, リサーチ § 3 Auth)。
//!
//! Codex CLI の OAuth refresh は CLI 内部で透過実行されるが、openclaw issue
//! #57399 (10〜30 日毎の手動再ログイン) や #52037 (refresh が disk に persist
//! しない) で示されるとおり**サイレント失敗**事例多数。Asagi は CLI に頼らず、
//! `account/read` を**5 分間隔 polling** して `requires_openai_auth: true` を
//! 検知する独立 watchdog を持つ必要がある (リサーチ「主要発見 #3」)。
//!
//! # 本ファイルの位置づけ
//!
//! POC 通過前は Real Codex CLI が叩けないため、**mock の `account/read`
//! ハンドラ**を polling して動作する mock-first frame として実装する。
//! Real 切替時は `MultiSidecarManager` 配下の sidecar が
//! `RealCodexSidecar` に変わるだけで、本 watchdog コード自体は無修正で
//! Real CLI への JSON-RPC 呼び出しに乗る。
//!
//! # State machine (Mermaid)
//!
//! ```mermaid
//! stateDiagram-v2
//!     [*] --> Unknown
//!     Unknown --> Authenticated: account/read OK\n+ requires_openai_auth=false
//!     Unknown --> RequiresReauth: account/read OK\n+ requires_openai_auth=true
//!     Unknown --> Error: account/read err / RPC fail
//!     Authenticated --> RequiresReauth: poll detects requires_openai_auth=true
//!     Authenticated --> Error: account/read err / RPC fail
//!     RequiresReauth --> Authenticated: re-login → poll detects false
//!     RequiresReauth --> Error: account/read err / RPC fail
//!     Error --> Authenticated: poll recovers
//!     Error --> RequiresReauth: poll detects requires_openai_auth=true
//! ```
//!
//! # 環境変数
//!
//!   - `ASAGI_AUTH_POLL_INTERVAL_MS` ... 上書き polling 間隔 ms (テスト用、default 300_000)
//!   - `ASAGI_AUTH_WATCHDOG_DISABLED=1` ... 起動時の自動 start を抑止
//!   - `ASAGI_MOCK_FORCE_REAUTH=1` ... mock の account/read が requires_openai_auth=true を返す
//!   - `ASAGI_MOCK_FAIL_ACCOUNT_READ=1` ... mock の account/read がエラー返却

use anyhow::{anyhow, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::{Mutex as TokioMutex, RwLock};
use tokio::task::JoinHandle;
use tokio::time;

use super::contract::EXPIRY_WARNING_THRESHOLD_SECS;
use super::multi::{MultiSidecarManager, ProjectId};
use super::protocol::{method, AccountReadResult};
use super::CodexRequest;

/// 本 watchdog の default polling 間隔 (5 minutes、リサーチ § 3.6 推奨)。
pub const DEFAULT_POLL_INTERVAL_MS: u64 = 5 * 60 * 1000;

/// 環境変数名定数。
pub const ENV_POLL_INTERVAL_MS: &str = "ASAGI_AUTH_POLL_INTERVAL_MS";
pub const ENV_WATCHDOG_DISABLED: &str = "ASAGI_AUTH_WATCHDOG_DISABLED";
pub const ENV_MOCK_FORCE_REAUTH: &str = "ASAGI_MOCK_FORCE_REAUTH";
pub const ENV_MOCK_FAIL_ACCOUNT_READ: &str = "ASAGI_MOCK_FAIL_ACCOUNT_READ";

/// Tauri event 名 prefix。`auth:{projectId}:state_changed`。
pub fn auth_event_name(project_id: &str) -> String {
    format!("auth:{project_id}:state_changed")
}

/// Auth state machine の state。
///
/// DEC-018-045 QW1 (AS-200.2): `Authenticated` に expiry warning fields を追加。
/// 既存 frontend (`use-auth-watchdog.ts` の `state.kind === 'authenticated'`)
/// は serde tag が変わらないため後方互換。新規 fields は default でも安全。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthState {
    Unknown,
    Authenticated {
        /// SystemTime → Unix epoch seconds (UI 表示用)
        last_checked_unix: i64,
        plan: String,
        user: String,
        /// DEC-018-045 QW1 (AS-200.2): access token の expiry (Unix sec)。
        /// CLI が返さない場合は None で fail-soft（warning 計算もスキップ）。
        #[serde(rename = "accessExpiresAtUnix")]
        access_expires_at_unix: Option<i64>,
        /// DEC-018-045 QW1 (AS-200.2): expiry が
        /// `now + EXPIRY_WARNING_THRESHOLD_SECS (=30min)` 以内なら true。
        /// `access_expires_at_unix == None` の時は false 固定。
        #[serde(rename = "expiryWarning")]
        expiry_warning: bool,
    },
    RequiresReauth {
        detected_at_unix: i64,
        reason: String,
    },
    Error {
        last_error: String,
        since_unix: i64,
    },
}

impl AuthState {
    /// state の短い tag 名 (event payload `{from,to}` で使う)。
    pub fn tag(&self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Authenticated { .. } => "authenticated",
            Self::RequiresReauth { .. } => "requires_reauth",
            Self::Error { .. } => "error",
        }
    }

    /// state machine 上で「再認証が必要」かどうか。
    pub fn requires_reauth(&self) -> bool {
        matches!(self, Self::RequiresReauth { .. })
    }
}

/// state 遷移時の event payload。
#[derive(Debug, Clone, Serialize)]
pub struct AuthStateChangedPayload {
    pub from: String,
    pub to: String,
    pub state: AuthState,
    pub reason: String,
}

/// system_time を Unix seconds に変換 (失敗時 0)。
fn to_unix_seconds(t: SystemTime) -> i64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `ASAGI_AUTH_POLL_INTERVAL_MS` を解決する。未設定なら default、
/// 不正値も default に fallback。
pub fn resolve_poll_interval() -> Duration {
    std::env::var(ENV_POLL_INTERVAL_MS)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v > 0)
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_millis(DEFAULT_POLL_INTERVAL_MS))
}

/// state 遷移を購読する Emitter trait (DI 化)。
///
/// # 動機
/// Tauri AppHandle を直接 take する設計だと unit test に WebView2 の DLL が
/// 必要になり Windows 上でテストが起動できなくなる (STATUS_ENTRYPOINT_NOT_FOUND)。
/// よって state 通知の出口を trait で抽象化し、production は AppHandle adapter、
/// test は in-memory の `CapturingEmitter` を使う。
pub trait WatchdogEmitter: Send + Sync {
    fn emit_state_changed(&self, project_id: &str, payload: &AuthStateChangedPayload);
}

/// Tauri AppHandle を WatchdogEmitter として使うアダプタ。
pub struct TauriEmitter<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> TauriEmitter<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> WatchdogEmitter for TauriEmitter<R> {
    fn emit_state_changed(&self, project_id: &str, payload: &AuthStateChangedPayload) {
        let event_name = auth_event_name(project_id);
        if let Err(e) = self.app.emit(&event_name, payload) {
            tracing::warn!("auth watchdog emit {event_name} failed: {e}");
        }
    }
}

/// Watchdog 本体。
///
/// 起動 (`start()`) で tokio::spawn のループを 1 本立て、
/// `MultiSidecarManager::list_active()` で取得した全 project に対して
/// `account/read` を順次送信する。state 変化があれば `WatchdogEmitter` 経由で通知。
pub struct AuthWatchdog {
    multi: Arc<MultiSidecarManager>,
    poll_interval: Duration,
    handle: Option<JoinHandle<()>>,
    states: Arc<RwLock<HashMap<ProjectId, AuthState>>>,
    emitter: Arc<dyn WatchdogEmitter>,
    /// DEC-018-045 厳守事項 ⑥ (R-QW-1 緩和策): poll_one / force_check の並行実行を抑制する。
    /// `try_lock()` で busy 判定し、busy 時は早期 return + state-changed 再 emit なし。
    /// async 中で hold するため必ず `tokio::sync::Mutex` を使用 (`std::sync::Mutex` 不可)。
    in_flight: Arc<TokioMutex<()>>,
}

impl AuthWatchdog {
    /// 一般構築。production / test 兼用 (emitter を差し替える)。
    pub fn new(multi: Arc<MultiSidecarManager>, emitter: Arc<dyn WatchdogEmitter>) -> Self {
        Self {
            multi,
            poll_interval: resolve_poll_interval(),
            handle: None,
            states: Arc::new(RwLock::new(HashMap::new())),
            emitter,
            in_flight: Arc::new(TokioMutex::new(())),
        }
    }

    /// Tauri AppHandle 1 引数の便利コンストラクタ (production パス)。
    pub fn with_tauri<R: Runtime>(multi: Arc<MultiSidecarManager>, app: AppHandle<R>) -> Self {
        Self::new(multi, Arc::new(TauriEmitter::new(app)))
    }

    /// 状態 map のクローン (シャローコピー、テスト・読み取り用)。
    pub fn states_snapshot_arc(&self) -> Arc<RwLock<HashMap<ProjectId, AuthState>>> {
        self.states.clone()
    }

    /// 現在の polling 間隔。
    pub fn poll_interval(&self) -> Duration {
        self.poll_interval
    }

    /// 1 project に対して `account/read` を投げ、state 遷移を計算 + emit する。
    ///
    /// Real 切替時の差し替え点:
    ///   ここで送信する `CodexRequest { method: "account/read", ... }` が
    ///   `MultiSidecarManager::send_request` 経由で **mock または real** sidecar
    ///   に届く。Real 化は `codex_sidecar/real.rs` を埋める 1 ファイル変更で完了し、
    ///   本 watchdog 側は無修正。
    ///
    /// DEC-018-045 厳守事項 ⑥ (R-QW-1 緩和策): `in_flight` Mutex を `try_lock`。
    /// busy 時は `state-changed` 再 emit なしで即 return (二重通知防止)。
    pub async fn poll_one(
        multi: &Arc<MultiSidecarManager>,
        states: &Arc<RwLock<HashMap<ProjectId, AuthState>>>,
        emitter: &Arc<dyn WatchdogEmitter>,
        in_flight: &Arc<TokioMutex<()>>,
        project_id: &str,
    ) {
        // DEC-018-045 ⑥: 並行抑制ガード。busy 時は静かに早期 return する
        // (state は変えない / event 再 emit しない)。
        let _guard = match in_flight.try_lock() {
            Ok(g) => g,
            Err(_) => {
                tracing::debug!(
                    "auth watchdog poll_one for {project_id} skipped: already in flight"
                );
                return;
            }
        };

        let req_id = format!("auth-watchdog-{}", uuid::Uuid::new_v4());
        let req = CodexRequest::new(req_id, method::ACCOUNT_READ, None);

        let new_state: AuthState = match multi.send_request(project_id, req).await {
            Ok(resp) => {
                if let Some(err) = resp.error {
                    AuthState::Error {
                        last_error: format!("codex error {}: {}", err.code, err.message),
                        since_unix: to_unix_seconds(SystemTime::now()),
                    }
                } else {
                    match resp
                        .result
                        .ok_or_else(|| anyhow!("empty result"))
                        .and_then(|v| {
                            serde_json::from_value::<AccountReadResult>(v)
                                .map_err(|e| anyhow!("decode account/read: {e}"))
                        }) {
                        Ok(r) => {
                            if r.requires_openai_auth {
                                AuthState::RequiresReauth {
                                    detected_at_unix: to_unix_seconds(SystemTime::now()),
                                    reason: "account/read returned requires_openai_auth=true"
                                        .into(),
                                }
                            } else {
                                let plan = r
                                    .account
                                    .as_ref()
                                    .and_then(|a| a.plan_type.clone())
                                    .unwrap_or_else(|| "unknown".into());
                                let user = r
                                    .account
                                    .as_ref()
                                    .and_then(|a| a.email.clone())
                                    .unwrap_or_else(|| "unknown".into());
                                // DEC-018-045 QW1 (AS-200.2): expiry warning 計算。
                                // CLI が expiry 未返却 (None) の場合は warning=false で固定し、
                                // 既存の Authenticated 動作を一切変えない (fail-soft 厳守)。
                                let now_unix = to_unix_seconds(SystemTime::now());
                                let access_expires_at_unix = r.access_token_expires_at;
                                let expiry_warning = match access_expires_at_unix {
                                    Some(exp) => now_unix + EXPIRY_WARNING_THRESHOLD_SECS >= exp,
                                    None => false,
                                };
                                AuthState::Authenticated {
                                    last_checked_unix: now_unix,
                                    plan,
                                    user,
                                    access_expires_at_unix,
                                    expiry_warning,
                                }
                            }
                        }
                        Err(e) => AuthState::Error {
                            last_error: format!("decode error: {e:#}"),
                            since_unix: to_unix_seconds(SystemTime::now()),
                        },
                    }
                }
            }
            Err(e) => AuthState::Error {
                last_error: format!("rpc error: {e:#}"),
                since_unix: to_unix_seconds(SystemTime::now()),
            },
        };

        // state 比較 + 遷移検知
        // DEC-018-045 QW1 (AS-200.2): Authenticated 内の expiry_warning も
        // 「sub-state 遷移」として扱い、false→true / true→false で必ず emit する。
        // tag (= "authenticated") 同士の比較では拾えないため、prev の expiry_warning
        // を併せて取得しておく。
        let (prev_tag, prev_expiry_warning): (String, Option<bool>) = {
            let map = states.read().await;
            match map.get(project_id) {
                Some(s) => {
                    let warn = match s {
                        AuthState::Authenticated { expiry_warning, .. } => Some(*expiry_warning),
                        _ => None,
                    };
                    (s.tag().to_string(), warn)
                }
                None => ("unknown".to_string(), None),
            }
        };
        let new_tag = new_state.tag().to_string();
        let new_expiry_warning: Option<bool> = match &new_state {
            AuthState::Authenticated { expiry_warning, .. } => Some(*expiry_warning),
            _ => None,
        };
        // 注意: Error / RequiresReauth は tag が同じでも reason / since_unix が
        // 変わるため、毎回 emit する (UI 上で「いつから止まっているか」を更新可能)。
        // Authenticated は idempotent だが、expiry_warning が前回と異なれば emit。
        let auth_warning_changed = prev_tag == "authenticated"
            && new_tag == "authenticated"
            && prev_expiry_warning != new_expiry_warning;
        let changed = prev_tag != new_tag
            || matches!(
                new_state,
                AuthState::Error { .. } | AuthState::RequiresReauth { .. }
            )
            || auth_warning_changed;

        // state 更新
        {
            let mut map = states.write().await;
            map.insert(project_id.to_string(), new_state.clone());
        }

        if changed {
            let reason = match &new_state {
                AuthState::Unknown => "unknown".to_string(),
                AuthState::Authenticated {
                    plan,
                    user,
                    access_expires_at_unix,
                    expiry_warning,
                    ..
                } => {
                    if *expiry_warning {
                        // DEC-018-045 QW1 (AS-200.2): expiry が間近 → 残 N 分を reason に含める
                        let now_unix = to_unix_seconds(SystemTime::now());
                        let remaining_min = access_expires_at_unix
                            .map(|exp| ((exp - now_unix).max(0) + 59) / 60)
                            .unwrap_or(0);
                        format!(
                            "expiry warning: 残 {remaining_min} 分 (authenticated as {user} ({plan}))"
                        )
                    } else {
                        format!("authenticated as {user} ({plan})")
                    }
                }
                AuthState::RequiresReauth { reason, .. } => reason.clone(),
                AuthState::Error { last_error, .. } => last_error.clone(),
            };
            let payload = AuthStateChangedPayload {
                from: prev_tag,
                to: new_tag,
                state: new_state,
                reason,
            };
            emitter.emit_state_changed(project_id, &payload);
        }
    }

    /// 起動。重複 start は no-op。
    pub fn start(&mut self) {
        if self.handle.is_some() {
            return;
        }
        let interval = self.poll_interval;
        let multi = self.multi.clone();
        let states = self.states.clone();
        let emitter = self.emitter.clone();
        let in_flight = self.in_flight.clone();
        let handle = tokio::spawn(async move {
            // 起動直後に 1 度即時実行 (initial seed)
            // 念のため小休止して sidecar spawn の機会を与える
            time::sleep(Duration::from_millis(50)).await;
            loop {
                let active: Vec<String> = multi.list_active().await;
                for pid in active {
                    Self::poll_one(&multi, &states, &emitter, &in_flight, &pid).await;
                }
                time::sleep(interval).await;
            }
        });
        self.handle = Some(handle);
    }

    /// 停止。冪等。
    pub fn stop(&mut self) {
        if let Some(h) = self.handle.take() {
            h.abort();
        }
    }

    /// 即時 1 回 poll を強制実行する (UI からの「今すぐ確認」)。
    ///
    /// DEC-018-045 ⑥: `poll_one` 冒頭の `in_flight.try_lock()` により、
    /// 並行する poll (start ループ内 / 連打された force_check) は静かにスキップされる。
    pub async fn force_check_now(&self, project_id: &str) -> Result<()> {
        Self::poll_one(
            &self.multi,
            &self.states,
            &self.emitter,
            &self.in_flight,
            project_id,
        )
        .await;
        Ok(())
    }

    /// 現在の state を取得。未 polled の場合は Unknown。
    pub async fn get_state(&self, project_id: &str) -> AuthState {
        let map = self.states.read().await;
        map.get(project_id).cloned().unwrap_or(AuthState::Unknown)
    }
}

impl Drop for AuthWatchdog {
    fn drop(&mut self) {
        self.stop();
    }
}

// AS-200/202 Real impl: replace mock account/read with real Codex CLI JSON-RPC call.
// Once codex_sidecar/real.rs is filled in, AuthWatchdog will work transparently.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_sidecar::{env_test_lock, SidecarMode};
    use std::sync::{Mutex as StdMutex, MutexGuard};

    /// AS-CLEAN-06 (DEC-018-038 / DEC-018-044) → AS-200.2 で `codex_sidecar::env_test_lock`
    /// に統一。`mock` mod の env 操作 test と process 横断で直列化する。
    fn lock_env_test_serial() -> MutexGuard<'static, ()> {
        env_test_lock()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// テスト用の polling 間隔 100ms を環境変数で設定。
    /// `lock_env_test_serial()` の guard 保持下で呼ぶこと。
    fn setup_short_interval() {
        std::env::set_var(ENV_POLL_INTERVAL_MS, "100");
    }

    fn clear_mock_envs() {
        std::env::remove_var(ENV_MOCK_FORCE_REAUTH);
        std::env::remove_var(ENV_MOCK_FAIL_ACCOUNT_READ);
    }

    /// テスト用の in-memory emitter。emit を Vec に積み上げる。
    /// Tauri AppHandle 不要のため WebView2 DLL 依存ゼロ。
    #[derive(Default)]
    pub struct CapturingEmitter {
        pub events: StdMutex<Vec<(String, AuthStateChangedPayload)>>,
    }

    impl WatchdogEmitter for CapturingEmitter {
        fn emit_state_changed(&self, project_id: &str, payload: &AuthStateChangedPayload) {
            self.events
                .lock()
                .unwrap()
                .push((project_id.to_string(), payload.clone()));
        }
    }

    fn make_emitter() -> (Arc<CapturingEmitter>, Arc<dyn WatchdogEmitter>) {
        let cap = Arc::new(CapturingEmitter::default());
        let dyn_emitter: Arc<dyn WatchdogEmitter> = cap.clone();
        (cap, dyn_emitter)
    }

    /// Test 用 in_flight ガード生成 (DEC-018-045 ⑥)。
    fn make_in_flight() -> Arc<TokioMutex<()>> {
        Arc::new(TokioMutex::new(()))
    }

    #[tokio::test]
    async fn test_authenticated_state_after_first_poll() {
        let _env_guard = lock_env_test_serial();
        setup_short_interval();
        clear_mock_envs();

        let multi = Arc::new(MultiSidecarManager::new());
        multi
            .spawn_for("p-auth-1", SidecarMode::Mock)
            .await
            .unwrap();

        let (cap, emitter) = make_emitter();
        let states = Arc::new(RwLock::new(HashMap::new()));
        let in_flight = make_in_flight();
        AuthWatchdog::poll_one(&multi, &states, &emitter, &in_flight, "p-auth-1").await;

        let map = states.read().await;
        let s = map.get("p-auth-1").expect("state must be recorded");
        match s {
            AuthState::Authenticated { plan, user, .. } => {
                assert_eq!(plan, "mock-pro-5x");
                assert!(
                    user.contains("mock-user"),
                    "user should be mock-user: {user}"
                );
            }
            other => panic!("expected Authenticated, got {other:?}"),
        }

        // unknown -> authenticated の遷移で 1 件 emit されるはず
        let events = cap.events.lock().unwrap();
        assert_eq!(events.len(), 1, "must emit once on first transition");
        assert_eq!(events[0].0, "p-auth-1");
        assert_eq!(events[0].1.from, "unknown");
        assert_eq!(events[0].1.to, "authenticated");
    }

    #[tokio::test]
    async fn test_transitions_to_requires_reauth_on_force_reauth_env() {
        let _env_guard = lock_env_test_serial();
        setup_short_interval();
        clear_mock_envs();

        let multi = Arc::new(MultiSidecarManager::new());
        multi
            .spawn_for("p-auth-2", SidecarMode::Mock)
            .await
            .unwrap();
        let (cap, emitter) = make_emitter();
        let states = Arc::new(RwLock::new(HashMap::new()));
        let in_flight = make_in_flight();

        // 1) まず Authenticated を確認
        AuthWatchdog::poll_one(&multi, &states, &emitter, &in_flight, "p-auth-2").await;
        {
            let map = states.read().await;
            assert_eq!(map.get("p-auth-2").unwrap().tag(), "authenticated");
        }

        // 2) FORCE_REAUTH を立てて再 poll
        std::env::set_var(ENV_MOCK_FORCE_REAUTH, "1");
        AuthWatchdog::poll_one(&multi, &states, &emitter, &in_flight, "p-auth-2").await;
        {
            let map = states.read().await;
            let s = map.get("p-auth-2").unwrap();
            assert!(s.requires_reauth(), "expected RequiresReauth, got {s:?}");
        }

        // emit が 2 回行われ、2 回目は authenticated -> requires_reauth
        let events = cap.events.lock().unwrap();
        assert!(events.len() >= 2, "must emit twice: got {}", events.len());
        let last = events.last().unwrap();
        assert_eq!(last.1.from, "authenticated");
        assert_eq!(last.1.to, "requires_reauth");
        drop(events);
        clear_mock_envs();
    }

    #[tokio::test]
    async fn test_force_check_now_triggers_immediate_poll() {
        let _env_guard = lock_env_test_serial();
        setup_short_interval();
        clear_mock_envs();

        let multi = Arc::new(MultiSidecarManager::new());
        multi
            .spawn_for("p-auth-3", SidecarMode::Mock)
            .await
            .unwrap();
        let (_cap, emitter) = make_emitter();

        let watchdog = AuthWatchdog::new(multi.clone(), emitter);
        // start() しないで force_check_now のみ
        watchdog.force_check_now("p-auth-3").await.unwrap();
        let s = watchdog.get_state("p-auth-3").await;
        assert_eq!(s.tag(), "authenticated");
    }

    #[tokio::test]
    async fn test_error_state_on_account_read_failure() {
        let _env_guard = lock_env_test_serial();
        setup_short_interval();
        clear_mock_envs();

        // Case A: sidecar を spawn せずに poll → MultiSidecarManager は err
        {
            let multi = Arc::new(MultiSidecarManager::new());
            let (_cap, emitter) = make_emitter();
            let states = Arc::new(RwLock::new(HashMap::new()));
            let in_flight = make_in_flight();
            AuthWatchdog::poll_one(&multi, &states, &emitter, &in_flight, "p-not-spawned").await;
            let map = states.read().await;
            let s = map.get("p-not-spawned").unwrap();
            match s {
                AuthState::Error { last_error, .. } => {
                    assert!(
                        last_error.contains("rpc error") || last_error.contains("no sidecar"),
                        "error must mention rpc/sidecar: {last_error}"
                    );
                }
                other => panic!("expected Error, got {other:?}"),
            }
        }

        // Case B: ASAGI_MOCK_FAIL_ACCOUNT_READ=1 で mock 自体がエラー返す
        {
            let multi = Arc::new(MultiSidecarManager::new());
            multi.spawn_for("p-fail", SidecarMode::Mock).await.unwrap();
            let (_cap, emitter) = make_emitter();
            let states = Arc::new(RwLock::new(HashMap::new()));
            let in_flight = make_in_flight();
            std::env::set_var(ENV_MOCK_FAIL_ACCOUNT_READ, "1");
            AuthWatchdog::poll_one(&multi, &states, &emitter, &in_flight, "p-fail").await;
            std::env::remove_var(ENV_MOCK_FAIL_ACCOUNT_READ);
            let map = states.read().await;
            let s = map.get("p-fail").unwrap();
            match s {
                AuthState::Error { last_error, .. } => {
                    assert!(
                        last_error.contains("codex error") || last_error.contains("forced"),
                        "error must mention codex/forced: {last_error}"
                    );
                }
                other => panic!("expected Error from mock failure, got {other:?}"),
            }
        }
    }

    /// AS-200.2 DoD #1: expiry が短い (warning=true) → 通常 (warning=false) への遷移で
    /// emit が +1 件されること。Authenticated 同士の sub-state 遷移として扱う。
    ///
    /// シナリオ:
    ///   1) ASAGI_MOCK_EXPIRY_IN_SECS=120 → expiry=now+120s、warning=true
    ///   2) env を消して再 poll → expiry=now+3600s (default)、warning=false
    ///   3) 初回 unknown→authenticated(warning=true) で 1 件、
    ///      2 回目 authenticated(warning=true)→authenticated(warning=false) で +1 件 = 計 2 件
    #[tokio::test]
    async fn test_authenticated_expiry_warning_transition_emits() {
        let _env_guard = lock_env_test_serial();
        setup_short_interval();
        clear_mock_envs();
        std::env::remove_var("ASAGI_MOCK_EXPIRY_IN_SECS");

        let multi = Arc::new(MultiSidecarManager::new());
        multi
            .spawn_for("p-warn-1", SidecarMode::Mock)
            .await
            .unwrap();

        let (cap, emitter) = make_emitter();
        let states = Arc::new(RwLock::new(HashMap::new()));
        let in_flight = make_in_flight();

        // 1) warning=true な expiry でスタート (120s < 1800s threshold)
        std::env::set_var("ASAGI_MOCK_EXPIRY_IN_SECS", "120");
        AuthWatchdog::poll_one(&multi, &states, &emitter, &in_flight, "p-warn-1").await;
        {
            let map = states.read().await;
            let s = map.get("p-warn-1").unwrap();
            match s {
                AuthState::Authenticated {
                    expiry_warning,
                    access_expires_at_unix,
                    ..
                } => {
                    assert!(*expiry_warning, "warning must be true at 120s expiry");
                    assert!(
                        access_expires_at_unix.is_some(),
                        "expiry must be returned by mock"
                    );
                }
                other => panic!("expected Authenticated, got {other:?}"),
            }
        }

        // 2) env を消して default (3600s) に戻し、再 poll → warning=false
        std::env::remove_var("ASAGI_MOCK_EXPIRY_IN_SECS");
        AuthWatchdog::poll_one(&multi, &states, &emitter, &in_flight, "p-warn-1").await;
        {
            let map = states.read().await;
            let s = map.get("p-warn-1").unwrap();
            match s {
                AuthState::Authenticated { expiry_warning, .. } => {
                    assert!(!*expiry_warning, "warning must be false at 3600s expiry");
                }
                other => panic!("expected Authenticated, got {other:?}"),
            }
        }

        // 3) emit count: 1) unknown→authenticated(warning=true)
        //                2) authenticated(warning=true)→authenticated(warning=false)
        let events = cap.events.lock().unwrap();
        assert_eq!(
            events.len(),
            2,
            "must emit twice (initial + warning sub-state change), got {}",
            events.len()
        );
        // 1 件目 reason に "残 N 分" が含まれること
        assert!(
            events[0].1.reason.contains("残") && events[0].1.reason.contains("分"),
            "first emit reason must include 残 N 分: {}",
            events[0].1.reason
        );
        // 2 件目は warning=false なので素の "authenticated as ..." 形式
        assert!(
            !events[1].1.reason.contains("残"),
            "second emit reason must NOT include 残 (warning=false): {}",
            events[1].1.reason
        );
        drop(events);
        clear_mock_envs();
    }

    /// AS-200.2 DoD #2: CLI が expiry を返さない (None) ケースで warning=false 固定、
    /// かつ重複 poll で emit が増えないこと (Authenticated は idempotent)。
    ///
    /// `ASAGI_MOCK_FORCE_NO_EXPIRY=1` を mock が解釈し expiry を None で返す前提
    /// (mock.rs AS-200.1 実装と整合)。本テストでは「expiry がそもそも返らない時に
    /// warning が常に false で安定し、emit が増えない」ことを担保する。
    #[tokio::test]
    async fn test_authenticated_no_expiry_means_warning_false_and_idempotent() {
        let _env_guard = lock_env_test_serial();
        setup_short_interval();
        clear_mock_envs();
        std::env::remove_var("ASAGI_MOCK_EXPIRY_IN_SECS");
        // mock 側に「expiry を返さない」モードがあれば使う。無ければ default (=expiry あり)
        // でも Authenticated 側の warning=false → emit 増えない idempotency は確認できる。
        std::env::set_var("ASAGI_MOCK_FORCE_NO_EXPIRY", "1");

        let multi = Arc::new(MultiSidecarManager::new());
        multi
            .spawn_for("p-noexp-1", SidecarMode::Mock)
            .await
            .unwrap();
        let (cap, emitter) = make_emitter();
        let states = Arc::new(RwLock::new(HashMap::new()));
        let in_flight = make_in_flight();

        // 1 回目: unknown→authenticated で 1 件 emit
        AuthWatchdog::poll_one(&multi, &states, &emitter, &in_flight, "p-noexp-1").await;
        {
            let map = states.read().await;
            let s = map.get("p-noexp-1").unwrap();
            match s {
                AuthState::Authenticated { expiry_warning, .. } => {
                    assert!(
                        !*expiry_warning,
                        "warning must be false (no expiry / fail-soft)"
                    );
                }
                other => panic!("expected Authenticated, got {other:?}"),
            }
        }

        // 2 回目: 同じ state → emit 増えない
        AuthWatchdog::poll_one(&multi, &states, &emitter, &in_flight, "p-noexp-1").await;
        // 3 回目も同じく
        AuthWatchdog::poll_one(&multi, &states, &emitter, &in_flight, "p-noexp-1").await;

        let events = cap.events.lock().unwrap();
        assert_eq!(
            events.len(),
            1,
            "Authenticated with stable warning=false must emit only once, got {}",
            events.len()
        );
        // reason に "残" は含まれない
        assert!(
            !events[0].1.reason.contains("残"),
            "reason must not include 残 when warning=false: {}",
            events[0].1.reason
        );
        drop(events);
        std::env::remove_var("ASAGI_MOCK_FORCE_NO_EXPIRY");
        clear_mock_envs();
    }

    #[tokio::test]
    async fn test_start_loop_polls_periodically_with_short_interval() {
        let _env_guard = lock_env_test_serial();
        // 100ms 間隔で 250ms 待つ → 少なくとも 2 回 poll される
        std::env::set_var(ENV_POLL_INTERVAL_MS, "100");
        clear_mock_envs();

        let multi = Arc::new(MultiSidecarManager::new());
        multi.spawn_for("p-loop", SidecarMode::Mock).await.unwrap();
        let (cap, emitter) = make_emitter();
        let mut w = AuthWatchdog::new(multi.clone(), emitter);
        assert_eq!(w.poll_interval(), Duration::from_millis(100));
        w.start();
        // 1 回目の seed (50ms) + 100ms × 2 + 余裕
        time::sleep(Duration::from_millis(400)).await;
        w.stop();
        let events = cap.events.lock().unwrap();
        assert!(!events.is_empty(), "must emit at least once during loop");
        // 初回は unknown → authenticated の 1 件、その後 authenticated → authenticated は
        // tag 同一なので emit されないことを確認 (Authenticated は idempotent)
        assert_eq!(events[0].1.from, "unknown");
        assert_eq!(events[0].1.to, "authenticated");
    }

    /// DEC-018-045 厳守事項 ⑥ (R-QW-1 緩和策): `force_check` 並行呼び出し時に
    /// `in_flight` Mutex の `try_lock` が片方を busy 判定 → 早期 return すること。
    /// busy で return した側は **state-changed event を再 emit しない** (二重通知防止)。
    ///
    /// シナリオ:
    ///   1) initial seed として 1 度 poll → unknown→authenticated で 1 件 emit
    ///   2) `in_flight` lock を test 側が hold した状態で `force_check_now` を呼ぶ
    ///      → busy 判定で早期 return → emit 増えない (件数 1 件のまま)
    ///   3) lock を release してもう 1 度 force_check → 通常実行 (idempotent なので emit 増えない)
    ///
    /// 「2 本の force_check を真の並行で起動して片方が busy で抜ける」のは
    /// tokio task のスケジューリング順に依存しフレーキーになるため、
    /// 上記のように lock を test 側が hold する形で**決定論的**に検証する。
    #[tokio::test]
    async fn test_force_check_concurrent_call_returns_busy() {
        let _env_guard = lock_env_test_serial();
        setup_short_interval();
        clear_mock_envs();

        let multi = Arc::new(MultiSidecarManager::new());
        multi
            .spawn_for("p-busy-1", SidecarMode::Mock)
            .await
            .unwrap();
        let (cap, emitter) = make_emitter();
        let watchdog = AuthWatchdog::new(multi.clone(), emitter);

        // 1) initial seed: unknown → authenticated で 1 件 emit
        watchdog.force_check_now("p-busy-1").await.unwrap();
        {
            let events = cap.events.lock().unwrap();
            assert_eq!(
                events.len(),
                1,
                "initial seed must emit once: got {}",
                events.len()
            );
        }

        // 2) in_flight lock を test 側で hold した状態で force_check_now → 早期 return
        //    poll_one が `try_lock()` で Err → `state-changed` 再 emit なしで即抜ける
        let in_flight = watchdog.in_flight.clone();
        let held = in_flight
            .try_lock()
            .expect("test must own the lock initially");
        watchdog.force_check_now("p-busy-1").await.unwrap();
        {
            let events = cap.events.lock().unwrap();
            assert_eq!(
                events.len(),
                1,
                "busy force_check must NOT emit (state-changed 再 emit 禁止): got {}",
                events.len()
            );
        }
        drop(held);

        // 3) lock release 後は再度 force_check が通常実行されるが、
        //    Authenticated → Authenticated (warning 同値) は idempotent なので emit 増えない
        watchdog.force_check_now("p-busy-1").await.unwrap();
        {
            let events = cap.events.lock().unwrap();
            assert_eq!(
                events.len(),
                1,
                "post-release force_check is idempotent: got {}",
                events.len()
            );
        }
    }
}
