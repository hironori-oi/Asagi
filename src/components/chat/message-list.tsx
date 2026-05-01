'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useChatStore } from '@/lib/stores/chat';
import { useProjectStore } from '@/lib/stores/project';
import { MessageItem } from './message-item';

/**
 * メッセージ一覧（スクロール）。
 *
 * - active project の messagesByProject[id] を購読
 * - 新規メッセージ追加時に自動スクロール（design-brand-v1.md § 6.3）
 * - 空状態は中央寄せのプレースホルダ
 */
export function MessageList() {
  const t = useTranslations('chat.empty');
  const activeId = useProjectStore((s) => s.activeProjectId);
  const messages = useChatStore((s) => s.messagesByProject[activeId] ?? []);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages.length, activeId]);

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <h2 className="text-lg font-medium text-foreground/90">{t('title')}</h2>
        <p className="max-w-md text-sm text-muted-foreground">{t('body')}</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        {messages.map((m) => (
          <MessageItem key={m.id} message={m} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
