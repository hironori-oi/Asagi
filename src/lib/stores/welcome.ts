import { create } from 'zustand';

interface WelcomeState {
  step: number;
  totalSteps: number;
  completed: boolean;
  next: () => void;
  back: () => void;
  finish: () => void;
  reset: () => void;
}

export const useWelcomeStore = create<WelcomeState>((set, get) => ({
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
}));
