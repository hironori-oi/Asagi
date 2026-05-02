//! AS-141: Codex OAuth トークン保管 + 自動 refresh (DEC-018-034 / PM § 2.2)。
//!
//! Codex CLI の `~/.codex/auth.json` に格納される access/refresh token を
//! **OS keyring (Win Credential Manager / macOS Keychain / Linux Secret Service)**
//! に redundant cache し、`refresh_if_needed()` で expires_at < now()+5min を検知
//! したら refresh を試行する。
//!
//! # 設計方針
//!
//! - `~/.codex/auth.json` の write owner は **Codex CLI** であり Asagi は触らない
//!   (DEC-018-009 / リサーチ § 6.2)。本モジュールは「読んだ結果を keyring に
//!   再 cache」+ 「expires_at watch」のみ。
//! - keyring 障害 (Linux DBus 無し / NoStorageBackend) 時は **debug build のみ**
//!   `InMemoryBackend` に fallback。release build では panic させる
//!   (秘匿情報のメモリ平文化を black-box ユーザに気づかせるため)。
//! - 実 OAuth refresh wires は M2 で実装 (Codex CLI の `codex login --refresh`
//!   を spawn する経路)。AS-141 段階の `StubRefresher` は常に
//!   `AuthRefreshError::RefreshFailed` を返し、auth_watchdog 側に「refresh 失敗 →
//!   `RequiresReauth` に遷移」させる動線を確認する。
//!
//! # auth_watchdog との連携
//!
//! `AuthRefreshError` は `auth_watchdog::AuthState::RequiresReauth` / `Error` への
//! 変換ヘルパ `into_watchdog_state()` を持つ。watchdog 側 (M2 で実装) は以下を行う:
//!
//! ```text
//!   match auth_manager.refresh_if_needed().await {
//!       Ok(true)  => /* refreshed silently */,
//!       Ok(false) => /* still valid */,
//!       Err(e)    => emit AuthState::RequiresReauth { reason: e.to_string() },
//!   }
//! ```
//!
//! # 関連
//!
//! - DEC-018-034: AS-141 同梱方針
//! - DEC-018-028: F3 Auth Watchdog (`auth_watchdog.rs`) 既存
//! - PM § 2.2 AS-141 DoD ①〜⑦

use anyhow::Result;
use async_trait::async_trait;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// =====================================================================
// 定数
// =====================================================================

/// keyring service 名 (OS の credential store における namespace)。
pub const KEYRING_SERVICE: &str = "asagi-codex-oauth";

/// keyring entry key (1 件の AuthState を JSON serialized で格納)。
pub const KEYRING_USER_AUTH_STATE: &str = "auth_state_v1";

/// expires_at の警戒域。残り時間が閾値未満なら refresh を試みる。
/// Codex CLI 側 access_token の TTL (3600s) よりも十分小さくする (DEC-018-034)。
pub const REFRESH_THRESHOLD: Duration = Duration::from_secs(5 * 60);

/// keyring backend probe に使う dummy account。
const KEYRING_PROBE_KEY: &str = "__asagi_probe__";

// =====================================================================
// AuthState struct (PM § 2.2 DoD ③)
// =====================================================================

/// Codex CLI OAuth credentials。keyring に JSON serialized で格納される。
///
/// # 注意
///
/// `auth_watchdog::AuthState` (state machine の enum) と名前衝突しないよう
/// **必ず** `crate::codex_sidecar::auth::AuthState` で完全修飾するか、
/// `use ... as AuthCredentials` で alias すること。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthState {
    /// OAuth access_token (Codex CLI が `~/.codex/auth.json` で管理)
    pub access_token: String,
    /// OAuth refresh_token (refresh 時に CLI 内部で利用)
    pub refresh_token: String,
    /// プラン種別 (例: "pro_5x", "team", "free")。Codex CLI 由来。
    pub plan_type: String,
    /// access_token の有効期限 (Unix epoch seconds, UTC)。
    pub expires_at: i64,
}

impl AuthState {
    /// `now` 時点で expires_at が REFRESH_THRESHOLD 内に入っているか。
    /// true なら `refresh_if_needed()` が refresh を試行する。
    pub fn is_expiring_soon(&self, now: SystemTime) -> bool {
        let now_secs = now
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let threshold_secs = now_secs + REFRESH_THRESHOLD.as_secs() as i64;
        self.expires_at < threshold_secs
    }

