'use client';

import { useId, useRef, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { motion } from 'framer-motion';
import { MessageSquare, Folder, Activity } from 'lucide-react';
import { useUiStore, type SidebarTab } from '@/lib/stores/ui';
import { cn } from '@/lib/utils';
import { SessionsTab } from './sessions-tab';
import { FilesTab } from './files-tab';
import { RuntimeTab } from './runtime-tab';

/**
 * Sidebar — AS-UX-05 / DEC-018-037 §① 5-tab 化 第 1 弾。
 *
 * Sumi DEC-082 翻訳。
 * 上部に WAI-ARIA tablist（Sessions / Files / Runtime の 3 タブ）を配置し、
 * 各タブの中身を `<SessionsTab />` / `<FilesTab />` / `<RuntimeTab />` に切替表示する。
 *
 * - 折り畳み: `useUiStore.sidebarCollapsed` (Cmd+B でトグル) で 240px <-> 48px
 * - active tab persist: `useUiStore.sidebarActiveTab` を localStorage 永続化
 * - underline indicator: framer-motion `layoutId="sidebar-tab-indicator"` で滑らか移動
 *
 * keyboard navigation:
 *   - 左右矢印で tab 移動 (WAI-ARIA tab pattern)
 *   - Home / End で最初 / 最後の tab
 *   - Tab で tabpanel 内のフォーカスへ
 *
 * 残 2 タブ (Servers / Rules) は M1.1 (AS-UX-07/08 完了後) 評価。
 */
const TABS: ReadonlyArray<{
  id: SidebarTab;
  i18nKey: string;
  icon: typeof MessageSquare;
}> = [
  { id: 'sessions', i18nKey: 'tabs.sessions', icon: MessageSquare },
  { id: 'files', i18nKey: 'tabs.files', icon: Folder },
  { id: 'runtime', i18nKey: 'tabs.runtime', icon: Activity },
] as const;

export function Sidebar() {
  const t = useTranslations('sidebar');
  const activeTab = useUiStore((s) => s.sidebarActiveTab);
  const setActiveTab = useUiStore((s) => s.setSidebarActiveTab);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const tablistId = useId();
  const tabRefs = useRef<Record<SidebarTab, HTMLButtonElement | null>>({
    sessions: null,
    files: null,
    runtime: null,
  });

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const idx = TABS.findIndex((tt) => tt.id === activeTab);
    if (idx < 0) return;
    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % TABS.length;
    if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + TABS.length) % TABS.length;
    if (e.key === 'Home') nextIdx = 0;
    if (e.key === 'End') nextIdx = TABS.length - 1;
    if (nextIdx == null) return;
    e.preventDefault();
    const next = TABS[nextIdx]!;
    setActiveTab(next.id);
    // フォーカスも次タブに移す（WAI-ARIA tab pattern automatic activation）
    tabRefs.current[next.id]?.focus();
  };

  return (
    <aside
      aria-label={t('title')}
      data-testid="sidebar"
      data-collapsed={collapsed ? 'true' : 'false'}
      className={cn(
        'hidden shrink-0 flex-col border-r border-border bg-surface md:flex',
        'transition-[width] duration-base ease-out-expo',
        collapsed ? 'w-12' : 'w-60',
      )}
    >
      <div
        role="tablist"
        aria-label={t('tablistLabel')}
        aria-orientation={collapsed ? 'vertical' : 'horizontal'}
        data-testid="sidebar-tablist"
        className={cn(
          'relative flex shrink-0 border-b border-border',
          collapsed ? 'flex-col gap-1 px-1 py-2' : 'h-9 items-stretch',
        )}
      >
        {TABS.map((tab) => {
          const selected = tab.id === activeTab;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[tab.id] = el;
              }}
              role="tab"
              type="button"
              id={`${tablistId}-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${tablistId}-${tab.id}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={onKeyDown}
              data-testid={`sidebar-tab-${tab.id}`}
              title={t(tab.i18nKey)}
              className={cn(
                'relative flex items-center justify-center gap-1.5 text-xs',
                'transition-colors duration-fast ease-out-expo',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                collapsed
                  ? cn(
                      'h-9 w-full rounded-sm',
                      selected
                        ? 'text-accent'
                        : 'text-muted-foreground hover:bg-surface-elevated hover:text-foreground',
                    )
                  : cn(
                      'flex-1 px-2',
                      selected
                        ? 'text-accent'
                        : 'text-muted-foreground hover:bg-surface-elevated hover:text-foreground',
                    ),
              )}
            >
              <Icon strokeWidth={1.5} className="h-3.5 w-3.5" />
              {!collapsed ? <span>{t(tab.i18nKey)}</span> : null}
              {selected ? (
                <motion.span
                  aria-hidden
                  layoutId="sidebar-tab-indicator"
                  transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                  className={cn(
                    'absolute bg-accent',
                    collapsed
                      ? 'left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r'
                      : 'bottom-0 left-2 right-2 h-[2px] rounded-t',
                  )}
                />
              ) : null}
            </button>
          );
        })}
      </div>

      {/* tabpanel: collapsed 時はパネル本体を非表示にして 48px column を維持 */}
      {!collapsed ? (
        <div
          role="tabpanel"
          id={`${tablistId}-${activeTab}-panel`}
          aria-labelledby={`${tablistId}-${activeTab}`}
          data-testid={`sidebar-panel-${activeTab}`}
          className="min-h-0 flex-1"
        >
          {activeTab === 'sessions' ? <SessionsTab /> : null}
          {activeTab === 'files' ? <FilesTab /> : null}
          {activeTab === 'runtime' ? <RuntimeTab /> : null}
        </div>
      ) : null}
    </aside>
  );
}
