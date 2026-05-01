# Commands — Command Palette と Slash Commands

## コマンドパレット (Ctrl+K)

| コマンド | グループ | 状態 | 用途 |
|---|---|---|---|
| プロジェクト切替 | project | TODO (toast) | ProjectRail の任意プロジェクトに移動 |
| 新規セッション | session | 実装済 | 現在のプロジェクトに新しいセッションを作成 (Ctrl+N と同じ) |
| チャットをクリア | session | 実装済 | 現在のセッションのメッセージを削除 |
| モデルを選択 | session | TODO (toast) | Codex のモデル変更 |
| テーマを切替 | settings | 実装済 | ダーク/ライト切替 (Ctrl+T と同じ) |
| 言語を切替 | settings | 実装済 | 日本語/英語切替 |
| 設定を開く | settings | 実装済 | SettingsDrawer を開く |
| キーバインドを表示 | help | 実装済 | HelpDialog を開く (Ctrl+/ と同じ) |

## Slash Commands (入力欄で `/` トリガ)

| コマンド | 状態 | 動作 |
|---|---|---|
| `/clear` | 実装済 | 現在のセッションのメッセージを削除 |
| `/help` | 実装済 | キーバインドモーダルを表示 |
| `/model` | TODO (toast) | モデル選択 (POC 通過後) |
| `/config` | TODO (toast) | 設定パネルを開く (POC 通過後) |

## 操作

- 入力欄で `/` を 1 文字目に打つと SlashPalette が表示される
- ↑/↓ で選択、Enter で実行、Esc でキャンセル
- 確定したコマンドは即座に実行され、入力欄はクリア
- `/` 以外の文字に切替えれば通常の入力に戻る

## 拡張ポイント

- 新規コマンド追加: `src/components/command-palette/command-items.ts`
- Slash 追加: `src/components/chat/slash-palette.tsx` の `SLASH_ITEMS`
- アイコンは `lucide-react` (strokeWidth 1.5)
