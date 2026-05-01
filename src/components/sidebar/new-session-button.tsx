'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { invoke } from '@/lib/tauri/invoke';
import { useProjectStore } from '@/lib/stores/project';
import { useSessionStore } from '@/lib/stores/session';
import type { SessionRow } from '@/lib/tauri/types';
import { cn } from '@/lib/utils';

/**
 * 新規セッション作成ボタン（AS-117）。
 *
 * - Sidebar / CommandPalette / Ctrl+N から呼ばれる。
 * - SQLite に INSERT し、`useSessionStore` を更新して active を切替。
 * - Tauri 非接続環境（next dev 単体）ではローカル state のみ更新（フォールバック）。
 */
export function NewSessionButton() {
  const t = useTranslations('sidebar');
  const tToast = useTranslations('toast');
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const sessions = useSessionStore((s) => s.sessions);
  const setSessions = useSessionStore((s) => s.setSessions);
  const setActive = useSessionStore((s) => s.setActive);

  const create = useCallback(async () => {
    const now = new Date();
    const title = `${now.getMonth() + 1}/${now.getDate()} ${now
      .getHours()
      .toString()
      .padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    try {
      const id = await invoke<string>('create_session', {
        args: { title, projectId: activeProjectId },
      });
      const row: SessionRow = {
        id,
        title,
        project_id: activeProjectId,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      };
      setSessions([row, ...sessions]);
      setActive(id);
      toast.success(tToast('newSessionCreated'));
    } catch {
      // Fallback: Tauri 非接続環境（next dev only）でも UI を進められるよう、
      // ローカル ID で session を生やす。永続化は次回 Tauri 起動時にされない点に注意。
      const id = `local-${Date.now()}`;
      const row: SessionRow = {
        id,
        title,
        project_id: activeProjectId,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      };
      setSessions([row, ...sessions]);
      setActive(id);
      toast.success(tToast('newSessionCreated'));
    }
  }, [activeProjectId, sessions, setSessions, setActive, tToast]);

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
