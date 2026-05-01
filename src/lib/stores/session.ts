import { create } from 'zustand';
import type { SessionRow } from '@/lib/tauri/types';

interface SessionState {
  sessions: SessionRow[];
  activeSessionId: string | null;
  setSessions: (sessions: SessionRow[]) => void;
  setActive: (id: string | null) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: [],
  activeSessionId: null,
  setSessions: (sessions) => set({ sessions }),
  setActive: (id) => set({ activeSessionId: id }),
}));
