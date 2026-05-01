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
    conn.execute_batch("SELECT fts5_version();")
        .context("rusqlite is not compiled with FTS5 support; check Cargo features")?;

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
