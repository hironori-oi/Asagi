/**
 * AS-145 — Real Codex sidecar E2E 共通ヘルパ。
 *
 * 本ヘルパは `e2e/codex-real-flow.spec.ts` から参照され、real Codex CLI 0.128.0
 * app-server を実機起動するシナリオ群（Phase 1 M1 critical path）で使う。
 *
 * 設計方針:
 *   - `ASAGI_SIDECAR_MODE=real` のときだけ test を有効化（誤実行防止）
 *   - Welcome ウィザードを localStorage で skip し、メインシェルに直接着地
 *   - dev サーバー (port 1420) 経由の Playwright E2E を主軸（Tauri 直接 driving は
 *     M2 で `tauri-driver` 導入予定、本 phase では skip + 手動 smoke で代替）
 *
 * 関連: PM § 6.5 厳守事項 7（schema 文字列リテラル禁止 → CodexEvent / AgentEvents
 * から import するが、本ヘルパは event 直接 emit はせず、real sidecar の自然な
 * event flow に依拠する）
 */

import type { Page, BrowserContext } from '@playwright/test';

/**
 * 本 spec が real mode 専用であることを示すタグ。
 *
 * - playwright.config.ts では特別な filter を設定していないため、
 *   `--grep` で明示的に選択 / 除外することを想定。
 * - CI では `--grep-invert '@codex-real-smoke'` で除外する運用（OAuth + 実機
 *   Codex CLI が必須環境のため、CI runner では実行不可）。
 */
export const REAL_SMOKE_TAG = '@codex-real-smoke' as const;

/**
 * 環境変数 `ASAGI_SIDECAR_MODE` が `'real'` でない場合は true を返す。
 *
 * `test.skip(shouldSkipReal(), 'real mode required')` の引数として使う。
 * これにより、誤実行（mock 環境で real シナリオを実行しようとする）を未然に防ぎ、
 * CI では skip 結果として記録される。
 */
export function shouldSkipReal(): boolean {
  return process.env.ASAGI_SIDECAR_MODE !== 'real';
}

/**
 * Welcome ウィザード完了フラグを localStorage に注入し、メインシェルに直接着地させる。
 *
 * `codex-mock-flow.spec.ts` の DEC-018-026 ① pattern と同じ。welcome.spec.ts
 * のように毎回 `removeItem` で初期化するのとは逆方向。
 *
 * 呼び出しは `test.beforeEach` で `await primeWelcomeSkipped(context)` の形式。
 */
export async function primeWelcomeSkipped(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem(
        'asagi-welcome',
        JSON.stringify({ state: { completed: true }, version: 1 }),
      );
      window.localStorage.setItem('asagi-locale', 'ja');
    } catch {
      /* ignore: in-memory localStorage の初期化失敗は致命的でない */
    }
  });
}

/**
 * Sidecar mode badge の data-mode 属性を読む。
 *
 * StatusBar 右下に常駐する `data-testid="status-sidecar-mode-badge"` の
 * `data-mode` 属性は `'real' | 'mock'` の値を持ち、Real impl 切替検証で使う。
 *
 * 失敗時は null を返す（badge 未マウント = sidecar mode store 未初期化）。
 */
export async function readSidecarModeBadge(page: Page): Promise<string | null> {
  const badge = page.getByTestId('status-sidecar-mode-badge');
  try {
    return await badge.getAttribute('data-mode', { timeout: 5000 });
  } catch {
    return null;
  }
}

/**
 * Tauri webview 直接 driving 不可時の運用注記。
 *
 * Playwright (Chromium) は WebView2 / Tauri webview を直接操作できない。
 * 本 phase（M1）では `npm run dev` の dev サーバー経由 E2E を主軸とし、
 * 実機 Tauri ウィンドウ検証は **オーナー手動 smoke** で代替する
 * （`reports/dev-as145-smoke-2026-05-03.md` に手順 + screenshot 添付）。
 *
 * 本定数は spec の docstring から参照され、test 失敗時のデバッグ起点となる。
 */
export const TAURI_DRIVING_NOTE = `
本 spec は dev サーバー (http://localhost:1420) を主軸とする。
ASAGI_SIDECAR_MODE=real かつ Tauri webview 経由でないと
agent_spawn_sidecar が成立しないため、real handshake / multi-session
test は手動 smoke で代替する選択肢がある。
詳細: reports/pm-as145-wbs-2026-05-03.md § 4.2 R-E2E-1。
`.trim();
