# Troubleshooting — Asagi

## アプリ起動関連

### Q. `npm run tauri:dev` で「webview2 not found」エラー (Windows)

A. WebView2 ランタイムが未インストール。
[Microsoft 公式](https://developer.microsoft.com/microsoft-edge/webview2/) から Evergreen Bootstrapper をインストール。
Win11 22H2 以降は標準同梱だが、稀に欠落するケースあり。

### Q. Linux で `failed to load webkit2gtk` エラー

A. システムパッケージ不足。
```bash
sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev
```

### Q. macOS で「unidentified developer」警告

A. Asagi は当面コード署名なし配布 (DEC-018 と Sumi DEC-013 同方針)。
右クリック → 開く → 確認、または System Settings > Privacy & Security から許可。

## Codex 統合関連 (Phase 0 POC 通過まで)

### Q. ログインボタンが押せない

A. **仕様**。Phase 0 POC 通過まで `disabled`。`projects/PRJ-018/app/poc/results/` に POC 結果が揃った後、AS-115 で有効化される。

### Q. チャット送信したらモック応答 `[stub] Codex 統合は POC 通過後に実装` が返る

A. **仕様**。`InputArea` は `setTimeout(200ms)` でスタブ応答を返す実装。Codex CLI 連携は POC 通過後 AS-118 で接続する。

## データベース関連

### Q. SessionList に「セッション一覧の取得に失敗しました (DB 未接続)」と表示

A. `npm run dev` 単体起動時 (Tauri 非接続環境) では invoke が失敗する。
Tauri を経由した起動 (`npm run tauri:dev`) を使うか、無視して構わない。

### Q. `~/.asagi/history.db` を削除して初期化したい

A. アプリを停止後、ファイル削除。次回起動時に schema が再作成される。
Windows: `%USERPROFILE%\.asagi\history.db`
macOS/Linux: `~/.asagi/history.db`

### Q. localStorage を初期化したい (ProjectRail のダミー 3 件を消したい)

A. DevTools (F12) を開き Console で:
```js
localStorage.removeItem('asagi-project-registry');
localStorage.removeItem('asagi-welcome');
localStorage.removeItem('asagi-locale');
location.reload();
```

## 開発環境

### Q. `cargo check` が遅い

A. 初回は Tauri 全依存をビルドするので 5〜10 分かかる。`target/` キャッシュ後は数秒。
CI では `actions/cache` でキャッシュしている (`.github/workflows/ci.yml`)。

### Q. `next lint` が「Would you like to install ESLint?」プロンプトを出す

A. **解消済**。`eslint.config.mjs` を配置済。再現したら `npm install` を再実行。

### Q. Vitest が `Cannot find module` で失敗

A. `vite-tsconfig-paths` 相当の alias 解決を `vitest.config.ts` で明示している。
`@/` パスを追加した場合は `vitest.config.ts` の `resolve.alias` も同期。

## ログ確認

実行ログ: `~/.asagi/logs/asagi-{YYYY-MM-DD}.log`

問題報告時は最新 1 ファイルを添付してください。機密情報 (token / 会話本文) は出力していません。
