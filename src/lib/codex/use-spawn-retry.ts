/**
 * useSpawnRetry React hook (DEC-018-045 QW2 / F1, AS-201.3)。
 *
 * Rust 側 `agent_spawn_sidecar` の outer retry layer が emit する
 * `agent:{projectId}:spawn-retry` event を購読し、UI 用の status を返す。
 *
 * # 利用例
 *   ```tsx
 *   const retry = useSpawnRetry(projectId);
 *   if (retry.isRetrying) toast.info(`再接続中… (試行 ${retry.attempt}/${retry.maxRetries})`);
 *   if (retry.isFailed) toast.error('Codex 接続に失敗しました。再試行してください');
 *   ```
 *
 * # ライフサイクル
 *  - mount で event 購読
 *  - max_retries 到達 + last_error あり + next_sleep_ms=null → `'failed'`
 *  - 試行中 (next_sleep_ms !== null OR attempt < max_retries) → `'retrying'`
 *  - 成功時は spawn 完了 → 別経路 (use-codex の status='ready') で表示。
 *    本 hook は spawn-retry event の最終 callback だけ受信する設計のため、
 *    `'idle'` への自動 reset は呼び出し側 (clear()) で行う。
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { AgentEvents, on } from '@/lib/tauri/events';
import {
  validateSpawnAttemptEvent,
  type SpawnAttemptEvent,
} from './schemas';

export type SpawnRetryStatus = 'idle' | 'retrying' | 'failed';

export interface UseSpawnRetryResult {
  /** 直近 event payload。一度も受信していないなら null。 */
  last: SpawnAttemptEvent | null;
  /** UI バッジ用の status。 */
  status: SpawnRetryStatus;
  /** `status === 'retrying'` の short alias。 */
  isRetrying: boolean;
  /** `status === 'failed'` の short alias。 */
  isFailed: boolean;
  /** 1-based の現在試行回数。`last` から取得（無ければ 0）。 */
  attempt: number;
  /** policy の max_retries。`last` から取得（無ければ 0）。 */
  maxRetries: number;
  /** 直近 error 文。`last.lastError` 由来。 */
  lastError: string | null;
  /** 次回試行までの sleep ms。なければ null。 */
  nextSleepMs: number | null;
  /** UI 側で「再試行が完了した / 手動 reset したい」場合に呼ぶ。 */
  clear: () => void;
}

export function useSpawnRetry(projectId: string): UseSpawnRetryResult {
  const [last, setLast] = useState<SpawnAttemptEvent | null>(null);
  const [status, setStatus] = useState<SpawnRetryStatus>('idle');

  useEffect(() => {
    if (!projectId) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        unsub = await on<unknown>(AgentEvents.spawnRetry(projectId), (e) => {
          if (cancelled) return;
          const p = validateSpawnAttemptEvent(e.payload);
          if (!p) return;
          setLast(p);
          // 最終試行 + sleep なし + error あり → failed
          if (
            p.attempt >= p.maxRetries &&
            p.nextSleepMs === null &&
            p.lastError !== null
          ) {
            setStatus('failed');
          } else {
            setStatus('retrying');
          }
        });
      } catch {
        // 購読失敗は致命的でない
      }
    })();
    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, [projectId]);

  const clear = useCallback(() => {
    setLast(null);
    setStatus('idle');
  }, []);

  return {
    last,
    status,
    isRetrying: status === 'retrying',
    isFailed: status === 'failed',
    attempt: last?.attempt ?? 0,
    maxRetries: last?.maxRetries ?? 0,
    lastError: last?.lastError ?? null,
    nextSleepMs: last?.nextSleepMs ?? null,
    clear,
  };
}
