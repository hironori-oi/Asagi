'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Cpu, Gauge, GitBranch, BatteryMedium } from 'lucide-react';
import { useProjectStore } from '@/lib/stores/project';
import { useChatStore, CHAT_DEFAULT_MODEL } from '@/lib/stores/chat';
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
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground/60">{t('stub')}</span>
        <QuotaGauge quota={quota} remainingPct={remainingPct} tone={quotaTone} planLabel={t('quota')} />
      </div>
    </footer>
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
