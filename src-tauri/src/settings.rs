//! Asagi 設定永続化 (AS-META-06)。
//!
//! tauri-plugin-store による key/value persist。
//! `~/.asagi/store.json` 相当に置かれる JSON ストアで、テーマ・ロケール・
//! 直近 active project / session 等の app-wide 設定を保持する。
//!
//! - localStorage との整理:
//!   - localStorage = frontend-only ephemeral data (Welcome step 等)
//!   - tauri store  = app-wide persistent data (theme / locale / lastActiveProjectId)
//!
//! 関連 DEC: DEC-018-021 (品質基盤継続着手)

use serde::{Deserialize, Serialize};

/// Asagi 設定キー一覧。`Display` で文字列化して store のキーに使う。
///
/// 文字列リテラルを散らさないよう一元管理。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum SettingKey {
    Theme,
    Locale,
    LastActiveProjectId,
    LastActiveSessionId,
    WindowWidth,
    WindowHeight,
    PreferredModel,
    ReasoningEffort,
}

impl SettingKey {
    pub const fn as_str(&self) -> &'static str {
        match self {
            SettingKey::Theme => "theme",
            SettingKey::Locale => "locale",
            SettingKey::LastActiveProjectId => "lastActiveProjectId",
            SettingKey::LastActiveSessionId => "lastActiveSessionId",
            SettingKey::WindowWidth => "windowWidth",
            SettingKey::WindowHeight => "windowHeight",
            SettingKey::PreferredModel => "preferredModel",
            SettingKey::ReasoningEffort => "reasoningEffort",
        }
    }

    /// 既知キー一覧。`list_settings` でクライアント返却に使う。
    pub const fn all() -> &'static [SettingKey] {
        &[
            SettingKey::Theme,
            SettingKey::Locale,
            SettingKey::LastActiveProjectId,
            SettingKey::LastActiveSessionId,
            SettingKey::WindowWidth,
            SettingKey::WindowHeight,
            SettingKey::PreferredModel,
            SettingKey::ReasoningEffort,
        ]
    }
}

/// store に書く JSON ファイル名 (~/.asagi/store.json 相当)。
pub const STORE_FILE: &str = "settings.json";
