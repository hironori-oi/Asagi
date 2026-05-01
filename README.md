# Asagi (浅葱)

Codex マルチプロジェクト IDE。日本語 UI ファースト、Slack 風 Multi-Project、
ローカル永続化 + FTS5 横断検索。

ChatGPT サブスク + Codex CLI sidecar による「サブスク経済圏」で動作する
個人向けデスクトップアプリ。

- 兄弟プロダクト: Sumi (PRJ-012) — Claude Code 専用 IDE。コード共有なし。
- 上位文書: claude-code-company/projects/PRJ-018/brief.md
- ステータス: M1 雛形構築中（Phase 0 POC 通過後、Codex sidecar 統合に着手予定）

---

## 技術スタック

| レイヤ | 採用 |
|---|---|
| デスクトップシェル | Tauri 2.x |
| フロント | Next.js 15 App Router + React 19 + TypeScript |
| UI | shadcn/ui + Tailwind CSS 3.4 |
| アニメーション | framer-motion 11 |
| 状態管理 | Zustand 5 |
| i18n | next-intl |
| AI 統合 | Codex CLI sidecar（`codex app-server --listen stdio`、JSON-RPC 2.0） |
| ローカル DB | rusqlite 0.32（bundled + FTS5） |
| 認証保管 | keyring 2 |

---

## 開発手順

### 前提

- Rust 1.94.0（`rust-toolchain.toml` で pin）
- Node.js 20+ / npm 10+
- Tauri 2 の OS 別前提条件（Windows: WebView2, macOS: Xcode CLT, Linux: webkit2gtk-4.1）
- Codex CLI（`codex app-server` 実行可能なバージョン、Phase 0 POC 通過後に必須）

### 初回セットアップ

```bash
# 依存取得
npm install
cd src-tauri && cargo fetch && cd ..
```

### 開発起動

```bash
npm run tauri:dev
```

### 配布ビルド

```bash
npm run tauri:build
```

---

## ディレクトリ構成

```
asagi-app/
├── src-tauri/         # Tauri Rust main process
│   ├── src/
│   │   ├── main.rs              # エントリ
│   │   ├── db.rs                # SQLite (rusqlite + FTS5)
│   │   ├── session.rs           # session CRUD
│   │   ├── project.rs           # project registry
│   │   ├── codex_sidecar.rs     # POC 通過後実装（現状スタブ）
│   │   ├── multi_sidecar.rs     # POC 通過後実装（現状スタブ）
│   │   ├── auth.rs              # POC 通過後実装（現状スタブ）
│   │   ├── image_paste.rs       # POC 通過後実装（現状スタブ）
│   │   ├── jobobject.rs         # POC 通過後実装（現状スタブ）
│   │   └── commands/mod.rs      # Tauri command handlers
│   ├── tauri.conf.json
│   ├── Cargo.toml
│   └── rust-toolchain.toml
├── src/
│   ├── app/                     # Next.js App Router
│   ├── components/              # UI コンポーネント
│   │   ├── welcome/             # Welcome ウィザード
│   │   ├── project-rail/        # Slack 風プロジェクト切替
│   │   ├── chat/                # チャット UI
│   │   ├── inspector/           # 右ペイン
│   │   └── ui/                  # shadcn/ui (後で追加)
│   ├── lib/
│   │   ├── stores/              # Zustand stores
│   │   ├── tauri/               # invoke / event wrappers
│   │   └── i18n/                # next-intl messages
│   └── styles/
│       └── tokens.css           # OKLCH デザイントークン
├── public/
├── package.json
├── next.config.mjs
├── tailwind.config.ts
├── tsconfig.json
├── components.json
└── README.md
```

---

## デザインシステム

- 主色: **浅葱色 oklch(0.72 0.10 200)**（青緑、ChatGPT/OpenAI ブランドと親和）
- ダーク中心、Tokyo Night Storm inspired
- フォント: Geist Sans + Geist Mono
- アイコン: lucide-react (strokeWidth 1.5)
- 詳細トークン: `src/styles/tokens.css`

---

## Phase 0 POC ゲート（DEC-018-014）

Codex CLI sidecar 統合（AS-110 / AS-115 / AS-118 等）は **Phase 0 POC 通過後**に
着手する。本リポジトリ上の以下のモジュールは現時点でスタブ実装：

- `src-tauri/src/codex_sidecar.rs`
- `src-tauri/src/multi_sidecar.rs`
- `src-tauri/src/auth.rs`
- `src-tauri/src/image_paste.rs`
- `src-tauri/src/jobobject.rs`

POC 結果（`projects/PRJ-018/app/poc/results/`）を `dev-v0.1.0-scaffold-design.md` § 6 に従って
これらのモジュールへ移植する。

---

## ライセンス

License: **TBD**（M3 配布判定時に決定）

詳細は `LICENSE` ファイル参照。
