'use client';

import { useId, useRef, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { motion } from 'framer-motion';
import { MessageSquare, Folder, BookOpen, Activity } from 'lucide-react';
import { useUiStore, type SidebarTab } from '@/lib/stores/ui';
import { cn } from '@/lib/utils';
import { SessionsTab } from './sessions-tab';
import { FilesTab } from './files-tab';
import { RuntimeTab } from './runtime-tab';

/**
 * Sidebar — AS-UX-05 / AS-UX-11 / DEC-018-040 4-tab 化（Sessions/Files/Rules/Runtime）。
 *
 * Sumi DEC-082 翻訳 + Sumi v3.5.3 の右 Inspector 撤去パターン継承。
 * 上部に WAI-ARIA tablist を配置し、各タブの中身を
 * `<SessionsTab />` / `<FilesTab />` / `<RulesTab />` / `<RuntimeTab />` に切替表示する。
 *
 * - 折り畳み: `useUiStore.sidebarCollapsed` (Cmd+B でトグル) で 256px <-> 48px
 * - active tab persist: `useUiStore.sidebarActiveTab` を localStorage 永続化
 * - underline indicator: framer-motion `layoutId="sidebar-tab-indicator"` で滑らか移動
 *
 * keyboard navigation:
 *   - 左右矢印で tab 移動 (WAI-ARIA tab pattern)
 *   - Home / End で最初 / 最後の tab
 *   - Tab で tabpanel 内のフォーカスへ
 *
 * width / nowrap 仕様 (DEC-018-040 ④, Bug B 解消の核心):
 *   - Sidebar 親 `w-64` (256px) 固定 — Wave 1 の `w-60` (240px) + 3 タブ折返しを根本解消
 *   - 各 `<button role="tab">` に `whitespace-nowrap` 適用、icon `h-3 w-3` + padding `px-1.5`
 *     で 4 タブ全件 1 行表示を物理保証（最長 4 字「セッション」も収まる）
 *
 * RulesTab は AS-UX-11.3 commit で実装。本 commit (11.2) では panel 分岐に
 * `null` を入れて 4 タブ枠だけ整備する。
 */
const TABS: ReadonlyArray<{
  id: SidebarTab;
  i18nKey: string;
  icon: typeof MessageSquare;
}> = [
  { id: 'sessions', i18nKey: 'tabs.sessions', icon: MessageSquare },
  { id: 'files', i18nKey: 'tabs.files', icon: Folder },
  { id: 'rules', i18nKey: 'tabs.rules', icon: BookOpen },
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
    rules: null,
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
        collapsed ? 'w-12' : 'w-64',
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
                'relative flex items-center justify-center gap-1 whitespace-nowrap text-xs',
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
                      'flex-1 px-1.5',
                      selected
                        ? 'text-accent'
                        : 'text-muted-foreground hover:bg-surface-elevated hover:text-foreground',
                    ),
              )}
            >
              <Icon strokeWidth={1.5} className="h-3 w-3" />
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
                      : 'bottom-0 left-1.5 right-1.5 h-[2px] rounded-t',
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
          {/* Rules タブの中身は AS-UX-11.3 commit で <RulesTab /> として実装 */}
          {activeTab === 'rules' ? null : null}
          {activeTab === 'runtime' ? <RuntimeTab /> : null}
        </div>
      ) : null}
    </aside>
  );
}
