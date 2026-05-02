'use client';

/**
 * Typing indicator (DEC-018-026 ① A)。
 *
 * ChatPane の MessageList 末尾に inline placeholder bubble として表示する
 * 「Asagi が考えています…」インジケータ。
 *
 * 表示条件 (CodexContext 経由):
 *   - status が `streaming`
 *   - かつ `awaitingFirstDelta` が true（最初の delta が来ていない）
 *
 * ChatStatusBadge と二重表示にならないよう、badge は header、
 * indicator は MessageList 末尾と役割分離する。
 *
 * アニメーションは pure CSS の `animate-bounce` を 3 dot に時差適用。
 */

import { useTranslations } from 'next-intl';
import { Bot } from 'lucide-react';
import { useCodexContext } from './codex-context';
import { cn } from '@/lib/utils';

export function TypingIndicator() {
  const ctx = useCodexContext();
  const t = useTranslations('chat');
  if (!ctx) return null;
  const visible = ctx.status === 'streaming' && ctx.awaitingFirstDelta;
  if (!visible) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="chat-typing-indicator"
      className={cn(
        'flex gap-3 rounded-lg border border-border/40 bg-surface/60 p-3',
      )}
    >
      <div
        aria-hidden
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent"
      >
        <Bot strokeWidth={1.5} className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
          Codex
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>{t('thinking')}</span>
          <span aria-hidden className="inline-flex items-end gap-0.5 leading-none">
            <span
              className="h-1 w-1 rounded-full bg-muted-foreground/70 animate-bounce"
              style={{ animationDelay: '0ms', animationDuration: '900ms' }}
            />
            <span
              className="h-1 w-1 rounded-full bg-muted-foreground/70 animate-bounce"
              style={{ animationDelay: '150ms', animationDuration: '900ms' }}
            />
            <span
              className="h-1 w-1 rounded-full bg-muted-foreground/70 animate-bounce"
              style={{ animationDelay: '300ms', animationDuration: '900ms' }}
            />
          </span>
        </div>
      </div>
    </div>
  );
}
