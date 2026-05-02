'use client';

import { useTranslations } from 'next-intl';
import { SessionList } from './session-list';
import { NewSessionButton } from './new-session-button';

/**
 * Sessions タブ wrapper（AS-UX-05 / DEC-018-037 §①）。
 *
 * 既存 SessionList をそのまま新タブの中に配置する thin wrapper。
 * AS-UX-08 (M1.1) で context menu / pinned filter 等を追加する。
 */
export function SessionsTab() {
  const t = useTranslations('sidebar');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {t('title')}
        </h3>
        <NewSessionButton />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <SessionList />
      </div>
    </div>
  );
}
