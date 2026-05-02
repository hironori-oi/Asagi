'use client';

import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { useProjectStore, PROJECT_COLORS, type RegisteredProject } from '@/lib/stores/project';
import {
  useChatActivityStore,
  type ChatActivityState,
} from '@/lib/stores/chat-activity';
import { cn } from '@/lib/utils';

interface ProjectIconProps {
  project: RegisteredProject;
}

/**
 * AS-UX-06 / DEC-018-037 §②: 5 状態の色マッピング。
 * idle = 透明 (dot 自体非表示)、それ以外は明示色。
 * Tailwind 標準色名で書くと CSS variable に紐づき theme 切替に追随する。
 */
const STATUS_DOT_COLOR: Record<ChatActivityState, string | null> = {
  idle: null,
  thinking: 'bg-warning',
  streaming: 'bg-accent',
  completed: 'bg-success',
  error: 'bg-destructive',
};

/**
 * 1 プロジェクトのアイコンボタン。
 *
 * - サイズ: 36x36（48px Rail の中央配置）
 * - active 時: 浅葱 ring (`shadow-glow`) + 左側 4px の bar
 * - hover 時: 角丸が circle → squircle へ（design-brand-v1.md § 6.3 motion-fast 150ms）
 * - title.charAt(0) または絵文字以外の 1 文字をラベルに使用
 */
export function ProjectIcon({ project }: ProjectIconProps) {
  const t = useTranslations('rail');
  const activeId = useProjectStore((s) => s.activeProjectId);
  const setActive = useProjectStore((s) => s.setActive);
  const isActive = project.id === activeId;
  const color = PROJECT_COLORS[project.colorIdx % PROJECT_COLORS.length];
  const initial = project.title.trim().charAt(0).toUpperCase() || 'P';
  const activity = useChatActivityStore(
    (s) => s.stateByProject[project.id] ?? 'idle',
  );
  const dotColor = STATUS_DOT_COLOR[activity];
  const animated = activity === 'thinking' || activity === 'streaming';

  return (
    <div className="relative flex w-full items-center justify-center">
      {isActive && (
        <motion.span
          layoutId="rail-active-indicator"
          aria-hidden
          className="absolute left-0 h-7 w-1 rounded-r-md bg-accent"
          transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
        />
      )}
      <button
        type="button"
        onClick={() => setActive(project.id)}
        aria-current={isActive}
        aria-label={t('switchTo', { name: project.title })}
        title={`${project.title}${project.phase ? ` (${project.phase})` : ''}\n${project.path}`}
        className={cn(
          'relative flex h-9 w-9 items-center justify-center text-xs font-semibold text-foreground',
          'transition-[border-radius,transform] duration-fast ease-out-expo',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
          isActive
            ? 'rounded-md shadow-glow'
            : 'rounded-full hover:rounded-md hover:scale-[1.04]'
        )}
        style={{
          backgroundColor: color,
          color: 'oklch(0.15 0.01 230)',
        }}
      >
        {initial}
        {dotColor ? (
          <span
            data-testid={`project-status-dot-${project.id}`}
            data-state={activity}
            aria-hidden
            className={cn(
              'absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-surface',
              dotColor,
              animated && 'animate-pulse',
            )}
          />
        ) : null}
      </button>
    </div>
  );
}
