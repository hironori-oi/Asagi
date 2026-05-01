# 開発環境セットアップ — Asagi

## 前提

| ツール | バージョン | 備考 |
|---|---|---|
| Node.js | 20.x LTS | nvm-windows / fnm 推奨 |
| npm | 10.x | Node 20 に同梱 |
| Rust | **1.94.0** | `rust-toolchain.toml` で pin、rustup install で自動取得 |
| Cargo | Rust に同梱 | |
| Git | 2.40+ | |
| Codex CLI | latest | Phase 0 POC 通過後に必須 |

### OS 別追加要件

#### Windows 11

- WebView2 Runtime (22H2 以降標準同梱)
- Visual Studio Build Tools (C++) — Tauri ビルド用
- (推奨) Windows Terminal + PowerShell 7

#### macOS 13+

- Xcode Command Line Tools: `xcode-select --install`

#### Ubuntu 22.04+

```bash
sudo apt update
sudo apt install -y \
  build-essential curl wget file libssl-dev \
  libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
  libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev
```

## クローン & 初回セットアップ

```bash
git clone https://github.com/hironori-oi/Asagi.git
cd Asagi/app/asagi-app

# Node 依存
npm install

# Rust 依存 (toolchain は rust-toolchain.toml で auto)
cd src-tauri && cargo fetch && cd ..
```

## 開発起動

```bash
# Tauri ウィンドウ起動 (推奨)
npm run tauri:dev

# Web 単体起動 (UI のみ確認、Tauri 非接続)
npm run dev
# → http://localhost:3000
```

## テスト

```bash
npm run test          # vitest (watch)
npm run test:ci       # vitest run (1 回)
npm run test:coverage # カバレッジ HTML 出力
npm run test:e2e      # Playwright (内部で next dev 自動起動)
```

## Lint / Type Check

```bash
npm run lint          # ESLint (next lint)
npx tsc --noEmit      # TypeScript 型チェック
cd src-tauri && cargo fmt --check && cargo clippy && cargo check
```

## ビルド

```bash
npm run build         # Next.js static export → out/
npm run tauri:build   # Tauri バンドル → src-tauri/target/release/bundle/
```

## CI 構成

`.github/workflows/ci.yml` で以下を実行:

| Job | OS | 内容 |
|---|---|---|
| frontend-check | Ubuntu / Win / macOS | tsc / lint / vitest / next build |
| rust-check | Ubuntu / Win / macOS | cargo fmt --check / clippy / check |
| e2e-smoke | Ubuntu | Playwright Chromium で Welcome smoke |

PR / push to main で自動実行。

## ディレクトリ規約

- 新規 component: `src/components/{group}/{name}.tsx`
- 新規 store: `src/lib/stores/{name}.ts`
- 新規 i18n: `src/lib/i18n/{ja,en}.json` の両方を必ず更新
- 新規 Tauri command: `src-tauri/src/commands/mod.rs` + `lib.rs` invoke_handler!
- アイコンは `lucide-react` (strokeWidth 1.5)
- 絵文字禁止 (DEC-018 / 全社規約)

## Sumi コードの参照禁止 (DEC-018-008)

兄弟プロダクト Sumi (PRJ-012) のソース物理コピーは禁止。設計思想・UX パターンの参考のみ可。
レビューで Sumi 由来コードが検出された場合は差し戻し対象。

## デバッグ

### Rust 側

- `tracing::info!` `tracing::warn!` `tracing::error!` を使用
- ログファイル: `~/.asagi/logs/asagi-{YYYY-MM-DD}.log`
- 環境変数 `RUST_LOG=asagi=debug,info` で詳細化

### Web 側

- `import { logger } from '@/lib/logger'` を使用 (production で Tauri ファイル出力)
- `console.log` 直接呼出は ESLint で警告予定 (M2)
