/**
 * Chat activity store (AS-UX-04 / DEC-018-037 §②).
 *
 * StatusBar Activity summary と ProjectRail status dot (AS-UX-06) のために、
 * 「いま動いている AI の状態」を per-session / per-project で集約する zustand store。
 *
 * # 設計判断
 *
 * - **真実の源は ChatPane (useCodex)**: 各 ChatPane が mount 中、`useCodex.status`
 *   と `awaitingFirstDelta` から activity state を導出して `setSession` を呼ぶ。
 *   これにより Tauri event listener を二重に張らずに済む（DRY）。
 * - **per-session / per-project**: M1 段階の Asagi は「1 project = 1 active session」
 *   が暗黙だが、将来 multi-session 時を見据えて両方を保持する。今は同期して書く。
 * - **completed 表示は時限**: 'completed' 状態は AS-UX-06 で 2 秒だけ green dot を
 *   見せるため、setSession('completed') の呼び出し側が 2 秒後に setSession('idle')
 *   を行うのではなく、StatusBar / ProjectIcon 側 view で auto-fade させる方針。
 *   ここでは状態をそのまま保持する（明示的に上書きされるまで）。
 *
 * # 状態遷移（典型例）
 *
 *   idle → thinking (turn/start)
 *        → streaming (item/agentMessage/delta 初回)
 *        → completed (turn/completed) → idle (次 turn / interrupt)
 *        → error (sidecar error)
 */

import { create } from 'zustand';

export type ChatActivityState =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'completed'
  | 'error';

interface ChatActivityStore {
  stateBySession: Record<string, ChatActivityState>;
  stateByProject: Record<string, ChatActivityState>;
  setSession: (sessionId: string | null, state: ChatActivityState) => void;
  setProject: (projectId: string | null, state: ChatActivityState) => void;
  /** session / project 両方を同じ state に揃える便利メソッド。 */
  syncBoth: (
    sessionId: string | null,
    projectId: string | null,
    state: ChatActivityState,
  ) => void;
  reset: () => void;
}

export const useChatActivityStore = create<ChatActivityStore>((set) => ({
  stateBySession: {},
  stateByProject: {},
  setSession: (sessionId, state) =>
    set((s) => {
      if (!sessionId) return s;
      if (s.stateBySession[sessionId] === state) return s;
      return {
        stateBySession: { ...s.stateBySession, [sessionId]: state },
      };
    }),
  setProject: (projectId, state) =>
    set((s) => {
      if (!projectId) return s;
      if (s.stateByProject[projectId] === state) return s;
      return {
        stateByProject: { ...s.stateByProject, [projectId]: state },
      };
    }),
  syncBoth: (sessionId, projectId, state) =>
    set((s) => {
      const nextSession =
        sessionId && s.stateBySession[sessionId] !== state
          ? { ...s.stateBySession, [sessionId]: state }
          : s.stateBySession;
      const nextProject =
        projectId && s.stateByProject[projectId] !== state
          ? { ...s.stateByProject, [projectId]: state }
          : s.stateByProject;
      if (nextSession === s.stateBySession && nextProject === s.stateByProject) {
        return s;
      }
      return { stateBySession: nextSession, stateByProject: nextProject };
    }),
  reset: () => set({ stateBySession: {}, stateByProject: {} }),
}));
