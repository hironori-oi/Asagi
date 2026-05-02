import { test, expect } from '@playwright/test';

/**
 * AS-UX-FIX-A / DEC-018-039 W1 — Bug A regression spec.
 *
 * Bug 内容:
 *   smoke FB で「mock 応答が
 *     `mockmock app app-ser-server ver からの応答からの応答です（モ...`
 *   のように各 token が 2 連 interleave で重複する」報告を受けた。
 *
 * 根本原因（修正後の正規ルート）:
 *   1) `chat-pane.tsx` の useEffect は React StrictMode (dev) で 2 回 mount される
 *   2) `void codex.spawn()` も 2 回呼ばれる
 *   3) 旧 `agent_spawn_sidecar` は `MultiSidecarManager.spawn_for` が冪等 no-op で
 *      あっても無条件に notification pump task を spawn していた
 *   4) 同一 `broadcast::Sender` に subscriber が 2 経路でき、1 つの
 *      `item/agentMessage/delta` が 2 回 Tauri Event として emit される
 *   5) UI 側 `use-codex.ts` の delta accumulator が 2 回呼ばれて token 二重 append
 *
 * 修正:
 *   - `MultiSidecarManager::spawn_for` の戻り値を `Result<bool>` 化し、
 *     `agent_spawn_sidecar` は new-create 時のみ pump task を spawn する。
 *   - 防御として `use-codex.ts` の event 購読 useEffect で、await 中に cleanup が
 *     走った場合に on() の戻り unsub を即破棄する race guard を追加。
 *
 * このテストは fix なし状態では assistant 文字列に
 *   `(.{4,})\1` (4 文字以上の連続重複) が必ず検出される設計。
 * fix 後は MOCK_RESPONSE_TEMPLATE と完全一致することを assert する。
 *
 * 対象 page は `/dev/codex-mock/`（codex-mock-flow.spec.ts と同じく
 *   in-process mockIPC + mock token 列を 1 回ずつ emit する設計）。
 * test 内 mock では emit が 1 回だけ走るが、もし StrictMode + 旧 race で
 * UI 内ハンドラが重複登録されていると、1 emit に対して accumulator が
 * 2 回呼ばれるため duplicate になる、という構造を捉える。
 */

const MOCK_PROJECT_ID = 'dev-mock-project';
const MOCK_RESPONSE_TEMPLATE =
  'mock app-server からの応答です（モデル: gpt-mock-5.5）';

test.beforeEach(async ({ context }) => {
  await context.addInitScript(
    ({ projectId }) => {
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

      // 厳密に「1 emit = 1 callback 呼び出し」になることを担保する emit 関数。
      // 重複防御は UI 側 (use-codex.ts) の責務だが、test 側でも壊れていないことを示すために
      // listener 登録 ID を Set で唯一化している。
      const emit = (event: string, payload: unknown) => {
        const ids = eventListeners[event];
        if (!ids) return;
        for (const id of ids) {
          const cb = callbacks[id];
          if (cb) cb({ event, id, payload });
        }
      };

      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      // 実装 mock_response_tokens() と一致する 10 token 分割
      // (chars-based 等分。MOCK_RESPONSE_TEMPLATE.chars().count() = 30 → 3 char/token)
      const T = 'mock app-server からの応答です（モデル: gpt-mock-5.5）';
      const chars = Array.from(T);
      const TOKEN_COUNT = 10;
      const tokens: string[] = [];
      for (let i = 0; i < TOKEN_COUNT; i++) {
        const start = Math.floor((i * chars.length) / TOKEN_COUNT);
        const end = Math.floor(((i + 1) * chars.length) / TOKEN_COUNT);
        tokens.push(chars.slice(start, end).join(''));
      }

      const handleAgentSend = async (args: {
        project_id: string;
        content: string;
        thread_id?: string;
      }) => {
        const pid = args.project_id;
        const threadId = args.thread_id ?? `thread-${Date.now()}`;
        const turnId = `turn-${Date.now()}`;
        const itemId = `item-${Date.now()}`;
        (async () => {
          for (const tok of tokens) {
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

      const invoke = async (
        cmd: string,
        payload?: Record<string, unknown>,
      ): Promise<unknown> => {
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
            return handleAgentSend(
              payload!.args as { project_id: string; content: string; thread_id?: string },
            );
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

      (window as unknown as { __ASAGI_MOCK_PROJECT_ID__?: string }).__ASAGI_MOCK_PROJECT_ID__ =
        projectId;
    },
    { projectId: MOCK_PROJECT_ID },
  );
});

test('@bug-fix AS-UX-FIX-A: assistant 応答に文字重複が発生しないこと', async ({ page }) => {
  await page.goto('/dev/codex-mock/');

  // spawn → ready
  const status = page.getByTestId('codex-mock-status');
  await expect(status).toHaveAttribute('data-status', 'idle');
  await page.getByTestId('codex-mock-spawn').click();
  await expect(status).toHaveAttribute('data-status', 'ready', { timeout: 5000 });

  // send
  await page.getByTestId('codex-mock-input').fill('ハロー');
  await page.getByTestId('codex-mock-send').click();

  // assistant message 完成まで待つ。
  // streaming 状態は status badge で判定し、data-streaming attr は対象外
  // (DEC-018-039 W1 のスコープ外。dev 専用ページの装飾フラグでありバグ A 本筋ではない)。
  const assistantMsg = page.getByTestId('codex-mock-message-assistant');
  await expect(assistantMsg).toBeVisible({ timeout: 5000 });
  // turn/completed 後 ready に戻る
  await expect(status).toHaveAttribute('data-status', 'ready', { timeout: 5000 });
  // 全 token が到着していることを部分文字列で待ち合わせ（最後の token "5）" が現れる）
  await expect(assistantMsg).toContainText('5.5）', { timeout: 5000 });

  // <li> 内には role badge ("assistant") + 本文 textNode + (streaming 中なら "...") が並ぶ。
  // Page 内 evaluate で「直接の text node」だけを連結して assistant 本文を取り出す。
  const text = (await assistantMsg.evaluate((el) => {
    let s = '';
    el.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) s += n.textContent ?? '';
    });
    return s;
  })).trim();

  // 1) 必ず期待文字列と完全一致すること（最強の duplicate 検出）
  expect(text).toBe(MOCK_RESPONSE_TEMPLATE);

  // 2) 4 文字以上の連続重複部分文字列が無いこと
  //    バグ症状: `mockmock app app-ser-server` 等で `mock` が連続するパターン
  expect(text).not.toMatch(/(.{4,})\1/);
});
