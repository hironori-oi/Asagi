'use client';

import { useEffect, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Send, Brain, Gauge } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useProjectStore } from '@/lib/stores/project';
import {
  useChatStore,
  CHAT_DEFAULT_MODEL,
  CHAT_DEFAULT_EFFORT,
  type ReasoningEffort,
} from '@/lib/stores/chat';
import { invoke } from '@/lib/tauri/invoke';
import { cn } from '@/lib/utils';

const FALLBACK_MODELS = ['gpt-5.5-codex', 'gpt-5-codex', 'o4-mini'];
const EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high'];

/**
 * 入力エリア — テキストエリア + 送信ボタン + モデル選択 + Reasoning effort。
 *
 * 仕様（v0.1.0）:
 *   - 送信時は appendUser → appendAssistantStub のみ（Codex CLI 統合は POC 通過後）
 *   - モデル一覧は Tauri command `codex_get_models` から取得（モック値返却）。
 *     dev サーバ単体（Tauri 非接続）では FALLBACK_MODELS にフォールバック。
 *   - Reasoning effort は design-brand-v1.md § 8.3 に準拠した 3 段セグメント。
 */
export function InputArea() {
  const t = useTranslations('chat');
  const activeId = useProjectStore((s) => s.activeProjectId);
  const draft = useChatStore((s) => s.inputDraftByProject[activeId] ?? '');
  const setDraft = useChatStore((s) => s.setInputDraft);
  const appendUser = useChatStore((s) => s.appendUser);
  const appendAssistantStub = useChatStore((s) => s.appendAssistantStub);
  const model = useChatStore((s) => s.modelByProject[activeId] ?? CHAT_DEFAULT_MODEL);
  const effort = useChatStore((s) => s.effortByProject[activeId] ?? CHAT_DEFAULT_EFFORT);
  const setModel = useChatStore((s) => s.setModel);
  const setEffort = useChatStore((s) => s.setEffort);

  const [models, setModels] = useState<string[]>(FALLBACK_MODELS);

  useEffect(() => {
    let cancelled = false;
    invoke<string[]>('codex_get_models')
      .then((list) => {
        if (!cancelled && Array.isArray(list) && list.length > 0) setModels(list);
      })
      .catch(() => {
        if (!cancelled) setModels(FALLBACK_MODELS);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const send = () => {
    const value = draft.trim();
    if (!value) return;
    appendUser(activeId, value);
    // モック応答。POC 通過後に invoke('agent_send_message', ...) + listen('agent:{id}:assistant_message_delta')
    setTimeout(() => appendAssistantStub(activeId), 200);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="border-t border-border bg-surface px-4 py-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <ModelSelect models={models} value={model} onChange={(v) => setModel(activeId, v)} t={t} />
          <EffortSelect value={effort} onChange={(v) => setEffort(activeId, v)} t={t} />
        </div>
        <div className="flex items-end gap-2 rounded-lg border border-border bg-surface-elevated p-2 focus-within:ring-2 focus-within:ring-ring">
          <textarea
            value={draft}
            onChange={(e) => setDraft(activeId, e.target.value)}
            onKeyDown={onKeyDown}
            aria-label={t('placeholder')}
            placeholder={t('placeholder')}
            rows={2}
            className="selectable min-h-[40px] flex-1 resize-none bg-transparent px-2 py-1 text-sm placeholder:text-muted-foreground focus-visible:outline-none"
          />
          <Button
            type="button"
            size="icon"
            onClick={send}
            disabled={draft.trim().length === 0}
            aria-label={t('send')}
            title={t('send')}
          >
            <Send strokeWidth={1.5} className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">{t('stub')}</p>
      </div>
    </div>
  );
}

interface ModelSelectProps {
  models: string[];
  value: string;
  onChange: (v: string) => void;
  t: (key: string) => string;
}

function ModelSelect({ models, value, onChange, t }: ModelSelectProps) {
  return (
    <label className="flex items-center gap-1.5 text-muted-foreground">
      <Brain strokeWidth={1.5} className="h-3.5 w-3.5" />
      <span>{t('model')}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-sm border border-border bg-surface px-1.5 py-0.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </label>
  );
}

interface EffortSelectProps {
  value: ReasoningEffort;
  onChange: (v: ReasoningEffort) => void;
  t: (key: string) => string;
}

function EffortSelect({ value, onChange, t }: EffortSelectProps) {
  return (
    <div className="flex items-center gap-1.5 text-muted-foreground">
      <Gauge strokeWidth={1.5} className="h-3.5 w-3.5" />
      <span>{t('effort.label')}:</span>
      <div role="radiogroup" aria-label={t('effort.label')} className="flex overflow-hidden rounded-sm border border-border">
        {EFFORTS.map((e) => {
          const selected = e === value;
          return (
            <button
              key={e}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(e)}
              className={cn(
                'px-2 py-0.5 text-xs transition-colors duration-instant ease-out-expo',
                selected
                  ? 'bg-accent/20 text-accent'
                  : 'bg-transparent text-muted-foreground hover:bg-surface-elevated'
              )}
            >
              {t(`effort.${e}`)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