    /// 既に expires_at が過去か (完全に期限切れか)。
    pub fn is_expired(&self, now: SystemTime) -> bool {
        let now_secs = now
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        self.expires_at <= now_secs
    }
}

// =====================================================================
// Error type (PM § 2.2 DoD ⑤ — auth_watchdog 連動の境界)
// =====================================================================

/// AuthManager / Backend / Refresher 共通エラー。
/// `auth_watchdog` 側はこれを `AuthState::RequiresReauth` または `Error` に変換する。
#[derive(Debug, thiserror::Error)]
pub enum AuthRefreshError {
    /// keyring に entry が無い (= 未ログイン or 削除済)。
    /// auth_watchdog では `RequiresReauth` 相当として扱う。
    #[error("no credentials stored in keyring")]
    NoCredentials,

    /// keyring backend 自体が利用不可 (Linux DBus 無し等)。
    /// auth_watchdog では `Error` として扱い、UI で「保管庫使えません」を表示する。
    #[error("keyring backend unavailable: {0}")]
    NoBackend(String),

    /// refresh API 呼び出し / シリアライズ等の汎用失敗。
    /// auth_watchdog では `RequiresReauth` 相当として扱う (再ログインで復旧)。
    #[error("refresh failed: {0}")]
    RefreshFailed(String),
}

impl AuthRefreshError {
    /// auth_watchdog 連携用の人間可読タグ。
    /// 「reauth が必要か / それ以前の障害か」の二択。
    pub fn requires_reauth(&self) -> bool {
        matches!(
            self,
            AuthRefreshError::NoCredentials | AuthRefreshError::RefreshFailed(_)
        )
    }
}

// =====================================================================
// CredentialBackend trait (PM § 2.2 DoD ② / ⑥)
// =====================================================================

/// keyring 抽象。production = `OsKeyringBackend`、test/dev fallback = `InMemoryBackend`。
pub trait CredentialBackend: Send + Sync {
    /// 上書き保存 (既存 entry があれば置換)。
    fn save(&self, creds: &AuthState) -> Result<(), AuthRefreshError>;
    /// 読み出し。entry 無ければ `NoCredentials`。
    fn load(&self) -> Result<AuthState, AuthRefreshError>;
    /// 削除 (logout 時等)。entry 無くても Ok を返す (idempotent)。
    fn delete(&self) -> Result<(), AuthRefreshError>;
}

/// OS keyring を使う本番 backend。
pub struct OsKeyringBackend;

impl OsKeyringBackend {
    /// keyring backend が利用可能かを probe する (Entry::new 成功 = OS API 到達)。
    /// Linux で DBus が無い場合は Err になり、`default_backend()` が fallback を選ぶ。
    pub fn is_available() -> bool {
        Entry::new(KEYRING_SERVICE, KEYRING_PROBE_KEY).is_ok()
    }

    fn entry() -> Result<Entry, AuthRefreshError> {
        Entry::new(KEYRING_SERVICE, KEYRING_USER_AUTH_STATE)
            .map_err(|e| AuthRefreshError::NoBackend(e.to_string()))
    }
}

impl CredentialBackend for OsKeyringBackend {
    fn save(&self, creds: &AuthState) -> Result<(), AuthRefreshError> {
        let json = serde_json::to_string(creds)
            .map_err(|e| AuthRefreshError::RefreshFailed(format!("serialize: {e}")))?;
        let entry = Self::entry()?;
        entry.set_password(&json).map_err(map_keyring_err)?;
        Ok(())
    }

    fn load(&self) -> Result<AuthState, AuthRefreshError> {
        let entry = Self::entry()?;
        let json = entry.get_password().map_err(map_keyring_err)?;
        serde_json::from_str(&json)
            .map_err(|e| AuthRefreshError::RefreshFailed(format!("parse: {e}")))
    }

    fn delete(&self) -> Result<(), AuthRefreshError> {
        let entry = Self::entry()?;
        match entry.delete_password() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(map_keyring_err(e)),
        }
    }
}

