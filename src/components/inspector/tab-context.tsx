'use client';

import { useTranslations } from 'next-intl';
import { BookOpen } from 'lucide-react';

/**
 * Inspector「コンテキスト」タブのプレースホルダ。
 * M3 AS-301 で CLAUDE.md / AGENTS.md / CODEX.md などのコンテキストファイルを編集する Monaco を組み込む。
 */
export function TabContext() {
  const t = useTranslations('inspector.context');
  return (
    <div className="flex h-full flex-col gap-3 p-4 text-sm">
      <header className="flex items-center gap-2 text-muted-foreground">
        <BookOpen strokeWidth={1.5} className="h-4 w-4 text-accent" />
        <h3 className="text-xs font-medium uppercase tracking-wider">{t('title')}</h3>
      </header>
      <p className="text-xs text-muted-foreground">{t('body')}</p>
      <ul className="space-y-1.5">
        <PlaceholderRow name="CLAUDE.md" hint="未検出" />
        <PlaceholderRow name="AGENTS.md" hint="未検出" />
        <PlaceholderRow name="CODEX.md" hint="未検出" />
      </ul>
    </div>
  );
}

function PlaceholderRow({ name, hint }: { name: string; hint: string }) {
  return (
    <li className="flex items-center justify-between rounded-sm border border-dashed border-border px-3 py-2 text-xs">
      <span className="font-mono">{name}</span>
      <span className="text-muted-foreground">{hint}</span>
    </li>
  );
}
