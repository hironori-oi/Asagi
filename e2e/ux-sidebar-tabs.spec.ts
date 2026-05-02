import { test, expect } from '@playwright/test';

/**
 * AS-UX-05 / DEC-018-037 §① Sidebar 5-tab phase 1 smoke E2E.
 *
 * Welcome を localStorage で skip し、メインシェルに着地した状態から:
 *   1. Sidebar が表示され、Sessions tab が初期 active
 *   2. Files tab に切替 → list_dir 結果が表示される
 *   3. Runtime tab に切替 → Sub-agents セクションが表示される
 *
 * 加えて Cmd+B (Ctrl+B) で sidebar が collapse → expand する toggle も検証。
 *
 * ※ 5 tab のうち Servers / Rules は M1.1 評価のため対象外。
 */

test.describe('@ux-sidebar-tabs AS-UX-05 Sidebar 5-tab phase 1', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      try {
        // Welcome をスキップ
        window.localStorage.setItem(
          'asagi-welcome',
          JSON.stringify({ state: { completed: true }, version: 1 }),
        );
        window.localStorage.setItem('asagi-locale', 'ja');
        // Sidebar UI state を初期化（Sessions tab / not collapsed）
        window.localStorage.removeItem('asagi-ui');
      } catch {
        /* ignore */
      }

      // Tauri mock — Sidebar 関連の invoke を中心に。
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
            // 本実装は Vec<String>（sidecar ID のみ）を返す
            return ['sidecar-mock-1'];
          case 'list_sessions':
            return [];
          case 'list_dir':
            return [
              { name: 'README.md', path: '/mock/README.md', kind: 'file', size: 1234 },
              { name: 'src', path: '/mock/src', kind: 'dir', size: null },
              { name: 'package.json', path: '/mock/package.json', kind: 'file', size: 567 },
            ];
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

  test('Sessions → Files → Runtime tab 切替 + Cmd+B collapse', async ({ page }) => {
    await page.goto('/');

    // 1) Sidebar が表示され、Sessions tab が active
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible({ timeout: 10000 });
    await expect(sidebar).toHaveAttribute('data-collapsed', 'false');

    const tabSessions = page.getByTestId('sidebar-tab-sessions');
    const tabFiles = page.getByTestId('sidebar-tab-files');
    const tabRuntime = page.getByTestId('sidebar-tab-runtime');
    await expect(tabSessions).toHaveAttribute('aria-selected', 'true');
    await expect(tabFiles).toHaveAttribute('aria-selected', 'false');
    await expect(tabRuntime).toHaveAttribute('aria-selected', 'false');

    // 2) Files tab に切替 → list_dir 結果が見える
    await tabFiles.click();
    await expect(tabFiles).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('sidebar-panel-files')).toBeVisible();
    await expect(page.getByTestId('sidebar-panel-files')).toContainText('README.md');
    await expect(page.getByTestId('sidebar-panel-files')).toContainText('src');

    // 3) Runtime tab に切替 → Sub-agents が見える
    await tabRuntime.click();
    await expect(tabRuntime).toHaveAttribute('aria-selected', 'true');
    const runtimePanel = page.getByTestId('sidebar-panel-runtime');
    await expect(runtimePanel).toBeVisible();
    await expect(runtimePanel).toContainText('sidecar-mock-1');

    // 4) Cmd+B (or Ctrl+B) で collapse
    const isMac = process.platform === 'darwin';
    const mod = isMac ? 'Meta' : 'Control';
    await page.keyboard.press(`${mod}+b`);
    await expect(sidebar).toHaveAttribute('data-collapsed', 'true');
    // collapsed 時は tabpanel を render しない
    await expect(page.getByTestId('sidebar-panel-runtime')).toHaveCount(0);
    // tab buttons は依然見える
    await expect(tabRuntime).toBeVisible();

    // 5) もう一度 Cmd+B で expand
    await page.keyboard.press(`${mod}+b`);
    await expect(sidebar).toHaveAttribute('data-collapsed', 'false');
    await expect(page.getByTestId('sidebar-panel-runtime')).toBeVisible();
  });
});
