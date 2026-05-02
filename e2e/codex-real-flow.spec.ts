import { test, expect } from '@playwright/test';
import {
  REAL_SMOKE_TAG,
  primeWelcomeSkipped,
  readSidecarModeBadge,
  shouldSkipReal,
} from './helpers/real-mode';
import { CodexEvent } from '../src/lib/codex/schemas';
import { AgentEvents } from '../src/lib/tauri/events';

/**
 * AS-145 — Real Codex sidecar (Codex CLI 0.128.0 app-server 実機) E2E シナリオ。
 *
 * Phase 1 / M1 critical path 最終 2h。本 spec が PASS することで CEO 決裁ゲート ②
 * の起票材料が揃い、M1 完成宣言に到達する。
 *
 * 想定 4 シナリオ（PM § 1.2 / WBS pm-as145-wbs-2026-05-03.md）:
 *   1. Real handshake — dev サーバー起動 → ChatPane に「こんにちは」入力 → Send
 *      → 30s 以内に Codex から日本語 agent 応答が描画される
 *   2. Multi-session 切替 — project A で send → session B 作成 → send →
 *      A に戻って履歴独立性を assert（AS-CLEAN-11 regression check 含む）
 *   3. Settings preflight + auth status — Settings drawer 開く → sidecar mode
 *      picker の current value が `real` を assert + AS-CLEAN-12 regression check
 *      （ChatPane に `[stub]` hint が出ていないこと）
 *   4. 動画証跡 — gif_creator で smoke 動画 1 本以上、reports/screenshots/
 *      as145-real-smoke-2026-05-03/ に保存（spec ファイル内の自動化対象外、
 *      手動 smoke 報告書 dev-as145-smoke-2026-05-03.md にて担保）
 *
 * Real mode 前提:
 *   - `ASAGI_SIDECAR_MODE=real` で `RealCodexSidecar` 選択（DEC-018-035 実証済）
 *   - `CODEX_BIN_PATH` で Codex CLI 0.128.0 binary 解決可（本機: hiron Windows）
 *   - ChatGPT Pro 5x OAuth 済（DEC-018-035 smoke 3 で 8.08s 1 ターン応答実証）
 *   - Tauri webview 経由でないと `agent_spawn_sidecar` は成立しない（R-E2E-1）
 *
 * 重要 — Tauri webview driving 制約 (R-E2E-1):
 *   - Playwright (Chromium) は WebView2 / Tauri webview を直接操作できない
 *   - 本 spec は dev サーバー (port 1420) 主軸であり、`agent_spawn_sidecar` は
 *     Tauri 非接続環境では fallback (catch して空 list 返却) で動作する
 *   - そのため `@codex-real-smoke` タグの test 群は **`ASAGI_SIDECAR_MODE`
 *     未設定環境では全件 skip**（CI / Tauri 非接続な dev サーバー単体含む）
 *   - 実機 Real handshake は **オーナー手動 smoke** で reports/dev-as145-smoke-2026-05-03.md
 *     に記録、本 spec は (a) スキップ動作の正常性 + (b) 環境変数セット時の
 *     UI 表示 assertion を担保するという二段役割
 *
 * schema 文字列リテラル禁止 (PM § 6.5 厳守事項 7):
 *   - `'thread/started'` 等の magic string は使用禁止
 *   - 代わりに `CodexEvent.THREAD_STARTED` / `AgentEvents.threadStarted(pid)` を import
 *   - 本 spec では event 直接購読は行わないが、CI が文字列禁止規則を再確認できるよう
 *     import を維持し、log assertion 等で利用する余地を残す
 */

// schema constants の参照を維持し、tsc / lint の dead-import 警告と
// 「文字列リテラル禁止」契約の双方を満たす。実 assertion 内では使わなくとも、
// 将来の event log 検証拡張で参照する設計上の足場として残す。
void CodexEvent.THREAD_STARTED;
void CodexEvent.ITEM_AGENT_MESSAGE_DELTA;
void CodexEvent.TURN_COMPLETED;
void AgentEvents.threadStarted('default-asagi');

const REAL_PROJECT_ID = 'default-asagi';

