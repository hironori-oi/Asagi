import { test, expect } from '@playwright/test';

/**
 * AS-CLEAN-11 / AS-CLEAN-12 恒久回帰スイート (AS-145.3 / AS-145.4 派生).
 *
 * 趣旨:
 *   - AS-145 本体 (codex-real-flow.spec.ts) は real Codex CLI binary が必要で
 *     CI では skip される。一方で AS-CLEAN-11 / 12 の修正は CI 上でも常時
 *     回帰検証されるべき性質（i18n キー / DOM 構造の固定）を持つ。
 *   - 本 spec は Tauri IPC を mock し、dev サーバー単体で
 *       (1) AS-CLEAN-11: SessionsTab に「DB 未接続」誤表示が出ない
 *       (2) AS-CLEAN-12: ChatPane InputArea 下に `[stub]` hint が表示されない
 *     を毎回 PASS させる安全網として機能する。
 *
 * 関連:
 *   - commit 280dbd4 (AS-CLEAN-11/12)
 *   - DEC-018-043
 *   - pm-as145-wbs-2026-05-03.md § 2.3 / § 2.4
 *
 * mock 範囲:
 *   - list_sessions: 1 件返す（`session-1`）→ SessionsTab が描画される正常系
 *   - agent_status / codex_get_models / auth_watchdog_get_state: ChatPane が
 *     エラー状態で stuck しないよう最小限のスタブを返す
 */

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    // Welcome を skip
    try {
      window.localStorage.setItem(
        'asagi-welcome',
        JSON.stringify({ state: { completed: true }, version: 1 }),
      );
      window.localStorage.setItem('asagi-locale', 'ja');
    } catch {
      /* ignore */
    }

    const w = window as unknown as {
      __TAURI_INTERNALS__?: {
        invoke: (cmd: string, payload?: Record<string, unknown>) => Promise<unknown>;
        transformCallback: (cb: (...args: unknown[]) => unknown, once?: boolean) => number;
        unregisterCallback?: (id: number) => void;
        callbacks?: Record<number, (...args: unknown[]) => unknown>;
      };
    };

    const callbacks: Record<number, (...args: unknown[]) => unknown> = {};
    let counter = 1;
    const transformCallback = (cb: (...args: unknown[]) => unknown, _once?: boolean) => {
      const id = counter++;
      callbacks[id] = cb;
      return id;
    };

    const invoke = async (
      cmd: string,
      _payload?: Record<string, unknown>,
    ): Promise<unknown> => {
      switch (cmd) {
        case 'plugin:event|listen':
          return 1;
        case 'plugin:event|unlisten':
        case 'plugin:event|emit':
        case 'plugin:event|emit_to':
          return null;
        case 'list_sessions':
          // AS-CLEAN-11 の本質は args の camelCase 化（commit 280dbd4）。
          // mock では args 中身は問わず、正常系として 1 件返す。
          return [
            {
              id: 'session-mock-1',
              title: 'Mock Session',
              project_id: 'default-asagi',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ];
        case 'list_messages':
          return [];
        case 'create_session':
          return 'session-mock-2';
        case 'create_message':
          return 'message-mock-1';
        case 'agent_spawn_sidecar':
        case 'agent_shutdown_sidecar':
          return null;
        case 'agent_list_sidecars':
          return [];
        case 'agent_status':
          return { account: null, requiresOpenaiAuth: true };
        case 'agent_get_sidecar_mode':
          return { mode: 'real' };
        case 'codex_get_models':
          return ['gpt-5.5-codex', 'gpt-5-codex', 'o4-mini'];
        case 'codex_get_quota':
          return { used: 42, limit: 500, plan: 'Pro 5x' };
        case 'auth_watchdog_get_state':
          return {
            kind: 'authenticated',
            last_checked_unix: 1727040000,
            plan: 'mock-pro-5x',
            user: 'mock-user@asagi.local',
          };
        case 'auth_watchdog_force_check':
        case 'auth_watchdog_start':
        case 'auth_watchdog_stop':
          return null;
        default:
          return null;
      }
    };

    w.__TAURI_INTERNALS__ = {
      invoke,
      transformCallback,
      callbacks,
      unregisterCallback: (id: number) => {
        delete callbacks[id];
      },
    };
  });
});

test('@regression AS-CLEAN-11: Sessions tab に「DB 未接続」誤表示が出ない', async ({ page }) => {
  await page.goto('/');

  const sessionsTab = page.getByTestId('sidebar-tab-sessions');
  await expect(sessionsTab).toBeVisible({ timeout: 10000 });
  await sessionsTab.click();

  const sessionsPanel = page.getByTestId('sidebar-panel-sessions');
  await expect(sessionsPanel).toBeVisible();

  // i18n: ja.json sidebar.loadFailed = 「セッション一覧の取得に失敗しました（DB 未接続）」
  await expect(sessionsPanel.getByText(/DB\s*未接続/)).toHaveCount(0);
  await expect(sessionsPanel.getByText(/セッション一覧の取得に失敗/)).toHaveCount(0);

  // mock で 1 件返したので、SessionItem が 1 件以上描画される
  const items = sessionsPanel.locator('ul > li > button');
  await expect(items.first()).toBeVisible({ timeout: 5000 });
});

test('@regression AS-CLEAN-12: ChatPane に `[stub]` hint が表示されない', async ({ page }) => {
  await page.goto('/');

  // ChatPane 着地確認
  await expect(page.getByTestId('chat-input-textarea')).toBeVisible({ timeout: 10000 });

  // commit 280dbd4 で input-area.tsx:192 のヒント削除済み
  await expect(page.getByText(/\[stub\]/)).toHaveCount(0);
  await expect(page.getByText(/POC 通過後に実装/)).toHaveCount(0);
});
