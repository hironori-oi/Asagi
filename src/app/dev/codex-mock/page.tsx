'use client';

/**
 * `/dev/codex-mock` — Codex sidecar mock 動作検証ページ (AS-135)。
 *
 * 本番 ChatPane とは独立。`ASAGI_SIDECAR_MODE=mock` (default) で
 * Codex CLI 不要のまま spawn / sendMessage / streaming / shutdown を確認できる。
 */

import { useState } from 'react';
import { useCodex } from '@/lib/codex/use-codex';

const DEFAULT_PROJECT_ID = 'dev-mock-project';

export default function CodexMockPage() {
  const [projectId, setProjectId] = useState(DEFAULT_PROJECT_ID);
  const codex = useCodex(projectId);
  const [draft, setDraft] = useState('');

  const onSend = async () => {
    if (!draft.trim()) return;
    const text = draft;
    setDraft('');
    await codex.sendMessage(text);
  };

  return (
    <main className="mx-auto max-w-3xl p-8 space-y-6 font-sans">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">Codex sidecar mock 検証</h1>
        <p className="text-sm text-neutral-500">
          AS-135 / DEC-018-022。OpenAI API には触れません。 mock mode で
          spawn → sendMessage → streaming → shutdown を確認します。
        </p>
      </header>

      <section className="space-y-2">
        <label className="block text-sm font-medium">project_id</label>
        <input
          className="w-full rounded border px-3 py-2 text-sm"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        />
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded bg-sky-600 px-4 py-2 text-sm text-white disabled:opacity-50"
            onClick={() => void codex.spawn()}
            disabled={codex.isReady}
          >
            spawn sidecar
          </button>
          <button
            type="button"
            className="rounded bg-neutral-700 px-4 py-2 text-sm text-white disabled:opacity-50"
            onClick={() => void codex.shutdown()}
            disabled={!codex.isReady}
          >
            shutdown
          </button>
          <button
            type="button"
            className="rounded border px-4 py-2 text-sm"
            onClick={() => codex.clear()}
          >
            clear messages
          </button>
        </div>
        <div className="text-xs text-neutral-500">
          status: {codex.isReady ? 'ready' : 'idle'}
          {codex.isStreaming ? ' (streaming...)' : ''}
        </div>
      </section>

      {codex.error ? (
        <div className="rounded border border-red-500 bg-red-50 p-3 text-sm text-red-700">
          error: {codex.error}
        </div>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">messages</h2>
        <ul className="space-y-2 rounded border p-4">
          {codex.messages.length === 0 ? (
            <li className="text-sm text-neutral-400">(no messages yet)</li>
          ) : (
            codex.messages.map((m) => (
              <li
                key={m.id}
                className={
                  m.role === 'user'
                    ? 'text-sm font-medium text-neutral-900'
                    : 'text-sm text-sky-800'
                }
              >
                <span className="mr-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs uppercase text-neutral-600">
                  {m.role}
                </span>
                {m.content}
                {m.streaming ? <span className="ml-1 animate-pulse">...</span> : null}
              </li>
            ))
          )}
        </ul>
      </section>

      <section className="space-y-2">
        <label className="block text-sm font-medium">message</label>
        <textarea
          className="w-full rounded border px-3 py-2 text-sm"
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="hello asagi..."
          disabled={!codex.isReady}
        />
        <button
          type="button"
          className="rounded bg-emerald-600 px-4 py-2 text-sm text-white disabled:opacity-50"
          onClick={() => void onSend()}
          disabled={!codex.isReady || codex.isStreaming || !draft.trim()}
        >
          send
        </button>
      </section>
    </main>
  );
}