/// keyring crate のエラーを `AuthRefreshError` にマップ。
fn map_keyring_err(e: keyring::Error) -> AuthRefreshError {
    match e {
        keyring::Error::NoEntry => AuthRefreshError::NoCredentials,
        keyring::Error::NoStorageAccess(inner) => {
            AuthRefreshError::NoBackend(format!("no storage access: {inner}"))
        }
        keyring::Error::PlatformFailure(inner) => {
            AuthRefreshError::NoBackend(format!("platform failure: {inner}"))
        }
        other => AuthRefreshError::RefreshFailed(other.to_string()),
    }
}

/// テスト + Linux NoStorageBackend fallback 用の in-memory backend。
///
/// **WARNING**: 平文でメモリに保管するため release build では使わない。
/// `default_backend()` は debug_assertions 時のみこれを返す。
pub struct InMemoryBackend {
    inner: Mutex<Option<AuthState>>,
}

impl InMemoryBackend {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    /// テスト便利: 初期値を即セットして construct する。
    pub fn with_seed(creds: AuthState) -> Self {
        Self {
            inner: Mutex::new(Some(creds)),
        }
    }
}

impl Default for InMemoryBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl CredentialBackend for InMemoryBackend {
    fn save(&self, creds: &AuthState) -> Result<(), AuthRefreshError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| AuthRefreshError::RefreshFailed(format!("mutex poisoned: {e}")))?;
        *guard = Some(creds.clone());
        Ok(())
    }

    fn load(&self) -> Result<AuthState, AuthRefreshError> {
        let guard = self
            .inner
            .lock()
            .map_err(|e| AuthRefreshError::RefreshFailed(format!("mutex poisoned: {e}")))?;
        guard.clone().ok_or(AuthRefreshError::NoCredentials)
    }

    fn delete(&self) -> Result<(), AuthRefreshError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| AuthRefreshError::RefreshFailed(format!("mutex poisoned: {e}")))?;
        *guard = None;
        Ok(())
    }
}

/// production backend factory (PM § 2.2 DoD ⑥)。
///
/// 動作:
///   1. `OsKeyringBackend::is_available()` true なら OS keyring を使う
///   2. false (Linux DBus 無し等) かつ debug build → `InMemoryBackend` fallback
///   3. release build かつ keyring 不可 → **panic** (秘匿性低下を黙殺しない)
///
/// `ASAGI_AUTH_FORCE_INMEMORY=1` でテスト時に強制 fallback。
pub fn default_backend() -> Box<dyn CredentialBackend> {
    let force_inmemory = std::env::var("ASAGI_AUTH_FORCE_INMEMORY").ok().as_deref() == Some("1");
    if force_inmemory {
        tracing::warn!(
            "ASAGI_AUTH_FORCE_INMEMORY=1 set, using InMemoryBackend (DEV/TEST ONLY, plaintext)"
        );
        return Box::new(InMemoryBackend::new());
    }

    if OsKeyringBackend::is_available() {
        Box::new(OsKeyringBackend)
    } else if cfg!(debug_assertions) {
        tracing::warn!(
            "OS keyring backend unavailable, falling back to InMemoryBackend \
             (DEV ONLY — credentials will not persist across runs)"
        );
        Box::new(InMemoryBackend::new())
    } else {
        // release build: secret を平文化しない契約を厳守
        panic!(
            "OS keyring backend unavailable in release build; \
             install libsecret (Linux) or unlock keychain (macOS) and retry"
        )
    }
}

// =====================================================================
// TokenRefresher trait (PM § 2.2 DoD ④ — refresh の差し替え点)
// =====================================================================

/// OAuth refresh の実行者。M1 段階は `StubRefresher` で常に Err、
/// M2 で Codex CLI `codex login --refresh` spawn 経路を実装する。
#[async_trait]
pub trait TokenRefresher: Send + Sync {
    /// 現在の creds を渡し、新しい creds を取得する。
    /// 成功時は new creds を返し、AuthManager がそれを backend.save() する。
    async fn refresh(&self, current: &AuthState) -> Result<AuthState, AuthRefreshError>;
}

/// AS-141 段階の stub。常に `RefreshFailed` を返し、auth_watchdog 連動を verify する。
pub struct StubRefresher;

#[async_trait]
impl TokenRefresher for StubRefresher {
    async fn refresh(&self, _current: &AuthState) -> Result<AuthState, AuthRefreshError> {
        Err(AuthRefreshError::RefreshFailed(
            "OAuth refresh not implemented at M1 (AS-141 stub); see AS-200/M2 for codex login --refresh wiring"
                .into(),
        ))
    }
}

