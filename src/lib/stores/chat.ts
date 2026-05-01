import { create } from 'zustand';

/**
 * Chat ペインのローカル state。
 *
 * v0.1.0 では Codex 統合非依存。送信は `appendUser()` → `appendAssistantStub()` で
 * モック応答を返す。Codex CLI sidecar 統合は POC 通過後（AS-122 / AS-123）。
 *
 * 設計参照:
 *   - dev-v0.1.0-scaffold-design.md § 1.2 主要データフロー
 *   - design-brand-v1.md § 8 Codex CLI 統合に固有の UI 要素
 */
export type ChatRole = 'user' | 'assistant' | 'tool';

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
}

interface ChatState {
  messagesByProject: Record<string, ChatMessage[]>;
  modelByProject: Record<string, string>;
  effortByProject: Record<string, ReasoningEffort>;
  inputDraftByProject: Record<string, string>;
  setInputDraft: (projectId: string, draft: string) => void;
  setModel: (projectId: string, model: string) => void;
  setEffort: (projectId: string, effort: ReasoningEffort) => void;
  appendUser: (projectId: string, content: string) => void;
  appendAssistantStub: (projectId: string) => void;
  /**
   * AS-144: useCodex 経由のストリーミング assistant message を同期する。
   * 既存 message が同 id で存在すれば content を上書き、無ければ append する。
   */
  upsertAssistantStreaming: (
    projectId: string,
    id: string,
    content: string,
  ) => void;
  clear: (projectId: string) => void;
  getMessages: (projectId: string) => ChatMessage[];
  getModel: (projectId: string) => string;
  getEffort: (projectId: string) => ReasoningEffort;
}

const DEFAULT_MODEL = 'gpt-5.5-codex';
const DEFAULT_EFFORT: ReasoningEffort = 'medium';
const STUB_RESPONSE = '[stub] Codex 統合は POC 通過後に実装';

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messagesByProject: {},
  modelByProject: {},
  effortByProject: {},
  inputDraftByProject: {},
  setInputDraft: (projectId, draft) =>
    set((s) => ({
      inputDraftByProject: { ...s.inputDraftByProject, [projectId]: draft },
    })),
  setModel: (projectId, model) =>
    set((s) => ({
      modelByProject: { ...s.modelByProject, [projectId]: model },
    })),
  setEffort: (projectId, effort) =>
    set((s) => ({
      effortByProject: { ...s.effortByProject, [projectId]: effort },
    })),
  appendUser: (projectId, content) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    const msg: ChatMessage = {
      id: genId(),
      role: 'user',
      content: trimmed,
      createdAt: Date.now(),
    };
    set((s) => {
      const prev = s.messagesByProject[projectId] ?? [];
      return {
        messagesByProject: {
          ...s.messagesByProject,
          [projectId]: [...prev, msg],
        },
        inputDraftByProject: { ...s.inputDraftByProject, [projectId]: '' },
      };
    });
  },
  appendAssistantStub: (projectId) => {
    const msg: ChatMessage = {
      id: genId(),
      role: 'assistant',
      content: STUB_RESPONSE,
      createdAt: Date.now(),
    };
    set((s) => {
      const prev = s.messagesByProject[projectId] ?? [];
      return {
        messagesByProject: {
          ...s.messagesByProject,
          [projectId]: [...prev, msg],
        },
      };
    });
  },
  upsertAssistantStreaming: (projectId, id, content) => {
    set((s) => {
      const prev = s.messagesByProject[projectId] ?? [];
      const idx = prev.findIndex((m) => m.id === id);
      if (idx >= 0) {
        const updated = prev.slice();
        updated[idx] = { ...prev[idx]!, content };
        return {
          messagesByProject: {
            ...s.messagesByProject,
            [projectId]: updated,
          },
        };
      }
      const msg: ChatMessage = {
        id,
        role: 'assistant',
        content,
        createdAt: Date.now(),
      };
      return {
        messagesByProject: {
          ...s.messagesByProject,
          [projectId]: [...prev, msg],
        },
      };
    });
  },
  clear: (projectId) =>
    set((s) => ({
      messagesByProject: { ...s.messagesByProject, [projectId]: [] },
    })),
  getMessages: (projectId) => get().messagesByProject[projectId] ?? [],
  getModel: (projectId) => get().modelByProject[projectId] ?? DEFAULT_MODEL,
  getEffort: (projectId) => get().effortByProject[projectId] ?? DEFAULT_EFFORT,
}));

export const CHAT_DEFAULT_MODEL = DEFAULT_MODEL;
export const CHAT_DEFAULT_EFFORT = DEFAULT_EFFORT;
