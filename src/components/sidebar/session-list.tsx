'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { invoke } from '@/lib/tauri/invoke';
import { useProjectStore } from '@/lib/stores/project';
import { useSessionStore } from '@/lib/stores/session';
import { useChatStore, type ChatMessage } from '@/lib/stores/chat';
import type { MessageRow, SessionRow } from '@/lib/tauri/types';
import { SessionItem } from './session-item';

/**
 * SessionList（AS-117）。
 *
 * - active project が変わるたびに `list_sessions({ projectId })` を invoke
 * - active session が変わるたびに `list_messages({ sessionId })` を invoke して chat store に hydrate
 * - Tauri 非接続環境では空 list を表示してフォールバック
 *
 * 注: window CustomEvent 'asagi:new-session' を listen し、
 *     CommandPalette / 全体ショートカット (Ctrl+N) からの新規作成イベントを受けて refetch する。
 */
export function SessionList() {
  const t = useTranslations('sidebar');
  const tToast = useTranslations('toast');

  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const sessions = useSessionStore((s) => s.sessions);
  const setSessions = useSessionStore((s) => s.setSessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActive);

  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const rows = await invoke<SessionRow[]>('list_sessions', {
        args: { projectId: activeProjectId },
      });
      setSessions(rows);
      setError(null);
    } catch (e) {
      // dev サーバ単体（Tauri 非接続）では DB 未接続エラーになる。
      // UI を白ブランクにせずプレースホルダを表示する。
      setError(t('loadFailed'));
      setSessions([]);
    }
  }, [activeProjectId, setSessions, t]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // CommandPalette / Ctrl+N 経由の新規作成シグナル受信。
  //
  // AS-HOTFIX-QW7 (DEC-018-048 候補): 旧実装は `refetch` だけ呼んでいたため、
  // CommandPalette と Ctrl+N から「新規セッション」を実行しても **何も起きない**
  // バグが残っていた（Owner 5/9 smoke 報告 ①「セッション名の設定が出てこない」の
  // 真因）。NewSessionButton はインライン create を持つため + ボタン経由のみ動作
  // していた。ここで listener を「実際に create_session を呼ぶ」実装に揃え、
  // 3 つの導線（+ ボタン / Ctrl+N / CommandPalette）を 1 経路に統合する。
  // NewSessionButton 側はイベント発火に切替えるため、ここで二重生成は起きない。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onNew = () => {
      void (async () => {
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
          setSessions([row, ...useSessionStore.getState().sessions]);
          setActiveSession(id);
          toast.success(tToast('newSessionCreated'));
        } catch {
          // Tauri 非接続環境（next dev 単体）では DB 接続無し → fallback
          const id = `local-${Date.now()}`;
          const row: SessionRow = {
            id,
            title,
            project_id: activeProjectId,
            created_at: now.toISOString(),
            updated_at: now.toISOString(),
          };
          setSessions([row, ...useSessionStore.getState().sessions]);
          setActiveSession(id);
          toast.success(tToast('newSessionCreated'));
        }
      })();
    };
    window.addEventListener('asagi:new-session', onNew);
    return () => window.removeEventListener('asagi:new-session', onNew);
  }, [activeProjectId, setSessions, setActiveSession, tToast]);

  // active session が変わるたびに messages を chat store に hydrate
  useEffect(() => {
    if (!activeSessionId) return;
    let cancelled = false;
    invoke<MessageRow[]>('list_messages', {
      args: { sessionId: activeSessionId },
    })
      .then((rows) => {
        if (cancelled) return;
        const mapped: ChatMessage[] = rows.map((r) => ({
          id: r.id,
          role: (r.role === 'user' || r.role === 'assistant'
            ? r.role
            : 'tool') as ChatMessage['role'],
          content: r.content,
          createdAt: Date.parse(r.created_at) || Date.now(),
        }));
        useChatStore.setState((s) => ({
          messagesByProject: {
            ...s.messagesByProject,
            [activeProjectId]: mapped,
          },
        }));
      })
      .catch(() => {
        // ignore: Tauri 非接続環境
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, activeProjectId]);

  // active project が切替わったが activeSessionId 未設定の場合、最新セッションを自動選択
  useEffect(() => {
    if (!activeSessionId && sessions[0]) {
      setActiveSession(sessions[0].id);
    }
  }, [activeSessionId, sessions, setActiveSession]);

  if (error) {
    return (
      <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
        {error}
      </p>
    );
  }

  if (sessions.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
        {t('empty')}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {sessions.map((session) => (
        <li key={session.id}>
          <SessionItem
            session={session}
            active={session.id === activeSessionId}
            onSelect={setActiveSession}
          />
        </li>
      ))}
    </ul>
  );
}
