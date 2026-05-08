'use client';

import { useCallback, useMemo } from 'react';
import { Command } from 'cmdk';
// AS-CLEAN-22: Radix Dialog (cmdk transitive dep) から DialogTitle のみ使用。
// cmdk 1.0.4 は内部で Radix DialogContent を使うが Title 要素を露出しない。
// `<DialogTitle>` を sr-only でレンダリングして screen reader 向け a11y を満たす。
import { DialogTitle } from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import { Search } from 'lucide-react';
import { useUiStore } from '@/lib/stores/ui';
import { useLocaleStore } from '@/lib/stores/locale';
import { useChatStore } from '@/lib/stores/chat';
import { useProjectStore } from '@/lib/stores/project';
import { formatHotkey } from '@/lib/keybindings';
import { cn } from '@/lib/utils';
import {
  COMMAND_GROUP_ORDER,
  COMMAND_ITEMS,
  type CommandActionId,
  type CommandGroup,
  type CommandItem,
} from './command-items';

/**
 * グローバル CommandPalette（AS-114）。
 *
 * - cmdk + sonner toast でモック動作。Ctrl+K で開閉。
 * - 各コマンドの実体は `runAction()` で dispatch。未実装は toast で通知。
 * - Open 状態は `useUiStore.commandPaletteOpen`（react-hotkeys-hook 側からも開ける）
 *
 * 設計参照: design-brand-v1.md § 6.4 Command Palette / § 8.4
 */
export function CommandPalette() {
  const open = useUiStore((s) => s.commandPaletteOpen);
  const setOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const setHelpOpen = useUiStore((s) => s.setHelpOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);

  const t = useTranslations('command');
  const tToast = useTranslations('toast');
  const tSettings = useTranslations('settings.theme.options');
  const tLocale = useTranslations('settings.locale.options');

  const { setTheme, resolvedTheme } = useTheme();
  const { locale, setLocale } = useLocaleStore();
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const clearChat = useChatStore((s) => s.clear);

  /** 1 アクションの実体。未実装はトーストで「未実装」を通知。 */
  const runAction = useCallback(
    (id: CommandActionId) => {
      setOpen(false);
      switch (id) {
        case 'toggleTheme': {
          const next = resolvedTheme === 'dark' ? 'light' : 'dark';
          setTheme(next);
          toast.success(tToast('themeSwitched', { theme: tSettings(next) }));
          break;
        }
        case 'switchLocale': {
          const next = locale === 'ja' ? 'en' : 'ja';
          setLocale(next);
          toast.success(tToast('localeSwitched', { locale: tLocale(next) }));
          break;
        }
        case 'clearChat': {
          clearChat(activeProjectId);
          toast.success(tToast('newSessionCreated'));
          break;
        }
        case 'newSession': {
          // SessionList 側で listen/dispatch するため CustomEvent でブロードキャスト
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('asagi:new-session'));
          }
          break;
        }
        case 'openSettings':
          setSettingsOpen(true);
          break;
        case 'showHelp':
          setHelpOpen(true);
          break;
        case 'switchProject':
        case 'selectModel':
          toast.message(tToast('comingSoon'));
          break;
      }
    },
    [
      setOpen,
      resolvedTheme,
      setTheme,
      tToast,
      tSettings,
      locale,
      setLocale,
      tLocale,
      clearChat,
      activeProjectId,
      setSettingsOpen,
      setHelpOpen,
    ]
  );

  /** グループ別のアイテム配列。 */
  const grouped = useMemo(() => {
    const map = new Map<CommandGroup, CommandItem[]>();
    for (const g of COMMAND_GROUP_ORDER) map.set(g, []);
    for (const item of COMMAND_ITEMS) map.get(item.group)?.push(item);
    return map;
  }, []);

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label={t('placeholder')}
      className={cn(
        // overlay は内部で position: fixed; inset: 0 を当てるが、cmdk は overlay 自体を持たない。
        // 自前で overlay を被せる。
        'fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'
      )}
      overlayClassName="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
      contentClassName={cn(
        'relative z-50 w-full max-w-[640px] overflow-hidden rounded-xl border border-border bg-surface-elevated text-foreground',
        'shadow-2xl shadow-black/40',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95'
      )}
    >
      {/*
       * AS-CLEAN-22: Radix Dialog は DialogContent 直下に Dialog.Title 要素が
       * 存在することを前提に screen reader 用 aria-labelledby を組み立てる。
       * `label` prop は aria-label fallback だが、Radix 1.x はそれでも
       * 「DialogContent requires a DialogTitle for the component to be
       * accessible for screen reader users.」という console.error を吐く。
       * sr-only クラスで視覚的に隠したまま DialogTitle を提供して解消する。
       */}
      <DialogTitle className="sr-only">{t('placeholder')}</DialogTitle>
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search strokeWidth={1.5} className="h-4 w-4 text-muted-foreground" />
        <Command.Input
          placeholder={t('placeholder')}
          className={cn(
            'flex h-11 w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground',
            'focus:outline-none disabled:cursor-not-allowed disabled:opacity-50'
          )}
        />
      </div>
      <Command.List className="max-h-[400px] overflow-y-auto p-2">
        <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
          {t('empty')}
        </Command.Empty>
        {COMMAND_GROUP_ORDER.map((group) => {
          const items = grouped.get(group) ?? [];
          if (items.length === 0) return null;
          return (
            <Command.Group
              key={group}
              heading={t(`groups.${group}`)}
              className={cn(
                '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5',
                '[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium',
                '[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider',
                '[&_[cmdk-group-heading]]:text-muted-foreground'
              )}
            >
              {items.map((item) => {
                const Icon = item.icon;
                return (
                  <Command.Item
                    key={item.id}
                    value={`${item.id} ${t(`items.${item.id}`)} ${t(
                      `hints.${item.id}`
                    )}`}
                    onSelect={() => runAction(item.id)}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                      'transition-colors duration-instant ease-out-expo',
                      'aria-selected:bg-accent/15 aria-selected:text-foreground',
                      'data-[selected=true]:bg-accent/15 data-[selected=true]:text-foreground'
                    )}
                  >
                    <Icon
                      strokeWidth={1.5}
                      className="h-4 w-4 text-muted-foreground"
                    />
                    <span className="flex-1">{t(`items.${item.id}`)}</span>
                    <span className="hidden text-xs text-muted-foreground sm:inline">
                      {t(`hints.${item.id}`)}
                    </span>
                    {item.shortcut ? (
                      <kbd className="ml-2 rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {formatHotkey(item.shortcut)}
                      </kbd>
                    ) : null}
                  </Command.Item>
                );
              })}
            </Command.Group>
          );
        })}
      </Command.List>
    </Command.Dialog>
  );
}
