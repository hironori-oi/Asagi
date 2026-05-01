import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore, CHAT_DEFAULT_MODEL, CHAT_DEFAULT_EFFORT } from '../chat';

function reset() {
  useChatStore.setState({
    messagesByProject: {},
    modelByProject: {},
    effortByProject: {},
    inputDraftByProject: {},
  });
}

describe('useChatStore', () => {
  beforeEach(reset);

  it('appendUser は user メッセージを追加する', () => {
    useChatStore.getState().appendUser('p1', 'hello');
    const list = useChatStore.getState().getMessages('p1');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ role: 'user', content: 'hello' });
  });

  it('appendUser は trim 済みで空文字なら無視する', () => {
    useChatStore.getState().appendUser('p1', '   ');
    expect(useChatStore.getState().getMessages('p1')).toHaveLength(0);
  });

  it('appendAssistantStub は固定文字列の assistant を追加する', () => {
    useChatStore.getState().appendAssistantStub('p1');
    const list = useChatStore.getState().getMessages('p1');
    expect(list[0]?.role).toBe('assistant');
    expect(list[0]?.content).toMatch(/POC/);
  });

  it('clear は project の messages を空にする', () => {
    useChatStore.getState().appendUser('p1', 'a');
    useChatStore.getState().appendUser('p1', 'b');
    useChatStore.getState().clear('p1');
    expect(useChatStore.getState().getMessages('p1')).toHaveLength(0);
  });

  it('getModel/getEffort は default を返す', () => {
    expect(useChatStore.getState().getModel('p1')).toBe(CHAT_DEFAULT_MODEL);
    expect(useChatStore.getState().getEffort('p1')).toBe(CHAT_DEFAULT_EFFORT);
  });

  it('setInputDraft はプロジェクトごとに分離', () => {
    useChatStore.getState().setInputDraft('p1', 'hi');
    useChatStore.getState().setInputDraft('p2', 'hello');
    expect(useChatStore.getState().inputDraftByProject).toMatchObject({
      p1: 'hi',
      p2: 'hello',
    });
  });
});
