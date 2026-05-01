'use client';

import { useState, type KeyboardEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { MessageCircle, Send, User, Bot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface SampleMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Welcome Step 3: サンプル体験（AS-119）。
 *
 * 旧 step-permissions を差し替え。
 * Tauri / Codex 統合一切なしで、入力 → モック応答のミニチャットを動かし、
 * Asagi の操作感を初回起動時に体験させる。
 *
 * 仕様:
 *   - 入力 → 送信で「あなた」のメッセージを追加
 *   - 250ms 後に固定スタブ応答を返す
 *   - メッセージは framer-motion で fade-in（design-brand-v1.md § 6.3）
 */
export function StepSample() {
  const t = useTranslations('welcome.sample');
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<SampleMessage[]>([]);
  const [counter, setCounter] = useState(0);

  const send = () => {
    const value = draft.trim();
    if (!value) return;
    const userMsg: SampleMessage = { id: counter, role: 'user', content: value };
    const assistantMsg: SampleMessage = {
      id: counter + 1,
      role: 'assistant',
      content: t('stubResponse'),
    };
    setMessages((prev) => [...prev, userMsg]);
    setDraft('');
    setCounter((c) => c + 2);
    setTimeout(() => {
      setMessages((prev) => [...prev, assistantMsg]);
    }, 250);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center gap-3">
        <div
          aria-hidden
          className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-elevated text-accent"
        >
          <MessageCircle strokeWidth={1.5} className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
      </div>

      <p className="text-md leading-relaxed text-foreground/90">{t('body')}</p>

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
        <div className="flex max-h-56 min-h-[120px] flex-col gap-2 overflow-y-auto pr-1">
          <AnimatePresence initial={false}>
            {messages.map((m) => (
              <motion.div
                key={m.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                className={cn(
                  'flex items-start gap-2 rounded-md p-2 text-sm',
                  m.role === 'user'
                    ? 'bg-surface-elevated text-foreground'
                    : 'bg-accent/10 text-foreground/90'
                )}
              >
                {m.role === 'user' ? (
                  <User strokeWidth={1.5} className="mt-0.5 h-4 w-4 text-muted-foreground" />
                ) : (
                  <Bot strokeWidth={1.5} className="mt-0.5 h-4 w-4 text-accent" />
                )}
                <div className="flex-1">
                  <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    {m.role === 'user' ? t('you') : t('codex')}
                  </p>
                  <p className="mt-0.5 leading-relaxed">{m.content}</p>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
        <div className="flex items-center gap-2 rounded-md border border-border bg-surface-elevated p-1.5 focus-within:ring-2 focus-within:ring-ring">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('placeholder')}
            aria-label={t('placeholder')}
            className="flex-1 bg-transparent px-2 py-1 text-sm placeholder:text-muted-foreground focus-visible:outline-none"
          />
          <Button
            type="button"
            size="sm"
            onClick={send}
            disabled={draft.trim().length === 0}
            aria-label={t('send')}
          >
            <Send strokeWidth={1.5} className="h-3.5 w-3.5" />
            {t('send')}
          </Button>
        </div>
      </div>
    </section>
  );
}
