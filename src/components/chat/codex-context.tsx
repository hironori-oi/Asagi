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
  /** DEC-018-026 ① A: turn/start 後 → 最初の delta まで true。 */
  awaitingFirstDelta: boolean;
  /** DEC-018-026 ① A: 直近 streaming の assistant item id (typing indicator 配置判定用)。 */
  streamingItemId: string | null;
  /** ChatPane 側で SQLite 永続化 + appendUser + codex.sendMessage を順に呼ぶラッパ。 */
  send: (content: string) => Promise<void>;
  /**
   * DEC-018-026 ① C: 現 turn を中断する。streaming で無いときは no-op。
   * Real impl 切替後も同じ呼び出し規約 (`turn/interrupt`) で動く。
   */
  interrupt: () => Promise<void>;
}

export const CodexContext = createContext<CodexContextValue | null>(null);

export function useCodexContext(): CodexContextValue | null {
  return useContext(CodexContext);
}
