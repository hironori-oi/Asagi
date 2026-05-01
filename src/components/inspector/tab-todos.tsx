'use client';

import { useTranslations } from 'next-intl';
import { ListChecks } from 'lucide-react';

/**
 * Inspector「Todos」タブのプレースホルダ。
 * Codex が抽出した TODO 一覧を表示する（M2 以降）。
 */
export function TabTodos() {
  const t = useTranslations('inspector.todos');
  return (
    <div className="flex h-full flex-col gap-3 p-4 text-sm">
      <header className="flex items-center gap-2 text-muted-foreground">
        <ListChecks strokeWidth={1.5} className="h-4 w-4 text-accent" />
        <h3 className="text-xs font-medium uppercase tracking-wider">{t('title')}</h3>
      </header>
      <p className="text-xs text-muted-foreground">{t('body')}</p>
      <div className="rounded-sm border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
        実装予定
      </div>
    </div>
  );
}
