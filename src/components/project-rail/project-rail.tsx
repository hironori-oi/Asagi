'use client';

import { Plus } from 'lucide-react';
import { useProjectStore } from '@/lib/stores/project';
import { cn } from '@/lib/utils';

/**
 * Slack 風 ProjectRail（48px 縦アイコン列）。
 * v0.1.0 では default project 1 件のみ表示。
 * M2 AS-201 で `+` ボタンによる任意ディレクトリ追加を実装。
 */
export function ProjectRail() {
  const { projects, activeProjectId, setActive } = useProjectStore();

  return (
    <nav
      aria-label="プロジェクト切替"
      className="flex h-full w-12 flex-col items-center gap-2 border-r border-border bg-surface py-3"
    >
      {projects.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => setActive(p.id)}
          aria-label={`プロジェクト: ${p.name}`}
          aria-current={p.id === activeProjectId}
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-md text-sm font-medium transition-colors duration-fast ease-out-expo',
            p.id === activeProjectId
              ? 'bg-accent text-accent-foreground ring-2 ring-accent/40'
              : 'bg-surface-elevated text-muted-foreground hover:bg-surface-elevated/80'
          )}
        >
          {p.name.charAt(0).toUpperCase()}
        </button>
      ))}
      <button
        type="button"
        aria-label="プロジェクトを追加（M2 で実装）"
        disabled
        className="mt-1 flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground opacity-40"
      >
        <Plus strokeWidth={1.5} className="h-4 w-4" />
      </button>
    </nav>
  );
}
