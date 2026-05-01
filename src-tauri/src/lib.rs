//! Asagi (PRJ-018) — Tauri 2 Rust main process library.
//!
//! 本クレートは Tauri アプリの初期化、状態管理、コマンド登録を行う。
//! Codex sidecar 統合系のモジュール（codex_sidecar / multi_sidecar / auth /
//! image_paste / jobobject）は Phase 0 POC 通過後に本実装する（DEC-018-014）。

use std::sync::Mutex;
use tauri::Manager;

pub mod auth;
pub mod codex_sidecar;
pub mod commands;
pub mod db;
pub mod image_paste;
pub mod jobobject;
pub mod message;
pub mod multi_sidecar;
pub mod project;
pub mod session;
pub mod settings;

/// アプリ全体で共有する状態。
/// SQLite コネクションと Multi-Sidecar マップを保持する。
pub struct AppState {
    pub db: Mutex<Option<rusqlite::Connection>>,
    // Multi-Sidecar は POC 通過後に有効化
    // pub sidecars: Mutex<multi_sidecar::MultiSidecar>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            db: Mutex::new(None),
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Asagi application");
}
