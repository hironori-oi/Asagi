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
use crate::codex_sidecar::multi::MultiSidecarManager;

/// アプリ全体で共有する状態。
/// SQLite コネクションと Multi-Sidecar マップを保持する。
pub struct AppState {
    pub db: Mutex<Option<rusqlite::Connection>>,
    /// Multi-Sidecar Manager (AS-134)。mock / real を sidecar_mode で切替。
    pub multi: Arc<MultiSidecarManager>,
    /// DEC-018-028 QW1 (F3 Auth Watchdog)。`WatchdogEmitter` trait で
    /// emitter を抽象化したため、generic param は不要。
    pub auth_watchdog: Arc<RwLock<Option<AuthWatchdog>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            db: Mutex::new(None),
            multi: Arc::new(MultiSidecarManager::new()),
            auth_watchdog: Arc::new(RwLock::new(None)),
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
            // AS-134 Multi-Sidecar commands
            commands::codex::agent_spawn_sidecar,
            commands::codex::agent_send_message_v2,
            commands::codex::agent_shutdown_sidecar,
            commands::codex::agent_list_sidecars,
            commands::codex::agent_status,
            // DEC-018-026 ① C: turn 中断
            commands::codex::agent_interrupt,
            // DEC-018-028 QW1 (F3 Auth Watchdog) commands
            commands::codex::auth_watchdog_start,
            commands::codex::auth_watchdog_stop,
            commands::codex::auth_watchdog_force_check,
            commands::codex::auth_watchdog_get_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Asagi application");
}
