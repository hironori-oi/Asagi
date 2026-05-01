//! Session CRUD。
//!
//! M1 AS-128 / AS-129 相当。`project_id` 列を最初から持たせて
//! M2 AS-200 の Multi-Project 拡張に備える。

use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRow {
    pub id: String,
    pub title: String,
    pub project_id: String,
    pub created_at: String,
    pub updated_at: String,
}

pub fn create(conn: &Connection, title: &str, project_id: &str) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO sessions (id, title, project_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
        params![id, title, project_id, now],
    )
    .context("failed to insert session")?;
    Ok(id)
}

pub fn list(conn: &Connection, project_id: Option<&str>) -> Result<Vec<SessionRow>> {
    let (sql, project_filter): (&str, String) = match project_id {
        Some(pid) => (
            "SELECT id, title, project_id, created_at, updated_at
                 FROM sessions
                 WHERE project_id = ?1
                 ORDER BY updated_at DESC",
            pid.to_string(),
        ),
        None => (
            "SELECT id, title, project_id, created_at, updated_at
                 FROM sessions
                 ORDER BY updated_at DESC",
            String::new(),
        ),
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = if project_id.is_some() {
        stmt.query_map([project_filter], row_to_session)?
            .collect::<Result<Vec<_>, _>>()?
    } else {
        stmt.query_map([], row_to_session)?
            .collect::<Result<Vec<_>, _>>()?
    };
    Ok(rows)
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<SessionRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, project_id, created_at, updated_at
             FROM sessions
             WHERE id = ?1",
    )?;
    let result = stmt
        .query_row([id], row_to_session)
        .map(Some)
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    Ok(result)
}

pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM sessions WHERE id = ?1", [id])?;
    Ok(())
}

fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        id: row.get(0)?,
        title: row.get(1)?,
        project_id: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}
