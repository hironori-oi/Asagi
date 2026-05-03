//! Asagi (PRJ-018) — Tauri 2 Rust main process library.
//!
//! 本クレートは Tauri アプリの初期化、状態管理、コマンド登録を行う。
//! Codex sidecar 統合系モジュールは AS-130〜AS-135 で mock-first 実装済。
//! Real impl は Phase 0 POC (DEC-018-010) 通過後に `codex_sidecar/real.rs` を
//! 埋めることで切替可能（環境変数 `ASAGI_SIDECAR_MODE=real`）。

use std::sync::{Arc, Mutex};
use tauri::Manager;
use tokio::sync::RwLock;

pub mod auth;
pub mod codex_sidecar;
pub mod commands;
pub mod db;
pub mod image_paste;
pub mod message;
pub mod process;
pub mod project;
pub mod session;
pub mod settings;

use crate::codex_sidecar::auth_watchdog::{AuthWatchdog, ENV_WATCHDOG_DISABLED};
use crate::codex_sidecar::contract::AGENT_IDLE_SHUTDOWN_EVENT_SUFFIX;
use crate::codex_sidecar::multi::MultiSidecarManager;
use crate::codex_sidecar::SidecarMode;
use tauri::Emitter;

/// DEC-018-045 QW3 (AS-202.1): idle reaper を起動時に有効化するか抑止する env。
/// `1` 設定時は idle reaper task を起動しない（テスト・デバッグ用）。
const ENV_IDLE_REAPER_DISABLED: &str = "ASAGI_SIDECAR_IDLE_REAPER_DISABLED";

/// アプリ全体で共有する状態。
/// SQLite コネクションと Multi-Sidecar マップを保持する。
pub struct AppState {
    pub db: Mutex<Option<rusqlite::Connection>>,
    /// Multi-Sidecar Manager (AS-134)。mock / real を sidecar_mode で切替。
    pub multi: Arc<MultiSidecarManager>,
    /// DEC-018-028 QW1 (F3 Auth Watchdog)。`WatchdogEmitter` trait で
    /// emitter を抽象化したため、generic param は不要。
    pub auth_watchdog: Arc<RwLock<Option<AuthWatchdog>>>,
    /// DEC-018-036 / AS-144: 現在の Sidecar mode（runtime 切替可能）。
    ///
    /// 起動時は `SidecarMode::from_env()` で `ASAGI_SIDECAR_MODE` から初期化し、
    /// 以降は `agent_set_sidecar_mode` Tauri command で UI から切替可能。
    /// `agent_spawn_sidecar` は本値を読んで mock / real を選択する。
    /// 既存 sidecar はモード変更後も再 spawn まで現行モードで継続動作する
    /// （additive 切替、mock fallback 維持）。
    pub current_sidecar_mode: Arc<RwLock<SidecarMode>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            db: Mutex::new(None),
            multi: Arc::new(MultiSidecarManager::new()),
            auth_watchdog: Arc::new(RwLock::new(None)),
            current_sidecar_mode: Arc::new(RwLock::new(SidecarMode::from_env())),
        }
    }
}