test.describe(`${REAL_SMOKE_TAG} AS-145 — Real Codex sidecar E2E`, () => {
  test.beforeEach(async ({ context }) => {
    // Welcome ウィザードを skip して main shell に直接着地する。
    await primeWelcomeSkipped(context);
  });

  // ------------------------------------------------------------------
  // 1) AS-145.2 — Real handshake + agentMessage 表示
  //
  // 手動 smoke 手順 (R-E2E-1 fallback 時, Tauri 実機ウィンドウ):
  //   1. PowerShell で
  //        $env:ASAGI_SIDECAR_MODE='real'
  //        $env:CODEX_BIN_PATH='C:\Users\hiron\AppData\Roaming\npm\node_modules\
  //                              @openai\codex\node_modules\@openai\codex-win32-x64\
  //                              vendor\x86_64-pc-windows-msvc\codex\codex.exe'
  //   2. cd projects/PRJ-018/app/asagi-app && npm run tauri dev
  //   3. Welcome を skip (3 step 進行) → ChatPane に「こんにちは」入力
  //   4. Cmd/Ctrl+Enter で送信、30s 以内に Codex から日本語応答が出ることを確認
  //   5. StatusBar 右下の sidecar mode badge が `real` を示すことを確認
  //   6. 結果（応答時間 / 応答内容 / エラー）を reports/dev-as145-smoke-2026-05-03.md
  //      § 1 Real handshake 表に記録
  // ------------------------------------------------------------------
  test.describe('Real handshake', () => {
    test(`${REAL_SMOKE_TAG} 1 turn chat completes within 30s`, async ({ page }, testInfo) => {
      test.skip(shouldSkipReal(), 'ASAGI_SIDECAR_MODE=real が必須');
      // Tauri 非接続環境ではこの test は意味を持たないため、追加 guard。
      // dev サーバー単体実行時は env がセットされていても sidecar が起動しないので
      // skip 理由を明示する。
      // → R-E2E-1 fallback: 手動 smoke で代替
      test.skip(
        !process.env.ASAGI_TAURI_DRIVING,
        'Tauri webview 経由でないと agent_spawn_sidecar が成立しない (R-E2E-1)。' +
          ' 手動 smoke は reports/dev-as145-smoke-2026-05-03.md を参照',
      );

      await page.goto('/');

      // ChatPane 着地 → status badge が描画される
      const statusBadge = page.getByTestId('chat-status-badge');
      await expect(statusBadge).toBeVisible({ timeout: 10000 });

      // sidecar が ready になるまで待機（real binary spawn の I/O 安定）
      await expect(statusBadge).toHaveAttribute('data-status', 'ready', {
        timeout: 30000,
      });

      // Sidecar mode badge が `real` を示すことを assert
      const mode = await readSidecarModeBadge(page);
      expect(mode).toBe('real');

      // 「こんにちは」入力 → Cmd/Ctrl+Enter で送信
      const textarea = page.getByTestId('chat-input-textarea');
      await textarea.fill('こんにちは');
      await page.getByTestId('chat-send-button').click();

      // user メッセージが即時描画
      const userMsg = page.getByTestId('chat-message-user').first();
      await expect(userMsg).toContainText('こんにちは', { timeout: 2000 });

      // assistant メッセージが 30s 以内に描画される（DEC-018-035 smoke 3 = 8.08s 実測）
      const assistantMsg = page.getByTestId('chat-message-assistant').first();
      await expect(assistantMsg).toBeVisible({ timeout: 30000 });

      // 日本語が含まれていることを正規表現で検証（exact match は不可能）
      const text = (await assistantMsg.textContent()) ?? '';
      expect(text.length).toBeGreaterThan(0);
      expect(text).toMatch(/[ぁ-ん一-龥]/);

      await testInfo.attach('assistant-text', {
        body: text,
        contentType: 'text/plain',
      });
    });
  });

  // ------------------------------------------------------------------
  // 2) AS-145.3 — Multi-session 切替 + メッセージ独立性
  //    + AS-CLEAN-11 regression check (DB 未接続誤表示なし)
  //
  // 手動 smoke 手順:
  //   1. AS-145.2 続きで session A 状態
  //   2. Sidebar の Sessions tab に切替（既に active なら省略）
  //   3. 「+ 新規セッション」ボタンを押下 → session B 着地
  //   4. session B で「テストB」入力 → 送信 → assistant 応答待機
  //   5. Sidebar 一覧の最下段（session A）をクリック → A の履歴復元を確認
  //   6. session A の message-list に「テストB」が含まれない（独立性）
  //   7. Sessions tab に「DB 未接続」「セッション一覧の取得に失敗」が
  //      表示されない（AS-CLEAN-11 regression check）
  //   8. 結果を reports/dev-as145-smoke-2026-05-03.md § 2 に記録
  // ------------------------------------------------------------------
  test.describe('Multi-session 切替', () => {
    test(`${REAL_SMOKE_TAG} A/B switch keeps message isolation`, async ({ page }) => {
      test.skip(shouldSkipReal(), 'ASAGI_SIDECAR_MODE=real が必須');
      test.skip(
        !process.env.ASAGI_TAURI_DRIVING,
        'Tauri webview 経由でないと create_session / list_sessions が DB に届かない (R-E2E-1)',
      );

      await page.goto('/');

      // Sidebar の Sessions tab に切替（AS-UX-11 / DEC-018-040 4-tab）
      const sessionsTab = page.getByTestId('sidebar-tab-sessions');
      await expect(sessionsTab).toBeVisible({ timeout: 10000 });
      await sessionsTab.click();

      const sessionsPanel = page.getByTestId('sidebar-panel-sessions');
      await expect(sessionsPanel).toBeVisible();

      // AS-CLEAN-11 regression check: 「DB 未接続」誤表示が出ない
      // （commit 280dbd4 で list_sessions args が camelCase 化済み）
      // i18n: ja.json sidebar.loadFailed = 「セッション一覧の取得に失敗しました（DB 未接続）」
      await expect(
        sessionsPanel.getByText(/DB\s*未接続/),
      ).toHaveCount(0);
      await expect(
        sessionsPanel.getByText(/セッション一覧の取得に失敗/),
      ).toHaveCount(0);

      // session A: 既存 active session に「こんにちは」を送る
      const textareaA = page.getByTestId('chat-input-textarea');
      await textareaA.fill('こんにちは');
      await page.getByTestId('chat-send-button').click();

      // assistant 応答到着まで待機
      await expect(page.getByTestId('chat-message-assistant').first()).toBeVisible({
        timeout: 30000,
      });

      // session B: 新規セッション作成
      // NewSessionButton には testid が無いので aria-label / title から取得
      // i18n: sidebar.newSession = '新規セッション'
      await sessionsPanel.getByRole('button', { name: '新規セッション' }).click();

      // session B 着地 → 「テストB」を送信
      const textareaB = page.getByTestId('chat-input-textarea');
      await textareaB.fill('テストB');
      await page.getByTestId('chat-send-button').click();
      await expect(page.getByTestId('chat-message-user').last()).toContainText('テストB');

      // session B の assistant 応答待機
      await expect(page.getByTestId('chat-message-assistant').last()).toBeVisible({
        timeout: 30000,
      });

      // session A に戻る（SessionItem に testid が無いため、一覧 <li> 内の
      // <button aria-current> パターンで取得。新規順 desc で並ぶため、最後 = A）。
      const sessionItems = sessionsPanel.locator('ul > li > button');
      const count = await sessionItems.count();
      expect(count).toBeGreaterThanOrEqual(2);
      await sessionItems.nth(count - 1).click();

      // session A の message-list に「こんにちは」が再描画
      await expect(page.getByTestId('chat-message-user').first()).toContainText('こんにちは');

      // 「テストB」が A の message-list に含まれない（独立性検証）
      await expect(page.getByText('テストB')).toHaveCount(0);

      // 再度 AS-CLEAN-11 regression check（セッション切替後も誤表示が再発しない）
      await expect(sessionsPanel.getByText(/DB\s*未接続/)).toHaveCount(0);
    });
  });

  // ------------------------------------------------------------------
  // 3) AS-145.4 — Settings preflight + auth status
  //    + AS-CLEAN-12 regression check (stub hint 表示なし)
  //
  // 手動 smoke 手順:
  //   1. TitleBar 右上の Settings (歯車) ボタンをクリック → drawer open
  //   2. Sidecar Mode セクションの `real` ボタンが selected (border-accent) を確認
  //   3. ChatPane ヘッダ右肩の AuthBadge が緑（authenticated 表示）を確認
  //   4. ChatPane InputArea 下に `[stub] Codex 統合は POC 通過後に実装` が
  //      表示されない（AS-CLEAN-12 regression check）
  //   5. StatusBar 右下の sidecar mode badge が `real` 表示
  //   6. 結果を reports/dev-as145-smoke-2026-05-03.md § 3 に記録
  //
  // 注: M1 完成時点で Settings drawer 内に「preflight」専用セクションは
  //     未実装（M1.1 backlog）。本 test では sidecar mode picker / AuthBadge /
  //     stub hint の 3 点で preflight 相当を担保する。
  // ------------------------------------------------------------------
  test.describe('Settings preflight', () => {
    test(`${REAL_SMOKE_TAG} sidecar mode = real + auth ok + no stub hint`, async ({ page }) => {
      test.skip(shouldSkipReal(), 'ASAGI_SIDECAR_MODE=real が必須');
      // 本 test は Settings drawer の sidecar mode picker / AuthBadge / stub hint
      // のみを検証する。real binary 起動は Real handshake test 側で担保するため、
      // Tauri driving 不在でも UI assertion 部分は実行可能。
      // ただし AuthBadge の「authenticated」表示は agent_status invoke が
      // 成功する必要があるため、Tauri 接続を求める。
      test.skip(
        !process.env.ASAGI_TAURI_DRIVING,
        'AuthBadge の authenticated 表示は agent_status invoke が必要 (R-E2E-1)',
      );

      await page.goto('/');

      // メインシェル着地確認
      await expect(page.getByTestId('chat-status-badge')).toBeVisible({ timeout: 10000 });

      // AS-CLEAN-12 regression check: ChatPane に `[stub] Codex 統合は POC 通過後に実装` が出ない
      // commit 280dbd4 で input-area.tsx:192 のヒント削除済み
      await expect(page.getByText(/\[stub\]/)).toHaveCount(0);
      await expect(page.getByText(/POC 通過後に実装/)).toHaveCount(0);

      // StatusBar の Sidecar mode badge が `real` を示す（preflight 相当）
      const sidecarMode = await readSidecarModeBadge(page);
      expect(sidecarMode).toBe('real');

      // AuthBadge: data-auth=authenticated（DEC-018-028 QW1 F3 Auth Watchdog で
      // ChatGPT Pro 5x OAuth 済の場合）
      const authBadge = page.getByTestId('auth-badge');
      await expect(authBadge).toBeVisible({ timeout: 5000 });
      await expect(authBadge).toHaveAttribute('data-auth', 'authenticated', {
        timeout: 10000,
      });

      // Settings drawer を開く（TitleBar の Settings ボタン）
      // i18n: shell.titlebar.settings = '設定'
      await page.getByRole('button', { name: '設定' }).first().click();

      // sidecar-mode-group が visible で、real が aria-checked=true
      const modeGroup = page.getByTestId('sidecar-mode-group');
      await expect(modeGroup).toBeVisible({ timeout: 5000 });
      const realOption = page.getByTestId('sidecar-mode-option-real');
      await expect(realOption).toHaveAttribute('aria-checked', 'true');
    });
  });

  // ------------------------------------------------------------------
  // 4) AS-145.4 — UI 静的 assertion（Tauri driving 不在でも実行可能）
  //    sidecar mode badge の存在 + AS-CLEAN-12 regression check の static 部分
  // ------------------------------------------------------------------
  test.describe('Static UI guards (Tauri 不在でも実行)', () => {
    test(`${REAL_SMOKE_TAG} stub hint absent + sidecar badge mounted`, async ({ page }) => {
      test.skip(shouldSkipReal(), 'ASAGI_SIDECAR_MODE=real が必須');
      // 本 test は Tauri driving guard を意図的に外し、dev サーバー単体で
      // (a) `[stub]` hint 不在（AS-CLEAN-12 regression）
      // (b) sidecar mode badge が DOM にマウントされている（描画 path 健全性）
      // を最低限担保する。real handshake / auth は他 test で。
      REAL_PROJECT_ID; // mark used

      await page.goto('/');

      // StatusBar / ChatPane が描画されるまで（Tauri 非接続でも MessageList は出る）
      await expect(page.getByTestId('chat-input-textarea')).toBeVisible({
        timeout: 15000,
      });

      // AS-CLEAN-12 regression check
      await expect(page.getByText(/\[stub\]/)).toHaveCount(0);
      await expect(page.getByText(/POC 通過後に実装/)).toHaveCount(0);

      // Sidecar mode badge が DOM 上に存在（Tauri 非接続時は `mock` のことがあるため
      // 値の assert はせず、マウント健全性のみ検証）
      await expect(page.getByTestId('status-sidecar-mode-badge')).toBeVisible({
        timeout: 5000,
      });
    });
  });
});
