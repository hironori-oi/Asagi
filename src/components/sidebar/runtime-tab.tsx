'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CircleDot, ListTodo, Gauge } from 'lucide-react';
import { useProjectStore } from '@/lib/stores/project';
import { invoke } from '@/lib/tauri/invoke';
import { cn } from '@/lib/utils';

/**
 * 実行状態 (Runtime) タブ（AS-UX-05 / DEC-018-037 §① / AS-UX-11.4 / DEC-018-040 ⑦）。
 *
 * v0.1.0 段階の表示要素:
 *   - SubAgents 相当: agent_list_sidecars の結果（active sidecar 一覧）
 *   - Quota 相当: codex_get_quota の簡易表示
 *   - Todos: M2 拡張用の placeholder
 *
 * 詳細な MultiSidecar 制御 UI は M2 AS-220 で本実装する。本タブは「現に動いている
 * sidecar が一目で見える」ことだけを目的とした最小実装。
 *
 * AS-UX-11.4 (Inspector 撤去) の責務統合:
 *   - 旧 Inspector の subAgents tab placeholder（M2 AS-220 以降）→ 本タブ subAgents
 *     セクションが既に同等の placeholder（noSubAgents + sidecar 一覧）を提供
 *   - 旧 Inspector の todos tab placeholder（M2 以降）→ 本タブ Todos セクションの
 *     todosM2 文言で同等表現
 *   - Inspector の context tab は Rules タブ (AS-UX-11.3) に分離
 *   - full-height flex 化: 既存の `flex h-full min-h-0 flex-col` 構造で tabpanel
 *     全高 scroll 動作する
 */
interface QuotaInfo {
  used: number;
  limit: number;
  plan: string;
}

export function RuntimeTab() {
  const t = useTranslations('sidebar.runtimeTab');

  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  const [sidecars, setSidecars] = useState<string[]>([]);
  const [quota, setQuota] = useState<QuotaInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<string[]>('agent_list_sidecars')
      .then((rows) => {
        if (!cancelled) setSidecars(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setSidecars([]);
      });
    invoke<QuotaInfo>('codex_get_quota')
      .then((q) => {
        if (!cancelled) setQuota(q);
      })
      .catch(() => {
        if (!cancelled) setQuota(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  const remainingPct =
    quota != null
      ? Math.max(0, Math.round(((quota.limit - quota.used) / quota.limit) * 100))
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {t('title')}
        </h3>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 text-xs" data-testid="runtime-list">
        {/* Sub-agents (active sidecars) */}
        <section>
          <h4 className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80">
            <CircleDot strokeWidth={1.5} className="h-3 w-3 text-accent" />
            {t('subAgents')}
          </h4>
          {sidecars.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-2 text-[11px] text-muted-foreground">
              {t('noSubAgents')}
            </p>
          ) : (
            <ul className="space-y-1">
              {sidecars.map((id) => (
                <li
                  key={id}
                  className={cn(
                    'flex items-center gap-1.5 rounded-sm px-2 py-1',
                    'text-foreground/85',
                    id === activeProjectId && 'bg-surface-elevated text-accent',
                  )}
                >
                  <span
                    aria-hidden
                    className="inline-block h-1.5 w-1.5 rounded-full bg-success"
                  />
                  <span className="truncate font-mono text-[10px]">{id}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Quota */}
        <section>
          <h4 className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80">
            <Gauge strokeWidth={1.5} className="h-3 w-3 text-accent" />
            {t('quota')}
          </h4>
          {quota == null || remainingPct == null ? (
            <p className="rounded-md border border-dashed border-border p-2 text-[11px] text-muted-foreground">
              {t('quotaUnknown')}
            </p>
          ) : (
            <div className="space-y-1">
              <p className="text-[11px] text-foreground/85">
                {quota.plan}: {remainingPct}% ({quota.used} / {quota.limit})
              </p>
              <span
                aria-hidden
                className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-elevated"
              >
                <span
                  className="block h-full rounded-full bg-accent transition-[width] duration-base ease-out-expo"
                  style={{ width: `${remainingPct}%` }}
                />
              </span>
            </div>
          )}
        </section>

        {/* Todos placeholder */}
        <section>
          <h4 className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80">
            <ListTodo strokeWidth={1.5} className="h-3 w-3 text-accent" />
            {t('todos')}
          </h4>
          <p className="rounded-md border border-dashed border-border p-2 text-[11px] text-muted-foreground">
            {t('todosM2')}
          </p>
        </section>
      </div>
    </div>
  );
}
