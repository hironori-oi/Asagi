'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { MessageList } from './message-list';
import { InputArea } from './input-area';
import {
  ChatStatusBadge,
  ChatSessionTokenCount,
} from './chat-status-badge';
import { AuthBadge } from './auth-badge';
import { CodexContext, type CodexContextValue } from './codex-context';
import { useCodex } from '@/lib/codex/use-codex';
import { useProjectStore } from '@/lib/stores/project';
import { useSessionStore } from '@/lib/stores/session';
import { useChatStore } from '@/lib/stores/chat';
import { useChatActivityStore, type ChatActivityState } from '@/lib/stores/chat-activity';
import { invoke } from '@/lib/tauri/invoke';

/**
 * Main shell の中央 Chat ペイン (AS-115 / AS-144)。
 *
 * AS-144 (DEC-018-023):
 *   - `useCodex(activeProjectId)` を 1 度だけ呼び、ChatPane を sidecar の
 *     ライフサイクルホストにする。
 *   - 初回マウントで `spawn()` を起動し、unmount 時に `shutdown()`。
 *   - `useCodex.messages` の assistant message を `useChatStore.upsertAssistantStreaming`
 *     経由でストアに反映 → 既存 `MessageList` がそのまま購読する。
 *   - `send()` を Context で `InputArea` に渡し、ユーザ送信 + SQLite 永続化 +
 *     `codex.sendMessage()` を 1 ステップで実行する。
 *   - 右上に `ChatStatusBadge` で sidecar status を可視化。
 *
 * `ASAGI_SIDECAR_MODE=mock` (default) で OpenAI 不要のまま動作する。
 */
export function ChatPane() {
  const t = useTranslations('chat');
  const activeId = useProjectStore((s) => s.activeProjectId);
  const codex = useCodex(activeId);

  const appendUser = useChatStore((s) => s.appendUser);
  const upsertAssistant = useChatStore((s) => s.upsertAssistantStreaming);
  const markInterrupted = useChatStore((s) => s.markInterrupted);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  // 初回 (project 切替含む) で spawn / cleanup で shutdown
  const spawnedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeId) return;
    if (spawnedRef.current === activeId) return;
    spawnedRef.current = activeId;
    void codex.spawn();
    return () => {
      void codex.shutdown();
      spawnedRef.current = null;
    };
    // codex は安定参照ではないため依存に含めず、明示的に activeId のみ。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // useCodex の assistant streaming を chat store に同期
  useEffect(() => {
    for (const m of codex.messages) {
      if (m.role !== 'assistant') continue;
      upsertAssistant(activeId, m.id, m.content);
    }
  }, [codex.messages, activeId, upsertAssistant]);

  // AS-UX-04 / DEC-018-037 §②: useCodex の status / awaitingFirstDelta を
  // useChatActivityStore に橋渡し（StatusBar Activity summary + ProjectRail dot）。
  // turn/start → thinking、初回 delta → streaming、turn/completed → completed、
  // error → error、それ以外 → idle。
  const syncActivity = useChatActivityStore((s) => s.syncBoth);
  useEffect(() => {
    let next: ChatActivityState = 'idle';
    if (codex.status === 'error') next = 'error';
    else if (codex.awaitingFirstDelta) next = 'thinking';
    else if (codex.isStreaming) next = 'streaming';
    else if (codex.status === 'ready') next = 'idle';
    syncActivity(activeSessionId, activeId, next);
  }, [
    codex.status,
    codex.isStreaming,
    codex.awaitingFirstDelta,
    activeId,
    activeSessionId,
    syncActivity,
  ]);

  // DEC-018-026 ① C: 中断は明示的に completed 寄りの 'idle' へ。
  // turn/completed の場合は useCodex の awaitingFirstDelta = false かつ
  // isStreaming = false に落ちて自然に idle 化されるので、そのフローに乗せる。

  // 送信ラッパ: appendUser → SQLite create_message → codex.sendMessage
  const send = useCallback(
    async (content: string) => {
      const value = content.trim();
      if (!value) return;
      appendUser(activeId, value);

      if (activeSessionId) {
        try {
          await invoke<string>('create_message', {
            args: { sessionId: activeSessionId, role: 'user', content: value },
          });
        } catch {
          toast.error(t('saveFailed'));
        }
      }

      try {
        await codex.sendMessage(value);
      } catch (e) {
        toast.error(`Codex error: ${String(e)}`);
      }
    },
    [activeId, activeSessionId, appendUser, codex, t],
  );

  // DEC-018-026 ① C: useCodex.interrupt をラップして markInterrupted も呼ぶ。
  // Real impl 切替後も呼び出し規約は同じ (`turn/interrupt` を sidecar に送る)。
  const interrupt = useCallback(async () => {
    const itemId = await codex.interrupt();
    if (itemId) {
      markInterrupted(activeId, itemId);
    }
  }, [activeId, codex, markInterrupted]);

  const ctx = useMemo<CodexContextValue>(
    () => ({
      status: codex.status,
      isReady: codex.isReady,
      isStreaming: codex.isStreaming,
      error: codex.error,
      awaitingFirstDelta: codex.awaitingFirstDelta,
      streamingItemId: codex.streamingItemId,
      send,
      interrupt,
    }),
    [
      codex.status,
      codex.isReady,
      codex.isStreaming,
      codex.error,
      codex.awaitingFirstDelta,
      codex.streamingItemId,
      send,
      interrupt,
    ],
  );

  return (
    <CodexContext.Provider value={ctx}>
      <section
        aria-label="チャット"
        className="flex h-full min-w-0 flex-1 flex-col bg-background"
      >
        <header className="flex items-center justify-end gap-2 border-b border-border/40 px-4 py-1.5">
          <ChatSessionTokenCount />
          <AuthBadge />
          <ChatStatusBadge />
        </header>
        <MessageList />
        <InputArea />
      </section>
    </CodexContext.Provider>
  );
}
