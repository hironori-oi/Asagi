'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Trash2, Cpu, Keyboard, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * SlashPalette（AS-115）— textarea の上にフロート表示するスラッシュコマンドメニュー。
 *
 * v0.1.0 で動作するもの:
 *   - /clear: 現在セッションをクリア（実装は実際の onSelect コールバック側）
 *   - /model, /help, /config: 未実装トースト or help 表示
 *
 * - draft が `/` で始まるときに自動表示。
 * - ArrowUp/Down + Enter で選択（textarea 側のキーイベントを使う）。
 * - 表示は Sumi の SlashCommandMenu（PRJ-012）に倣う。
 */
export interface SlashPaletteItem {
  id: 'clear' | 'model' | 'help' | 'config';
  icon: typeof Trash2;
}

const ITEMS: SlashPaletteItem[] = [
  { id: 'clear', icon: Trash2 },
  { id: 'model', icon: Cpu },
  { id: 'help', icon: Keyboard },
  { id: 'config', icon: Settings },
];

interface SlashPaletteProps {
  query: string;
  /** active index を外部から制御するため、textarea 側で ArrowUp/Down を吸収する。 */
  selectedIndex: number;
  onHover: (index: number) => void;
  onSelect: (id: SlashPaletteItem['id']) => void;
}

export function SlashPalette({
  query,
  selectedIndex,
  onHover,
  onSelect,
}: SlashPaletteProps) {
  const t = useTranslations('slash');
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return ITEMS.filter((it) => it.id.startsWith(q));
  }, [query]);

  // 選択行が見えるようにスクロール
  useEffect(() => {
    const el = itemRefs.current[selectedIndex];
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (filtered.length === 0) {
    return (
      <div
        role="listbox"
        aria-label={t('placeholder')}
        className="absolute bottom-full left-0 right-0 mb-2 rounded-md border border-border bg-surface-elevated p-3 text-xs text-muted-foreground shadow-lg"
      >
        {t('empty')}
      </div>
    );
  }

  return (
    <div
      role="listbox"
      aria-label={t('placeholder')}
      className="absolute bottom-full left-0 right-0 mb-2 max-h-64 overflow-y-auto rounded-md border border-border bg-surface-elevated p-1 text-sm shadow-lg"
    >
      {filtered.map((item, i) => {
        const Icon = item.icon;
        const selected = i === selectedIndex;
        return (
          <button
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            key={item.id}
            type="button"
            role="option"
            aria-selected={selected}
            onMouseEnter={() => onHover(i)}
            onClick={() => onSelect(item.id)}
            className={cn(
              'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors duration-instant ease-out-expo',
              selected
                ? 'bg-accent/15 text-foreground'
                : 'text-muted-foreground hover:bg-surface'
            )}
          >
            <Icon strokeWidth={1.5} className="h-3.5 w-3.5" />
            <span className="font-mono text-xs text-foreground/80">/{item.id}</span>
            <span className="ml-2 flex-1 truncate text-xs">{t(`items.${item.id}`)}</span>
          </button>
        );
      })}
    </div>
  );
}

export const SLASH_ITEMS = ITEMS;
