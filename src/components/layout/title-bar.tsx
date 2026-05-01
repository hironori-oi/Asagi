'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { Minus, Square, X, Sun, Moon, Settings } from 'lucide-react';
import { useProjectStore } from '@/lib/stores/project';
import { useUiStore } from '@/lib/stores/ui';
import { cn } from '@/lib/utils';

/**
 * TitleBar — 36px 高、Tauri カスタム window controls 想定。
 *
 * AS-108 / AS-116 / AS-118 / AS-120:
 *   - 左: Asagi ロゴ + アプリ名 + active project
 *   - 中央: drag region（透過）
 *   - 右: テーマ切替（mod+t）/ 設定 / minimize / maximize / close
 *
 * data-tauri-drag-region により WebView 全体をドラッグ可能化（macOS / Win 共通）。
 */
export function TitleBar() {
  const t = useTranslations('shell.titlebar');
  const projects = useProjectStore((s) => s.projects);
  const activeId = useProjectStore((s) => s.activeProjectId);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const active = projects.find((p) => p.id === activeId);

  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isDark = mounted ? resolvedTheme === 'dark' : true;

  const toggleTheme = () => setTheme(isDark ? 'light' : 'dark');

  return (
    <header
      data-tauri-drag-region
      className={cn(
        'flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface px-3',
        'select-none text-xs text-muted-foreground'
      )}
    >
      <div className="flex items-center gap-2" data-tauri-drag-region>
        <span
          aria-hidden
          className="flex h-5 w-5 items-center justify-center rounded-sm bg-accent text-[10px] font-semibold text-accent-foreground"
        >
          A
        </span>
        <span className="font-medium text-foreground">{t('appName')}</span>
        <span className="text-muted-foreground/60">/</span>
        <span className="truncate text-foreground/80">
          {active ? active.title : t('noProject')}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <TitleBarButton
          label={t('themeToggle')}
          onClick={toggleTheme}
          icon={isDark ? Sun : Moon}
        />
        <TitleBarButton
          label={t('settings')}
          onClick={() => setSettingsOpen(true)}
          icon={Settings}
        />
        <span className="mx-1 h-3 w-px bg-border" aria-hidden />
        <WindowControl label={t('minimize')} icon={Minus} />
        <WindowControl label={t('maximize')} icon={Square} />
        <WindowControl label={t('close')} icon={X} variant="destructive" />
      </div>
    </header>
  );
}

interface TitleBarButtonProps {
  label: string;
  onClick: () => void;
  icon: typeof Minus;
}

function TitleBarButton({ label, onClick, icon: Icon }: TitleBarButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded-sm transition-colors duration-fast ease-out-expo',
        'text-muted-foreground hover:bg-surface-elevated hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
    >
      <Icon strokeWidth={1.5} className="h-3.5 w-3.5" />
    </button>
  );
}

interface WindowControlProps {
  label: string;
  icon: typeof Minus;
  variant?: 'default' | 'destructive';
}

function WindowControl({ label, icon: Icon, variant = 'default' }: WindowControlProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'flex h-6 w-7 items-center justify-center rounded-sm transition-colors duration-fast ease-out-expo',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        variant === 'destructive'
          ? 'hover:bg-destructive hover:text-destructive-foreground'
          : 'hover:bg-surface-elevated'
      )}
      onClick={() => {
        // TODO(v0.2): @tauri-apps/api/window で minimize / toggleMaximize / close
      }}
    >
      <Icon strokeWidth={1.5} className="h-3 w-3" />
    </button>
  );
}
