# Asagi (浅葱)

> Codex マルチプロジェクト IDE — 日本語ファースト、Slack 風 Multi-Project、ローカル永続化。
> ChatGPT のサブスク経済圏で動く、個人/小規模チーム向けデスクトップ IDE。

[![CI](https://img.shields.io/badge/ci-pending-lightgrey)](./.github/workflows/ci.yml)
![status](https://img.shields.io/badge/status-M1%20scaffold-blue)
![platform](https://img.shields.io/badge/platform-Windows%2011%20|%20macOS%20|%20Linux-informational)

---

## スクリーンショット

> M1 雛形段階。スクリーンショットは v0.2 で差し替え予定。

```
+-----------------------------------------------------------------+
| Asagi  / Project A             [theme] [settings] [_][□][x]    |  ← TitleBar 36px
+--+-------+----------------------------------------+-------------+
|  |Sessions|  Codex と日本語で対話                  | Inspector   |
|R |        |                                        | Context     |
|a |- 11/02 |  > はじめまして                         | SubAgents   |
|i |- 11/01 |                                        | Todos       |
|l |        |                                        |             |
|  |  [+]   |  [Send]                                |             |
+--+-------+----------------------------------------+-------------+
| gpt-5.5-codex  ctx 38%  branch main  Pro 5x: 92%               |  ← StatusBar 28px
+-----------------------------------------------------------------+
```

詳細は `docs/architecture.md` 参照。

---

## 概要

- **Asagi** (浅葱) は Codex CLI を素人でも触れる日本語 GUI IDE
- 兄弟プロダクト **[Sumi](https://github.com/hironori-oi/Sumi)** (墨) は Claude Code 専用 (色違いの双子)
- DEC-018-002 により **完全独立アプリ・独立リポジトリ**。Sumi のソースは流用しない (DEC-018-008)
- 配布対象: 自分 + 日本語話者の素人開発者・非エンジニア
- 主 OS: **Windows 11 primary**、macOS / Linux 副次対応

詳細な背景・経営判断・撤退基準は `claude-code-company/projects/PRJ-018/brief.md` 参照。

---

## 主な特徴 (差別化 4 軸 / DEC-018-006)

### A. 日本語 UI ファースト

公式 ChatGPT Desktop / Cursor / Windsurf / Codex VSCode 拡張は英語中心。Asagi は **next-intl で全 UI 日本語デフォルト**、英語切替も即時可能。Codex CLI の英語出力は日本語コンテキストに馴染ませて整形する。

### B. Linear/Arc/Raycast 級デザイン

- 主色 **浅葱 oklch(0.72 0.10 200)** (青緑) — Sumi の Claude オレンジ (oklch 0.72 0.15 45) と色相 155deg 離れた識別色
- Geist Sans / Geist Mono + lucide-react (strokeWidth 1.5)
- framer-motion 11 で 200〜400ms cubic-bezier(0.16, 1, 0.3, 1) のマイクロアニメ
- ダーク中心 (Tokyo Night Storm inspired) + ライト切替

### C. Slack 風 Multi-Project + Multi-Sidecar

- **ProjectRail (48px Discord 風縦列)** で複数プロジェクトを瞬時切替
- 各 project ごとに **Codex CLI を独立 spawn** (`HashMap<projectId, CodexSidecarHandle>`)
- Project A で Codex が長時間 reasoning 中でも Project B に切替えて別作業可
- Tauri event prefix `agent:{projectId}:*` で session 完全分離

### D. ローカル永続化 + プライバシー + FTS5 横断検索

- 全会話を `~/.asagi/history.db` に **rusqlite bundled + FTS5** で保存
- Ctrl+Shift+F で過去会話の snippet ハイライト付き横断検索 (M3)
- ChatGPT サブスク認証トークンは **OS keyring** (Win Credential Manager / macOS Keychain / Linux Secret Service)
- **テレメトリ送信なし**

---

## 必要要件

| 項目 | 要件 |
|---|---|
| OS | Windows 11 (primary), macOS 13+, Ubuntu 22.04+ |
| Node.js | 20 LTS 以上 |
| npm | 10 以上 |
| Rust | **1.94.0** (`rust-toolchain.toml` で pin、stable channel) |
| Codex CLI | `codex app-server --listen stdio` 対応版 (Phase 0 POC 通過後に必須) |
| ChatGPT サブスク | **Codex x5 プラン** (Must)、他プラン (Should) |
| Tauri 2 OS 別前提 | Windows: WebView2 / macOS: Xcode CLT / Linux: webkit2gtk-4.1 + libsoup-3.0 |

---

## 開発手順

### 初回セットアップ

```bash
git clone https://github.com/hironori-oi/Asagi.git
cd Asagi/app/asagi-app
npm install
cd src-tauri && cargo fetch && cd ..
```

### 開発起動 (Tauri ウィンドウ)

```bash
npm run tauri:dev
```

WebView2 単体で確認したい場合 (CI / 軽量):

```bash
npm run dev
# → http://localhost:3000
```

### テスト

```bash
npm run test          # vitest (watch)
npm run test:ci       # vitest run (1 回実行)
npm run test:coverage # カバレッジ付き
npm run test:e2e      # Playwright (要 npm run dev 自動起動)
```

### 配布ビルド

```bash
npm run tauri:build
```

成果物は `src-tauri/target/release/bundle/` に配置される (msi / dmg / AppImage)。

---

## ディレクトリ構成

```
asagi-app/
├── .github/workflows/ci.yml     # GitHub Actions (frontend / rust / e2e の 3 job × 3 OS matrix)
├── docs/                        # 開発者向けドキュメント
│   ├── architecture.md
│   ├── commands.md
│   ├── keybindings.md
│   ├── troubleshooting.md
│   └── dev-setup.md
├── e2e/                         # Playwright spec
├── src/
│   ├── app/                     # Next.js App Router (layout / page)
│   ├── components/
│   │   ├── layout/              # AppShell / TitleBar / StatusBar
│   │   ├── welcome/             # Welcome ウィザード 3 ステップ
│   │   ├── project-rail/        # 48px Slack 風 Rail
│   │   ├── sidebar/             # SessionList
│   │   ├── chat/                # ChatPane / InputArea / SlashPalette
│   │   ├── inspector/           # 320px 右ペイン (3 タブ)
│   │   ├── command-palette/     # Ctrl+K cmdk
│   │   ├── settings/            # vaul Drawer
│   │   ├── help/                # キーバインド一覧モーダル
│   │   ├── keybindings/         # GlobalKeybindings (ヘッドレス)
│   │   ├── error-boundary.tsx   # React Error Boundary
│   │   ├── providers/           # IntlProvider
│   │   └── ui/                  # Button etc. (shadcn/ui ベース)
│   ├── lib/
│   │   ├── stores/              # Zustand (project / session / chat / locale / welcome / ui)
│   │   ├── tauri/               # invoke / event / settings wrappers
│   │   ├── i18n/                # ja.json / en.json
│   │   ├── keybindings.ts       # KEYBINDINGS 定数 + formatHotkey
│   │   └── logger.ts            # console wrapper (production で Tauri ファイル出力)
│   └── styles/                  # tokens.css (OKLCH デザイントークン)
├── src-tauri/                   # Tauri Rust main process
│   ├── src/
│   │   ├── main.rs              # bin entry
│   │   ├── lib.rs               # tauri::Builder
│   │   ├── db.rs                # SQLite + FTS5 init
│   │   ├── session.rs           # session CRUD
│   │   ├── message.rs           # message CRUD
│   │   ├── project.rs           # project registry
│   │   ├── settings.rs          # tauri-plugin-store wrapper (AS-META-06)
│   │   ├── codex_sidecar.rs     # POC 通過後本実装 (現状スタブ)
│   │   ├── multi_sidecar.rs     # POC 通過後本実装 (現状スタブ)
│   │   ├── auth.rs              # POC 通過後本実装 (現状スタブ)
│   │   ├── image_paste.rs       # POC 通過後本実装 (現状スタブ)
│   │   ├── jobobject.rs         # Win JobObject 子プロセス管理 (現状スタブ)
│   │   └── commands/mod.rs      # Tauri command handlers
│   ├── Cargo.toml
│   ├── rust-toolchain.toml
│   ├── tauri.conf.json
│   └── icons/                   # AppIcon (デザイナー成果物投入予定)
├── public/                      # static (favicon 等)
├── package.json
├── playwright.config.ts
├── vitest.config.ts
├── eslint.config.mjs
└── tsconfig.json
```

---

## アーキテクチャ図 (テキスト表現)

```
+-------------------------------------------------------------------+
|                  Asagi Tauri 2 Process (Rust)                    |
|                                                                   |
|  +-------------+   +--------------+   +--------------------+      |
|  | invoke      |   | events       |   | tauri-plugin-store |      |
|  | handlers    |<->| emit/listen  |   | (settings persist) |      |
|  +-------------+   +--------------+   +--------------------+      |
|        |                                                          |
|        v                                                          |
|  +-------------+   +--------------+   +--------------------+      |
|  | rusqlite    |   | keyring 2    |   | tracing log file   |      |
|  | + FTS5      |   | (auth token) |   | ~/.asagi/logs/...  |      |
|  +-------------+   +--------------+   +--------------------+      |
|        |                                                          |
|        v   (POC 通過後)                                            |
|  +----------------------------------------------------------+    |
|  |  HashMap<projectId, CodexSidecarHandle>                  |    |
|  |  └ codex app-server --listen stdio (JSON-RPC 2.0 / Rust) |    |
|  |     └ ChatGPT Subscription OAuth (codex login 別 spawn)  |    |
|  |        └ OpenAI API (Codex backend)                      |    |
|  +----------------------------------------------------------+    |
|                                                                   |
|        ^                                                          |
|        | tauri::Manager / window message                          |
|        v                                                          |
|  +-------------------------------------------------------+        |
|  | WebView2 / WKWebView / WebKitGTK                      |        |
|  | └ Next.js 15 static export (out/)                     |        |
|  |    └ React 19 + shadcn/ui + framer-motion             |        |
|  |       └ Zustand stores + Tauri invoke wrapper         |        |
|  +-------------------------------------------------------+        |
+-------------------------------------------------------------------+
```

詳細: `docs/architecture.md`

---

## Codex 統合の現状 (DEC-018-014 ハイブリッド運用)

Phase 0 POC ゲート通過まで、以下のモジュール/コマンドは **`unimplemented!()` または "POC pending" を返すスタブ** のまま:

- `src-tauri/src/codex_sidecar.rs` — JSON-RPC 2.0 接続
- `src-tauri/src/multi_sidecar.rs` — `HashMap<projectId, CodexSidecarHandle>`
- `src-tauri/src/auth.rs` — `codex login` OAuth spawn
- `src-tauri/src/image_paste.rs` — Ctrl+V 画像取り込み
- `src-tauri/src/jobobject.rs` — Windows JobObject 子プロセス kill chain
- `commands::codex_login` / `commands::codex_send_message`

POC 結果は `claude-code-company/projects/PRJ-018/app/poc/results/` に置かれ、通過後 AS-115 / AS-118 で本実装する。

---

## ライセンス

**TBD** (M3 配布判定時に確定予定)。詳細は `LICENSE` ファイル参照。

---

## 貢献ガイド

- 当面 **Closed**: 個人開発フェーズ (M1〜M3)
- M3 到達後に外部貢献の判定をする
- バグ報告は GitHub Issues、ただしレスポンスは best-effort

---

## 関連ドキュメント

- 案件 brief: `claude-code-company/projects/PRJ-018/brief.md`
- 意思決定: `claude-code-company/projects/PRJ-018/decisions.md` (DEC-018-001〜021)
- 設計書: `claude-code-company/projects/PRJ-018/reports/dev-v0.1.0-scaffold-design.md`
- 実装報告: `claude-code-company/projects/PRJ-018/reports/dev-v0.1.0-*.md`
- ブランド v1: `claude-code-company/projects/PRJ-018/reports/design-brand-v1.md`
- 兄弟プロダクト: [Sumi (PRJ-012)](https://github.com/hironori-oi/Sumi) — Claude Code 専用 IDE
