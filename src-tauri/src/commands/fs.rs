//! Filesystem commands (AS-UX-05 / DEC-018-037 §①).
//!
//! Sidebar の Files タブが shallow tree（cwd 直下のみ、深さ 1）を表示するための
//! 軽量 list_dir 実装。深い再帰展開や glob filter は AS-UX-07 (M1.1) で対応する。
//!
//! 設計判断:
//!   - `tauri-plugin-fs` は scope ベースのため動的 cwd 切替に向かない
//!   - shallow tree なので read_dir 1 回で十分（perf 上もコスト無し）
//!   - hidden file (.git, node_modules 等) はデフォルトで除外し、
//!     `include_hidden=true` で取得可能とする（M1.1 で UI 切替予定）

use serde::{Deserialize, Serialize};
use std::path::Path;

/// 1 件のエントリ。type は file / dir / symlink を区別する。
#[derive(Debug, Clone, Serialize)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    /// "file" | "dir" | "symlink"
    pub kind: &'static str,
    /// ファイルサイズ (dir / symlink は None)。
    pub size: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct ListDirArgs {
    pub path: String,
    /// 隠しファイル (`.` で始まる) と `node_modules` / `.git` を含めるか。
    /// 既定 false。
    #[serde(default)]
    pub include_hidden: bool,
}

const HIDDEN_DIR_DEFAULTS: &[&str] = &[".git", "node_modules", ".next", "out", ".turbo"];

/// shallow list_dir（深さ 1）。失敗時はエラーメッセージを文字列で返す。
#[tauri::command]
pub fn list_dir(args: ListDirArgs) -> Result<Vec<FsEntry>, String> {
    let p = Path::new(&args.path);
    if !p.exists() {
        return Err(format!("path not found: {}", args.path));
    }
    if !p.is_dir() {
        return Err(format!("not a directory: {}", args.path));
    }
    let read = std::fs::read_dir(p).map_err(|e| format!("read_dir failed: {e}"))?;
    let mut out: Vec<FsEntry> = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !args.include_hidden {
            if name.starts_with('.') {
                continue;
            }
            if HIDDEN_DIR_DEFAULTS.contains(&name.as_str()) {
                continue;
            }
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let kind: &'static str = if meta.file_type().is_symlink() {
            "symlink"
        } else if meta.is_dir() {
            "dir"
        } else {
            "file"
        };
        let size = if meta.is_file() { Some(meta.len()) } else { None };
        let path = entry.path().to_string_lossy().to_string();
        out.push(FsEntry {
            name,
            path,
            kind,
            size,
        });
    }
    // dir → file の順、各内アルファベット昇順
    out.sort_by(|a, b| match (a.kind, b.kind) {
        ("dir", "file") => std::cmp::Ordering::Less,
        ("file", "dir") => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_dir_returns_entries_for_temp() {
        let tmp = std::env::temp_dir();
        let res = list_dir(ListDirArgs {
            path: tmp.to_string_lossy().to_string(),
            include_hidden: false,
        });
        assert!(res.is_ok(), "list_dir should succeed for temp dir");
    }

    #[test]
    fn list_dir_rejects_missing_path() {
        let res = list_dir(ListDirArgs {
            path: "C:/this/path/should/not/exist/asagi-test".to_string(),
            include_hidden: false,
        });
        assert!(res.is_err());
    }
}
