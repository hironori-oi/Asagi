//! Codex CLI 実体バイナリの解決ヘルパ (AS-140.1)。
//!
//! POC #5 の resolve_codex_bin() を Rust 化したもの。優先順位:
//!
//! 1. 環境変数 `ASAGI_CODEX_BIN_PATH` （テスト・カスタム配置用 override）
//! 2. Windows: `%APPDATA%\<contract::CODEX_BIN_WIN_RELATIVE>` （npm `@openai/codex` グローバル経由の標準 path）
//! 3. PATH 上の `codex` バイナリ（cmd ラッパ経由 — fallback only、JobObject 制約あり）
//!
//! **重要**: cmd ラッパ経由 spawn は JobObject 結合がラッパ PID にしか効かず、
//! 実体プロセスが breakaway する事例が POC #5 で観測された。Windows では必ず ②
//! の実体 .exe path を優先採用する（DEC-018-033 ②）。

use anyhow::{anyhow, Context, Result};
use std::path::PathBuf;

use super::contract::CODEX_BIN_WIN_RELATIVE;

/// 環境変数による override キー名。
pub const ENV_CODEX_BIN_PATH: &str = "ASAGI_CODEX_BIN_PATH";

/// Codex 実体 .exe（Win）または `codex` 実行ファイル（Unix）への絶対パスを解決する。
///
/// エラー時は「解決を試みた候補すべてが見つからなかった」旨の説明的メッセージを返す。
pub fn resolve_codex_bin() -> Result<PathBuf> {
    // Step 1: env override
    if let Ok(p) = std::env::var(ENV_CODEX_BIN_PATH) {
        let path = PathBuf::from(&p);
        if path.is_file() {
            return Ok(path);
        }
        return Err(anyhow!(
            "{ENV_CODEX_BIN_PATH} is set to '{p}' but the file does not exist"
        ));
    }

    // Step 2: Windows %APPDATA% 標準 path
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            let mut p = PathBuf::from(appdata);
            p.push(CODEX_BIN_WIN_RELATIVE);
            if p.is_file() {
                return Ok(p);
            }
        }
    }

    // Step 3: PATH 上の `codex`（最終 fallback）
    if let Some(p) = which_codex() {
        return Ok(p);
    }

    Err(anyhow!(
        "codex binary not found. Tried: ${ENV_CODEX_BIN_PATH} env, %APPDATA%\\{CODEX_BIN_WIN_RELATIVE}, PATH"
    ))
}

/// PATH 上の `codex`（または Windows では `codex.cmd`）を探す。
/// `which` クレートを足さずに最小実装する。
fn which_codex() -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    let candidates: &[&str] = if cfg!(windows) {
        &["codex.exe", "codex.cmd", "codex"]
    } else {
        &["codex"]
    };
    for dir in std::env::split_paths(&path_env) {
        for name in candidates {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// オーナー smoke で「どの path を使ったか」を logs / report にダンプするための説明文。
pub fn describe_resolution(path: &std::path::Path) -> Result<String> {
    let canon =
        std::fs::canonicalize(path).with_context(|| format!("canonicalize failed for {path:?}"))?;
    Ok(format!("codex bin resolved at: {}", canon.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_override_to_missing_file_returns_error() {
        // SAFETY: テスト中 env を一時 set / 戻す。並列テストは serial_test 推奨だが
        // 単独 process 内なら本ケースに限って影響なし。
        let key = ENV_CODEX_BIN_PATH;
        let prior = std::env::var(key).ok();
        std::env::set_var(key, "Z:/definitely/does/not/exist/codex.exe");
        let r = resolve_codex_bin();
        // restore
        match prior {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
        let err = r.expect_err("missing override file must error");
        let msg = format!("{err}");
        assert!(msg.contains("does not exist"), "msg should explain: {msg}");
    }

    #[test]
    fn env_override_to_existing_file_returns_path() {
        let tmp = std::env::temp_dir().join("asagi-resolve-test.txt");
        std::fs::write(&tmp, b"fake codex").unwrap();

        let key = ENV_CODEX_BIN_PATH;
        let prior = std::env::var(key).ok();
        std::env::set_var(key, &tmp);
        let r = resolve_codex_bin();
        match prior {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }

        let p = r.expect("must resolve to override path");
        assert_eq!(p, tmp);

        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn describe_resolution_reports_canonicalized_path() {
        let tmp = std::env::temp_dir().join("asagi-resolve-describe.txt");
        std::fs::write(&tmp, b"x").unwrap();
        let s = describe_resolution(&tmp).unwrap();
        assert!(s.contains("codex bin resolved at"), "unexpected: {s}");
        let _ = std::fs::remove_file(&tmp);
    }
}
