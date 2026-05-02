'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BookOpen, RefreshCw } from 'lucide-react';
import { useProjectStore } from '@/lib/stores/project';
import { invoke } from '@/lib/tauri/invoke';
import { cn } from '@/lib/utils';

/**
 * Rules タブ — AS-UX-11.3 / DEC-018-040 ③。
 *
 * activeProject の cwd 直下を `list_dir` で読み、CLAUDE.md / AGENTS.md / CODEX.md
 * (case-insensitive) を抽出して表示する。Asagi 独自実装（DEC-018-008 = 兄弟プロダクト
 * との実装共有禁止に従い、構造・スタイルとも本ファイル内で完結）。`files-tab.tsx` の
 * shallow tree fetch + RefreshCw button + cleanup pattern を踏襲。
 *
 * v0.1.0 段階の挙動:
 *   - 検出時: BookOpen icon + ファイル名 + サイズ表示
 *   - 未検出時: 候補 3 件すべてに「未検出」placeholder を表示（旧 Inspector
 *     `tab-context.tsx` の dashed border 行と同等の視覚プロトコル）
 *   - クリック時: M3 AS-310 で Monaco editor 編集モード起動予定。M1 段階では noop
 *
 * 親ディレクトリ探索（claude-code-company root の CLAUDE.md など）は R-UX-11
 * として M3 AS-310 で評価。本実装は cwd 直下のみ。
 */
interface FsEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir' | 'symlink';
  size?: number | null;
}

const RULE_CANDIDATES = ['CLAUDE.md', 'AGENTS.md', 'CODEX.md'] as const;
type RuleCandidate = (typeof RULE_CANDIDATES)[number];

interface DetectedRule {
  candidate: RuleCandidate;
  entry: FsEntry | null;
}

function buildDetected(entries: FsEntry[]): DetectedRule[] {
  // case-insensitive lookup map（同名ファイルが複数ある場合は先勝ち）
  const byLower = new Map<string, FsEntry>();
  for (const e of entries) {
    if (e.kind !== 'file') continue;
    const key = e.name.toLowerCase();
    if (!byLower.has(key)) byLower.set(key, e);
  }
  return RULE_CANDIDATES.map((candidate) => ({
    candidate,
    entry: byLower.get(candidate.toLowerCase()) ?? null,
  }));
}

export function RulesTab() {
  const t = useTranslations('sidebar.rulesTab');
  const project = useProjectStore((s) =>
    s.projects.find((p) => p.id === s.activeProjectId),
  );
  const cwd = project?.path ?? '';

  const [detected, setDetected] = useState<DetectedRule[]>(() =>
    buildDetected([]),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!cwd) return;
    setLoading(true);
    try {
      const rows = await invoke<FsEntry[]>('list_dir', {
        args: { path: cwd, includeHidden: false },
      });
      setDetected(buildDetected(Array.isArray(rows) ? rows : []));
      setError(null);
    } catch (e) {
      // Tauri 非接続 (next dev only) では検出ロジックを fallback できないため
      // 全候補を「未検出」表示にして error メッセージのみ追加表示。
      setDetected(buildDetected([]));
      setError(typeof e === 'string' ? e : (e as Error)?.message ?? t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [cwd, t]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!cwd) return;
      setLoading(true);
      try {
        const rows = await invoke<FsEntry[]>('list_dir', {
          args: { path: cwd, includeHidden: false },
        });
        if (!cancelled) {
          setDetected(buildDetected(Array.isArray(rows) ? rows : []));
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setDetected(buildDetected([]));
          setError(
            typeof e === 'string' ? e : (e as Error)?.message ?? t('loadFailed'),
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, t]);

  const detectedCount = detected.filter((d) => d.entry != null).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h3
          className="truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
          title={cwd || t('subtitle')}
        >
          {t('title')}
        </h3>
        <button
          type="button"
          onClick={() => void refetch()}
          aria-label={t('refresh')}
          title={t('refresh')}
          data-testid="rules-refresh"
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
      <div
        className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3 text-xs"
        data-testid="rules-list"
      >
        <p className="text-[11px] text-muted-foreground/80">{t('subtitle')}</p>
        {error ? (
          <p
            className="rounded-md border border-dashed border-border p-2 text-[10px] text-muted-foreground/80"
            data-testid="rules-error"
          >
            {error}
          </p>
        ) : null}
        {detectedCount === 0 && !loading && !error ? (
          <p className="rounded-md border border-dashed border-border p-2 text-[10px] text-muted-foreground/80">
            {t('empty')}
          </p>
        ) : null}
        <ul className="flex flex-col gap-1.5">
          {detected.map(({ candidate, entry }) => {
            const present = entry != null;
            return (
              <li key={candidate}>
                <button
                  type="button"
                  // M3 AS-310 までクリックは noop。disabled 風 styling は付けず、
                  // 検出有無のテキスト差で状態を伝える。
                  data-testid={`rules-row-${candidate.toLowerCase()}`}
                  data-present={present ? 'true' : 'false'}
                  aria-label={
                    present
                      ? candidate
                      : `${candidate} (${t('notFound')})`
                  }
                  title={entry?.path ?? `${candidate} (${t('notFound')})`}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded-sm border border-dashed border-border px-3 py-2 text-left text-xs',
                    'transition-colors duration-fast ease-out-expo',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    present
                      ? 'border-solid text-foreground/90 hover:bg-surface-elevated'
                      : 'text-muted-foreground hover:bg-surface-elevated/40',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <BookOpen
                      strokeWidth={1.5}
                      className={cn(
                        'h-3.5 w-3.5 shrink-0',
                        present ? 'text-accent' : 'opacity-50',
                      )}
                    />
                    <span className="truncate font-mono">{candidate}</span>
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {present
                      ? entry && typeof entry.size === 'number'
                        ? `${entry.size} B`
                        : ''
                      : t('notFound')}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
