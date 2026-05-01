'use client';

import { useTranslations } from 'next-intl';
import { SessionList } from './session-list';
import { NewSessionButton } from './new-session-button';

/**
 * 240px 固定幅の Sidebar（AS-117）。
 *
 * - 上: タイトル + 新規セッションボタン
 * - 下: SessionList（SQLite から hydration、Tauri 非接続時は空状態 / fallback）
 *
 * 設計参照: design-brand-v1.md § 5.1 Sidebar
 */
export function Sidebar() {
  const t = useTranslations('sidebar');

  return (
    <aside
      aria-label={t('title')}
      className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface md:flex"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t('title')}
        </h2>
        <NewSessionButton />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <SessionList />
      </div>
    </aside>
  );
}
