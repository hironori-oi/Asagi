'use client';

import { useTranslations } from 'next-intl';
import { MessageSquare } from 'lucide-react';
import type { SessionRow } from '@/lib/tauri/types';
import { cn } from '@/lib/utils';

interface SessionItemProps {
  session: SessionRow;
  active: boolean;
  messageCount?: number;
  onSelect: (id: string) => void;
}

/**
 * 1 セッション行（AS-117）。タイトル + メッセージ件数 + 経過時間。
 * 横幅 240px の Sidebar にフィットする tight なレイアウト。
 */
export function SessionItem({ session, active, messageCount, onSelect }: SessionItemProps) {
  const t = useTranslations('sidebar');
  const title = session.title.trim() || t('untitled');

  return (
    <button
      type="button"
      onClick={() => onSelect(session.id)}
      aria-current={active}
      className={cn(
        'group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm',
        'transition-colors duration-fast ease-out-expo',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'bg-accent/15 text-foreground'
          : 'text-muted-foreground hover:bg-surface-elevated hover:text-foreground'
      )}
    >
      <MessageSquare
        strokeWidth={1.5}
        className={cn(
          'mt-0.5 h-3.5 w-3.5 shrink-0',
          active ? 'text-accent' : 'text-muted-foreground/70'
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs font-medium">{title}</span>
        {messageCount !== undefined && messageCount > 0 ? (
          <span className="truncate text-[10px] text-muted-foreground">
            {t('messageCount', { count: messageCount })}
          </span>
        ) : null}
      </div>
    </button>
  );
}
