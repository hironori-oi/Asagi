/**
 * useLazySpawn hook tests (DEC-018-045 QW3 / F4, AS-202.3)。
 *
 * Tauri event をグローバル mock した上で、lazy-spawn / idle-shutdown event を
 * 受信したときの状態遷移を検証する。
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- module-level mocks: must be set before importing the hook ----
const mockListen = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

import { useLazySpawn } from '../use-lazy-spawn';

beforeEach(() => {
  mockListen.mockReset();
});

describe('useLazySpawn', () => {
  it('mount 直後は lazySpawning=false / reason=null / idleShutdownAt=null', async () => {
    mockListen.mockResolvedValue(() => {});
    const { result } = renderHook(() => useLazySpawn('p-1'));
    expect(result.current.lazySpawning).toBe(false);
    expect(result.current.lazyReason).toBeNull();
    expect(result.current.idleShutdownAt).toBeNull();
  });

  it('AS-202.3: lazy-spawn event を受信すると lazySpawning=true + reason 反映', async () => {
    const handlers = new Map<
      string,
      (e: { payload: unknown }) => void
    >();
    mockListen.mockImplementation(
      (name: string, h: (e: { payload: unknown }) => void) => {
        handlers.set(name, h);
        return Promise.resolve(() => {});
      },
    );

    const { result } = renderHook(() => useLazySpawn('p-l1'));
    await waitFor(() => {
      expect(handlers.size).toBeGreaterThanOrEqual(1);
    });
    const h = handlers.get('agent:p-l1:lazy-spawn');
    expect(h).toBeTruthy();

    await act(async () => {
      h!({ payload: { projectId: 'p-l1', reason: 'sidecar_inactive' } });
    });
    await waitFor(() => {
      expect(result.current.lazySpawning).toBe(true);
    });
    expect(result.current.lazyReason).toBe('sidecar_inactive');
  });

  it('AS-202.3: idle-shutdown event を受信すると idleShutdownAt が更新される', async () => {
    const handlers = new Map<
      string,
      (e: { payload: unknown }) => void
    >();
    mockListen.mockImplementation(
      (name: string, h: (e: { payload: unknown }) => void) => {
        handlers.set(name, h);
        return Promise.resolve(() => {});
      },
    );

    const { result } = renderHook(() => useLazySpawn('p-i1'));
    await waitFor(() => {
      expect(handlers.size).toBeGreaterThanOrEqual(2);
    });
    const h = handlers.get('agent:p-i1:idle-shutdown');
    expect(h).toBeTruthy();

    expect(result.current.idleShutdownAt).toBeNull();
    const before = Date.now();
    await act(async () => {
      h!({ payload: 'p-i1' });
    });
    await waitFor(() => {
      expect(result.current.idleShutdownAt).not.toBeNull();
    });
    expect(result.current.idleShutdownAt).toBeGreaterThanOrEqual(before);
  });

  it('AS-202.3: clear() で lazySpawning / reason / idleShutdownAt がリセットされる', async () => {
    const handlers = new Map<
      string,
      (e: { payload: unknown }) => void
    >();
    mockListen.mockImplementation(
      (name: string, h: (e: { payload: unknown }) => void) => {
        handlers.set(name, h);
        return Promise.resolve(() => {});
      },
    );

    const { result } = renderHook(() => useLazySpawn('p-c1'));
    await waitFor(() => {
      expect(handlers.size).toBeGreaterThanOrEqual(2);
    });
    const lazyH = handlers.get('agent:p-c1:lazy-spawn')!;
    const idleH = handlers.get('agent:p-c1:idle-shutdown')!;

    await act(async () => {
      lazyH({ payload: { projectId: 'p-c1', reason: 'sidecar_inactive' } });
      idleH({ payload: 'p-c1' });
    });
    await waitFor(() => {
      expect(result.current.lazySpawning).toBe(true);
      expect(result.current.idleShutdownAt).not.toBeNull();
    });

    act(() => {
      result.current.clear();
    });
    await waitFor(() => {
      expect(result.current.lazySpawning).toBe(false);
    });
    expect(result.current.lazyReason).toBeNull();
    expect(result.current.idleShutdownAt).toBeNull();
  });
});
