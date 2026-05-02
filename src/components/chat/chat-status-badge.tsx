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
import { useSidecarModeStore } from '@/lib/stores/sidecar-mode';
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

/**
 * AS-144 / DEC-018-036: 現在の Sidecar mode を表示する小バッジ。
 *
 * - mode 未取得（起動直後 / refresh 失敗）時は何も描画しない（ノイズ抑制）
 * - mock: 中立色、real: アクセント色（浅葱）で UX 上「実 CLI 接続中」を強調
 * - 設定で切替可能なことは tooltip で明示
 */
export function ChatSidecarModeBadge() {
  const t = useTranslations('chat.modeBadge');
  const mode = useSidecarModeStore((s) => s.mode);
  if (!mode) return null;
  const isReal = mode === 'real';
  const label = t(mode);
  const tooltip = isReal ? t('tooltipReal') : t('tooltipMock');
  return (
    <div
      data-testid="chat-sidecar-mode-badge"
      data-mode={mode}
      title={tooltip}
      aria-label={tooltip}
      className={cn(
        'rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wider',
        isReal
          ? 'border-accent/60 bg-accent/15 text-foreground'
          : 'border-border/60 bg-surface-elevated/60 text-muted-foreground'
      )}
    >
      {label}
    </div>
  );
}

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
