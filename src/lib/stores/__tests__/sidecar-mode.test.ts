/**
 * useSidecarModeStore tests (AS-144 / DEC-018-036)。
 *
 * Tauri invoke は vitest.setup.ts でグローバル mock 済み。
 * ここでは個別に再 mock して、`agent_get_sidecar_mode` /
 * `agent_set_sidecar_mode` の呼出シグネチャと store state 反映を検証する。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { useSidecarModeStore, SIDECAR_MODES } from '../sidecar-mode';

beforeEach(() => {
  mockInvoke.mockReset();
  // 各テスト間で state リセット
  useSidecarModeStore.setState({ mode: null, switching: false, error: null });
});

describe('useSidecarModeStore', () => {
  it('SIDECAR_MODES は mock / real の 2 件', () => {
    expect(SIDECAR_MODES).toEqual(['mock', 'real']);
  });

  it('初期状態は mode=null / switching=false / error=null', () => {
    const s = useSidecarModeStore.getState();
    expect(s.mode).toBeNull();
    expect(s.switching).toBe(false);
    expect(s.error).toBeNull();
  });

  it('refresh: backend が mock を返したら mode=mock を反映', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'agent_get_sidecar_mode') return { mode: 'mock' };
      throw new Error(`unexpected: ${cmd}`);
    });
    const got = await useSidecarModeStore.getState().refresh();
    expect(got).toBe('mock');
    expect(useSidecarModeStore.getState().mode).toBe('mock');
    expect(useSidecarModeStore.getState().error).toBeNull();
  });

  it('refresh: backend が real を返したら mode=real を反映', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'agent_get_sidecar_mode') return { mode: 'real' };
      throw new Error(`unexpected: ${cmd}`);
    });
    const got = await useSidecarModeStore.getState().refresh();
    expect(got).toBe('real');
    expect(useSidecarModeStore.getState().mode).toBe('real');
  });

  it('refresh: backend が失敗したら mock fallback + error 保存', async () => {
    mockInvoke.mockRejectedValue(new Error('tauri unavailable'));
    const got = await useSidecarModeStore.getState().refresh();
    expect(got).toBe('mock');
    const s = useSidecarModeStore.getState();
    expect(s.mode).toBe('mock');
    expect(s.error).toContain('getSidecarMode failed');
  });

  it('setMode: real 切替で agent_set_sidecar_mode が args 構造で呼ばれる', async () => {
    mockInvoke.mockImplementation(async (cmd: string, payload: unknown) => {
      if (cmd === 'agent_set_sidecar_mode') {
        // Tauri command の args は { args: { mode } } という二重構造
        // (invoke layer が Rust 側 Deserialize と整合させるため)
        const p = payload as { args?: { mode?: string } };
        return { mode: p.args?.mode ?? 'mock' };
      }
      throw new Error(`unexpected: ${cmd}`);
    });
    const got = await useSidecarModeStore.getState().setMode('real');
    expect(got).toBe('real');
    expect(useSidecarModeStore.getState().mode).toBe('real');
    expect(useSidecarModeStore.getState().switching).toBe(false);
    expect(mockInvoke).toHaveBeenCalledWith('agent_set_sidecar_mode', {
      args: { mode: 'real' },
    });
  });

  it('setMode: mock fallback も維持（real → mock 戻し可能）', async () => {
    mockInvoke.mockImplementation(async (_cmd: string, payload: unknown) => {
      const p = payload as { args?: { mode?: string } };
      return { mode: p.args?.mode ?? 'mock' };
    });
    await useSidecarModeStore.getState().setMode('real');
    expect(useSidecarModeStore.getState().mode).toBe('real');
    await useSidecarModeStore.getState().setMode('mock');
    expect(useSidecarModeStore.getState().mode).toBe('mock');
  });

  it('setMode: backend が reject したら switching=false + error 保存 + throw', async () => {
    mockInvoke.mockRejectedValue(new Error('invalid mode'));
    await expect(
      useSidecarModeStore.getState().setMode('real'),
    ).rejects.toThrow();
    const s = useSidecarModeStore.getState();
    expect(s.switching).toBe(false);
    expect(s.error).toContain('setSidecarMode failed');
  });
});
