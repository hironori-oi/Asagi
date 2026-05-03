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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { on } from '@/lib/tauri/events';
import {
  AuthEvents,
  authOpenLogin,
  authWatchdogForceCheck,
  authWatchdogGetState,
  type AuthStateChangedPayload,
  type AuthWatchdogState,
} from './sidecar-client';

export type AuthKind = AuthWatchdogState['kind'];

/**
 * DEC-018-045 厳守事項 ⑥ (R-QW-1 緩和策): 「今すぐ確認」ボタン連打時に
 * IDP refresh が並行実行され 429 / refresh-token-reuse → session 無効化
 * (worst case account lock) を起こすのを防ぐ trailing-edge debounce。
 *
 * 連打中は最後の呼び出しのみを 500ms 後に 1 度だけ実行する。
 * 新規 dep 追加禁止 (DEC-018-045 ⑦) のため lodash を使わず手書き setTimeout で実装。
 */
const FORCE_CHECK_DEBOUNCE_MS = 500;

/**
 * AS-HOTFIX-QW4 (DEC-018-046 carryover): 「再ログイン」CTA 連打時に
 * `account/login/start` JSON-RPC が並行実行され、Rust 側 sidecar に
 *   - "no sidecar for project_id: ..." (idle reaper kill 後)
 *   - 同一 OAuth flow の重複起動による IDP 側 nonce 衝突
 * を起こすのを防ぐ trailing-edge debounce。
 *
 * forceCheck と同様の shared Promise pattern で 500ms 沈静化後に 1 度だけ invoke する。
 * 新規 dep 追加禁止 (DEC-018-045 ⑦) のため lodash を使わず手書き setTimeout で実装。
 */
