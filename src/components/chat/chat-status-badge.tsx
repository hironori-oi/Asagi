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
import { useSpawnRetry } from '@/lib/codex/use-spawn-retry';
import { useLazySpawn } from '@/lib/codex/use-lazy-spawn';
import { cn } from '@/lib/utils';

const STATUS_DOT: Record<string, string> = {
  idle: 'bg-muted-foreground/40',
  spawning: 'bg-warning animate-pulse',
  ready: 'bg-success',
  streaming: 'bg-accent animate-pulse',
  error: 'bg-destructive',
  // DEC-018-045 QW2 (AS-201.3): outer retry layer の overlay state
  retrying: 'bg-warning animate-pulse',
  spawn_failed: 'bg-destructive',
  // DEC-018-045 QW3 (AS-202.3): lazy spawn の overlay state
  lazy_spawning: 'bg-warning animate-pulse',
};

export function ChatStatusBadge() {
  const ctx = useCodexContext();
  const t = useTranslations('chat.status');
  const activeId = useProjectStore((s) => s.activeProjectId);
  const retry = useSpawnRetry(activeId);
  const lazy = useLazySpawn(activeId);
  if (!ctx) return null;

  // DEC-018-045 QW2/QW3 (AS-201.3 / AS-202.3): retry / lazy overlay
  // 優先度: spawn_failed > retrying > lazy_spawning > ctx.status
  // retry の方が深刻な状態（=明示 spawn の retry 失敗）なので最優先。
  // lazy は send 時の自動 fallback 進行中 — UI 上は黄色 dot で「自動再接続中」。
  const effectiveStatus: string = retry.isFailed
    ? 'spawn_failed'
    : retry.isRetrying
      ? 'retrying'
      : lazy.lazySpawning && (ctx.status === 'idle' || ctx.status === 'ready')
        ? 'lazy_spawning'
        : ctx.status;

  const dot = STATUS_DOT[effectiveStatus] ?? 'bg-muted-foreground/40';
  const label = (() => {
    if (effectiveStatus === 'retrying' && retry.attempt > 0) {
      try {
        return t('retrying', {
          attempt: retry.attempt,
          max: retry.maxRetries,
        });
      } catch {
        return `Retrying (${retry.attempt}/${retry.maxRetries})`;
      }
    }
    if (effectiveStatus === 'spawn_failed') {
      try {
        return t('spawn_failed');
      } catch {
        return 'Connect failed';
      }
    }
    if (effectiveStatus === 'lazy_spawning') {
      try {
        return t('lazy_spawning');
      } catch {
        return 'Auto-reconnecting…';
      }
    }
    try {
      return t(ctx.status);
    } catch {
      return ctx.status;
    }
  })();

  // Tooltip: retry 中は last_error を、lazy_spawning 中は reason を載せる
  const title =
    effectiveStatus === 'spawn_failed' || effectiveStatus === 'retrying'
      ? (retry.lastError ?? label)
      : effectiveStatus === 'lazy_spawning'
        ? (lazy.lazyReason ?? label)
        : label;

  return (
    <div
      role="status"
      aria-live={
        effectiveStatus === 'retrying' || effectiveStatus === 'lazy_spawning'
          ? 'polite'
          : undefined
      }
      aria-label={`Codex ${effectiveStatus}`}
      data-testid="chat-status-badge"
      data-status={effectiveStatus}
      data-retry-attempt={retry.attempt || undefined}
      data-lazy-spawning={lazy.lazySpawning ? 'true' : undefined}
      title={title}
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
