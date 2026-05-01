/**
 * useCodex React hook (AS-135 / DEC-018-023 / AS-144)。
 *
 * `projectId` スコープで Codex sidecar を統括する hook。
 *   - spawn / shutdown lifecycle
 *   - sendMessage 1 ターン送信 (Real protocol: thread/start → turn/start)
 *   - item/agentMessage/delta / turn/completed event 購読
 *   - エラー / ストリーミング状態管理
 *
 * 開発検証ページ `/dev/codex-mock` および本番 ChatPane (AS-144) から利用される。
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentEvents, on } from '@/lib/tauri/events';
import {
  validateItemAgentMessageDeltaParams,
  validateTurnCompletedParams,
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

/** sidecar の段階状態。ChatPane 側で UI バッジに使う。 */
export type CodexStatus = 'idle' | 'spawning' | 'ready' | 'streaming' | 'error';

export interface UseCodexResult {
  messages: UseCodexMessage[];
  sendMessage: (content: string) => Promise<void>;
  spawn: () => Promise<void>;
  shutdown: () => Promise<void>;
  isReady: boolean;
  isStreaming: boolean;
  status: CodexStatus;
  error: string | null;
  clear: () => void;
}

export function useCodex(projectId: string): UseCodexResult {
  const [messages, setMessages] = useState<UseCodexMessage[]>([]);
  const [isReady, setIsReady] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState<CodexStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // 現在ストリーミング中の assistant item id 追跡
  const streamingItemIdRef = useRef<string | null>(null);
  // 現在 turn を保持する thread_id (mock では project ごとに最初の thread/start が固定)
  const threadIdRef = useRef<string | null>(null);

  // event 購読
  useEffect(() => {
    let unsubDelta: (() => void) | null = null;
    let unsubCompleted: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        unsubDelta = await on<unknown>(
          AgentEvents.itemAgentMessageDelta(projectId),
          (e) => {
            const p = validateItemAgentMessageDeltaParams(e.payload);
            if (!p) return;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.id === p.itemId && last.role === 'assistant') {
                const updated = [...prev];
                updated[prev.length - 1] = {
                  ...last,
                  content: last.content + p.delta,
                  streaming: true,
                };
                return updated;
              }
              streamingItemIdRef.current = p.itemId;
              return [
                ...prev,
                {
                  id: p.itemId,
                  role: 'assistant',
                  content: p.delta,
                  streaming: true,
                },
              ];
            });
          },
        );
        unsubCompleted = await on<unknown>(
          AgentEvents.turnCompleted(projectId),
          (e) => {
            const p = validateTurnCompletedParams(e.payload);
            if (!p) return;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === streamingItemIdRef.current
                  ? { ...m, streaming: false }
                  : m,
              ),
            );
            setIsStreaming(false);
            setStatus('ready');
            streamingItemIdRef.current = null;
          },
        );
      } catch (err) {
        if (!cancelled) {
          setError(`event subscribe failed: ${String(err)}`);
          setStatus('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      if (unsubDelta) unsubDelta();
      if (unsubCompleted) unsubCompleted();
    };
  }, [projectId]);

  const spawn = useCallback(async () => {
    setError(null);
    setStatus('spawning');
    try {
      await spawnSidecarImpl(projectId);
      setIsReady(true);
      setStatus('ready');
    } catch (e) {
      setError(`spawn failed: ${String(e)}`);
      setIsReady(false);
      setStatus('error');
    }
  }, [projectId]);

  const shutdown = useCallback(async () => {
    setError(null);
    try {
      await shutdownSidecarImpl(projectId);
      setIsReady(false);
      setIsStreaming(false);
      setStatus('idle');
      threadIdRef.current = null;
    } catch (e) {
      setError(`shutdown failed: ${String(e)}`);
      setStatus('error');
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
      setStatus('streaming');
      try {
        const result = await sendMessageImpl({
          projectId,
          content,
          threadId: threadIdRef.current ?? undefined,
        });
        threadIdRef.current = result.thread_id;
        // streaming は turn/completed event で false になる
      } catch (e) {
        setError(`sendMessage failed: ${String(e)}`);
        setIsStreaming(false);
        setStatus('error');
      }
    },
    [projectId],
  );

  const clear = useCallback(() => {
    setMessages([]);
    setError(null);
    setIsStreaming(false);
    streamingItemIdRef.current = null;
    if (status === 'streaming' || status === 'error') {
      setStatus(isReady ? 'ready' : 'idle');
    }
  }, [isReady, status]);

  return {
    messages,
    sendMessage,
    spawn,
    shutdown,
    isReady,
    isStreaming,
    status,
    error,
    clear,
  };
}
