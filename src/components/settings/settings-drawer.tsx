'use client';

import { Drawer } from 'vaul';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import { X, Sun, Moon, Monitor, Languages, Keyboard } from 'lucide-react';
import { useUiStore } from '@/lib/stores/ui';
import { useLocaleStore, type Locale, SUPPORTED_LOCALES } from '@/lib/stores/locale';
import { KEYBINDINGS, formatHotkey } from '@/lib/keybindings';
import { cn } from '@/lib/utils';

type ThemeOption = 'light' | 'dark' | 'system';
const THEME_OPTIONS: ThemeOption[] = ['light', 'dark', 'system'];
const THEME_ICON: Record<ThemeOption, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

/**
 * 設定ドロワー（AS-118 / AS-120）。vaul Drawer を使用。
 *
 * v0.1.0 で扱う設定:
 *   - テーマ（light / dark / system）
 *   - 言語（ja / en）
 *   - キーバインド一覧（読み取り専用）
 *
 * グローバル state は `useUiStore.settingsOpen` で管理（CommandPalette からも開ける）。
 */
export function SettingsDrawer() {
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);

  const t = useTranslations('settings');
  const tToast = useTranslations('toast');
  const tHelp = useTranslations('help.shortcuts');
  const tThemeOptions = useTranslations('settings.theme.options');
  const tLocaleOptions = useTranslations('settings.locale.options');

  const { theme, setTheme } = useTheme();
  const { locale, setLocale } = useLocaleStore();

  const handleTheme = (value: ThemeOption) => {
    setTheme(value);
    toast.success(tToast('themeSwitched', { theme: tThemeOptions(value) }));
  };

  const handleLocale = (value: Locale) => {
    setLocale(value);
    toast.success(tToast('localeSwitched', { locale: tLocaleOptions(value) }));
  };

  return (
    <Drawer.Root open={open} onOpenChange={setOpen} direction="right">
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" />
        <Drawer.Content
          className={cn(
            'fixed right-0 top-0 z-50 flex h-full w-[420px] max-w-[100vw] flex-col',
            'border-l border-border bg-surface text-foreground shadow-2xl shadow-black/40',
            'focus:outline-none'
          )}
          aria-describedby={undefined}
        >
          <Drawer.Title className="sr-only">{t('title')}</Drawer.Title>
          <Drawer.Description className="sr-only">{t('subtitle')}</Drawer.Description>
          <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
              <p className="text-xs text-muted-foreground">{t('subtitle')}</p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t('close')}
              className="flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition-colors duration-fast ease-out-expo hover:bg-surface-elevated hover:text-foreground"
            >
              <X strokeWidth={1.5} className="h-4 w-4" />
            </button>
          </header>
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
            <section>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {t('sections.appearance')}
              </h3>
              <div className="grid grid-cols-3 gap-2">
                {THEME_OPTIONS.map((opt) => {
                  const Icon = THEME_ICON[opt];
                  const selected = theme === opt;
                  return (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => handleTheme(opt)}
                      aria-pressed={selected}
                      className={cn(
                        'flex flex-col items-center gap-1.5 rounded-md border px-2 py-3 text-xs transition-colors duration-fast ease-out-expo',
                        selected
                          ? 'border-accent bg-accent/10 text-foreground'
                          : 'border-border text-muted-foreground hover:bg-surface-elevated'
                      )}
                    >
                      <Icon strokeWidth={1.5} className="h-4 w-4" />
                      <span>{tThemeOptions(opt)}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {t('sections.language')}
              </h3>
              <div className="flex items-center gap-2">
                <Languages strokeWidth={1.5} className="h-4 w-4 text-muted-foreground" />
                <div role="radiogroup" className="flex flex-1 overflow-hidden rounded-md border border-border">
                  {SUPPORTED_LOCALES.map((opt) => {
                    const selected = locale === opt;
                    return (
                      <button
                        key={opt}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => handleLocale(opt)}
                        className={cn(
                          'flex-1 px-3 py-1.5 text-xs transition-colors duration-fast ease-out-expo',
                          selected
                            ? 'bg-accent/15 text-foreground'
                            : 'text-muted-foreground hover:bg-surface-elevated'
                        )}
                      >
                        {tLocaleOptions(opt)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>

            <section>
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <Keyboard strokeWidth={1.5} className="h-3.5 w-3.5" />
                {t('sections.shortcuts')}
              </h3>
              <ul className="space-y-1 rounded-md border border-border bg-surface-elevated p-2 text-xs">
                <ShortcutRow label={tHelp('commandPalette')} keys={KEYBINDINGS.commandPalette} />
                <ShortcutRow label={tHelp('newSession')} keys={KEYBINDINGS.newSession} />
                <ShortcutRow label={tHelp('toggleTheme')} keys={KEYBINDINGS.toggleTheme} />
                <ShortcutRow label={tHelp('showHelp')} keys={KEYBINDINGS.showHelp} />
                <ShortcutRow label={tHelp('escape')} keys={KEYBINDINGS.escape} />
              </ul>
            </section>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

interface ShortcutRowProps {
  label: string;
  keys: string;
}
function ShortcutRow({ label, keys }: ShortcutRowProps) {
  return (
    <li className="flex items-center justify-between gap-2 px-1 py-1">
      <span className="text-foreground/85">{label}</span>
      <kbd className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
        {formatHotkey(keys)}
      </kbd>
    </li>
  );
}
