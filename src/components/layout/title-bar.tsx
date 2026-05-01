'use client';

import { useTranslations } from 'next-intl';
import { Minus, Square, X } from 'lucide-react';
import { useProjectStore } from '@/lib/stores/project';
import { cn } from '@/lib/utils';

/**
 * TitleBar — 36px 高、Tauri カスタム window controls 想定。
 *
 * design-brand-v1.md § 5.1 / § 8 に基づき:
 *   - 左: Asagi ロゴ + アプリ名
 *   - 中央: アクティブプロジェクト名
 *   - 右: ウィンドウ操作（最小化 / 最大化 / 閉じる）
 *
 * data-tauri-drag-region により WebView 全体をドラッグ可能化（macOS / Win 共通）。
 * Tauri ウィンドウ API 呼出は v0.2 で接続予定（現状はクリックで no-op）。
 */
export function TitleBar() {
  const t = useTranslations('shell.titlebar');
  const projects = useProjectStore((s) => s.projects);
  const activeId = useProjectStore((s) => s.activeProjectId);
  const active = projects.find((p) => p.id === activeId);

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
        <WindowControl label={t('minimize')} icon={Minus} />
        <WindowControl label={t('maximize')} icon={Square} />
        <WindowControl
          label={t('close')}
          icon={X}
          variant="destructive"
        />
      </div>
    </header>
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
      className={cn(
        'flex h-6 w-7 items-center justify-center rounded-sm transition-colors duration-fast ease-out-expo',
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
