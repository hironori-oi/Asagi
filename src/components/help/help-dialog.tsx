'use client';

import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { X, Keyboard, CornerDownLeft } from 'lucide-react';
import { useUiStore } from '@/lib/stores/ui';
import { KEYBINDINGS, formatHotkey } from '@/lib/keybindings';
import { cn } from '@/lib/utils';

/**
 * Help モーダル（AS-121 / AS-120）。キーバインド一覧を表示。
 *
 * 自前のオーバーレイ + framer-motion fade/scale。
 * Esc / 背景クリックで閉じる。fixed inset-0 で z-50。
 */
export function HelpDialog() {
  const open = useUiStore((s) => s.helpOpen);
  const setOpen = useUiStore((s) => s.setHelpOpen);

  const t = useTranslations('help');
  const tShortcuts = useTranslations('help.shortcuts');

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50">
          <motion.div
            key="overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <motion.div
            key="content"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-dialog-title"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              'absolute left-1/2 top-[18vh] -translate-x-1/2',
              'flex w-full max-w-[520px] flex-col overflow-hidden rounded-xl border border-border bg-surface-elevated text-foreground shadow-2xl shadow-black/40'
            )}
          >
            <header className="flex items-start justify-between border-b border-border px-4 py-3">
              <div className="flex items-start gap-3">
                <Keyboard strokeWidth={1.5} className="mt-0.5 h-5 w-5 text-accent" />
                <div>
                  <h2
                    id="help-dialog-title"
                    className="text-sm font-semibold text-foreground"
                  >
                    {t('title')}
                  </h2>
                  <p className="text-xs text-muted-foreground">{t('subtitle')}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t('close')}
                className="flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition-colors duration-fast ease-out-expo hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X strokeWidth={1.5} className="h-4 w-4" />
              </button>
            </header>
            <ul className="space-y-1 px-4 py-4 text-sm">
              <Row label={tShortcuts('commandPalette')} keys={KEYBINDINGS.commandPalette} />
              <Row label={tShortcuts('newSession')} keys={KEYBINDINGS.newSession} />
              <Row label={tShortcuts('toggleTheme')} keys={KEYBINDINGS.toggleTheme} />
              <Row label={tShortcuts('showHelp')} keys={KEYBINDINGS.showHelp} />
              <Row label={tShortcuts('escape')} keys={KEYBINDINGS.escape} />
              <RowLiteral label={tShortcuts('submit')} display="Enter" icon={CornerDownLeft} />
              <RowLiteral label={tShortcuts('newline')} display="Shift + Enter" />
            </ul>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

interface RowProps {
  label: string;
  keys: string;
}
function Row({ label, keys }: RowProps) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-surface">
      <span className="text-foreground/90">{label}</span>
      <kbd className="rounded border border-border bg-surface px-2 py-0.5 font-mono text-xs text-muted-foreground">
        {formatHotkey(keys)}
      </kbd>
    </li>
  );
}

interface RowLiteralProps {
  label: string;
  display: string;
  icon?: typeof CornerDownLeft;
}
function RowLiteral({ label, display, icon: Icon }: RowLiteralProps) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-surface">
      <span className="text-foreground/90">{label}</span>
      <kbd className="flex items-center gap-1 rounded border border-border bg-surface px-2 py-0.5 font-mono text-xs text-muted-foreground">
        {Icon ? <Icon strokeWidth={1.5} className="h-3 w-3" /> : null}
        {display}
      </kbd>
    </li>
  );
}
