import { test, expect } from '@playwright/test';
import path from 'node:path';

/**
 * AS-UX-05 / AS-UX-11 / DEC-018-040 Sidebar 4-tab smoke E2E.
 *
 * Welcome を localStorage で skip し、メインシェルに着地した状態から:
 *   1. Sidebar が表示され、4 タブ (Sessions/Files/Rules/Runtime) が並び Sessions tab が初期 active
 *   2. tablist の bounding box 高さが 36px 未満 ＝ 1 行に収まっている (Bug B 解消の物理確認)
 *   3. Files tab に切替 → list_dir 結果が表示される
 *   4. Rules tab に切替 → CLAUDE.md 検出行が表示される
 *   5. Runtime tab に切替 → Sub-agents セクションが表示される
 *   6. tests/screenshots/sidebar-4tab-256px.png に 4-tab レイアウト snapshot を保存
 *   7. Cmd+B (Ctrl+B) で sidebar が collapse → expand する toggle
 */

test.describe('@ux-sidebar-tabs AS-UX-11 Sidebar 4-tab', () => {
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
            return ['sidecar-mock-1'];
          case 'list_sessions':
            return [];
          case 'list_dir':
            // CLAUDE.md / AGENTS.md を含めることで Files / Rules tab 両方を満たす
            return [
              { name: 'README.md', path: '/mock/README.md', kind: 'file', size: 1234 },
              { name: 'CLAUDE.md', path: '/mock/CLAUDE.md', kind: 'file', size: 4242 },
              { name: 'AGENTS.md', path: '/mock/AGENTS.md', kind: 'file', size: 1024 },
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

  test('4 タブ 1 行レイアウト + Sessions/Files/Rules/Runtime 切替 + Cmd+B collapse', async ({ page }) => {
    await page.goto('/');

    // 1) Sidebar が表示され、Sessions tab が active
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible({ timeout: 10000 });
    await expect(sidebar).toHaveAttribute('data-collapsed', 'false');

    const tablist = page.getByTestId('sidebar-tablist');
    const tabSessions = page.getByTestId('sidebar-tab-sessions');
    const tabFiles = page.getByTestId('sidebar-tab-files');
    const tabRules = page.getByTestId('sidebar-tab-rules');
    const tabRuntime = page.getByTestId('sidebar-tab-runtime');

    // 4 タブ全件可視
    await expect(tabSessions).toBeVisible();
    await expect(tabFiles).toBeVisible();
    await expect(tabRules).toBeVisible();
    await expect(tabRuntime).toBeVisible();

    await expect(tabSessions).toHaveAttribute('aria-selected', 'true');
    await expect(tabFiles).toHaveAttribute('aria-selected', 'false');
    await expect(tabRules).toHaveAttribute('aria-selected', 'false');
    await expect(tabRuntime).toHaveAttribute('aria-selected', 'false');

    // 2) tablist の高さ ＝ 36px 未満 (1 行に収まる Bug B 物理確認)
    //    h-9 (36px) を超えると 2 行折返しの可能性が出るため厳密に < 36
    const box = await tablist.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThan(36);

    // 4-tab レイアウトのスクリーンショット保存（Bug B 解消エビデンス）
    await sidebar.screenshot({
      path: path.join('tests', 'screenshots', 'sidebar-4tab-256px.png'),
    });

    // 3) Files tab に切替 → list_dir 結果が見える
    await tabFiles.click();
    await expect(tabFiles).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('sidebar-panel-files')).toBeVisible();
    await expect(page.getByTestId('sidebar-panel-files')).toContainText('README.md');
    await expect(page.getByTestId('sidebar-panel-files')).toContainText('src');

    // 4) Rules tab に切替 → CLAUDE.md 検出行が表示される
    await tabRules.click();
    await expect(tabRules).toHaveAttribute('aria-selected', 'true');
    const rulesPanel = page.getByTestId('sidebar-panel-rules');
    await expect(rulesPanel).toBeVisible();
    await expect(page.getByTestId('rules-row-claude.md')).toHaveAttribute(
      'data-present',
      'true',
    );

    // 5) Runtime tab に切替 → Sub-agents が見える
    await tabRuntime.click();
    await expect(tabRuntime).toHaveAttribute('aria-selected', 'true');
    const runtimePanel = page.getByTestId('sidebar-panel-runtime');
    await expect(runtimePanel).toBeVisible();
    await expect(runtimePanel).toContainText('sidecar-mock-1');

    // 6) Cmd+B (or Ctrl+B) で collapse
    const isMac = process.platform === 'darwin';
    const mod = isMac ? 'Meta' : 'Control';
    await page.keyboard.press(`${mod}+b`);
    await expect(sidebar).toHaveAttribute('data-collapsed', 'true');
    // collapsed 時は tabpanel を render しない
    await expect(page.getByTestId('sidebar-panel-runtime')).toHaveCount(0);
    // tab buttons は依然見える (4 件)
    await expect(tabSessions).toBeVisible();
    await expect(tabFiles).toBeVisible();
    await expect(tabRules).toBeVisible();
    await expect(tabRuntime).toBeVisible();

    // 7) もう一度 Cmd+B で expand
    await page.keyboard.press(`${mod}+b`);
    await expect(sidebar).toHaveAttribute('data-collapsed', 'false');
    await expect(page.getByTestId('sidebar-panel-runtime')).toBeVisible();
  });
});
