/**
 * useCodex React hook (AS-135)。
 *
 * `projectId` スコープで Codex sidecar を統括する hook。
 *   - spawn / shutdown lifecycle
 *   - sendMessage 1 ターン送信
 *   - assistant_message_delta / done event 購読
 *   - エラー / ストリーミング状態管理
 *
 * 開発検証ページ `/dev/codex-mock` から利用される（本番 ChatPane とは独立）。
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentEvents, on } from '@/lib/tauri/events';
import {
  validateAssistantMessageDeltaParams,
  validateDoneParams,
} from './schemas';
import {
  sendMessage as sendMessageImpl,
  shutdownSidecar as shutdownSidecarImpl,
  spawnSidecar as spawnSidecarImpl,
} from './sidecar-client';

export interface UseCodexMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** assistant 側ストリーミング中なら true */
  streaming?: boolean;
}

export interface UseCodexResult {
  messages: UseCodexMessage[];
  sendMessage: (content: string) => Promise<void>;
  spawn: () => Promise<void>;
  shutdown: () => Promise<void>;
  isReady: boolean;
  isStreaming: boolean;
  error: string | null;
  clear: () => void;
}

export function useCodex(projectId: string): UseCodexResult {
  const [messages, setMessages] = useState<UseCodexMessage[]>([]);
  const [isReady, setIsReady] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // streaming 中の assistant message_id 追跡（同じ id の delta は同じ message に集約）
  const streamingIdRef = useRef<string | null>(null);
  const sessionId = useMemo(() => `sess-${projectId}`, [projectId]);

  // event 購読
  useEffect(() => {
    let unsubDelta: (() => void) | null = null;
    let unsubDone: (() => void) | null = null;
    let unsubError: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        unsubDelta = await on<unknown>(
          AgentEvents.assistantMessageDelta(projectId),
          (e) => {
            const p = validateAssistantMessageDeltaParams(e.payload);
            if (!p) return;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.id === p.message_id && last.role === 'assistant') {
                const updated = [...prev];
                updated[prev.length - 1] = {
                  ...last,
                  content: last.content + p.delta,
                  streaming: true,
                };
                return updated;
              }
              streamingIdRef.current = p.message_id;
              return [
                ...prev,
                {
                  id: p.message_id,
                  role: 'assistant',
                  content: p.delta,
                  streaming: true,
                },
              ];
            });
          },
        );
        unsubDone = await on<unknown>(
          `agent:${projectId}:done`,
          (e) => {
            const p = validateDoneParams(e.payload);
            if (!p) return;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === p.message_id ? { ...m, streaming: false } : m,
              ),
            );
            setIsStreaming(false);
            streamingIdRef.current = null;
          },
        );
        unsubError = await on<unknown>(
          AgentEvents.error(projectId),
          (e) => {
            const msg =
              typeof e.payload === 'string'
                ? e.payload
                : JSON.stringify(e.payload);
            setError(msg);
            setIsStreaming(false);
          },
        );
      } catch (err) {
        if (!cancelled) {
          setError(`event subscribe failed: ${String(err)}`);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (unsubDelta) unsubDelta();
      if (unsubDone) unsubDone();
      if (unsubError) unsubError();
    };
  }, [projectId]);

  const spawn = useCallback(async () => {
    setError(null);
    try {
      await spawnSidecarImpl(projectId);
      setIsReady(true);
    } catch (e) {
      setError(`spawn failed: ${String(e)}`);
      setIsReady(false);
    }
  }, [projectId]);

  const shutdown = useCallback(async () => {
    setError(null);
    try {
      await shutdownSidecarImpl(projectId);
      setIsReady(false);
      setIsStreaming(false);
    } catch (e) {
      setError(`shutdown failed: ${String(e)}`);
    }
  }, [projectId]);

  const sendMessage = useCallback(
    async (content: string) => {
      setError(null);
      // user message 追加
      const userId = `user-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: userId, role: 'user', content },
      ]);
      setIsStreaming(true);
      try {
        await sendMessageImpl({
          projectId,
          content,
          sessionId,
        });
        // streaming は done event で false になる
      } catch (e) {
        setError(`sendMessage failed: ${String(e)}`);
        setIsStreaming(false);
      }
    },
    [projectId, sessionId],
  );

  const clear = useCallback(() => {
    setMessages([]);
    setError(null);
    setIsStreaming(false);
    streamingIdRef.current = null;
  }, []);

  return {
    messages,
    sendMessage,
    spawn,
    shutdown,
    isReady,
    isStreaming,
    error,
    clear,
  };
}
