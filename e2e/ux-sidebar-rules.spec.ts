import { test, expect } from '@playwright/test';

/**
 * AS-UX-11.3 / DEC-018-040 ③ Rules tab dedicated E2E。
 *
 * Welcome を localStorage で skip し Rules タブをクリックした直後の挙動を検証する。
 *   1. detected ケース: list_dir mock が CLAUDE.md と AGENTS.md を返すと両者とも
 *      data-present="true" 表示、未検出 CODEX.md だけ「未検出」placeholder
 *   2. all-missing ケース: list_dir mock が一切返さないと 3 行とも「未検出」+ empty 文言
 *
 * Rules タブは AS-UX-11 で旧 Inspector の context tab を吸収した先。本 spec の
 * detected/non-detected の 2 パスで M1 段階の最低保証ラインを担保する。
 */

interface FsRow {
  name: string;
  path: string;
  kind: 'file' | 'dir' | 'symlink';
  size: number | null;
}

async function installMock(
  context: import('@playwright/test').BrowserContext,
  rulesEntries: FsRow[],
) {
  await context.addInitScript(
    ({ rulesEntries: entries }) => {
      try {
        window.localStorage.setItem(
          'asagi-welcome',
          JSON.stringify({ state: { completed: true }, version: 1 }),
        );
        window.localStorage.setItem('asagi-locale', 'ja');
        window.localStorage.removeItem('asagi-ui');
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
      let callbackCounter = 1;
      const transformCallback = (
        cb: (...args: unknown[]) => unknown,
        _once?: boolean,
      ) => {
        const id = callbackCounter++;
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
          case 'codex_get_models':
            return ['gpt-5.5-codex', 'gpt-5-codex', 'o4-mini'];
          case 'codex_get_quota':
            return { used: 0, limit: 100, plan: 'mock' };
          case 'agent_get_sidecar_mode':
            return { mode: 'mock' };
          case 'agent_status':
            return { account: null, requiresOpenaiAuth: true };
          case 'agent_list_sidecars':
            return [];
          case 'list_sessions':
            return [];
          case 'list_dir':
            return entries;
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
    },
    { rulesEntries },
  );
}

test.describe('@ux-sidebar-rules AS-UX-11.3 Rules tab', () => {
  test('CLAUDE.md / AGENTS.md 検出 → 行表示、CODEX.md は未検出 placeholder', async ({
    context,
    page,
  }) => {
    await installMock(context, [
      { name: 'CLAUDE.md', path: '/mock/CLAUDE.md', kind: 'file', size: 4242 },
      { name: 'AGENTS.md', path: '/mock/AGENTS.md', kind: 'file', size: 1024 },
      { name: 'README.md', path: '/mock/README.md', kind: 'file', size: 100 },
      { name: 'src', path: '/mock/src', kind: 'dir', size: null },
    ]);

    await page.goto('/');

    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible({ timeout: 10000 });

    const tabRules = page.getByTestId('sidebar-tab-rules');
    await tabRules.click();
    await expect(tabRules).toHaveAttribute('aria-selected', 'true');

    const panel = page.getByTestId('sidebar-panel-rules');
    await expect(panel).toBeVisible();

    const claude = page.getByTestId('rules-row-claude.md');
    const agents = page.getByTestId('rules-row-agents.md');
    const codex = page.getByTestId('rules-row-codex.md');

    await expect(claude).toHaveAttribute('data-present', 'true');
    await expect(claude).toContainText('CLAUDE.md');
    await expect(claude).toContainText('4242 B');

    await expect(agents).toHaveAttribute('data-present', 'true');
    await expect(agents).toContainText('AGENTS.md');

    await expect(codex).toHaveAttribute('data-present', 'false');
    await expect(codex).toContainText('未検出');
  });

  test('全候補未検出: empty メッセージ + 3 行とも未検出 placeholder', async ({
    context,
    page,
  }) => {
    await installMock(context, [
      { name: 'README.md', path: '/mock/README.md', kind: 'file', size: 100 },
      { name: 'src', path: '/mock/src', kind: 'dir', size: null },
    ]);

    await page.goto('/');

    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible({ timeout: 10000 });

    await page.getByTestId('sidebar-tab-rules').click();
    const panel = page.getByTestId('sidebar-panel-rules');
    await expect(panel).toBeVisible();

    await expect(panel).toContainText('プロジェクトルートに規約ファイルがありません');

    for (const id of ['rules-row-claude.md', 'rules-row-agents.md', 'rules-row-codex.md']) {
      const row = page.getByTestId(id);
      await expect(row).toHaveAttribute('data-present', 'false');
      await expect(row).toContainText('未検出');
    }
  });
});
