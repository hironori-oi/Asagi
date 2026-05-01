# Architecture — Asagi v0.1.0

## 概要

Asagi は Tauri 2 + Next.js 15 で構築されたデスクトップアプリ。
Rust 側 (main process) が Codex CLI sidecar / SQLite / OS keyring を司り、
Web 側 (WebView) が UI / 状態管理を担う。

## レイヤ図

```
+---------------------------------------------------------+
|  Web (WebView2 / WKWebView / WebKitGTK)                 |
|  └ Next.js 15 static export (out/)                      |
|    └ React 19 + shadcn/ui + framer-motion 11            |
|      └ Zustand stores                                   |
|        └ @tauri-apps/api (invoke / listen)              |
+---------------------------------------------------------+
                        ↑↓ Tauri IPC (JSON)
+---------------------------------------------------------+
|  Tauri 2 Rust main process                              |
|                                                         |
|  Plugins:                                               |
|    - tauri-plugin-shell      (codex CLI spawn)          |
|    - tauri-plugin-dialog     (open project picker)      |
|    - tauri-plugin-fs         (file ops)                 |
|    - tauri-plugin-store      (settings persist)         |
|    - tauri-plugin-clipboard  (image paste)              |
|                                                         |
|  Modules:                                               |
|    - db (rusqlite + FTS5)         → ~/.asagi/history.db |
|    - session/message CRUD                                |
|    - settings (JSON store)        → ~/.asagi/store.json |
|    - keyring 2 wrapper (token)    → OS keyring          |
|    - tracing logs                  → ~/.asagi/logs/      |
|                                                         |
|  POC 通過後:                                              |
|    - codex_sidecar (JSON-RPC 2.0)                       |
|    - multi_sidecar (HashMap<projectId, Handle>)         |
|    - auth (codex login OAuth spawn)                     |
|    - image_paste (arboard + bmp/png convert)            |
|    - jobobject (Win 子プロセス kill chain)               |
+---------------------------------------------------------+
                        ↓ child process (POC 通過後)
+---------------------------------------------------------+
|  Codex CLI (codex app-server --listen stdio)            |
|  └ JSON-RPC 2.0 over stdio                              |
|    └ ChatGPT Subscription OAuth (codex login で確立)    |
|      └ OpenAI API (Codex backend)                       |
+---------------------------------------------------------+
```

## イベント命名規約

Tauri event は **必ず `agent:{projectId}:` でプレフィックス**して project 単位に分離する。

| Event | ペイロード | 発行元 |
|---|---|---|
| `agent:{projectId}:ready` | `{ pid, model }` | sidecar 起動完了 |
| `agent:{projectId}:assistant_message_delta` | `{ delta: string }` | streaming chunk |
| `agent:{projectId}:assistant_message_done` | `{ messageId, content }` | turn 完了 |
| `agent:{projectId}:tool_use` | `{ tool, args }` | Codex の tool call |
| `agent:{projectId}:reasoning_delta` | `{ delta }` | reasoning streaming |
| `agent:{projectId}:complete` | `{ usage }` | turn 完全終了 |
| `agent:{projectId}:error` | `{ message, code }` | エラー |

## 状態管理レイヤ

### Frontend (Zustand)

| Store | 用途 | 永続化 |
|---|---|---|
| `useProjectStore` | RegisteredProject 配列 + active | localStorage `asagi-project-registry` |
| `useSessionStore` | SessionRow 配列 + active | なし (起動時 SQLite から再 hydrate) |
| `useChatStore` | messages/draft/model/effort by project | なし (session 切替で SQLite から hydrate) |
| `useLocaleStore` | UI ロケール ja/en | localStorage `asagi-locale` |
| `useWelcomeStore` | step / completed | localStorage `asagi-welcome` (completed のみ) |
| `useUiStore` | overlay 開閉 | なし |

### Backend persistent

| ストア | 場所 | 用途 |
|---|---|---|
| SQLite (rusqlite + FTS5) | `~/.asagi/history.db` | sessions / messages / messages_fts |
| tauri-plugin-store | `~/.asagi/store.json` 相当 | theme / locale / lastActiveProjectId 等の app 設定 |
| OS keyring | Win Cred / macOS Keychain / Linux Secret | ChatGPT サブスク認証トークン |
| tracing log | `~/.asagi/logs/asagi-{date}.log` | 実行ログ (非機密) |

## SQLite スキーマ (v0001)

```sql
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  project_id  TEXT NOT NULL DEFAULT 'default',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
```

## 関連 DEC

- DEC-018-009: `codex app-server --listen stdio` (JSON-RPC 2.0) を Rust から spawn
- DEC-018-012: Node sidecar 撤廃 (Codex 自身が Rust のため Tauri Rust から直接)
- DEC-018-014: ハイブリッド運用 (Codex 統合は POC 通過後)
