'use client';

import { useCallback } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useUiStore } from '@/lib/stores/ui';
import { KEYBINDINGS } from '@/lib/keybindings';

/**
 * グローバルキーバインドの装着（AS-121）。
 *
 * - ヘッドレスコンポーネント。AppShell に 1 つだけマウント。
 * - input/textarea にフォーカスがあっても発火するもの (mod+k / mod+/) と、
 *   フォーカス時は発火させないもの (mod+t / mod+n) を区別する。
 *
 * ESC は cmdk / vaul / Radix Dialog 側のフォーカストラップが個別にハンドリングするため
 * ここでは扱わない。
 */
export function GlobalKeybindings() {
  const toggleCommandPalette = useUiStore((s) => s.toggleCommandPalette);
  const setCommandPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const toggleHelp = useUiStore((s) => s.toggleHelp);
  const { setTheme, resolvedTheme } = useTheme();
  const tToast = useTranslations('toast');
  const tThemeOptions = useTranslations('settings.theme.options');

  const handleToggleTheme = useCallback(() => {
    const next = resolvedTheme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    toast.success(tToast('themeSwitched', { theme: tThemeOptions(next) }));
  }, [resolvedTheme, setTheme, tToast, tThemeOptions]);

  const handleNewSession = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('asagi:new-session'));
    }
  }, []);

  // CommandPalette: input にフォーカスがあっても発火させる。
  useHotkeys(
    KEYBINDINGS.commandPalette,
    (e) => {
      e.preventDefault();
      toggleCommandPalette();
    },
    { enableOnFormTags: true, enableOnContentEditable: true }
  );

  // Help: input にフォーカスがあっても発火させる（settings 画面外から呼べる必要があるため）。
  useHotkeys(
    KEYBINDINGS.showHelp,
    (e) => {
      e.preventDefault();
      // Help を開く前に CommandPalette は閉じる。
      setCommandPaletteOpen(false);
      toggleHelp();
    },
    { enableOnFormTags: true, enableOnContentEditable: true }
  );

  // テーマ切替: フォーカス中の textarea に文字を打ちたいので enableOnFormTags=false。
  useHotkeys(
    KEYBINDINGS.toggleTheme,
    (e) => {
      e.preventDefault();
      handleToggleTheme();
    },
    { enableOnFormTags: false }
  );

  // 新規セッション: 同上。
  useHotkeys(
    KEYBINDINGS.newSession,
    (e) => {
      e.preventDefault();
      handleNewSession();
    },
    { enableOnFormTags: false }
  );

  return null;
}
