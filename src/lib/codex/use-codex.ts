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
  interruptTurn as interruptTurnImpl,
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
  /**
   * DEC-018-026 ① C: 現在 streaming 中の turn を即座に中断する。
   * Real impl 切替後も同じ呼び出し規約 (`turn/interrupt` を送る) で
   * UI 側コードは無変更で動く。streaming で無い時は no-op。
   * 中断された assistant message id を返す（UI が markInterrupted を呼ぶため）。
   */
  interrupt: () => Promise<string | null>;
  /** 直近に streaming を開始した assistant item id (DEC-018-026 ① A: typing indicator 判定用)。 */
  streamingItemId: string | null;
  /** turn/start 送信後、最初の delta が来るまで true (DEC-018-026 ① A: typing indicator 判定用)。 */
  awaitingFirstDelta: boolean;
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
  /** DEC-018-026 ① A: typing indicator 用。turn/start 送信後 → 最初の delta まで true。 */
  const [awaitingFirstDelta, setAwaitingFirstDelta] = useState(false);
  /** DEC-018-026 ① A: 直近の streaming 中 assistant item id。delta 着弾で確定。 */
  const [streamingItemId, setStreamingItemId] = useState<string | null>(null);

  // 現在ストリーミング中の assistant item id 追跡
  const streamingItemIdRef = useRef<string | null>(null);
  // 現在 turn を保持する thread_id (mock では project ごとに最初の thread/start が固定)
  const threadIdRef = useRef<string | null>(null);
  // DEC-018-026 ① C: turn/interrupt 送信に必要な現 turn id
  const currentTurnIdRef = useRef<string | null>(null);

  // event 購読
  //
  // AS-UX-FIX-A / DEC-018-039 W1: React StrictMode (dev) は useEffect を
  // 意図的に 2 回 mount/unmount する。on() は async なので、
  // cleanup が「await on(...) が解決する前」に走ると unsub 関数が
  // 失われ、listener が DOM 上に残留 → 同 event を 2 回処理して
  // 文字重複の症状を補強する原因になる。
  // 対策: cancelled フラグを await 解決後に再チェックし、
  // 既に cleanup 済みなら受け取った unsub 関数を即座に呼び出して破棄する。
  useEffect(() => {
    let unsubDelta: (() => void) | null = null;
    let unsubCompleted: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        const ud = await on<unknown>(
          AgentEvents.itemAgentMessageDelta(projectId),
          (e) => {
            const p = validateItemAgentMessageDeltaParams(e.payload);
            if (!p) return;
            // DEC-018-026 ① A: 最初の delta が来た瞬間に typing indicator を消す
            setAwaitingFirstDelta(false);
            setStreamingItemId(p.itemId);
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
        // race 防御: await 中に cleanup が走っていたら即破棄
        if (cancelled) {
          ud();
        } else {
          unsubDelta = ud;
        }

        const uc = await on<unknown>(
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
            setAwaitingFirstDelta(false);
            streamingItemIdRef.current = null;
            currentTurnIdRef.current = null;
          },
        );
        if (cancelled) {
          uc();
        } else {
          unsubCompleted = uc;
        }
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
      // DEC-018-026 ① A: typing indicator ON、最初の delta で OFF
      setAwaitingFirstDelta(true);
      setStreamingItemId(null);
      try {
        const result = await sendMessageImpl({
          projectId,
          content,
          threadId: threadIdRef.current ?? undefined,
        });
        threadIdRef.current = result.thread_id;
        currentTurnIdRef.current = result.turn_id;
        // streaming は turn/completed event で false になる
      } catch (e) {
        setError(`sendMessage failed: ${String(e)}`);
        setIsStreaming(false);
        setStatus('error');
        setAwaitingFirstDelta(false);
      }
    },
    [projectId],
  );

  /**
   * DEC-018-026 ① C: 現 turn を中断する。
   * Real impl 切替後も同じ規約 (`turn/interrupt` を sidecar に送る) で動く。
   * 中断対象の assistant message id を返す（呼び出し側がストア markInterrupted で利用）。
   */
  const interrupt = useCallback(async (): Promise<string | null> => {
    const targetItemId = streamingItemIdRef.current;
    const threadId = threadIdRef.current;
    const turnId = currentTurnIdRef.current;
    if (!isStreaming) return null;
    try {
      await interruptTurnImpl({
        projectId,
        threadId: threadId ?? undefined,
        turnId: turnId ?? undefined,
      });
    } catch (e) {
      setError(`interrupt failed: ${String(e)}`);
      // 中断 RPC が失敗しても UI は中断扱いにする (mock 完成度優先、Real impl では retry 設計を別途)
    }
    // UI 側の streaming 状態を即時終端する。turn/completed 事後に届く可能性があるが、
    // streamingItemIdRef を null にリセットするので二重 markInterrupted は起きない。
    setMessages((prev) =>
      prev.map((m) =>
        m.id === targetItemId ? { ...m, streaming: false } : m,
      ),
    );
    setIsStreaming(false);
    setStatus(isReady ? 'ready' : 'idle');
    setAwaitingFirstDelta(false);
    streamingItemIdRef.current = null;
    currentTurnIdRef.current = null;
    return targetItemId;
  }, [isReady, isStreaming, projectId]);

  const clear = useCallback(() => {
    setMessages([]);
    setError(null);
    setIsStreaming(false);
    setAwaitingFirstDelta(false);
    setStreamingItemId(null);
    streamingItemIdRef.current = null;
    currentTurnIdRef.current = null;
    if (status === 'streaming' || status === 'error') {
      setStatus(isReady ? 'ready' : 'idle');
    }
  }, [isReady, status]);

  return {
    messages,
    sendMessage,
    spawn,
    shutdown,
    interrupt,
    streamingItemId,
    awaitingFirstDelta,
    isReady,
    isStreaming,
    status,
    error,
    clear,
  };
}
