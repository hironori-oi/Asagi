'use client';

import { useProjectStore } from '@/lib/stores/project';
import { ProjectIcon } from './project-icon';
import { AddProjectButton } from './add-project-button';

/**
 * Slack 風 ProjectRail — 48px 幅の縦アイコン列。
 *
 * v0.1.0:
 *   - localStorage `asagi-project-registry` に persist された RegisteredProject[] を表示
 *   - 起動時はダミー 3 件（`stores/project.ts` 参照）
 *   - active 切替は瞬時（state 更新のみ、Codex sidecar swap は M2）
 *
 * 設計参照:
 *   - design-brand-v1.md § 5.1 (48px 幅)
 *   - design-brand-v1.md § 6.3 (motion-fast 150ms cross-fade)
 *   - dev-v0.1.0-scaffold-design.md § 1.5 Multi-Sidecar Architecture
 */
export function ProjectRail() {
  const projects = useProjectStore((s) => s.projects);

  return (
    <nav
      aria-label="プロジェクト切替"
      className="flex h-full w-12 shrink-0 flex-col items-center gap-1.5 border-r border-border bg-surface py-3"
    >
      {projects.map((p) => (
        <ProjectIcon key={p.id} project={p} />
      ))}
      <div className="my-1 h-px w-6 bg-border" aria-hidden />
      <AddProjectButton />
    </nav>
  );
}
