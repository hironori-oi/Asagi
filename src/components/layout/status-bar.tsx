'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Cpu, Gauge, GitBranch, BatteryMedium, FlaskConical, PlugZap, Activity } from 'lucide-react';
import { useProjectStore } from '@/lib/stores/project';
import { useChatStore, CHAT_DEFAULT_MODEL } from '@/lib/stores/chat';
import { useSidecarModeStore } from '@/lib/stores/sidecar-mode';
import {
  useChatActivityStore,
  type ChatActivityState,
} from '@/lib/stores/chat-activity';
import { invoke } from '@/lib/tauri/invoke';
import { cn } from '@/lib/utils';

/**
 * StatusBar — 28px 高、design-brand-v1.md § 5.1 / § 8.2 に準拠。
 *
 * 表示項目（v0.1.0）:
 *   - モデル名（chat store から）
 *   - context 使用率（モック 0%、後で Codex sidecar の context.size 通知から算出）
 *   - git branch（v0.1.0 では「未取得」固定、M3 で `git status` 連携）
 *   - Codex プラン残枠（モック）— `codex_get_quota` Tauri command（モック値返却）から取得
 */
interface QuotaInfo {
  used: number;
  limit: number;
  plan: string;
}

export function StatusBar() {
  const t = useTranslations('shell.statusbar');
  const activeId = useProjectStore((s) => s.activeProjectId);
  const model = useChatStore((s) => s.modelByProject[activeId] ?? CHAT_DEFAULT_MODEL);

  const [quota, setQuota] = useState<QuotaInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<QuotaInfo>('codex_get_quota')
      .then((q) => {
        if (!cancelled) setQuota(q);
      })
      .catch(() => {
        // Tauri 非接続環境（next dev のみ）では fallback モック値を表示。
        if (!cancelled) setQuota({ used: 42, limit: 500, plan: 'Pro 5x' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const remainingPct = quota ? Math.max(0, Math.round(((quota.limit - quota.used) / quota.limit) * 100)) : 100;
  const quotaTone =
    remainingPct < 5 ? 'text-destructive' : remainingPct < 20 ? 'text-warning' : 'text-foreground/80';

  return (
    <footer
      className={cn(
        'flex h-7 shrink-0 items-center justify-between border-t border-border bg-surface px-3',
        'text-[11px] text-muted-foreground'
      )}
    >
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1.5">
          <Cpu strokeWidth={1.5} className="h-3 w-3 text-accent" />
          <span className="text-muted-foreground">{t('model')}:</span>
          <span className="text-foreground/80">{model}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <Gauge strokeWidth={1.5} className="h-3 w-3" />
          <span className="text-muted-foreground">{t('context')}:</span>
          <span className="text-foreground/80">0%</span>
        </span>
        <span className="flex items-center gap-1.5">
          <GitBranch strokeWidth={1.5} className="h-3 w-3" />
          <span className="text-muted-foreground">{t('branch')}:</span>
          <span className="text-foreground/80">{t('branchUnknown')}</span>
        </span>
      </div>
      <ActivitySummary />
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground/60">{t('stub')}</span>
        <SidecarModeBadge />
        <QuotaGauge quota={quota} remainingPct={remainingPct} tone={quotaTone} planLabel={t('quota')} />
      </div>
    </footer>
  );
}

/**
 * AS-UX-04 / DEC-018-037 §②: 中央に置く Activity summary。
 * useChatActivityStore.stateByProject[activeProjectId] を購読し、
 * thinking / streaming のときだけ pulse + label を出す。idle / completed /
 * error は控えめ表示（idle は何も出さない、error は赤 dot）。
 */
function ActivitySummary() {
  const t = useTranslations('shell.statusbar.activity');
  const activeId = useProjectStore((s) => s.activeProjectId);
  const state = useChatActivityStore(
    (s) => s.stateByProject[activeId] ?? 'idle',
  );
  if (state === 'idle') {
    // 静音モード: 何も出さない（StatusBar を埋め過ぎない）
    return <span data-testid="status-activity" data-state="idle" aria-hidden />;
  }
  const tone = ACTIVITY_TONE[state];
  const label = (() => {
    try {
      return t(state);
    } catch {
      return state;
    }
  })();
  const animated = state === 'thinking' || state === 'streaming';
  return (
    <span
      data-testid="status-activity"
      data-state={state}
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-center gap-1.5 rounded-full px-2 py-[1px] text-[11px]',
        tone,
      )}
    >
      <Activity
        strokeWidth={1.75}
        className={cn('h-3 w-3', animated && 'animate-pulse')}
      />
      <span>{label}</span>
    </span>
  );
}

const ACTIVITY_TONE: Record<ChatActivityState, string> = {
  idle: 'text-muted-foreground/60',
  thinking: 'text-warning',
  streaming: 'text-accent',
  completed: 'text-success',
  error: 'text-destructive',
};

/**
 * AS-UX-03 / DEC-018-037 §②: ChatPane header から StatusBar 右側へ移設した
 * Sidecar Mode badge。FlaskConical (mock) / PlugZap (real) icon + 略号で
 * 28px bar に収まるサイズに調整。tooltip は従来通り `chat.modeBadge.tooltip*`。
 */
function SidecarModeBadge() {
  const t = useTranslations('chat.modeBadge');
  const mode = useSidecarModeStore((s) => s.mode);
  if (!mode) return null;
  const isReal = mode === 'real';
  const Icon = isReal ? PlugZap : FlaskConical;
  const tooltip = isReal ? t('tooltipReal') : t('tooltipMock');
  return (
    <span
      data-testid="status-sidecar-mode-badge"
      data-mode={mode}
      title={tooltip}
      aria-label={tooltip}
      className={cn(
        'flex items-center gap-1 rounded-full border px-1.5 py-[1px] text-[10px] font-medium tracking-wider',
        isReal
          ? 'border-accent/60 bg-accent/15 text-foreground'
          : 'border-border/60 bg-surface-elevated/60 text-muted-foreground',
      )}
    >
      <Icon strokeWidth={1.5} className="h-3 w-3" />
      <span>{t(mode)}</span>
    </span>
  );
}

interface QuotaGaugeProps {
  quota: QuotaInfo | null;
  remainingPct: number;
  tone: string;
  planLabel: string;
}

function QuotaGauge({ quota, remainingPct, tone, planLabel }: QuotaGaugeProps) {
  if (!quota) {
    return (
      <span className="flex items-center gap-1.5">
        <BatteryMedium strokeWidth={1.5} className="h-3 w-3" />
        <span>{planLabel}: --</span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2" title={`${quota.used} / ${quota.limit} (${quota.plan})`}>
      <BatteryMedium strokeWidth={1.5} className={cn('h-3 w-3', tone)} />
      <span className={tone}>
        {quota.plan}: {remainingPct}%
      </span>
      <span
        aria-hidden
        className="relative inline-block h-1.5 w-16 overflow-hidden rounded-full bg-surface-elevated"
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-base ease-out-expo"
          style={{ width: `${remainingPct}%` }}
        />
      </span>
    </span>
  );
}
