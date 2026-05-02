/**
 * Sidecar mode store (AS-144 / DEC-018-036).
 *
 * Codex sidecar の mock <-> real 切替を UI から扱うための zustand store。
 *
 * # 設計判断
 *
 * - **永続化しない**: backend (`AppState.current_sidecar_mode`) が真実の源で、
 *   起動時は必ず `agent_get_sidecar_mode` で seed する。localStorage に持つと
 *   env (`ASAGI_SIDECAR_MODE`) との乖離が生じる。
 * - **切替後の既存 sidecar は触らない**: backend と同じ additive ポリシー。
 *   完全切替するには UI 側で「shutdown → setMode → spawn」の順を踏む。
 * - **mock fallback 維持**: 不正な値 / 未取得状態でも `mock` を default とする。
 */

import { create } from 'zustand';
import {
  getSidecarMode,
  setSidecarMode as setSidecarModeImpl,
  type SidecarMode,
} from '@/lib/codex/sidecar-client';

export type { SidecarMode };

export const SIDECAR_MODES: readonly SidecarMode[] = ['mock', 'real'] as const;

interface SidecarModeState {
  /** 現在の mode。`null` は未取得（起動直後）。 */
  mode: SidecarMode | null;
  /** Tauri 経由 `agent_set_sidecar_mode` が in-flight 中なら true。 */
  switching: boolean;
  /** 直近の切替エラー（成功で null クリア）。 */
  error: string | null;
  /**
   * Backend から現在の mode を取得して store に反映する（UI 起動時に呼ぶ）。
   * 失敗時は `mock` を fallback として state に書き、error を保存する。
   */
  refresh: () => Promise<SidecarMode>;
  /**
   * mode を切替える。Backend に commit 後、最新値を store に反映する。
   * 既存 sidecar は backend ポリシーにより触らない。
   */
  setMode: (mode: SidecarMode) => Promise<SidecarMode>;
}

export const useSidecarModeStore = create<SidecarModeState>((set) => ({
  mode: null,
  switching: false,
  error: null,
  refresh: async () => {
    try {
      const m = await getSidecarMode();
      set({ mode: m, error: null });
      return m;
    } catch (e) {
      // Backend 未準備時 (SSR / vitest 直叩き等) の fallback
      set({ mode: 'mock', error: `getSidecarMode failed: ${String(e)}` });
      return 'mock';
    }
  },
  setMode: async (mode) => {
    set({ switching: true, error: null });
    try {
      const committed = await setSidecarModeImpl(mode);
      set({ mode: committed, switching: false });
      return committed;
    } catch (e) {
      set({ switching: false, error: `setSidecarMode failed: ${String(e)}` });
      throw e;
    }
  },
}));
