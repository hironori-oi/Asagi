import { test, expect } from '@playwright/test';

/**
 * Codex sidecar mock E2E (AS-145 / DEC-018-023).
 *
 * `/dev/codex-mock` ページに対し:
 *   1. spawn を押す → status が ready になる
 *   2. message を入力して send → assistant message が 10 token 連結で 1 件追加
 *   3. shutdown を押す → status が idle に戻る
 *
 * Tauri 実 binary は使わず、`@tauri-apps/api/mocks#mockIPC` を addInitScript
 * 経由で仕込むことで、Rust 側 codex_sidecar の挙動をブラウザ内エミュレートする。
 *
 * - mock の応答 token は real の MOCK_RESPONSE_TEMPLATE 相当 (10 chunks ×
 *   "mock app-server からの応答です（モデル: gpt-mock-5.5）") を即時 emit する。
 * - emit ターゲットは `agent:{projectId}:item/agentMessage/delta` および
 *   `agent:{projectId}:turn/completed`。
 *
 * 本 spec は @smoke ではないので CI smoke run には含まれない。
 */

const MOCK_PROJECT_ID = 'dev-mock-project';

test.beforeEach(async ({ context }) => {
  // Tauri IPC + Event を `mockIPC(shouldMockEvents: true)` で差し替える。
  await context.addInitScript(
    ({ projectId }) => {
      // mocks.js を直接 import できないので window グローバルに inline 実装する。
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
      // event listener registry: event_name -> Set<id>
      const eventListeners: Record<string, Set<number>> = {};

      const transformCallback = (cb: (...args: unknown[]) => unknown, _once?: boolean) => {
        const id = callbackCounter++;
        callbacks[id] = cb;
        return id;
      };

      const emit = (event: string, payload: unknown) => {
        const ids = eventListeners[event];
        if (!ids) return;
        for (const id of ids) {
          const cb = callbacks[id];
          if (cb) cb({ event, id, payload });
        }
      };

      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      const mockResponseTokens = [
        'mock ',
        'app-server ',
        'からの',
        '応答',
        'です',
        '（モデル: ',
        'gpt-mock',
        '-5.5',
        '）',
        '',
      ];

      const handleAgentSend = async (args: { project_id: string; content: string; thread_id?: string }) => {
        const pid = args.project_id;
        const threadId = args.thread_id ?? `thread-${Date.now()}`;
        const turnId = `turn-${Date.now()}`;
        const itemId = `item-${Date.now()}`;
        // background で deltas を emit
        (async () => {
          for (const tok of mockResponseTokens) {
            if (tok === '') continue;
            await sleep(20);
            emit(`agent:${pid}:item/agentMessage/delta`, {
              itemId,
              delta: tok,
            });
          }
          await sleep(20);
          emit(`agent:${pid}:turn/completed`, {
            turn: { id: turnId, status: 'completed', items: [] },
          });
        })();
        return { thread_id: threadId, turn_id: turnId };
      };

      const sidecars = new Set<string>();

      const invoke = async (cmd: string, payload?: Record<string, unknown>): Promise<unknown> => {
        switch (cmd) {
          case 'plugin:event|listen': {
            const event = payload!.event as string;
            const handlerId = payload!.handler as number;
            if (!eventListeners[event]) eventListeners[event] = new Set();
            eventListeners[event].add(handlerId);
            return handlerId;
          }
          case 'plugin:event|unlisten': {
            const event = payload!.event as string;
            const eventId = payload!.eventId as number;
            eventListeners[event]?.delete(eventId);
            return null;
          }
          case 'plugin:event|emit':
          case 'plugin:event|emit_to':
            return null;
          case 'agent_spawn_sidecar': {
            sidecars.add(payload!.projectId as string);
            return null;
          }
          case 'agent_shutdown_sidecar': {
            sidecars.delete(payload!.projectId as string);
            return null;
          }
          case 'agent_list_sidecars':
            return Array.from(sidecars);
          case 'agent_send_message_v2':
            return handleAgentSend(payload!.args as { project_id: string; content: string; thread_id?: string });
          case 'agent_status':
            return { account: null, requiresOpenaiAuth: true };
          case 'codex_get_models':
            return ['gpt-5.5-codex', 'gpt-5-codex', 'o4-mini'];
          case 'create_message':
            return `msg-${Math.random().toString(36).slice(2, 8)}`;
          case 'list_sessions':
            return [];
          case 'get_session':
            return null;
          default:
            // 不明 cmd は no-op で null を返す。
            // console.warn だと test ログが汚れるので silent.
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

      // expose for debugging
      (window as unknown as { __ASAGI_MOCK_PROJECT_ID__?: string }).__ASAGI_MOCK_PROJECT_ID__ = projectId;
    },
    { projectId: MOCK_PROJECT_ID },
  );
});

test('@codex-mock spawn → send → 10-token streaming → shutdown', async ({ page }) => {
  await page.goto('/dev/codex-mock/');

  // status badge initial = idle
  const status = page.getByTestId('codex-mock-status');
  await expect(status).toHaveAttribute('data-status', 'idle');

  // spawn
  await page.getByTestId('codex-mock-spawn').click();
  await expect(status).toHaveAttribute('data-status', 'ready', { timeout: 5000 });

  // send "ハロー"
  await page.getByTestId('codex-mock-input').fill('ハロー');
  await page.getByTestId('codex-mock-send').click();

  // user message が 1 件追加
  const userMsg = page.getByTestId('codex-mock-message-user');
  await expect(userMsg).toContainText('ハロー');

  // assistant message: 完了するまで待つ
  const assistantMsg = page.getByTestId('codex-mock-message-assistant');
  await expect(assistantMsg).toBeVisible({ timeout: 5000 });
  // turn/completed まで待つ
  await expect(status).toHaveAttribute('data-status', 'ready', { timeout: 5000 });
  // 連結された結果文字列の一部が含まれる (10 token のうち少なくとも代表片を確認)
  await expect(assistantMsg).toContainText('mock');
  await expect(assistantMsg).toContainText('app-server');
  await expect(assistantMsg).toContainText('応答');

  // shutdown
  await page.getByTestId('codex-mock-shutdown').click();
  await expect(status).toHaveAttribute('data-status', 'idle', { timeout: 5000 });
});

/**
 * DEC-018-026 ① UX polish E2E (typing indicator + token count + interrupt).
 *
 * ChatPane 本体に対する E2E。Welcome 完了フラグを localStorage に直接書き、
 * default-asagi project に着地した状態から実施する。
 *
 * 上書き mock の特徴:
 *   - agent_send_message_v2 の delta を 200ms 間隔で発火し、interrupt の
 *     検証時間を確保する。
 *   - agent_interrupt は受信時にループを止め、turn/completed を即時 emit する。
 *
 * 検証:
 *   1. typing indicator (data-testid="chat-typing-indicator") が send 直後に出る
 *   2. interrupt button (data-testid="chat-interrupt-button") を押すと
 *      `(中断されました)` マーカー (data-testid="chat-message-interrupted-marker") が出る
 *   3. assistant message の token 数表示 (data-testid="chat-message-tokens") が
 *      1 以上 + session 累計バッジ (data-testid="chat-session-tokens") が出る
 */
test.describe('@codex-mock-ux DEC-018-026 ① ChatPane UX polish', () => {
  const CHATPANE_PROJECT_ID = 'default-asagi';

  test.beforeEach(async ({ context }) => {
    await context.addInitScript(
      ({ projectId }) => {
        // Welcome をスキップしてメインシェルに入る
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
        let callbackCounter = 1;
        const eventListeners: Record<string, Set<number>> = {};

        const transformCallback = (cb: (...args: unknown[]) => unknown, _once?: boolean) => {
          const id = callbackCounter++;
          callbacks[id] = cb;
          return id;
        };

        const emit = (event: string, payload: unknown) => {
          const ids = eventListeners[event];
          if (!ids) return;
          for (const id of ids) {
            const cb = callbacks[id];
            if (cb) cb({ event, id, payload });
          }
        };

        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

        // 200ms 間隔の slow-token mock — interrupt 検証のため間隔を伸ばす。
        const mockTokens = ['mock', ' app', '-server', ' resp', 'onse', ' xx', ' yy', ' zz'];

        // turnId -> { cancelled }
        const runningTurns: Record<string, { cancelled: boolean }> = {};

        const handleAgentSend = async (args: { project_id: string; content: string; thread_id?: string }) => {
          const pid = args.project_id;
          const threadId = args.thread_id ?? `thread-${Date.now()}`;
          const turnId = `turn-${Date.now()}`;
          const itemId = `item-${Date.now()}`;
          runningTurns[turnId] = { cancelled: false };
          (async () => {
            for (const tok of mockTokens) {
              await sleep(200);
              const t = runningTurns[turnId];
              if (!t || t.cancelled) break;
              emit(`agent:${pid}:item/agentMessage/delta`, {
                itemId,
                delta: tok,
              });
            }
            await sleep(50);
            emit(`agent:${pid}:turn/completed`, {
              turn: { id: turnId, status: runningTurns[turnId]?.cancelled ? 'interrupted' : 'completed', items: [] },
            });
            delete runningTurns[turnId];
          })();
          return { thread_id: threadId, turn_id: turnId };
        };

        const handleAgentInterrupt = async (args: { project_id: string; thread_id?: string; turn_id?: string }) => {
          if (args.turn_id && runningTurns[args.turn_id]) {
            runningTurns[args.turn_id]!.cancelled = true;
          } else {
            for (const k of Object.keys(runningTurns)) {
              runningTurns[k]!.cancelled = true;
            }
          }
          return null;
        };

        const sidecars = new Set<string>();

        const invoke = async (cmd: string, payload?: Record<string, unknown>): Promise<unknown> => {
          switch (cmd) {
            case 'plugin:event|listen': {
              const event = payload!.event as string;
              const handlerId = payload!.handler as number;
              if (!eventListeners[event]) eventListeners[event] = new Set();
              eventListeners[event].add(handlerId);
              return handlerId;
            }
            case 'plugin:event|unlisten': {
              const event = payload!.event as string;
              const eventId = payload!.eventId as number;
              eventListeners[event]?.delete(eventId);
              return null;
            }
            case 'plugin:event|emit':
            case 'plugin:event|emit_to':
              return null;
            case 'agent_spawn_sidecar': {
              sidecars.add(payload!.projectId as string);
              return null;
            }
            case 'agent_shutdown_sidecar': {
              sidecars.delete(payload!.projectId as string);
              return null;
            }
            case 'agent_list_sidecars':
              return Array.from(sidecars);
            case 'agent_send_message_v2':
              return handleAgentSend(payload!.args as { project_id: string; content: string; thread_id?: string });
            case 'agent_interrupt':
              return handleAgentInterrupt(payload!.args as { project_id: string; thread_id?: string; turn_id?: string });
            case 'agent_status':
              return { account: null, requiresOpenaiAuth: true };
            case 'codex_get_models':
              return ['gpt-5.5-codex', 'gpt-5-codex', 'o4-mini'];
            case 'create_message':
              return `msg-${Math.random().toString(36).slice(2, 8)}`;
            case 'list_sessions':
              return [];
            case 'get_session':
              return null;
            case 'create_session':
              return `sess-${Math.random().toString(36).slice(2, 8)}`;
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

        (window as unknown as { __ASAGI_CHATPANE_PROJECT_ID__?: string }).__ASAGI_CHATPANE_PROJECT_ID__ = projectId;
      },
      { projectId: CHATPANE_PROJECT_ID },
    );
  });

  test('typing indicator → interrupt → tokens 表示が ChatPane に揃う', async ({ page }) => {
    await page.goto('/');

    // ChatPane 着地確認 (status badge は ChatPane 内で render)
    const statusBadge = page.getByTestId('chat-status-badge');
    await expect(statusBadge).toBeVisible({ timeout: 10000 });
    // sidecar spawn → ready
    await expect(statusBadge).toHaveAttribute('data-status', 'ready', { timeout: 10000 });

    // 1) send → typing indicator が出る (最初の delta が 200ms 後)
    const textarea = page.getByTestId('chat-input-textarea');
    await textarea.fill('ハロー');
    await page.getByTestId('chat-send-button').click();

    const typing = page.getByTestId('chat-typing-indicator');
    await expect(typing).toBeVisible({ timeout: 1500 });

    // streaming 中になる
    await expect(statusBadge).toHaveAttribute('data-status', 'streaming', { timeout: 2000 });

    // 最初の delta 到着で typing indicator が消える
    await expect(typing).toBeHidden({ timeout: 2000 });

    // 2) interrupt button が表示されたらクリック
    const interruptBtn = page.getByTestId('chat-interrupt-button');
    await expect(interruptBtn).toBeVisible({ timeout: 2000 });
    await interruptBtn.click();

    // interrupted marker が assistant message に出る
    const interruptedMarker = page.getByTestId('chat-message-interrupted-marker');
    await expect(interruptedMarker).toBeVisible({ timeout: 2000 });

    // 状態が ready に戻る
    await expect(statusBadge).toHaveAttribute('data-status', 'ready', { timeout: 3000 });

    // 3) tokens 表示
    const tokenBadge = page.getByTestId('chat-message-tokens').first();
    await expect(tokenBadge).toBeVisible({ timeout: 2000 });
    const tokenText = await tokenBadge.getAttribute('data-tokens');
    expect(Number(tokenText) >= 1).toBeTruthy();

    // session total badge
    const sessionTokens = page.getByTestId('chat-session-tokens');
    await expect(sessionTokens).toBeVisible({ timeout: 2000 });
    const sessionTotal = await sessionTokens.getAttribute('data-tokens');
    expect(Number(sessionTotal) >= 1).toBeTruthy();
  });
});
