'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * 新規セッション作成ボタン（AS-117）。
 *
 * AS-HOTFIX-QW7 (DEC-018-048 候補): create ロジックを `SessionList` の
 * `asagi:new-session` listener に統合した（旧来は + ボタンのみ機能し、
 * Ctrl+N と CommandPalette は silent failure だった）。本コンポーネントは
 * 同一イベントを発火するだけの薄いラッパに簡略化。3 導線が同一経路を通るため
 * セッション名の auto-title 形式（M/D HH:MM）も常に揃う。
 *
 * - Sidebar の + ボタンから呼ばれる。
 * - CustomEvent `asagi:new-session` を window に dispatch する。
 * - 実際の create_session 呼び出し / store 更新 / toast は SessionList 側で実施。
 */
export function NewSessionButton() {
  const t = useTranslations('sidebar');

  const create = useCallback(() => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('asagi:new-session'));
  }, []);

  return (
    <button
      type="button"
      onClick={create}
      aria-label={t('newSession')}
      title={t('newSession')}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded-sm border border-border text-muted-foreground',
        'transition-colors duration-fast ease-out-expo',
        'hover:bg-surface-elevated hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
    >
      <Plus strokeWidth={1.5} className="h-3.5 w-3.5" />
    </button>
  );
}
