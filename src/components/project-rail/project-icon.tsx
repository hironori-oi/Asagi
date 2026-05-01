'use client';

import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { useProjectStore, PROJECT_COLORS, type RegisteredProject } from '@/lib/stores/project';
import { cn } from '@/lib/utils';

interface ProjectIconProps {
  project: RegisteredProject;
}

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
      </button>
    </div>
  );
}
