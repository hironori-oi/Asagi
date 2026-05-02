'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { File, Folder, RefreshCw } from 'lucide-react';
import { useProjectStore } from '@/lib/stores/project';
import { invoke } from '@/lib/tauri/invoke';
import { cn } from '@/lib/utils';

/**
 * Files タブ（AS-UX-05 / DEC-018-037 §①）。
 *
 * activeProject の cwd 直下を shallow tree（深さ 1）で一覧する。
 * 再帰展開・glob filter・検索は AS-UX-07 (M1.1) で react-arborist 導入時に対応。
 *
 * Tauri 非接続環境（next dev only）では `list_dir` invoke が reject されるため、
 * ダミーエントリを fallback 表示してレイアウト確認を可能にする。
 */
interface FsEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir' | 'symlink';
  size?: number | null;
}

const FALLBACK_ENTRIES: FsEntry[] = [
  { name: 'src', path: '/(fallback)/src', kind: 'dir' },
  { name: 'package.json', path: '/(fallback)/package.json', kind: 'file', size: 1234 },
  { name: 'README.md', path: '/(fallback)/README.md', kind: 'file', size: 567 },
];

export function FilesTab() {
  const t = useTranslations('sidebar.filesTab');
  const project = useProjectStore((s) =>
    s.projects.find((p) => p.id === s.activeProjectId),
  );
  const cwd = project?.path ?? '';

  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!cwd) return;
    setLoading(true);
    try {
      const rows = await invoke<FsEntry[]>('list_dir', {
        args: { path: cwd, includeHidden: false },
      });
      setEntries(rows);
      setError(null);
    } catch (e) {
      // dev サーバ単体（Tauri 非接続）。fallback でレイアウト確認可能にする。
      setEntries(FALLBACK_ENTRIES);
      setError(typeof e === 'string' ? e : (e as Error)?.message ?? t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [cwd, t]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h3
          className="truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
          title={cwd}
        >
          {t('title')}
        </h3>
        <button
          type="button"
          onClick={() => void refetch()}
          aria-label={t('refresh')}
          title={t('refresh')}
          data-testid="files-refresh"
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-sm border border-border text-muted-foreground',
            'transition-colors duration-fast ease-out-expo',
            'hover:bg-surface-elevated hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <RefreshCw
            strokeWidth={1.5}
            className={cn('h-3.5 w-3.5', loading && 'animate-spin')}
          />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2" data-testid="files-list">
        {error ? (
          <p className="rounded-md border border-dashed border-border p-2 text-[10px] text-muted-foreground/80">
            {error}
          </p>
        ) : null}
        {entries.length === 0 && !loading ? (
          <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
            {t('empty')}
          </p>
        ) : null}
        <ul className="flex flex-col gap-0.5 pt-1">
          {entries.map((e) => (
            <li key={e.path}>
              <button
                type="button"
                title={e.path}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-xs',
                  'text-foreground/85 transition-colors duration-fast ease-out-expo',
                  'hover:bg-surface-elevated focus-visible:outline-none focus-visible:bg-surface-elevated',
                )}
              >
                {e.kind === 'dir' ? (
                  <Folder strokeWidth={1.5} className="h-3.5 w-3.5 text-accent" />
                ) : (
                  <File strokeWidth={1.5} className="h-3.5 w-3.5 opacity-70" />
                )}
                <span className="truncate">{e.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
