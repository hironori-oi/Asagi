'use client';

import { useEffect, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Send, Square } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useProjectStore } from '@/lib/stores/project';
import { useSessionStore } from '@/lib/stores/session';
import { useUiStore } from '@/lib/stores/ui';
import { useChatStore } from '@/lib/stores/chat';
import { invoke } from '@/lib/tauri/invoke';
import { SLASH_ITEMS, SlashPalette, type SlashPaletteItem } from './slash-palette';
import { useCodexContext } from './codex-context';

/**
 * 入力エリア（AS-115 / AS-117 / AS-120 / AS-144 / AS-UX-02）。
 *
 * - 送信時: ChatPane が提供する `CodexContext.send()` に委譲する。
 *   ChatPane 側で appendUser → SQLite create_message (user) → useCodex.sendMessage を順に実行する。
 * - Context が無い場合 (legacy mount) は従来のスタブ応答にフォールバック。
 * - draft が `/` で始まると SlashPalette を表示。Enter で実行。
 *
 * AS-UX-02 / DEC-018-037 §②: Model / Effort picker は TrayBar に移管済み。
 * 本コンポーネントは textarea + send / interrupt のみのシンプル構成にする。
 */
export function InputArea() {
  const t = useTranslations('chat');
  const tSlash = useTranslations('slash');

  const activeId = useProjectStore((s) => s.activeProjectId);
  const draft = useChatStore((s) => s.inputDraftByProject[activeId] ?? '');
  const setDraft = useChatStore((s) => s.setInputDraft);
  const appendUser = useChatStore((s) => s.appendUser);
  const appendAssistantStub = useChatStore((s) => s.appendAssistantStub);
  const clearChat = useChatStore((s) => s.clear);

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setHelpOpen = useUiStore((s) => s.setHelpOpen);
  const codexCtx = useCodexContext();

  // SlashPalette
  const showSlash = draft.startsWith('/') && !draft.includes('\n');
  const slashQuery = showSlash ? draft.slice(1).trim() : '';
  const [slashIndex, setSlashIndex] = useState(0);

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  /** SlashPalette からのコマンド実行。 */
  const runSlash = (id: SlashPaletteItem['id']) => {
    setDraft(activeId, '');
    if (id === 'clear') {
      clearChat(activeId);
      toast.success(t('clearedToast'));
      return;
    }
    if (id === 'help') {
      setHelpOpen(true);
      return;
    }
    // model / config は未実装。
    toast.message(tSlash('notImplementedToast', { cmd: `/${id}` }));
  };

  const send = async () => {
    const value = draft.trim();
    if (!value) return;
    setDraft(activeId, '');

    // AS-144: ChatPane が CodexContext.send を提供している場合はそちらに委譲する。
    if (codexCtx) {
      await codexCtx.send(value);
      return;
    }

    // ---- legacy fallback (Context 外で InputArea を直接使うテスト等) ----
    appendUser(activeId, value);
    if (activeSessionId) {
      try {
        await invoke<string>('create_message', {
          args: { sessionId: activeSessionId, role: 'user', content: value },
        });
      } catch {
        toast.error(t('saveFailed'));
      }
    }
    setTimeout(async () => {
      const stub = '[stub] Codex 統合は POC 通過後に実装';
      appendAssistantStub(activeId);
      if (activeSessionId) {
        try {
          await invoke<string>('create_message', {
            args: { sessionId: activeSessionId, role: 'assistant', content: stub },
          });
        } catch {
          // 既に user 側で toast 出ているので再表示は省略。
        }
      }
    }, 200);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlash) {
      const filtered = SLASH_ITEMS.filter((it) => it.id.startsWith(slashQuery.toLowerCase()));
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (filtered.length === 0 ? 0 : (i + 1) % filtered.length));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) =>
          filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length
        );
        return;
      }
      // SlashPalette が開いている時は Enter (without modifier) で実行する。
      // これは通常のチャット送信規約 (Cmd/Ctrl+Enter) より優先する。
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        const target = filtered[slashIndex];
        if (target) runSlash(target.id);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDraft(activeId, '');
        return;
      }
    }
    // DEC-018-026 ① D: Cmd/Ctrl+Enter で送信、素の Enter は改行（macOS 慣用 + Slack/Discord 互換）。
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="border-t border-border bg-surface px-4 py-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        <div className="relative">
          {showSlash && (
            <SlashPalette
              query={slashQuery}
              selectedIndex={slashIndex}
              onHover={setSlashIndex}
              onSelect={runSlash}
            />
          )}
          <div className="flex items-end gap-2 rounded-lg border border-border bg-surface-elevated p-2 focus-within:ring-2 focus-within:ring-ring">
            <textarea
              value={draft}
              onChange={(e) => setDraft(activeId, e.target.value)}
              onKeyDown={onKeyDown}
              aria-label={t('placeholder')}
              placeholder={t('placeholder')}
              rows={2}
              data-testid="chat-input-textarea"
              className="selectable min-h-[40px] flex-1 resize-none bg-transparent px-2 py-1 text-sm placeholder:text-muted-foreground focus-visible:outline-none"
            />
            {codexCtx?.isStreaming ? (
              <Button
                type="button"
                size="icon"
                variant="outline"
                onClick={() => void codexCtx.interrupt()}
                aria-label={t('interrupt')}
                title={t('interrupt')}
                data-testid="chat-interrupt-button"
              >
                <Square strokeWidth={1.5} className="h-4 w-4" />
              </Button>
            ) : null}
            <Button
              type="button"
              size="icon"
              onClick={() => void send()}
              disabled={
                draft.trim().length === 0 ||
                (codexCtx ? codexCtx.isStreaming : false)
              }
              aria-label={t('send')}
              title={t('send')}
              data-testid="chat-send-button"
            >
              <Send strokeWidth={1.5} className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {/* AS-CLEAN-12 (DEC-018-043): Phase 0 POC 通過後も残存していた `[stub] Codex 統合は POC 通過後に実装` */}
        {/* ヒントを M1 Real impl 進行に伴い削除。i18n の `chat.stub` キーも併せて撤去。 */}
      </div>
    </div>
  );
}

// AS-UX-02: ModelSelect / EffortSelect は TrayBar (src/components/layout/tray-bar.tsx) に移管。
