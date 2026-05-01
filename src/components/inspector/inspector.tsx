'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { TabContext } from './tab-context';
import { TabSubAgents } from './tab-sub-agents';
import { TabTodos } from './tab-todos';
import { cn } from '@/lib/utils';

type InspectorTab = 'context' | 'subAgents' | 'todos';

const TAB_ORDER: InspectorTab[] = ['context', 'subAgents', 'todos'];

const TAB_PANEL: Record<InspectorTab, React.ComponentType> = {
  context: TabContext,
  subAgents: TabSubAgents,
  todos: TabTodos,
};

/**
 * Inspector ペイン — 320px、3 タブ切替（Context / SubAgents / Todos）。
 *
 * 設計参照: design-brand-v1.md § 5.1 / § 6.3
 *   - タブ切替アニメ: 150ms cross-fade
 *   - 内容はすべてプレースホルダ（POC 通過後 / M2 以降に本実装）
 */
export function Inspector() {
  const t = useTranslations('inspector');
  const tabsT = useTranslations('inspector.tabs');
  const [tab, setTab] = useState<InspectorTab>('context');
  const Panel = TAB_PANEL[tab];

  return (
    <aside
      aria-label={t('title')}
      className="hidden w-80 shrink-0 flex-col border-l border-border bg-surface lg:flex"
    >
      <header className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t('title')}
        </h2>
      </header>
      <nav role="tablist" aria-label={t('title')} className="flex shrink-0 border-b border-border">
        {TAB_ORDER.map((id) => {
          const selected = id === tab;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`inspector-panel-${id}`}
              onClick={() => setTab(id)}
              className={cn(
                'flex-1 px-3 py-2 text-xs transition-colors duration-fast ease-out-expo',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                selected
                  ? 'border-b-2 border-accent text-foreground'
                  : 'border-b-2 border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {tabsT(id)}
            </button>
          );
        })}
      </nav>
      <div
        role="tabpanel"
        id={`inspector-panel-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={tab}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="h-full"
          >
            <Panel />
          </motion.div>
        </AnimatePresence>
      </div>
    </aside>
  );
}
