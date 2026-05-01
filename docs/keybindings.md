# Keybindings — Asagi v0.1.0

すべて `react-hotkeys-hook` で実装。`mod` は macOS で Cmd、それ以外で Ctrl。
定義: `src/lib/keybindings.ts` (`KEYBINDINGS` 定数)。

## グローバル

| キー | 動作 | フォーム入力中も発火 |
|---|---|---|
| `Ctrl/Cmd + K` | コマンドパレットを開閉 | yes |
| `Ctrl/Cmd + /` | キーバインドモーダル (Help) を開閉 | yes |
| `Ctrl/Cmd + T` | ダーク/ライトテーマ切替 | no (textarea 入力優先) |
| `Ctrl/Cmd + N` | 新規セッション作成 | no |

## チャット入力欄

| キー | 動作 |
|---|---|
| `Enter` | 送信 |
| `Shift + Enter` | 改行 |
| `/` (1 文字目) | SlashPalette 表示 |
| `↑ / ↓` (Slash 表示中) | 候補選択 |
| `Enter` (Slash 表示中) | 候補確定 |
| `Esc` (Slash 表示中) | 入力をクリア |

## モーダル/ドロワー

| キー | 動作 |
|---|---|
| `Esc` | 開いているモーダル/ドロワーを閉じる (cmdk / vaul / Help dialog) |

## 将来の拡張 (M2 以降)

| キー (予定) | 動作 |
|---|---|
| `Ctrl/Cmd + Shift + F` | FTS5 横断検索 |
| `Ctrl/Cmd + ,` | 設定を開く (現状 mod+t 推奨) |
| `Ctrl/Cmd + 1〜9` | ProjectRail の n 番目に切替 |

## カスタマイズ

v0.1.0 ではキーバインドのカスタマイズ UI は未実装。
M2 で SettingsDrawer に編集セクションを追加予定 (Sumi の Phase 3a 相当)。
