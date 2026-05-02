import { create } from 'zustand';
import { estimateTokens } from '@/lib/codex/token-estimator';

/**
 * Chat ペインのローカル state。
 *
 * v0.1.0 では Codex 統合非依存。送信は `appendUser()` → `appendAssistantStub()` で
 * モック応答を返す。Codex CLI sidecar 統合は POC 通過後（AS-122 / AS-123）。
 *
 * 設計参照:
 *   - dev-v0.1.0-scaffold-design.md § 1.2 主要データフロー
 *   - design-brand-v1.md § 8 Codex CLI 統合に固有の UI 要素
 *
 * DEC-018-026 ① B: tokensThisSession を追加。assistant message の更新ごとに
 * `estimateTokens` で再計算しヘッダ累計に表示する。Real impl 切替時は
 * token-estimator.ts の差し替えのみで本ストアは無変更。
 *
 * DEC-018-026 ① C: interruptedMessageIds を追加。中断ボタン押下で
 * その時点の streaming assistant message を「中断済み」とマークする。
 */
export type ChatRole = 'user' | 'assistant' | 'tool';

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  /**
   * DEC-018-026 ① B: assistant message 1 件あたりの擬似 token 数。
   * upsertAssistantStreaming の中で content から再計算される。
   * user / tool は常に 0 (UI 側でも非表示)。
   */
  tokens?: number;
  /**
   * DEC-018-026 ① C: 中断された assistant message かどうか。
   * markInterrupted で true がセットされ、UI 末尾に「(中断されました)」マーカーを描画する。
   */
  interrupted?: boolean;
}

interface ChatState {
  messagesByProject: Record<string, ChatMessage[]>;
  modelByProject: Record<string, string>;
  effortByProject: Record<string, ReasoningEffort>;
  inputDraftByProject: Record<string, string>;
  /**
   * DEC-018-026 ① B: project スコープの「セッション内累計 token 数」。
   * 現状は in-memory のみで永続化しない (Real impl 切替後に
   * SQLite の messages.tokens カラムから集計する設計に置き換える想定)。
   */
  tokensThisSessionByProject: Record<string, number>;
  setInputDraft: (projectId: string, draft: string) => void;
  setModel: (projectId: string, model: string) => void;
  setEffort: (projectId: string, effort: ReasoningEffort) => void;
  appendUser: (projectId: string, content: string) => void;
  appendAssistantStub: (projectId: string) => void;
  /**
   * AS-144: useCodex 経由のストリーミング assistant message を同期する。
   * 既存 message が同 id で存在すれば content を上書き、無ければ append する。
   * tokens は estimateTokens() で再計算する。
   */
  upsertAssistantStreaming: (
    projectId: string,
    id: string,
    content: string,
  ) => void;
  /**
   * DEC-018-026 ① C: 指定 id の assistant message を中断済みとマークする。
   * 該当 id が無ければ no-op。
   */
  markInterrupted: (projectId: string, id: string) => void;
  /** DEC-018-026 ① B: 現プロジェクトのセッション累計 token 数を取得。 */
  getTokensThisSession: (projectId: string) => number;
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
  tokensThisSessionByProject: {},
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
      const tokens = estimateTokens(content);
      if (idx >= 0) {
        const oldTokens = prev[idx]!.tokens ?? 0;
        const updated = prev.slice();
        updated[idx] = { ...prev[idx]!, content, tokens };
        const sessionPrev = s.tokensThisSessionByProject[projectId] ?? 0;
        const nextSession = Math.max(0, sessionPrev - oldTokens) + tokens;
        return {
          messagesByProject: {
            ...s.messagesByProject,
            [projectId]: updated,
          },
          tokensThisSessionByProject: {
            ...s.tokensThisSessionByProject,
            [projectId]: nextSession,
          },
        };
      }
      const msg: ChatMessage = {
        id,
        role: 'assistant',
        content,
        createdAt: Date.now(),
        tokens,
      };
      const sessionPrev = s.tokensThisSessionByProject[projectId] ?? 0;
      return {
        messagesByProject: {
          ...s.messagesByProject,
          [projectId]: [...prev, msg],
        },
        tokensThisSessionByProject: {
          ...s.tokensThisSessionByProject,
          [projectId]: sessionPrev + tokens,
        },
      };
    });
  },
  markInterrupted: (projectId, id) => {
    set((s) => {
      const prev = s.messagesByProject[projectId] ?? [];
      const idx = prev.findIndex((m) => m.id === id);
      if (idx < 0) return {};
      if (prev[idx]!.interrupted) return {};
      const updated = prev.slice();
      updated[idx] = { ...prev[idx]!, interrupted: true };
      return {
        messagesByProject: {
          ...s.messagesByProject,
          [projectId]: updated,
        },
      };
    });
  },
  getTokensThisSession: (projectId) =>
    get().tokensThisSessionByProject[projectId] ?? 0,
  clear: (projectId) =>
    set((s) => ({
      messagesByProject: { ...s.messagesByProject, [projectId]: [] },
      tokensThisSessionByProject: {
        ...s.tokensThisSessionByProject,
        [projectId]: 0,
      },
    })),
  getMessages: (projectId) => get().messagesByProject[projectId] ?? [],
  getModel: (projectId) => get().modelByProject[projectId] ?? DEFAULT_MODEL,
  getEffort: (projectId) => get().effortByProject[projectId] ?? DEFAULT_EFFORT,
}));

export const CHAT_DEFAULT_MODEL = DEFAULT_MODEL;
export const CHAT_DEFAULT_EFFORT = DEFAULT_EFFORT;
