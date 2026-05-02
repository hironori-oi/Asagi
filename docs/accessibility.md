# Accessibility — Asagi v0.1.0 監査結果

## 監査スコープ (AS-META-08)

v0.1.0 シェル + Welcome ウィザード + Command/Settings/Help overlay 全コンポーネントを対象に
WCAG 2.1 AA 準拠を目標に audit。

## 監査項目と結果

| 項目 | 状態 | コメント |
|---|---|---|
| フォーカスリング統一 | OK | Tailwind `focus-visible:ring-2 focus-visible:ring-ring` を Button / TitleBar / NewSessionButton / SettingsDrawer / SlashPalette で統一 |
| キーボードナビゲーション | OK | Tab/Shift+Tab で UI 内移動可。CommandPalette / HelpDialog は Esc で閉じる。SlashPalette は ↑↓ で選択 |
| ARIA labels | 改善 | 追加: TitleBar の各 button、NewSessionButton、SlashPalette items、Sidebar tabs (AS-UX-11 で旧 Inspector tabs を統合) |
| role 属性 | 改善 | 追加: ChatPane Sidebar tabs に `role="tablist"` `role="tab"` `role="tabpanel"` (AS-UX-11 で旧 Inspector pane を Sidebar 4 タブに統合) |
| ARIA live regions | 改善 | 追加: ChatPane MessageList を `aria-live="polite"` に (新規メッセージを screen reader が読む) |
| コントラスト比 | 確認 | StatusBar の小文字 `text-[11px]` は背景 `bg-surface` に対し約 5.2:1 で AA 通過 (oklch(0.65) on oklch(0.18) 相当) |
| スクリーンリーダー | OK | `<span className="sr-only">` の導入箇所を増やし、icon-only buttons の意味付けを補強 |
| 言語属性 | OK | `<html lang>` を locale 切替で動的更新 (`ClientIntlProvider` 内) |
| ダーク/ライトコントラスト | OK | next-themes で system 追従、`tokens.css` で OKLCH ベースに整備 |
| reduced motion | TODO (M2) | `prefers-reduced-motion` 対応は framer-motion の `MotionConfig` で M2 入りで設定 |

## 修正したファイル一覧 (AS-META-08)

| ファイル | 変更概要 |
|---|---|
| `src/components/chat/message-list.tsx` | `aria-live="polite" aria-relevant="additions"` 追加 |
| `src/components/sidebar/sidebar.tsx` | tabs に `role="tablist"` `role="tab"` `aria-selected` 追加 (AS-UX-11 で旧 `src/components/inspector/inspector.tsx` を撤去し、Sidebar 4 タブに統合済) |
| `src/components/sidebar/session-item.tsx` | `aria-current="true"` を active session に |
| `src/components/error-boundary.tsx` | エラーメッセージを `role="alert"` に |
| `src/components/help/help-dialog.tsx` | Close ボタンに日本語 `aria-label` (旧 "Close" 英語) |
| `src/components/welcome/step-sample.tsx` | input + send button に `aria-label` |

## 既知の制限

- xterm.js の terminal 領域 (M2 導入予定) は screen reader 互換性が業界標準で限定的。M2 でフォローアップ調査
- Monaco Editor の DiffEditor (M2) も同様。alt キーボード操作と aria-live の追加検証必要
- カラーフィルタ (色覚多様性) チェック: 浅葱 oklch(0.72 0.10 200) は赤緑色覚タイプでも識別できる青緑だが、Sumi オレンジとの組合せ判別は WCAG NG ではないが M2 で改善余地

## レファレンス

- WCAG 2.1 AA: <https://www.w3.org/WAI/WCAG21/quickref/>
- Radix UI a11y guide: <https://www.radix-ui.com/primitives/docs/overview/accessibility>
- shadcn/ui a11y: <https://ui.shadcn.com/docs/components>
