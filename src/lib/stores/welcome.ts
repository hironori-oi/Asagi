import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface WelcomeState {
  step: number;
  totalSteps: number;
  completed: boolean;
  next: () => void;
  back: () => void;
  finish: () => void;
  reset: () => void;
}

/**
 * Welcome ウィザードの進行状態。
 * `completed` を localStorage に persist し、Welcome 画面と Main shell の切替判定に使う。
 * Welcome に戻りたい場合は `reset()` で完了フラグを倒す（M2 で設定画面から呼ぶ予定）。
 */
export const useWelcomeStore = create<WelcomeState>()(
  persist(
    (set, get) => ({
      step: 0,
      totalSteps: 3,
      completed: false,
      next: () => {
        const { step, totalSteps } = get();
        if (step < totalSteps - 1) set({ step: step + 1 });
      },
      back: () => {
        const { step } = get();
        if (step > 0) set({ step: step - 1 });
      },
      finish: () => set({ completed: true }),
      reset: () => set({ step: 0, completed: false }),
    }),
    {
      name: 'asagi-welcome',
      storage: createJSONStorage(() => {
        if (typeof window === 'undefined') {
          return {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
          };
        }
        return window.localStorage;
      }),
      version: 1,
      partialize: (state) => ({ completed: state.completed }),
    }
  )
);