/// Tauri アプリのエントリーポイント。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // tracing format を整える (AS-META-07):
    //   - 時刻 + level + target + message
    //   - ANSI 着色は terminal でのみ有効
    //   - file への rotation は M2 で `tracing-appender` を追加して対応
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "asagi=info,warn".into()),
        )
        .with_target(true)
        .with_thread_ids(false)
        .with_level(true)
        .with_ansi(true)
        .compact()
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::default())
        .setup(|app| {
            // 起動時に SQLite を初期化（~/.asagi/history.db）
            let state: tauri::State<AppState> = app.state();
            match db::init_database() {
                Ok(conn) => {
                    let mut guard = state.db.lock().expect("db mutex poisoned");
                    *guard = Some(conn);
                    tracing::info!("Asagi database initialized");
                }
                Err(e) => {
                    tracing::error!("failed to initialize database: {e:#}");
                }
            }

            // DEC-018-045 QW3 (AS-202.1): F4 idle reaper 起動。
            // `ASAGI_SIDECAR_IDLE_REAPER_DISABLED=1` で抑止可能。
            // idle 判定で shutdown された project には
            // `agent:{projectId}:idle-shutdown` event を emit する。
            let reaper_disabled =
                std::env::var(ENV_IDLE_REAPER_DISABLED).ok().as_deref() == Some("1");
            if reaper_disabled {
                tracing::info!(
                    "Sidecar idle reaper disabled by {ENV_IDLE_REAPER_DISABLED}=1"
                );
            } else {
                let multi_for_reaper = state.multi.clone();
                let app_for_reaper = app.handle().clone();
                // AS-HOTFIX-QW2 (DEC-018-046 carryover): Tauri 2 setup() は sync context のため、
                // start_idle_reaper 内部の `tokio::spawn` は runtime を見つけられず panic する。
                // L141 AuthWatchdog spawn と同じパターンで tauri::async_runtime::spawn に包む。
                // (cargo `#[tokio::test]` では runtime が常に存在するため検出不可、
                //  実機 setup() 経路を踏む smoke で初検出 — DEC-018-046 厳守事項 ⓕ 起票)
                tauri::async_runtime::spawn(async move {
                    let started = multi_for_reaper.start_idle_reaper(move |pid: &str| {
                        let event_name =
                            format!("agent:{pid}:{AGENT_IDLE_SHUTDOWN_EVENT_SUFFIX}");
                        if let Err(e) = app_for_reaper.emit(&event_name, pid.to_string()) {
                            tracing::warn!("emit {event_name} failed: {e}");
                        } else {
                            tracing::info!("Sidecar {pid} reaped (idle > threshold)");
                        }
                    });
                    if started {
                        tracing::info!(
                            "Sidecar idle reaper started (default 30min threshold)"
                        );
                    }
                });
            }

            // DEC-018-028 QW1: F3 Auth Watchdog 起動。
            // 環境変数 `ASAGI_AUTH_WATCHDOG_DISABLED=1` で抑止可能。
            // Real impl 切替時は MultiSidecarManager 配下が RealCodexSidecar に
            // 変わるだけで本 watchdog コードは無修正で動く (差し替え 1 箇所原則)。
            let disabled = std::env::var(ENV_WATCHDOG_DISABLED).ok().as_deref() == Some("1");
            if disabled {
                tracing::info!("AuthWatchdog disabled by ASAGI_AUTH_WATCHDOG_DISABLED=1");
            } else {
                let multi = state.multi.clone();
                let app_handle = app.handle().clone();
                let watchdog_slot = state.auth_watchdog.clone();
                tauri::async_runtime::spawn(async move {
                    let mut w = AuthWatchdog::with_tauri(multi, app_handle);
                    w.start();
                    let mut guard = watchdog_slot.write().await;
                    *guard = Some(w);
                    tracing::info!("AuthWatchdog started (default 5min polling)");
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::db_init,
            commands::create_session,
            commands::list_sessions,
            commands::get_session,
            commands::delete_session,
            commands::create_message,
            commands::list_messages,
            commands::count_messages,
            commands::auth_login_start,
            commands::auth_status,
            commands::agent_send_message,
            commands::agent_cancel,
            commands::codex_login,
            commands::codex_send_message,
            commands::codex_get_models,
            commands::codex_get_quota,
            commands::get_setting,
            commands::set_setting,
            commands::list_settings,
            // AS-142: clipboard image paste → data URL
            commands::paste_clipboard_image,
            // AS-134 Multi-Sidecar commands
            commands::codex::agent_spawn_sidecar,
            commands::codex::agent_send_message_v2,
            commands::codex::agent_shutdown_sidecar,
            commands::codex::agent_list_sidecars,
            commands::codex::agent_status,
            // DEC-018-026 ① C: turn 中断
            commands::codex::agent_interrupt,
            // AS-144 / DEC-018-036: Sidecar mode runtime switch (mock <-> real)
            commands::codex::agent_get_sidecar_mode,
            commands::codex::agent_set_sidecar_mode,
            // DEC-018-028 QW1 (F3 Auth Watchdog) commands
            commands::codex::auth_watchdog_start,
            commands::codex::auth_watchdog_stop,
            commands::codex::auth_watchdog_force_check,
            commands::codex::auth_watchdog_get_state,
            // DEC-018-045 QW1 (AS-200.3): re-login launcher
            commands::codex::auth_open_login,
            // AS-UX-05: Sidebar Files tab shallow tree
            commands::fs::list_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Asagi application");
}
