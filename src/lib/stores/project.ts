import { create } from 'zustand';
import type { ProjectMeta } from '@/lib/tauri/types';

/**
 * M1 段階では project_id = "default" 固定。
 * M2 AS-200 で registry.json から複数 project を読み込む形に拡張する。
 */
interface ProjectState {
  projects: ProjectMeta[];
  activeProjectId: string;
  setProjects: (projects: ProjectMeta[]) => void;
  setActive: (id: string) => void;
}

const DEFAULT_PROJECT: ProjectMeta = {
  id: 'default',
  name: 'Default',
  path: '',
  color_index: 0,
};

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [DEFAULT_PROJECT],
  activeProjectId: 'default',
  setProjects: (projects) => set({ projects }),
  setActive: (id) => set({ activeProjectId: id }),
}));
