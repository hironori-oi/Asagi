'use client';

/**
 * ChatPane ヘッダ右肩に表示する Codex sidecar status バッジ (AS-144)。
 *
 * useCodex の `status` を参照し、idle/spawning/ready/streaming/error を
 * 小さい dot + label で表示する。`null` (Context 外) では何も描画しない。
 */

import { useTranslations } from 'next-intl';
import { useCodexContext } from './codex-context';
import { cn } from '@/lib/utils';

const STATUS_DOT: Record<string, string> = {
  idle: 'bg-muted-foreground/40',
  spawning: 'bg-warning animate-pulse',
  ready: 'bg-success',
  streaming: 'bg-accent animate-pulse',
  error: 'bg-destructive',
};

export function ChatStatusBadge() {
  const ctx = useCodexContext();
  const t = useTranslations('chat.status');
  if (!ctx) return null;
  const dot = STATUS_DOT[ctx.status] ?? 'bg-muted-foreground/40';
  const label = (() => {
    try {
      return t(ctx.status);
    } catch {
      return ctx.status;
    }
  })();
  return (
    <div
      role="status"
      aria-label={`Codex ${ctx.status}`}
      data-testid="chat-status-badge"
      data-status={ctx.status}
      className="flex items-center gap-1.5 rounded-full border border-border/60 bg-surface-elevated/60 px-2 py-0.5 text-[11px] text-muted-foreground"
    >
      <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      <span>{label}</span>
    </div>
  );
}
