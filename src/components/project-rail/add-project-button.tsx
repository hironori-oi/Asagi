'use client';

import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

/**
 * `+` ボタン — 任意ディレクトリを追加するためのトリガ。
 *
 * v0.1.0 ではプレースホルダ。AS-112 で `@tauri-apps/plugin-dialog` の `open()` を
 * 呼び出して RegisteredProject を `useProjectStore.upsert()` する。
 */
export function AddProjectButton() {
  const t = useTranslations('rail');
  return (
    <button
      type="button"
      aria-label={t('addProject')}
      title={t('addDisabled')}
      disabled
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-full border border-dashed border-border-strong/60 text-muted-foreground',
        'transition-colors duration-fast ease-out-expo',
        'hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50'
      )}
    >
      <Plus strokeWidth={1.5} className="h-4 w-4" />
    </button>
  );
}
