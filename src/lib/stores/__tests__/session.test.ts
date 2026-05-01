import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from '../session';
import type { SessionRow } from '@/lib/tauri/types';

function reset() {
  useSessionStore.setState({
    sessions: [],
    activeSessionId: null,
  });
}

const mkRow = (id: string, title = id): SessionRow => ({
  id,
  title,
  project_id: 'default',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

describe('useSessionStore', () => {
  beforeEach(() => {
    reset();
  });

  it('初期状態は空配列 + active null', () => {
    expect(useSessionStore.getState().sessions).toEqual([]);
    expect(useSessionStore.getState().activeSessionId).toBeNull();
  });

  it('setSessions は配列を設定する', () => {
    const rows = [mkRow('s1'), mkRow('s2')];
    useSessionStore.getState().setSessions(rows);
    expect(useSessionStore.getState().sessions).toHaveLength(2);
  });

  it('setActive は active を切替える', () => {
    useSessionStore.getState().setActive('s1');
    expect(useSessionStore.getState().activeSessionId).toBe('s1');
    useSessionStore.getState().setActive(null);
    expect(useSessionStore.getState().activeSessionId).toBeNull();
  });
});
