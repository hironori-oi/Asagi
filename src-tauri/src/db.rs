//! SQLite 初期化と migration。
//!
//! `~/.asagi/history.db` を rusqlite (bundled + FTS5) で開き、
//! `sessions` / `messages` / `messages_fts` のスキーマを作成する。
//!
//! 関連: dev-v0.1.0-scaffold-design.md § 1.3

use std::path::PathBuf;

use anyhow::{Context, Result};
use rusqlite::Connection;

/// `~/.asagi/history.db` のパスを返す。
/// OS ごとに `dirs::home_dir()` を基準に解決する。
pub fn database_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("failed to resolve home directory")?;
    let asagi_dir = home.join(".asagi");
    std::fs::create_dir_all(&asagi_dir)
        .with_context(|| format!("failed to create directory: {}", asagi_dir.display()))?;
    Ok(asagi_dir.join("history.db"))
}

/// SQLite を開いて初期 migration を流す。
pub fn init_database() -> Result<Connection> {
    let path = database_path()?;
    tracing::info!("opening sqlite at {}", path.display());
    let conn = Connection::open(&path)
        .with_context(|| format!("failed to open sqlite: {}", path.display()))?;

    // FTS5 が bundled features で有効化されていることを確認するためのクエリ。
    // 失敗した場合は rusqlite features 設定が誤っている。
    // AS-HOTFIX-QW3: `fts5_supported` 経由でテスト共有可能化。
    fts5_supported(&conn)?;

    // Pragmas
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        "#,
    )?;

    run_migrations(&conn).context("migration failed")?;

    Ok(conn)
}

/// AS-HOTFIX-QW3 (DEC-018-046 carryover): rusqlite が FTS5 付きでビルドされて
/// いるかをランタイム判定する。
///
/// # 重要 — `fts5_version()` は存在しない
///
/// 本関数の旧版は `SELECT fts5_version();` を叩いていたが、SQLite には
/// `fts5_version()` という SQL 関数は **存在しない**。FTS5 のバージョン取得には
/// `fts5_source_id()` を使う（`sqlite3.c` L252533 で定義、`fts5_init.c` 由来）。
///
/// 旧コードは `bundled-full` feature が正しく FTS5 を有効化していたにも関わらず
/// "no such function: fts5_version" を返し、DB 初期化を fail させていた。
/// これが M-1 smoke で実機オーナー画面に出た「DB 未接続」の真の原因
/// （AS-CLEAN-09 の `bundled-full` 修正自体は正しかった）。
///
/// # 設計
///
/// - `fts5_supported(&conn)` を `init_database` と test の両方から呼べるよう純粋関数化
/// - 失敗 → Cargo features か SQLite 内部状態いずれかが壊れた → 起動を止めるべき
/// - 成功 → FTS5 vtab module が auto-init 済み（`messages_fts` の CREATE が安全）
pub fn fts5_supported(conn: &Connection) -> Result<()> {
    // `fts5_source_id()` は値を返す SQL 関数なので `execute_batch` ではなく
    // `query_row` を使う。`execute_batch` を使うと "Execute returned results" で
    // fail し、見かけ上「FTS5 が無い」かのように誤解される（旧版バグ）。
    conn.query_row("SELECT fts5_source_id();", [], |row| {
        row.get::<_, String>(0)
    })
    .context("rusqlite is not compiled with FTS5 support; check Cargo features (`bundled-full`)")?;
    Ok(())
}

/// migration v0001: sessions / messages / messages_fts を作成。
fn run_migrations(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        BEGIN;

        CREATE TABLE IF NOT EXISTS sessions (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            project_id  TEXT NOT NULL DEFAULT 'default',
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_project_id
            ON sessions(project_id);

        CREATE INDEX IF NOT EXISTS idx_sessions_updated_at
            ON sessions(updated_at DESC);

        CREATE TABLE IF NOT EXISTS messages (
            id          TEXT PRIMARY KEY,
            session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            role        TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
            content     TEXT NOT NULL,
            created_at  TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_messages_session_id
            ON messages(session_id);

        CREATE INDEX IF NOT EXISTS idx_messages_created_at
            ON messages(created_at);

        -- FTS5 仮想テーブル（M3 AS-300 検索 UI で利用）
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content,
            content='messages',
            content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2'
        );

        -- messages 挿入時に FTS5 へ同期
        CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
            INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content)
                VALUES('delete', old.rowid, old.content);
        END;

        CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, content)
                VALUES('delete', old.rowid, old.content);
            INSERT INTO messages_fts(rowid, content)
                VALUES (new.rowid, new.content);
        END;

        COMMIT;
        "#,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AS-HOTFIX-QW3 (DEC-018-046 carryover): FTS5 が bundled-full で有効化されて
    /// いることをユニットテストで担保する。
    ///
    /// **これが失敗するときは Cargo.toml の rusqlite features を確認**
    /// （`bundled` 単独 → `bundled-full` への戻しが必要）。
    /// 実機 smoke でしか検出できなかった「DB 未接続」表示の根本原因を、
    /// `cargo test` で先に検出するための保険ネット。
    #[test]
    fn fts5_is_available() {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        fts5_supported(&conn).expect(
            "rusqlite must be built with FTS5 support; see Cargo.toml `features = [\"bundled-full\"]`",
        );
    }

    /// in-memory DB 上で migration が完走することを担保する
    /// (init_database の HOME 依存部分を除いた純粋ロジック側)。
    /// FTS5 仮想テーブル + trigger 定義が誤っていれば落ちる。
    #[test]
    fn run_migrations_creates_full_schema_in_memory() {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        fts5_supported(&conn).expect("FTS5 must be available");
        run_migrations(&conn).expect("migration must succeed");

        // 期待 schema が揃っているかの sanity check (sqlite_master 探索)
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' OR type='trigger' ORDER BY name",
            )
            .expect("prepare master query");
        let names: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query")
            .filter_map(|r| r.ok())
            .collect();
        for required in [
            "sessions",
            "messages",
            "messages_fts",
            "messages_ai",
            "messages_ad",
            "messages_au",
        ] {
            assert!(
                names.iter().any(|n| n == required),
                "schema missing: {required} (found: {names:?})"
            );
        }
    }
}
