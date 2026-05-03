/**
 * useSpawnRetry hook tests (DEC-018-045 QW2 / F1, AS-201.3)。
 *
 * Tauri event をグローバル mock した上で、retry 試行 → 失敗 / 成功までの
 * status 遷移を検証する。
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- module-level mocks: must be set before importing the hook ----
const mockListen = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

import { useSpawnRetry } from '../use-spawn-retry';
import type { SpawnAttemptEvent } from '../schemas';

beforeEach(() => {
  mockListen.mockReset();
});

describe('useSpawnRetry', () => {
  it('mount 直後は idle / attempt=0', async () => {
    mockListen.mockResolvedValue(() => {});
    const { result } = renderHook(() => useSpawnRetry('p-1'));
    expect(result.current.status).toBe('idle');
    expect(result.current.isRetrying).toBe(false);
    expect(result.current.isFailed).toBe(false);
    expect(result.current.attempt).toBe(0);
  });

  it('AS-201.3: 試行中 event を受信すると retrying に遷移する', async () => {
    let handler:
      | ((e: { payload: unknown }) => void)
      | null = null;
    mockListen.mockImplementation((_name: string, h: typeof handler) => {
      handler = h;
      return Promise.resolve(() => {});
    });

    const { result } = renderHook(() => useSpawnRetry('p-r1'));
    // 1 回目失敗 + 次 sleep あり
    const ev: SpawnAttemptEvent = {
      attempt: 1,
      maxRetries: 3,
      lastError: 'spawn synthetic failure',
      nextSleepMs: 200,
    };
    await act(async () => {
      handler?.({ payload: ev });
    });
    await waitFor(() => {
      expect(result.current.isRetrying).toBe(true);
    });
    expect(result.current.attempt).toBe(1);
    expect(result.current.maxRetries).toBe(3);
    expect(result.current.lastError).toBe('spawn synthetic failure');
    expect(result.current.nextSleepMs).toBe(200);
    expect(result.current.isFailed).toBe(false);
  });

  it('AS-201.3: 最終試行失敗 (attempt=max, sleep=null, error あり) で failed', async () => {
    let handler:
      | ((e: { payload: unknown }) => void)
      | null = null;
    mockListen.mockImplementation((_name: string, h: typeof handler) => {
      handler = h;
      return Promise.resolve(() => {});
    });

    const { result } = renderHook(() => useSpawnRetry('p-r2'));
    const ev: SpawnAttemptEvent = {
      attempt: 3,
      maxRetries: 3,
      lastError: 'final failure',
      nextSleepMs: null,
    };
    await act(async () => {
      handler?.({ payload: ev });
    });
    await waitFor(() => {
      expect(result.current.isFailed).toBe(true);
    });
    expect(result.current.status).toBe('failed');
    expect(result.current.lastError).toBe('final failure');
  });

  it('AS-201.3: clear() で idle に戻る', async () => {
    let handler:
      | ((e: { payload: unknown }) => void)
      | null = null;
    mockListen.mockImplementation((_name: string, h: typeof handler) => {
      handler = h;
      return Promise.resolve(() => {});
    });

    const { result } = renderHook(() => useSpawnRetry('p-r3'));
    const ev: SpawnAttemptEvent = {
      attempt: 1,
      maxRetries: 3,
      lastError: null,
      nextSleepMs: 100,
    };
    await act(async () => {
      handler?.({ payload: ev });
    });
    await waitFor(() => {
      expect(result.current.isRetrying).toBe(true);
    });
    act(() => {
      result.current.clear();
    });
    await waitFor(() => {
      expect(result.current.status).toBe('idle');
    });
    expect(result.current.last).toBeNull();
  });
});
