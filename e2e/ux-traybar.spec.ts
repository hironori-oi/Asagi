import { test, expect } from '@playwright/test';

/**
 * AS-UX-01 / DEC-018-037 §② TrayBar smoke E2E.
 *
 * Welcome を localStorage で skip し、メインシェルに着地した状態から:
 *   1. TrayBar が表示される (data-testid="tray-bar")
 *   2. Model picker を開く → 候補一覧が出る
 *   3. 候補を選択 → trigger label が選んだ model の略号に変わる
 *
 * 詳細な a11y / keyboard navigation は手動 + axe-core で別途。
 */

test.describe('@ux-traybar AS-UX-01 TrayBar 集約 picker', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      try {
        // Welcome をスキップ
        window.localStorage.setItem(
          'asagi-welcome',
          JSON.stringify({ state: { completed: true }, version: 1 }),
        );
        window.localStorage.setItem('asagi-locale', 'ja');
      } catch {
        /* ignore */
      }

      // 最小限の Tauri mock — codex_get_models のみ返す。
      // 他 invoke は null を返して落ちないようにする。
      const w = window as unknown as {
        __TAURI_INTERNALS__?: {
          invoke: (cmd: string, payload?: Record<string, unknown>) => Promise<unknown>;
          transformCallback: (cb: (...args: unknown[]) => unknown, once?: boolean) => number;
          unregisterCallback?: (id: number) => void;
          callbacks?: Record<number, (...args: unknown[]) => unknown>;
        };
      };

      const callbacks: Record<number, (...args: unknown[]) => unknown> = {};
      let callbackCounter = 1;
      const transformCallback = (cb: (...args: unknown[]) => unknown, _once?: boolean) => {
        const id = callbackCounter++;
        callbacks[id] = cb;
        return id;
      };

      const invoke = async (cmd: string, _payload?: Record<string, unknown>): Promise<unknown> => {
        switch (cmd) {
          case 'plugin:event|listen':
            return 1;
          case 'plugin:event|unlisten':
          case 'plugin:event|emit':
          case 'plugin:event|emit_to':
            return null;
          case 'codex_get_models':
            return ['gpt-5.5-codex', 'gpt-5-codex', 'o4-mini'];
          case 'codex_get_quota':
            return { used: 42, limit: 500, plan: 'Pro 5x' };
          case 'agent_get_sidecar_mode':
            return { mode: 'mock' };
          case 'agent_status':
            return { account: null, requiresOpenaiAuth: true };
          case 'agent_list_sidecars':
            return [];
          case 'list_sessions':
            return [];
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

  test('TrayBar 表示 → Model picker 開く → 選択 → label 反映', async ({ page }) => {
    await page.goto('/');

    // 1) TrayBar が見える
    const trayBar = page.getByTestId('tray-bar');
    await expect(trayBar).toBeVisible({ timeout: 10000 });

    // Model picker / Effort picker が並んで見える
    const modelPicker = page.getByTestId('tray-model-picker');
    const effortPicker = page.getByTestId('tray-effort-picker');
    await expect(modelPicker).toBeVisible();
    await expect(effortPicker).toBeVisible();

    // 2) Model picker を開く
    await modelPicker.getByRole('button').first().click();

    // 3) 候補 "o4-mini" を選択
    const opt = page.getByTestId('tray-model-option-o4-mini');
    await expect(opt).toBeVisible({ timeout: 2000 });
    await opt.click();

    // 4) trigger label に "o4-mini" が反映される (略号変換対象外なので素のまま)
    await expect(modelPicker).toContainText('o4-mini');
  });
});
