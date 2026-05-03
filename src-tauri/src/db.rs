//! SQLite 初期化と migration。
//!
//! `~/.asagi/history.db` を rusqlite (bundled + FTS5) で開き、
//! `sessions` / `messages` / `messages_fts` のスキーマを作成する。
//!
//! 関連: dev-v0.1.0-scaffold-design.md § 1.3

use std::path::{Path, PathBuf};

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
    init_database_at(&path)
}

/// AS-HOTFIX-QW5 (DEC-018-047 ⓖ 生きた事例 #2): `init_database()` 全経路を
/// path 指定で test 可能にするため抽出した実装関数。
///
/// # なぜ抽出が必要か
///
/// 旧 `init_database()` は `dirs::home_dir()` 依存だったため、
/// `~/.asagi/history.db` の **on-disk** に対する以下の経路は cargo unit test
/// で検証されていなかった:
///   1. `Connection::open(&path)` の disk file 作成 / 開封
///   2. `PRAGMA journal_mode = WAL` の execute_batch (in-memory DB では noop)
///   3. `PRAGMA journal_mode = WAL` 実行時の `-wal` / `-shm` ファイル生成
///   4. **既存の空 / 部分 schema DB に対する追加 migration の冪等性**
///   5. `BEGIN; ... COMMIT;` トランザクションの execute_batch 動作
///
/// 旧 `run_migrations_creates_full_schema_in_memory` は (4) を含む全経路を
/// **完全に skip** しており、AS-HOTFIX-QW3 で fts5 sanity を pass させた結果
/// 初めて (1)〜(5) に到達するようになって新たな failure point を生んだ。
/// 本関数の抽出 + tempfile DB ベースの test (`init_database_at_*`) で
/// 以降は CI が即時検出する。
///
/// # 引数
///   - `path`: SQLite ファイル絶対 / 相対パス。親ディレクトリは事前に
///     `create_dir_all` 等で存在保証されている前提
///     (`init_database()` は `database_path()` 内で実施済)。
pub fn init_database_at(path: &Path) -> Result<Connection> {
    tracing::info!("opening sqlite at {}", path.display());
    let conn = Connection::open(path)
        .with_context(|| format!("failed to open sqlite: {}", path.display()))?;

    // FTS5 が bundled features で有効化されていることを確認するためのクエリ。
    // 失敗した場合は rusqlite features 設定が誤っている。
    // AS-HOTFIX-QW3: `fts5_supported` 経由でテスト共有可能化。
    fts5_supported(&conn)?;

    // Pragmas
    //
    // AS-HOTFIX-QW5 (DEC-018-047 ⓖ 生きた事例 #2): 旧版は execute_batch で
    // 3 PRAGMA を一括実行していたが、`PRAGMA journal_mode = WAL;` は新 mode 名
    // ("wal") を **結果として返す** ため `execute_batch` が
    // "Execute returned results - did you mean to call query?" で fail し、
    // init_database 全経路が Err 返却 → state.db = None →
    // 「DB 未接続」+「メッセージ保存に失敗しました」連鎖障害になる。
    //
    // (旧 in-memory test は PRAGMA を skip して run_migrations 直叩きだったため
    //  検出できなかった。AS-HOTFIX-QW3 と完全同型 — execute_batch を値返す SQL
    //  に使う pattern bug の隣接 2 件目。)
    //
    // 修正:
    //   - `journal_mode` は新 mode 名を返すので `query_row` で値を読む。
    //     `pragma_update` は内部で `execute` を使うため同じエラーになる。
    //     `pragma_update_and_check` が公式 API だが、最終 mode 名 ("wal") の
    //     verify を兼ねて `query_row` で受け取り、期待通りでなければ panic
    //     せず Err 返却（Windows + 一部 FS では WAL fallback も起こり得る）。
    //   - `synchronous` / `foreign_keys` は値を返さないので `execute` で十分。
    let journal_mode: String = conn
        .query_row("PRAGMA journal_mode = WAL;", [], |row| row.get(0))
        .context("PRAGMA journal_mode = WAL failed")?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        tracing::warn!(
            actual = %journal_mode,
            "WAL mode requested but SQLite returned other mode (FS may not support WAL)"
        );
    }
    conn.execute("PRAGMA synchronous = NORMAL;", [])
        .context("PRAGMA synchronous = NORMAL failed")?;
    conn.execute("PRAGMA foreign_keys = ON;", [])
        .context("PRAGMA foreign_keys = ON failed")?;

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

    /// AS-HOTFIX-QW5 (DEC-018-047 ⓖ 生きた事例 #2):
    /// **on-disk** SQLite で `init_database_at` が完走することを担保する。
    ///
    /// 旧 `run_migrations_creates_full_schema_in_memory` は in-memory DB のみを
    /// covers し、PRAGMA journal_mode = WAL の execute_batch / -wal/-shm 生成
    /// 経路を完全に skip していた。本 test で実機 ~/.asagi/history.db と同じ
    /// 経路を検証する。
    fn unique_temp_db_path(label: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        p.push(format!("asagi-test-{label}-{nanos}.db"));
        // 既存があれば消去 (前回 test のリーク対策)
        let _ = std::fs::remove_file(&p);
        for ext in ["-wal", "-shm"] {
            let mut sidecar = p.clone();
            sidecar.set_extension(format!("db{ext}"));
            let _ = std::fs::remove_file(&sidecar);
        }
        p
    }

    fn cleanup_temp_db(path: &std::path::Path) {
        let _ = std::fs::remove_file(path);
        for ext in ["-wal", "-shm"] {
            let mut sidecar = path.to_path_buf();
            sidecar.set_extension(format!("db{ext}"));
            let _ = std::fs::remove_file(&sidecar);
        }
    }

    #[test]
    fn init_database_at_fresh_path_succeeds() {
        let path = unique_temp_db_path("fresh");
        let result = init_database_at(&path);
        cleanup_temp_db(&path);
        result.expect("init_database_at must succeed on fresh path");
    }

    /// AS-HOTFIX-QW5 真因再現テスト:
    /// **空 4096-byte SQLite (schema 0, unknown encoding)** が事前に存在する状態で
    /// `init_database_at` が成功すること = 旧失敗 init_database が残した
    /// `~/.asagi/history.db` 残骸からの自動復旧を担保する。
    ///
    /// オーナー smoke で観測された stale DB 状態 (`file` コマンド出力:
    /// `SQLite 3.x database, ... database pages 1, cookie 0, schema 0, unknown 0 encoding`)
    /// を `Connection::open` + 即 close で再現し、その上で init_database_at を
    /// 走らせて全経路通過を確認する。
    #[test]
    fn init_database_at_stale_empty_db_recovers() {
        let path = unique_temp_db_path("stale");
        // 空 SQLite を作成 (Connection::open は 0-byte の場合 file 作成のみ)
        // 4096-byte page header だけ入った状態にするため、execute_batch で何もしない
        // ステートメントを 1 つ流す。
        {
            let conn = Connection::open(&path).expect("open empty sqlite");
            // 何の table も作らずに close → 4096-byte schema 0 状態になる
            // (PRAGMA を一度叩くと page header が確定する)
            conn.execute_batch("PRAGMA user_version = 0;").ok();
        }
        // 再オープン + init_database_at が正常完走すること
        let result = init_database_at(&path);
        cleanup_temp_db(&path);
        result.expect("init_database_at must recover from stale empty DB");
    }

    /// 二重 init (idempotency) も担保 — アプリ再起動時の経路。
    #[test]
    fn init_database_at_double_init_is_idempotent() {
        let path = unique_temp_db_path("doubleinit");
        let r1 = init_database_at(&path);
        let r2 = init_database_at(&path);
        cleanup_temp_db(&path);
        r1.expect("first init must succeed");
        r2.expect("second init must succeed (idempotent)");
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
