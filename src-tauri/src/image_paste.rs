//! AS-142: クリップボード画像 paste → data URL → JSON-RPC `turn/start` input part 化。
//!
//! POC #4 (2026-05-02 オーナー実機 / Docker Desktop ロゴ画像 / 7.34s 完走) で
//! 実証済の `{type:"image", url:"data:image/png;base64,..."}` schema を、
//! `contract::IMAGE_INPUT_TYPE` / `IMAGE_URL_FIELD` 経由でハードコード排除して実装する。
//!
//! # 受理 / 拒否 MIME (DEC-018-030)
//!
//!   - **受理**: PNG, JPEG
//!   - **拒否**: BMP, TIFF, SVG, HEIC, GIF, WebP, その他
//!   - **拒否**: 0 byte / フォーマット推定不能
//!
//! 拒否理由は UI で「対応していない画像形式」として通知する想定 (M1 ChatPane 側で実装)。
//!
//! # 関連
//!
//! - DEC-018-033 ②: `IMAGE_INPUT_TYPE="image"` / `IMAGE_URL_FIELD="url"` 固定
//! - DEC-018-030: base64 fallback 方針 (data URL 直渡し)
//! - PM § 2.3 AS-142 DoD ①〜⑧

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use image::{guess_format, GenericImageView, ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use std::io::Cursor;

use crate::codex_sidecar::contract::{IMAGE_INPUT_TYPE, IMAGE_URL_FIELD};

// =====================================================================
// 受理 MIME / 拒否ポリシー
// =====================================================================

/// 受理 MIME 種別 (PM § 2.3 DoD ③ — DEC-018-030 と整合)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageMime {
    Png,
    Jpeg,
}

impl ImageMime {
    /// data URL 用 MIME 文字列。
    pub fn as_data_url_mime(&self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
        }
    }

    /// `image::ImageFormat` に変換。
    pub fn to_image_format(&self) -> ImageFormat {
        match self {
            Self::Png => ImageFormat::Png,
            Self::Jpeg => ImageFormat::Jpeg,
        }
    }
}

/// AS-142 専用エラー (UI へ理由を伝えるため variant 分離)。
#[derive(Debug, thiserror::Error)]
pub enum ImagePasteError {
    #[error("clipboard image is empty (0 bytes)")]
    Empty,
    #[error("unsupported image format (only PNG / JPEG accepted)")]
    Unsupported,
    #[error("clipboard contained no image")]
    NoImage,
    #[error("clipboard backend unavailable: {0}")]
    ClipboardError(String),
    #[error("image decode failed: {0}")]
    DecodeError(String),
    #[error("PNG encode failed: {0}")]
    EncodeError(String),
}

// =====================================================================
// MIME 推定 + 受理 / 拒否 (PM § 2.3 DoD ③)
// =====================================================================

/// `image::guess_format` を使い受理 MIME に正規化する。
///
/// 0 byte / 推定不能 / BMP/TIFF/SVG/HEIC/GIF/WebP は `Err`。
pub fn detect_accepted_mime(bytes: &[u8]) -> Result<ImageMime, ImagePasteError> {
    if bytes.is_empty() {
        return Err(ImagePasteError::Empty);
    }
    let fmt = guess_format(bytes).map_err(|_| ImagePasteError::Unsupported)?;
    match fmt {
        ImageFormat::Png => Ok(ImageMime::Png),
        ImageFormat::Jpeg => Ok(ImageMime::Jpeg),
        _ => Err(ImagePasteError::Unsupported),
    }
}

/// PM § 2.3 DoD ③: dimensions が parseable か (壊れた header の早期検知)。
/// 戻り値: (width, height)。壊れた image なら `Err`。
pub fn validate_image_dimensions(
    bytes: &[u8],
    mime: ImageMime,
) -> Result<(u32, u32), ImagePasteError> {
    let cursor = Cursor::new(bytes);
    let reader = ImageReader::with_format(cursor, mime.to_image_format());
    let img = reader
        .decode()
        .map_err(|e| ImagePasteError::DecodeError(e.to_string()))?;
    Ok(img.dimensions())
}