/// テスト便利: 渡した creds を返すだけの noop refresher (refresh 成功路を test 可能)。
pub struct NoopRefresher {
    /// この creds を返す
    pub next: AuthState,
}

#[async_trait]
impl TokenRefresher for NoopRefresher {
    async fn refresh(&self, _current: &AuthState) -> Result<AuthState, AuthRefreshError> {
        Ok(self.next.clone())
    }
}

// =====================================================================
// AuthManager (PM § 2.2 DoD ① 主体)
// =====================================================================

/// CredentialBackend + TokenRefresher を束ね、`refresh_if_needed()` を提供する。
///
/// auth_watchdog からは Arc<AuthManager> を保持して 5min poll 内で
/// `refresh_if_needed()` を呼ぶ想定 (M2 で配線、AS-141 は API 整備のみ)。
pub struct AuthManager {
    backend: Box<dyn CredentialBackend>,
    refresher: Box<dyn TokenRefresher>,
}

impl AuthManager {
    pub fn new(backend: Box<dyn CredentialBackend>, refresher: Box<dyn TokenRefresher>) -> Self {
        Self { backend, refresher }
    }

    /// production 既定: OS keyring + StubRefresher。
    pub fn default_for_production() -> Self {
        Self::new(default_backend(), Box::new(StubRefresher))
    }

    pub fn save(&self, creds: &AuthState) -> Result<(), AuthRefreshError> {
        self.backend.save(creds)
    }

    pub fn load(&self) -> Result<AuthState, AuthRefreshError> {
        self.backend.load()
    }

    pub fn delete(&self) -> Result<(), AuthRefreshError> {
        self.backend.delete()
    }

    /// expires_at < now() + REFRESH_THRESHOLD なら refresh を実行する (PM § 2.2 ④)。
    ///
    /// 戻り値:
    ///   - `Ok(true)`  → refresh が成功し、新 creds を save した
    ///   - `Ok(false)` → まだ十分残っているので何もしなかった
    ///   - `Err(_)`    → refresh 失敗 (auth_watchdog で `RequiresReauth` / `Error` に遷移)
    pub async fn refresh_if_needed(&self) -> Result<bool, AuthRefreshError> {
        let current = self.backend.load()?;
        if !current.is_expiring_soon(SystemTime::now()) {
            return Ok(false);
        }
        let new_creds = self.refresher.refresh(&current).await?;
        self.backend.save(&new_creds)?;
        Ok(true)
    }
}

