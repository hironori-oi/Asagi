import { describe, it, expect, beforeEach } from 'vitest';
import { useChatActivityStore } from '../chat-activity';

beforeEach(() => {
  useChatActivityStore.getState().reset();
});

describe('useChatActivityStore', () => {
  it('setSession で sessionId スコープに state が保存される', () => {
    useChatActivityStore.getState().setSession('s1', 'thinking');
    expect(useChatActivityStore.getState().stateBySession.s1).toBe('thinking');
  });

  it('setProject で projectId スコープに state が保存される', () => {
    useChatActivityStore.getState().setProject('p1', 'streaming');
    expect(useChatActivityStore.getState().stateByProject.p1).toBe('streaming');
  });

  it('syncBoth で session と project を同時に更新できる', () => {
    useChatActivityStore.getState().syncBoth('s1', 'p1', 'thinking');
    const st = useChatActivityStore.getState();
    expect(st.stateBySession.s1).toBe('thinking');
    expect(st.stateByProject.p1).toBe('thinking');
  });

  it('null id は no-op（store を変更しない）', () => {
    useChatActivityStore.getState().setSession(null, 'thinking');
    useChatActivityStore.getState().setProject(null, 'streaming');
    const st = useChatActivityStore.getState();
    expect(Object.keys(st.stateBySession)).toHaveLength(0);
    expect(Object.keys(st.stateByProject)).toHaveLength(0);
  });

  it('同じ state の連続書込は state object を再生成しない（参照同一性）', () => {
    useChatActivityStore.getState().setSession('s1', 'thinking');
    const before = useChatActivityStore.getState().stateBySession;
    useChatActivityStore.getState().setSession('s1', 'thinking');
    const after = useChatActivityStore.getState().stateBySession;
    expect(after).toBe(before);
  });

  it('reset で全 state がクリアされる', () => {
    useChatActivityStore.getState().setSession('s1', 'thinking');
    useChatActivityStore.getState().setProject('p1', 'streaming');
    useChatActivityStore.getState().reset();
    const st = useChatActivityStore.getState();
    expect(Object.keys(st.stateBySession)).toHaveLength(0);
    expect(Object.keys(st.stateByProject)).toHaveLength(0);
  });
});