// =====================================================================
// data URL 生成 (PM § 2.3 DoD ④)
// =====================================================================

/// `data:<mime>;base64,<encoded>` の data URL を組み立てる。
pub fn encode_data_url(bytes: &[u8], mime: ImageMime) -> String {
    let b64 = BASE64_STANDARD.encode(bytes);
    format!("data:{};base64,{}", mime.as_data_url_mime(), b64)
}

// =====================================================================
// JSON-RPC `turn/start` input part 化 (PM § 2.3 DoD ⑤ / ⑥)
// =====================================================================

/// `{type:"image", url:"data:image/png;base64,..."}` JSON 値を組み立てる。
///
/// **重要**: `IMAGE_INPUT_TYPE` / `IMAGE_URL_FIELD` を `contract.rs` から import
/// しているため、schema 文字列は本ファイルにハードコードされない (DEC-018-034 / PM § 6.5)。
pub fn build_image_input_part(bytes: &[u8], mime: ImageMime) -> Result<JsonValue, ImagePasteError> {
    if bytes.is_empty() {
        return Err(ImagePasteError::Empty);
    }
    // dimensions 検証 (壊れた header の早期 reject)
    validate_image_dimensions(bytes, mime)?;
    let url = encode_data_url(bytes, mime);
    Ok(json!({
        "type": IMAGE_INPUT_TYPE,
        IMAGE_URL_FIELD: url,
    }))
}

/// 自動 MIME 推定版: `detect_accepted_mime()` → `build_image_input_part()`。
pub fn build_image_input_part_auto(bytes: &[u8]) -> Result<JsonValue, ImagePasteError> {
    let mime = detect_accepted_mime(bytes)?;
    build_image_input_part(bytes, mime)
}

// =====================================================================
// クリップボード PNG 取得 (PM § 2.3 DoD ② / ⑧)
// =====================================================================

/// クリップボードから画像を取得し、PNG bytes として返す。
///
/// 戻り値:
///   - `Ok(Vec<u8>)` ... PNG bytes (PNG として再 encode 済)
///   - `Err(NoImage)` ... クリップボードに画像がない
///   - `Err(ClipboardError)` ... arboard 初期化 / アクセス失敗
///   - `Err(EncodeError)` ... PNG 化失敗
///
/// 内部で arboard `Clipboard::get_image()` から RGBA8 raw を受け取り、
/// `image::RgbaImage` 経由で PNG に再 encode する。これにより HEIC / TIFF など
/// 受理 MIME 外の形式が混じっていても出力は必ず PNG になる。
pub fn paste_image_as_png() -> Result<Vec<u8>, ImagePasteError> {
    use arboard::{Clipboard, ImageData};

    let mut clipboard =
        Clipboard::new().map_err(|e| ImagePasteError::ClipboardError(e.to_string()))?;
    let img: ImageData = clipboard.get_image().map_err(|e| match e {
        arboard::Error::ContentNotAvailable => ImagePasteError::NoImage,
        other => ImagePasteError::ClipboardError(other.to_string()),
    })?;

    let width = img.width as u32;
    let height = img.height as u32;
    let raw: Vec<u8> = img.bytes.into_owned();

    encode_rgba_to_png(&raw, width, height)
}

/// RGBA8 raw bytes (4 bytes/px) を PNG に encode する純粋関数 (テスト容易)。
pub fn encode_rgba_to_png(
    rgba: &[u8],
    width: u32,
    height: u32,
) -> Result<Vec<u8>, ImagePasteError> {
    let expected = (width as usize) * (height as usize) * 4;
    if rgba.len() != expected {
        return Err(ImagePasteError::EncodeError(format!(
            "rgba length {} != expected {} (w={}, h={})",
            rgba.len(),
            expected,
            width,
            height
        )));
    }
    let img = image::RgbaImage::from_raw(width, height, rgba.to_vec())
        .ok_or_else(|| ImagePasteError::EncodeError("RgbaImage::from_raw returned None".into()))?;
    let mut out = Vec::with_capacity(expected / 4);
    let dyn_img = image::DynamicImage::ImageRgba8(img);
    dyn_img
        .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
        .map_err(|e| ImagePasteError::EncodeError(e.to_string()))?;
    Ok(out)
}