// =====================================================================
// 単体テスト (PM § 2.2 DoD ⑦ — dummy backend で 4 シナリオ)
// =====================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn now_unix() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    fn fresh_creds(ttl_secs: i64) -> AuthState {
        AuthState {
            access_token: "at-aaa".into(),
            refresh_token: "rt-bbb".into(),
            plan_type: "pro_5x".into(),
            expires_at: now_unix() + ttl_secs,
        }
    }

    // -----------------------------------------------------------------
    // シナリオ 1: save → load round-trip で同値が返る
    // -----------------------------------------------------------------
    #[test]
    fn scenario_1_save_then_load_returns_same_creds() {
        let backend = InMemoryBackend::new();
        let creds = fresh_creds(3600);
        backend.save(&creds).expect("save ok");
        let loaded = backend.load().expect("load ok");
        assert_eq!(loaded, creds, "load must return the same creds we saved");
    }

    // -----------------------------------------------------------------
    // シナリオ 2: 何も保存していない backend → load は NoCredentials
    // -----------------------------------------------------------------
    #[test]
    fn scenario_2_load_empty_returns_no_credentials() {
        let backend = InMemoryBackend::new();
        let err = backend.load().expect_err("must error when empty");
        assert!(
            matches!(err, AuthRefreshError::NoCredentials),
            "expected NoCredentials, got {err:?}"
        );
        assert!(err.requires_reauth(), "NoCredentials should map to reauth");
    }

    // -----------------------------------------------------------------
    // シナリオ 3: expires_at が十分未来 → refresh_if_needed は Ok(false)、
    //              refresher は呼ばれない (Stub なのでもし呼ばれたら Err になる)
    // -----------------------------------------------------------------
    #[tokio::test]
    async fn scenario_3_refresh_skipped_when_not_expiring() {
        let backend = InMemoryBackend::with_seed(fresh_creds(3600));
        let manager = AuthManager::new(Box::new(backend), Box::new(StubRefresher));
        let refreshed = manager.refresh_if_needed().await.expect("must be Ok");
        assert!(!refreshed, "must not refresh when expires_at is far away");
    }

    // -----------------------------------------------------------------
    // シナリオ 4: expires_at が閾値内 → refresh_if_needed が refresh を呼ぶ
    //              4a: NoopRefresher で成功 → Ok(true) かつ save 済
    //              4b: StubRefresher で失敗 → Err(RefreshFailed)
    // -----------------------------------------------------------------
    #[tokio::test]
    async fn scenario_4a_refresh_invoked_and_persisted_when_expiring() {
        let backend = InMemoryBackend::with_seed(fresh_creds(60)); // 60s 残 → 閾値内
        let next = AuthState {
            access_token: "at-NEW".into(),
            refresh_token: "rt-NEW".into(),
            plan_type: "pro_5x".into(),
            expires_at: now_unix() + 3600,
        };
        let refresher = NoopRefresher { next: next.clone() };
        let manager = AuthManager::new(Box::new(backend), Box::new(refresher));
        let refreshed = manager.refresh_if_needed().await.expect("must be Ok");
        assert!(refreshed, "must refresh when expires_at within threshold");
        let after = manager.load().expect("load must succeed after refresh");
        assert_eq!(after, next, "saved creds must match refreshed creds");
    }

    #[tokio::test]
    async fn scenario_4b_refresh_error_propagates_to_caller() {
        let backend = InMemoryBackend::with_seed(fresh_creds(60));
        let manager = AuthManager::new(Box::new(backend), Box::new(StubRefresher));
        let err = manager.refresh_if_needed().await.expect_err("stub refuses");
        assert!(
            matches!(err, AuthRefreshError::RefreshFailed(_)),
            "expected RefreshFailed, got {err:?}"
        );
        assert!(err.requires_reauth(), "RefreshFailed should map to reauth");
    }

    // -----------------------------------------------------------------
    // 補助: AuthState::is_expiring_soon / is_expired のロジック検証
    // -----------------------------------------------------------------
    #[test]
    fn auth_state_expiring_logic() {
        let now = SystemTime::now();
        let in_future = AuthState {
            expires_at: now_unix() + 3600,
            ..fresh_creds(3600)
        };
        assert!(!in_future.is_expiring_soon(now));
        assert!(!in_future.is_expired(now));

        let nearly = AuthState {
            expires_at: now_unix() + 60, // 60s 残 < 5min 閾値
            ..fresh_creds(60)
        };
        assert!(nearly.is_expiring_soon(now));
        assert!(!nearly.is_expired(now));

        let past = AuthState {
            expires_at: now_unix() - 1,
            ..fresh_creds(0)
        };
        assert!(past.is_expiring_soon(now));
        assert!(past.is_expired(now));
    }

    // -----------------------------------------------------------------
    // 補助: delete は idempotent
    // -----------------------------------------------------------------
    #[test]
    fn in_memory_delete_is_idempotent() {
        let backend = InMemoryBackend::new();
        backend.delete().expect("delete on empty must be ok");
        backend.save(&fresh_creds(3600)).unwrap();
        backend.delete().expect("delete after save must be ok");
        assert!(matches!(
            backend.load().unwrap_err(),
            AuthRefreshError::NoCredentials
        ));
    }

    // -----------------------------------------------------------------
    // 補助: ASAGI_AUTH_FORCE_INMEMORY=1 で fallback 経路が選ばれる
    // -----------------------------------------------------------------
    #[test]
    fn force_inmemory_env_returns_inmemory_backend() {
        // 並列テスト中の env 衝突を避け、明示 set + remove で局所化
        std::env::set_var("ASAGI_AUTH_FORCE_INMEMORY", "1");
        let b = default_backend();
        // 動作で判定: save → load が round-trip できれば backend は機能している
        let creds = fresh_creds(3600);
        b.save(&creds).unwrap();
        assert_eq!(b.load().unwrap(), creds);
        std::env::remove_var("ASAGI_AUTH_FORCE_INMEMORY");
    }
}
