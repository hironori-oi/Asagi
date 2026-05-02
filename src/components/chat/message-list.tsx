'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useChatStore, type ChatMessage } from '@/lib/stores/chat';
import { useProjectStore } from '@/lib/stores/project';
import { MessageItem } from './message-item';
import { TypingIndicator } from './typing-indicator';
import { useCodexContext } from './codex-context';

/**
 * 安定した空配列。`?? []` をインライン展開すると毎回新規参照になり、
 * React 19 + Zustand v5 の `useSyncExternalStore` で無限再レンダーループに
 * なる (Maximum update depth exceeded)。モジュールスコープに固定する。
 */
const EMPTY_MESSAGES: ChatMessage[] = [];

/**
 * メッセージ一覧（スクロール）。
 *
 * - active project の messagesByProject[id] を購読
 * - 新規メッセージ追加時 + delta 受信ごとに自動スクロール（DEC-018-026 ① D）
 * - 空状態は中央寄せのプレースホルダ。CodexContext がある（mock 完結 IDE）の
 *   場合は mock-asagi 用の hint も表示する（DEC-018-026 ① D）。
 * - streaming 中は末尾に typing indicator (DEC-018-026 ① A)。
 */
export function MessageList() {
  const t = useTranslations('chat.empty');
  const tChat = useTranslations('chat');
  const ctx = useCodexContext();
  const activeId = useProjectStore((s) => s.activeProjectId);
  const messages = useChatStore(
    (s) => s.messagesByProject[activeId] ?? EMPTY_MESSAGES,
  );
  const bottomRef = useRef<HTMLDivElement>(null);

  // DEC-018-026 ① D: delta 受信ごとに最下部へスクロール。
  // 末尾 assistant message の content 長を依存に含めて、token 追加ごとに発火させる。
  const tail = messages[messages.length - 1];
  const scrollKey = useMemo(
    () =>
      `${messages.length}|${tail?.id ?? ''}|${tail?.content.length ?? 0}|${
        ctx?.awaitingFirstDelta ? '1' : '0'
      }`,
    [messages.length, tail?.id, tail?.content.length, ctx?.awaitingFirstDelta],
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [scrollKey, activeId]);

  if (messages.length === 0) {
    return (
      <div
        role="status"
        className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
      >
        <h2 className="text-lg font-medium text-foreground/90">{t('title')}</h2>
        <p className="max-w-md text-sm text-muted-foreground">{t('body')}</p>
        {ctx ? (
          <p
            data-testid="chat-empty-mock-hint"
            className="mt-2 max-w-md rounded border border-dashed border-border/60 bg-surface/40 px-3 py-2 text-xs text-muted-foreground"
          >
            {tChat('emptyMockHint')}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      className="flex-1 overflow-y-auto px-4 py-4"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        {messages.map((m) => (
          <MessageItem key={m.id} message={m} />
        ))}
        <TypingIndicator />
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