// =====================================================================
// 高レベル: クリップボード → InputItem JSON (PM § 2.3 DoD ⑧ Tauri command 用)
// =====================================================================

/// クリップボード paste 1 ステップ: get_image → PNG → data URL → InputItem JSON。
///
/// Tauri command `paste_clipboard_image()` の本体。frontend は戻り値の JSON を
/// そのまま `turn/start` の input 配列に push できる。
pub fn paste_clipboard_image_as_input_part() -> Result<JsonValue, ImagePasteError> {
    let png = paste_image_as_png()?;
    build_image_input_part(&png, ImageMime::Png)
}

// =====================================================================
// anyhow 互換ヘルパ (既存 API 維持)
// =====================================================================

/// 旧 stub `paste_image_as_png() -> anyhow::Result<Vec<u8>>` 互換ヘルパ。
/// commands 層から `?` で受けやすくする。
pub fn paste_image_as_png_anyhow() -> Result<Vec<u8>> {
    paste_image_as_png()
        .map_err(|e| anyhow!(e.to_string()))
        .context("paste_image_as_png failed")
}

// =====================================================================
// 単体テスト (PM § 2.3 DoD ⑦ — 4 fixture)
// =====================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// 1×1 PNG fixture (黒 1px、image crate でランタイム生成)。
    fn fixture_png_1x1() -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(1, 1, image::Rgba([0, 0, 0, 255]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .expect("write png fixture");
        out
    }

    /// 1×1 JPEG fixture (白 1px)。
    fn fixture_jpeg_1x1() -> Vec<u8> {
        let img = image::RgbImage::from_pixel(1, 1, image::Rgb([255, 255, 255]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Jpeg)
            .expect("write jpeg fixture");
        out
    }

    /// 1×1 BMP fixture (赤 1px) — DoD ③ で reject されること。
    fn fixture_bmp_1x1() -> Vec<u8> {
        let img = image::RgbImage::from_pixel(1, 1, image::Rgb([255, 0, 0]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Bmp)
            .expect("write bmp fixture");
        out
    }

    // -----------------------------------------------------------------
    // Fixture 1/4: PNG accepted
    // -----------------------------------------------------------------
    #[test]
    fn fixture_1_png_is_accepted_and_round_trips() {
        let png = fixture_png_1x1();
        assert_eq!(detect_accepted_mime(&png).unwrap(), ImageMime::Png);
        let (w, h) = validate_image_dimensions(&png, ImageMime::Png).unwrap();
        assert_eq!((w, h), (1, 1));
        let part = build_image_input_part(&png, ImageMime::Png).unwrap();
        assert_eq!(part["type"], IMAGE_INPUT_TYPE);
        assert!(part[IMAGE_URL_FIELD]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }

    // -----------------------------------------------------------------
    // Fixture 2/4: JPEG accepted
    // -----------------------------------------------------------------
    #[test]
    fn fixture_2_jpeg_is_accepted() {
        let jpeg = fixture_jpeg_1x1();
        assert_eq!(detect_accepted_mime(&jpeg).unwrap(), ImageMime::Jpeg);
        let part = build_image_input_part(&jpeg, ImageMime::Jpeg).unwrap();
        assert_eq!(part["type"], IMAGE_INPUT_TYPE);
        assert!(part[IMAGE_URL_FIELD]
            .as_str()
            .unwrap()
            .starts_with("data:image/jpeg;base64,"));
    }

    // -----------------------------------------------------------------
    // Fixture 3/4: BMP rejected
    // -----------------------------------------------------------------
    #[test]
    fn fixture_3_bmp_is_rejected() {
        let bmp = fixture_bmp_1x1();
        let err = detect_accepted_mime(&bmp).expect_err("BMP must be rejected");
        assert!(matches!(err, ImagePasteError::Unsupported), "got {err:?}");
        let err2 = build_image_input_part_auto(&bmp).expect_err("BMP via auto must reject");
        assert!(matches!(err2, ImagePasteError::Unsupported), "got {err2:?}");
    }

    // -----------------------------------------------------------------
    // Fixture 4/4: 0 byte rejected
    // -----------------------------------------------------------------
    #[test]
    fn fixture_4_zero_bytes_is_rejected() {
        let err = detect_accepted_mime(&[]).expect_err("0 byte must be rejected");
        assert!(matches!(err, ImagePasteError::Empty), "got {err:?}");
        let err2 =
            build_image_input_part(&[], ImageMime::Png).expect_err("0 byte via build must reject");
        assert!(matches!(err2, ImagePasteError::Empty), "got {err2:?}");
    }

    // -----------------------------------------------------------------
    // Golden test: build_image_input_part の JSON が contract.rs と完全整合
    // (DEC-018-034 / PM § 6.5 — schema 違反検知)
    // -----------------------------------------------------------------
    #[test]
    fn golden_json_uses_contract_rs_constants_only() {
        let png = fixture_png_1x1();
        let part = build_image_input_part(&png, ImageMime::Png).unwrap();
        // type = contract::IMAGE_INPUT_TYPE ("image")
        assert_eq!(part["type"].as_str().unwrap(), IMAGE_INPUT_TYPE);
        // 旧誤値 "image_url" は **絶対に出現しない**
        assert!(
            part.get("image_url").is_none(),
            "image_url field must not exist"
        );
        // 正しい field 名は contract::IMAGE_URL_FIELD ("url")
        assert!(part.get(IMAGE_URL_FIELD).is_some());
        // 想定外フィールドが乗っていないこと (将来の schema 漏洩防止)
        let obj = part.as_object().expect("must be object");
        let keys: Vec<&str> = obj.keys().map(|s| s.as_str()).collect();
        assert!(
            keys.iter().all(|k| *k == "type" || *k == IMAGE_URL_FIELD),
            "unexpected keys: {keys:?}"
        );
    }

    // -----------------------------------------------------------------
    // 補助: encode_data_url の prefix 整合
    // -----------------------------------------------------------------
    #[test]
    fn encode_data_url_prefix_matches_mime() {
        assert!(encode_data_url(b"abc", ImageMime::Png).starts_with("data:image/png;base64,"));
        assert!(encode_data_url(b"abc", ImageMime::Jpeg).starts_with("data:image/jpeg;base64,"));
    }

    // -----------------------------------------------------------------
    // 補助: encode_rgba_to_png は length mismatch を detect する
    // -----------------------------------------------------------------
    #[test]
    fn encode_rgba_to_png_rejects_length_mismatch() {
        let bad = vec![0u8; 3]; // 1×1×4=4 が正しい
        let err = encode_rgba_to_png(&bad, 1, 1).expect_err("must reject");
        assert!(matches!(err, ImagePasteError::EncodeError(_)));
    }

    // -----------------------------------------------------------------
    // 補助: encode_rgba_to_png 1×1 success
    // -----------------------------------------------------------------
    #[test]
    fn encode_rgba_to_png_1x1_success() {
        let rgba = vec![10, 20, 30, 255];
        let png = encode_rgba_to_png(&rgba, 1, 1).expect("encode ok");
        assert_eq!(detect_accepted_mime(&png).unwrap(), ImageMime::Png);
        let (w, h) = validate_image_dimensions(&png, ImageMime::Png).unwrap();
        assert_eq!((w, h), (1, 1));
    }
}
