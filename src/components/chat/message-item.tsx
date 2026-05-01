'use client';

import { motion } from 'framer-motion';
import { Bot, User, Wrench } from 'lucide-react';
import type { ChatMessage } from '@/lib/stores/chat';
import { cn } from '@/lib/utils';

interface MessageItemProps {
  message: ChatMessage;
}

const ROLE_ICON = {
  user: User,
  assistant: Bot,
  tool: Wrench,
} as const;

const ROLE_LABEL = {
  user: 'あなた',
  assistant: 'Codex',
  tool: 'ツール',
} as const;

/**
 * 1 メッセージ表示。
 *
 * design-brand-v1.md § 6.3「Chat メッセージ追加: 200ms slide-up + fade-in」に準拠。
 * tool ロールは accent でラベル装飾し、本文は muted カラム表示。
 */
export function MessageItem({ message }: MessageItemProps) {
  const Icon = ROLE_ICON[message.role];
  const label = ROLE_LABEL[message.role];
  const isAssistant = message.role === 'assistant';
  const isTool = message.role === 'tool';

  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        'flex gap-3 rounded-lg border border-border/40 p-3',
        isAssistant ? 'bg-surface/60' : 'bg-transparent',
        isTool && 'bg-surface-elevated/40'
      )}
    >
      <div
        aria-hidden
        className={cn(
          'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
          isAssistant
            ? 'bg-accent/15 text-accent'
            : isTool
            ? 'bg-warning/20 text-warning'
            : 'bg-surface-elevated text-foreground/80'
        )}
      >
        <Icon strokeWidth={1.5} className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="selectable whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/95">
          {message.content}
        </div>
      </div>
    </motion.article>
  );
}