const OPEN_LOGIN_DEBOUNCE_MS = 500;

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
  /**
   * DEC-018-045 QW1 (AS-200.3): expiry が threshold 以内 (warning=true) か。
   * `requiresReauth` よりも 1 段階手前の予兆。`Authenticated` のサブ状態。
   */
  expiryWarning: boolean;
  /**
   * DEC-018-045 QW1 (AS-200.3): expiry までの残時間（分）。warning でない場合は null。
   * UI の toast / banner で「残 N 分」と表示する用途。
   */
  expiryRemainingMinutes: number | null;
  /** 最後に受信した遷移 payload (UI で「いつ from→to したか」を表示)。 */
  lastChange: AuthStateChangedPayload | null;
  /** UI の「今すぐ確認」ボタン handler。 */
  forceCheck: () => Promise<void>;
  /**
   * DEC-018-045 QW1 (AS-200.3): 再ログインモーダル / warning toast から呼ぶ。
   * `account/login/start` を invoke し、authUrl を既定ブラウザで開く。
   */
  openLogin: () => Promise<void>;
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

  // DEC-018-045 厳守事項 ⑥ (R-QW-1 緩和策): forceCheck の trailing-edge debounce。
  //   - timer ref に setTimeout id を保持し、再呼び出しのたびに clearTimeout でリセット
  //   - 500ms 沈静化したら **最後に渡された projectId** で 1 度だけ invoke
  //   - 連打中の各 caller には**共有 Promise**を返し、trailing 発火時に一括 resolve
  //     (Promise leak 防止)
  //   - unmount / projectId 切替時は pending Promise を resolve しつつ timer をクリア
  //   - 新規 dep 禁止 (DEC-018-045 ⑦) のため lodash 不使用 / 純粋 setTimeout 実装
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPromiseRef = useRef<Promise<void> | null>(null);
  const pendingResolveRef = useRef<(() => void) | null>(null);
  const latestProjectIdRef = useRef<string>(projectId);
  useEffect(() => {
    latestProjectIdRef.current = projectId;
  }, [projectId]);

  const forceCheck = useMemo(
    () => (): Promise<void> => {
      // 既存 timer をリセット (連打中は最後の 1 回だけ trailing で発火)。
      // pendingPromise は破棄せず流用 — 全 caller が同じ Promise を共有し、
      // trailing 発火時に一括 resolve される (= Promise leak 防止)。
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      const pid = latestProjectIdRef.current;
      if (!pid) {
        // projectId 未確定: 何もせず即時 resolve
        return Promise.resolve();
      }
      // 共有 Promise が無ければ生成
      if (pendingPromiseRef.current === null) {
        pendingPromiseRef.current = new Promise<void>((resolve) => {
          pendingResolveRef.current = resolve;
        });
      }
      const sharedPromise = pendingPromiseRef.current;
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        const resolve = pendingResolveRef.current;
        pendingPromiseRef.current = null;
        pendingResolveRef.current = null;
        // invoke 失敗は Rust 側 watchdog の next poll / event 経由で
        // UI に反映されるため握りつぶして OK。
        authWatchdogForceCheck(pid)
          .catch(() => {
            /* swallow: next poll で復帰 */
          })
          .finally(() => {
            resolve?.();
          });
      }, FORCE_CHECK_DEBOUNCE_MS);
      return sharedPromise;
    },
    [],
  );

  // AS-HOTFIX-QW4 (DEC-018-046 carryover): openLogin 用の独立した debounce ref。
  //   - forceCheck (`account/read` polling 抑制) とは別 invoke (`account/login/start` 抑制)
  //   - 共有してしまうと一方の連打が他方を窒息させてしまうため Ref を分離
  //   - shared Promise pattern も独立に保持し、leak を防ぐ
  const openLoginTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openLoginPendingPromiseRef = useRef<Promise<void> | null>(null);
  const openLoginPendingResolveRef = useRef<(() => void) | null>(null);

  // unmount / projectId 切替時に pending timer をクリア + pending Promise を resolve
  // (Rust 側 in_flight Mutex とは独立したフロント安全網。古い projectId の pending invoke を破棄。)
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      // pending caller を leak させないため即時 resolve
      const resolve = pendingResolveRef.current;
      pendingPromiseRef.current = null;
      pendingResolveRef.current = null;
      resolve?.();
      // openLogin 側も同様にクリア
      if (openLoginTimerRef.current !== null) {
        clearTimeout(openLoginTimerRef.current);
        openLoginTimerRef.current = null;
      }
      const openResolve = openLoginPendingResolveRef.current;
      openLoginPendingPromiseRef.current = null;
      openLoginPendingResolveRef.current = null;
      openResolve?.();
    };
  }, [projectId]);

  // AS-HOTFIX-QW4 (DEC-018-046 carryover): openLogin の trailing-edge debounce。
  // 設計は forceCheck と同一だが ref を分離し、相互窒息を防ぐ。
  //   - 連打中は **最後の 1 回のみ** 500ms 後に `account/login/start` を invoke
  //   - 共有 Promise を全 caller に返し、trailing 発火時に一括 resolve (leak 防止)
  //   - invoke 失敗は logger.warn で握りつぶす（authBadge 側で error toast 表示は別経路）
  //   - forceCheck と違い `useMemo([])` ではなく `useCallback([projectId])` を用い、
  //     projectId 切替直後の stale closure を防ぐ（実質的には ref 経由で解決済みだが念のため）
  const openLogin = useCallback((): Promise<void> => {
    if (openLoginTimerRef.current !== null) {
      clearTimeout(openLoginTimerRef.current);
      openLoginTimerRef.current = null;
    }
    const pid = latestProjectIdRef.current;
    if (!pid) {
      return Promise.resolve();
    }
    if (openLoginPendingPromiseRef.current === null) {
      openLoginPendingPromiseRef.current = new Promise<void>((resolve) => {
        openLoginPendingResolveRef.current = resolve;
      });
    }
    const sharedPromise = openLoginPendingPromiseRef.current;
    openLoginTimerRef.current = setTimeout(() => {
      openLoginTimerRef.current = null;
      const resolve = openLoginPendingResolveRef.current;
      openLoginPendingPromiseRef.current = null;
      openLoginPendingResolveRef.current = null;
      authOpenLogin(pid)
        .catch(() => {
          /* swallow: 失敗は authBadge 側 onClick の logger.warn で記録される。
             debounce 内で throw すると shared Promise が reject され、他 caller に
             副作用が波及するため、ここでは握りつぶし、Promise 1 本だけ resolve する */
        })
        .finally(() => {
          resolve?.();
        });
    }, OPEN_LOGIN_DEBOUNCE_MS);
    return sharedPromise;
  }, []);

  // DEC-018-045 QW1 (AS-200.3): expiry warning derived state。
  // Authenticated 以外では false 固定 (`requiresReauth` / `isError` が優先される)。
  const expiryWarning =
    state.kind === 'authenticated' && state.expiryWarning === true;
  const expiryRemainingMinutes = (() => {
    if (
      state.kind !== 'authenticated' ||
      state.expiryWarning !== true ||
      state.accessExpiresAtUnix == null
    ) {
      return null;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const diff = state.accessExpiresAtUnix - nowSec;
    if (diff <= 0) return 0;
    return Math.ceil(diff / 60);
  })();

  return {
    state,
    kind: state.kind,
    isAuthenticated: state.kind === 'authenticated',
    requiresReauth: state.kind === 'requires_reauth',
    isError: state.kind === 'error',
    expiryWarning,
    expiryRemainingMinutes,
    lastChange,
    forceCheck,
    openLogin,
  };
}
