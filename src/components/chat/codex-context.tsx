'use client';

/**
 * ChatPane → InputArea へ useCodex の操作を渡す React Context (AS-144)。
 *
 * ChatPane が `useCodex(activeProjectId)` を 1 度だけ呼び、その
 * `sendMessage` / `status` / `isReady` / `isStreaming` を
 * 子コンポーネント (InputArea, ChatStatusBadge) で参照できるようにする。
 *
 * provider 外で使った場合は `null` を返すので、コンポーネント側は
 * フォールバック (legacy stub) に切り替えられる。
 */

import { createContext, useContext } from 'react';
import type { CodexStatus } from '@/lib/codex/use-codex';

export interface CodexContextValue {
  status: CodexStatus;
  isReady: boolean;
  isStreaming: boolean;
  error: string | null;
  /** ChatPane 側で SQLite 永続化 + appendUser + codex.sendMessage を順に呼ぶラッパ。 */
  send: (content: string) => Promise<void>;
}

export const CodexContext = createContext<CodexContextValue | null>(null);

export function useCodexContext(): CodexContextValue | null {
  return useContext(CodexContext);
}
