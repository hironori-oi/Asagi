/**
 * useAuthWatchdog React hook (DEC-018-028 QW1 / F3)。
 *
 * Rust 側 AuthWatchdog の state を `auth:{projectId}:state_changed` event で
 * 購読し、UI 用に subset を返す。
 *
 * # Real impl 切替時
 *   本 hook はそのまま動く。`AuthWatchdog::poll_one` 内の `account/read` JSON-RPC
 *   が mock → real CLI に切り替わるだけで、event 名 / payload schema は不変。
 *
 * # 利用例
 *   ```tsx
 *   const auth = useAuthWatchdog(projectId);
 *   if (auth.requiresReauth) toast.warning('Codex の再ログインが必要です');
 *   ```
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { on } from '@/lib/tauri/events';
import {
  AuthEvents,
  authWatchdogForceCheck,
  authWatchdogGetState,
  type AuthStateChangedPayload,
  type AuthWatchdogState,
} from './sidecar-client';

export type AuthKind = AuthWatchdogState['kind'];

export interface UseAuthWatchdogResult {
  /** 現在の AuthState (`unknown` 初期値)。 */
  state: AuthWatchdogState;
  /** state.kind の short alias。 */
  kind: AuthKind;
  /** 認証 OK か。 */
  isAuthenticated: boolean;
  /** 再認証が必要 (Real CLI 側で OAuth refresh 失敗) か。 */
  requiresReauth: boolean;
  /** RPC 失敗 / decode 失敗 の状態か。 */
  isError: boolean;
  /** 最後に受信した遷移 payload (UI で「いつ from→to したか」を表示)。 */
  lastChange: AuthStateChangedPayload | null;
  /** UI の「今すぐ確認」ボタン handler。 */
  forceCheck: () => Promise<void>;
}

/**
 * Auth Watchdog 購読 hook。
 *
 * ## ライフサイクル
 *  1. mount 時に `auth_watchdog_get_state` で seed を取得
 *  2. `auth:{projectId}:state_changed` 購読
 *  3. unmount で unsubscribe
 *
 * projectId が空文字 ("") の時は no-op (購読しない / state は unknown のまま)。
 * これは初回 mount で activeProjectId がまだ確定していないケースを許容するため。
 */
export function useAuthWatchdog(projectId: string): UseAuthWatchdogResult {
  const [state, setState] = useState<AuthWatchdogState>({ kind: 'unknown' });
  const [lastChange, setLastChange] = useState<AuthStateChangedPayload | null>(
    null,
  );

  // 1) initial seed
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const seed = await authWatchdogGetState(projectId);
        if (!cancelled) setState(seed);
      } catch {
        // 取得失敗は無視 (event 待ちで埋まる)
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // 2) event subscription
  useEffect(() => {
    if (!projectId) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        unsub = await on<AuthStateChangedPayload>(
          AuthEvents.stateChanged(projectId),
          (e) => {
            if (cancelled) return;
            const payload = e.payload;
            setState(payload.state);
            setLastChange(payload);
          },
        );
      } catch {
        // event 購読失敗は致命的でない (UI はポーリングで埋まる)
      }
    })();
    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, [projectId]);

  const forceCheck = useCallback(async () => {
    if (!projectId) return;
    await authWatchdogForceCheck(projectId);
  }, [projectId]);

  return {
    state,
    kind: state.kind,
    isAuthenticated: state.kind === 'authenticated',
    requiresReauth: state.kind === 'requires_reauth',
    isError: state.kind === 'error',
    lastChange,
    forceCheck,
  };
}
