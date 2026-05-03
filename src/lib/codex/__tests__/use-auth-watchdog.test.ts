/**
 * useAuthWatchdog hook tests (DEC-018-028 QW1 / F3)。
 *
 * Tauri invoke / event はグローバル mock 済み (vitest.setup.ts) なので、
 * ここでは個別に tauri モジュールを stub し直して seed と event を制御する。
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- module-level mocks: must be set before importing the hook ----
const mockInvoke = vi.fn();
const mockListen = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

import { useAuthWatchdog } from '../use-auth-watchdog';
import type {
  AuthStateChangedPayload,
  AuthWatchdogState,
} from '../sidecar-client';

beforeEach(() => {
  mockInvoke.mockReset();
  mockListen.mockReset();
});

describe('useAuthWatchdog', () => {
  it('seed が unknown のときは isAuthenticated=false / requiresReauth=false', async () => {
    const seed: AuthWatchdogState = { kind: 'unknown' };
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'auth_watchdog_get_state') return seed;
      return undefined;
    });
    mockListen.mockResolvedValue(() => {});

    const { result } = renderHook(() => useAuthWatchdog('p-1'));
    await waitFor(() => {
      expect(result.current.kind).toBe('unknown');
    });
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.requiresReauth).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  it('event で requires_reauth payload を受信すると requiresReauth=true になる', async () => {
    const seed: AuthWatchdogState = {
      kind: 'authenticated',
      last_checked_unix: 1727040000,
      plan: 'mock-pro-5x',
      user: 'mock-user',
    };
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'auth_watchdog_get_state') return seed;
      return undefined;
    });

    // listen が登録した handler を捕捉して、後で手動発火する
    let handler: ((e: { payload: AuthStateChangedPayload }) => void) | null =
      null;
    mockListen.mockImplementation((_name: string, h: typeof handler) => {
      handler = h;
      return Promise.resolve(() => {});
    });

    const { result } = renderHook(() => useAuthWatchdog('p-2'));
    await waitFor(() => {
      expect(result.current.isAuthenticated).toBe(true);
    });

    // 認証エラーへ遷移
    const payload: AuthStateChangedPayload = {
      from: 'authenticated',
      to: 'requires_reauth',
      state: {
        kind: 'requires_reauth',
        detected_at_unix: 1727050000,
        reason: 'account/read returned requires_openai_auth=true',
      },
      reason: 'account/read returned requires_openai_auth=true',
    };
    await act(async () => {
      handler?.({ payload });
    });
    await waitFor(() => {
      expect(result.current.requiresReauth).toBe(true);
    });
    expect(result.current.kind).toBe('requires_reauth');
    expect(result.current.lastChange?.from).toBe('authenticated');
    expect(result.current.lastChange?.to).toBe('requires_reauth');
  });

  it('AS-200.3: expiry warning seed → expiryWarning=true / 残分計算が動く', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const seed: AuthWatchdogState = {
      kind: 'authenticated',
      last_checked_unix: nowSec,
      plan: 'mock-pro-5x',
      user: 'mock-user',
      accessExpiresAtUnix: nowSec + 600, // 10 分後
      expiryWarning: true,
    };
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'auth_watchdog_get_state') return seed;
      return undefined;
    });
    mockListen.mockResolvedValue(() => {});

    const { result } = renderHook(() => useAuthWatchdog('p-warn'));
    await waitFor(() => {
      expect(result.current.expiryWarning).toBe(true);
    });
    // 9〜11 分の範囲（実行時間ジッタ許容）
    expect(result.current.expiryRemainingMinutes).toBeGreaterThanOrEqual(9);
    expect(result.current.expiryRemainingMinutes).toBeLessThanOrEqual(11);
    // requires_reauth ではない (warning は authenticated のサブ状態)
    expect(result.current.requiresReauth).toBe(false);
    expect(result.current.isAuthenticated).toBe(true);
  });

  it('AS-200.3: openLogin が auth_open_login invoke を発火する', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'auth_watchdog_get_state') {
        return { kind: 'unknown' } satisfies AuthWatchdogState;
      }
      if (cmd === 'auth_open_login') return undefined;
      return undefined;
    });
    mockListen.mockResolvedValue(() => {});

    const { result } = renderHook(() => useAuthWatchdog('p-relogin'));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        'auth_watchdog_get_state',
        expect.objectContaining({ projectId: 'p-relogin' }),
      );
    });

    await act(async () => {
      await result.current.openLogin();
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      'auth_open_login',
      expect.objectContaining({ projectId: 'p-relogin' }),
    );
  });

  it('AS-HOTFIX-QW1 (DEC-018-045 ⑥): force-check is debounced — 5 連打 → 500ms 経過まで invoke は 1 回のみ', async () => {
    // fake timers で setTimeout(500ms) を制御 (advanceTimersByTimeAsync で microtask も flush)
    vi.useFakeTimers();
    try {
      let forceCheckCalls = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'auth_watchdog_get_state') {
          return { kind: 'unknown' } satisfies AuthWatchdogState;
        }
        if (cmd === 'auth_watchdog_force_check') {
          forceCheckCalls += 1;
          return undefined;
        }
        return undefined;
      });
      mockListen.mockResolvedValue(() => {});

      const { result } = renderHook(() => useAuthWatchdog('p-debounce'));
      // seed useEffect 起動を待つ (microtask flush)
      await act(async () => {
        await Promise.resolve();
      });

      // 100ms 間隔で 5 回連打 (= 計 400ms 経過)
      // 各呼び出しは共有 Promise を返し、trailing 発火時に一括 resolve される
      const pending: Array<Promise<void>> = [];
      for (let i = 0; i < 5; i += 1) {
        pending.push(result.current.forceCheck());
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });
      }
      // 最後の呼び出しは loop 内 i=4 で行われ、その後 100ms 進めた直後 (= 500ms 時点)。
      // 最後の forceCheck 呼び出し時刻は 400ms、debounce 500ms なので fire は 900ms。
      // よって 500ms 時点では invoke は 0 回。
      expect(forceCheckCalls).toBe(0);

      // 残り 400ms (= 計 900ms) で trailing 発火
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      // 共有 Promise 経由で全 caller が resolve される
      await Promise.all(pending);

      expect(forceCheckCalls).toBe(1);
      expect(mockInvoke).toHaveBeenCalledWith(
        'auth_watchdog_force_check',
        expect.objectContaining({ projectId: 'p-debounce' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('forceCheck が auth_watchdog_force_check invoke を発火する', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'auth_watchdog_get_state') {
        return { kind: 'unknown' } satisfies AuthWatchdogState;
      }
      if (cmd === 'auth_watchdog_force_check') return undefined;
      return undefined;
    });
    mockListen.mockResolvedValue(() => {});

    const { result } = renderHook(() => useAuthWatchdog('p-3'));
    await waitFor(() => {
      // seed 完了を待つ
      expect(mockInvoke).toHaveBeenCalledWith(
        'auth_watchdog_get_state',
        expect.objectContaining({ projectId: 'p-3' }),
      );
    });

    await act(async () => {
      await result.current.forceCheck();
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      'auth_watchdog_force_check',
      expect.objectContaining({ projectId: 'p-3' }),
    );
  });
});
