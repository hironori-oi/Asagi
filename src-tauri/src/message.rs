//! Message CRUD（AS-117）。
//!
//! `messages` テーブル（db.rs migration v0001）に対する CRUD。
//! FTS5 への同期は AFTER INSERT/DELETE/UPDATE トリガで自動。
//!
//! v0.1.0 では Codex 統合非依存で「モック応答も保存できる」状態を作り、
//! 起動時の session 復元 UI（Sidebar SessionList）を成立させる。

use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageRow {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

/// 1 メッセージを挿入。session の updated_at も同時更新する。
pub fn create(conn: &Connection, session_id: &str, role: &str, content: &str) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, session_id, role, content, now],
    )
    .context("failed to insert message")?;

    // 親 session の updated_at を更新（list_sessions の DESC 並びに反映）
    conn.execute(
        "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
        params![now, session_id],
    )
    .context("failed to bump session updated_at")?;
    Ok(id)
}

/// session に紐付くメッセージ一覧（古い順、UI スクロール表示前提）。
pub fn list(conn: &Connection, session_id: &str) -> Result<Vec<MessageRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, session_id, role, content, created_at
             FROM messages
             WHERE session_id = ?1
             ORDER BY created_at ASC",
    )?;
    let rows = stmt
        .query_map([session_id], row_to_message)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// セッションごとのメッセージ件数。Sidebar の補助表示に使う。
pub fn count(conn: &Connection, session_id: &str) -> Result<u32> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .context("failed to count messages")?;
    Ok(count as u32)
}

fn row_to_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<MessageRow> {
    Ok(MessageRow {
        id: row.get(0)?,
        session_id: row.get(1)?,
        role: row.get(2)?,
        content: row.get(3)?,
        created_at: row.get(4)?,
    })
}
