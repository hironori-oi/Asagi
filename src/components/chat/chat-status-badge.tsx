'use client';

/**
 * ChatPane ヘッダ右肩に表示する Codex sidecar status バッジ (AS-144)。
 *
 * useCodex の `status` を参照し、idle/spawning/ready/streaming/error を
 * 小さい dot + label で表示する。`null` (Context 外) では何も描画しない。
 *
 * DEC-018-026 ① B: ヘッダ左にセッション累計 token 数を表示する
 * `ChatSessionTokenCount` をエクスポート。
 */

import { useTranslations } from 'next-intl';
import { useCodexContext } from './codex-context';
import { useChatStore } from '@/lib/stores/chat';
import { useProjectStore } from '@/lib/stores/project';
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

// AS-UX-03 / DEC-018-037 §②: 旧 ChatSidecarModeBadge は StatusBar
// (src/components/layout/status-bar.tsx) の SidecarModeBadge に移管した。

/**
 * DEC-018-026 ① B: セッション累計 token 数バッジ。
 * 0 token のときは何も描画しない（チャット未開始時のノイズ抑制）。
 */
export function ChatSessionTokenCount() {
  const t = useTranslations('chat');
  const activeId = useProjectStore((s) => s.activeProjectId);
  const total = useChatStore(
    (s) => s.tokensThisSessionByProject[activeId] ?? 0,
  );
  if (total <= 0) return null;
  return (
    <div
      data-testid="chat-session-tokens"
      data-tokens={total}
      className="rounded-full border border-border/60 bg-surface-elevated/60 px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground"
      title={t('tokensSession', { count: total })}
    >
      {t('tokensSession', { count: total })}
    </div>
  );
}
