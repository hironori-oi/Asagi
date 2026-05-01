//! クリップボード画像 paste（Ctrl+V）処理。
//!
//! **Phase 0 POC #4 通過後に本実装**（DEC-018-010 / 014）。
//! arboard 主、Linux は wl-paste fallback を予定。
//!
//! 関連: dev-v0.1.0-scaffold-design.md § 6.2 / AS-125

use anyhow::Result;

/// クリップボード画像を取得して PNG bytes に変換する。
/// **POC 通過後実装**。
pub fn paste_image_as_png() -> Result<Vec<u8>> {
    unimplemented!("[POC pending: AS-125 で実装]")
}
