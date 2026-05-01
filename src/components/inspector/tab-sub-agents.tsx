'use client';

import { useTranslations } from 'next-intl';
import { Bot } from 'lucide-react';

/**
 * Inspector「SubAgents」タブのプレースホルダ。
 * Codex のサブエージェント呼出履歴を表示する（M2 AS-220 以降）。
 */
export function TabSubAgents() {
  const t = useTranslations('inspector.subAgents');
  return (
    <div className="flex h-full flex-col gap-3 p-4 text-sm">
      <header className="flex items-center gap-2 text-muted-foreground">
        <Bot strokeWidth={1.5} className="h-4 w-4 text-accent" />
        <h3 className="text-xs font-medium uppercase tracking-wider">{t('title')}</h3>
      </header>
      <p className="text-xs text-muted-foreground">{t('body')}</p>
      <div className="rounded-sm border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
        実装予定
      </div>
    </div>
  );
}
