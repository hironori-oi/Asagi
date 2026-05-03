/**
 * useLazySpawn React hook (DEC-018-045 QW3 / F4, AS-202.3)。
 *
 * Rust 側 `agent_send_message_v2` が sidecar 不在を検知して自動再接続を始めた際に
 * emit する `agent:{projectId}:lazy-spawn` event と、idle reaper が emit する
 * `agent:{projectId}:idle-shutdown` event を購読し、UI 側で「自動再接続中」
 * 状態を表示するための小さな state hook。
 *
 * # ライフサイクル
 *
 *   1. mount で 2 つの event を購読
 *   2. lazy-spawn を受信 → `lazySpawning=true`、reason 保存
 *   3. idle-shutdown を受信 → `idleShutdownAt` を SystemTime now に更新
 *      （UI で「30 分操作がなかったため接続を一時切断しました」表示等）
 *   4. spawn-retry の最終 callback (= attempt 達成) 後、上位 use-codex の
 *      status が 'ready' に戻った時点で UI 側が `clear()` を呼ぶ
 *
 * # use-spawn-retry との分離
 *
 *   - use-spawn-retry は **明示的 spawn 起動 (agent_spawn_sidecar)** の retry を扱う
 *   - use-lazy-spawn は **暗黙的 spawn 起動 (lazy fallback in send_message)** を扱う
 *   - 両者は同じ `spawn-retry` event を共有するが、`lazy-spawn` event の有無で
 *     UI 表示を区別できる（"再接続中" vs "自動再接続中"）。
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { AgentEvents, on } from '@/lib/tauri/events';

export interface LazySpawnEventPayload {
  projectId: string;
  reason: string;
}

export interface UseLazySpawnResult {
  /** `agent_send_message_v2` が sidecar 不在を検知して自動 spawn を始めたら true。 */
  lazySpawning: boolean;
  /** lazy spawn の発火理由 (現状 'sidecar_inactive' のみ)。 */
  lazyReason: string | null;
  /** 直近 idle-shutdown event を受信した unix ms。未受信なら null。 */
  idleShutdownAt: number | null;
  /** UI 側で reset したい場合に呼ぶ。 */
  clear: () => void;
}

function isLazyPayload(p: unknown): p is LazySpawnEventPayload {
  if (!p || typeof p !== 'object') return false;
  const v = p as Record<string, unknown>;
  return typeof v.projectId === 'string' && typeof v.reason === 'string';
}

export function useLazySpawn(projectId: string): UseLazySpawnResult {
  const [lazySpawning, setLazySpawning] = useState(false);
  const [lazyReason, setLazyReason] = useState<string | null>(null);
  const [idleShutdownAt, setIdleShutdownAt] = useState<number | null>(null);

  useEffect(() => {
    if (!projectId) return;
    const unsubs: Array<() => void> = [];
    let cancelled = false;

    (async () => {
      try {
        const u1 = await on<unknown>(AgentEvents.lazySpawn(projectId), (e) => {
          if (cancelled) return;
          if (isLazyPayload(e.payload)) {
            setLazySpawning(true);
            setLazyReason(e.payload.reason);
          } else {
            setLazySpawning(true);
            setLazyReason(null);
          }
        });
        unsubs.push(u1);
      } catch {
        // 購読失敗は致命的でない（mock-first 動作可能性を維持）
      }
      try {
        const u2 = await on<unknown>(
          AgentEvents.idleShutdown(projectId),
          () => {
            if (cancelled) return;
            setIdleShutdownAt(Date.now());
          },
        );
        unsubs.push(u2);
      } catch {
        // 同上
      }
    })();

    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, [projectId]);

  const clear = useCallback(() => {
    setLazySpawning(false);
    setLazyReason(null);
    setIdleShutdownAt(null);
  }, []);

  return { lazySpawning, lazyReason, idleShutdownAt, clear };
}
