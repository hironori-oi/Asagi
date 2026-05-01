import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * RegisteredProject — ProjectRail に並ぶ 1 プロジェクトのメタ。
 *
 * - id: ハッシュ衝突を避けるため、登録時に `path` の SHA256 先頭 12 文字 + 短縮を想定。
 *   v0.1.0 ではダミー値（`default-*`）固定。
 * - colorIdx: 0..7 の 8 色アクセント（`PROJECT_COLORS` で参照）。
 * - lastSessionId / preferredModel: M2 でセッション復元・モデル既定値に使用。
 *
 * 設計参照: dev-v0.1.0-scaffold-design.md § 1.5 Multi-Sidecar Architecture
 *           design-brand-v1.md § 5.1 ProjectRail
 *
 * Codex 統合 IF（モック値）: dev-v0.1.0-scaffold-design.md § 6.2
 *   - preferredModel は AS-112 で `codex_get_models` の結果から選択する。
 */
export interface RegisteredProject {
  id: string;
  path: string;
  title: string;
  phase?: string;
  colorIdx: number;
  lastSessionId?: string;
  preferredModel?: string;
}

interface ProjectState {
  projects: RegisteredProject[];
  activeProjectId: string;
  setProjects: (projects: RegisteredProject[]) => void;
  setActive: (id: string) => void;
  upsert: (project: RegisteredProject) => void;
  remove: (id: string) => void;
}

/**
 * Slack 風 8 色アクセントパレット。
 * `colorIdx % 8` で参照する。Tailwind では tokens.css の oklch を直接 inline style で使用。
 */
export const PROJECT_COLORS = [
  'oklch(0.72 0.10 200)', // asagi (default)
  'oklch(0.72 0.15 45)', // claude orange (sumi sibling, デモ用)
  'oklch(0.70 0.14 155)', // emerald
  'oklch(0.78 0.13 85)', // amber
  'oklch(0.62 0.16 25)', // crimson
  'oklch(0.70 0.14 280)', // violet
  'oklch(0.75 0.10 175)', // teal
  'oklch(0.70 0.12 320)', // pink
] as const;

/**
 * ダミーデータ（v0.1.0 限定、AS-112 の Tauri ダイアログ実装で置換）。
 *
 * 実プロジェクトは ChatGPT 認証 + Codex CLI 統合後に登録される想定。
 * ProjectRail のレイアウト確認・色分け確認のためだけに 3 件配置。
 */
const DUMMY_PROJECTS: RegisteredProject[] = [
  {
    id: 'default-asagi',
    path: 'C:/Users/demo/dev/asagi-app',
    title: 'Asagi',
    phase: 'Phase 0',
    colorIdx: 0,
    preferredModel: 'gpt-5.5-codex',
  },
  {
    id: 'default-sumi-sibling',
    path: 'C:/Users/demo/dev/sumi-sibling',
    title: 'Sumi 兄弟',
    phase: 'demo',
    colorIdx: 1,
    preferredModel: 'gpt-5-codex',
  },
  {
    id: 'default-playground',
    path: 'C:/Users/demo/dev/playground',
    title: 'Playground',
    phase: 'demo',
    colorIdx: 2,
    preferredModel: 'o4-mini',
  },
];

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      projects: DUMMY_PROJECTS,
      activeProjectId: DUMMY_PROJECTS[0]!.id,
      setProjects: (projects) => set({ projects }),
      setActive: (id) => set({ activeProjectId: id }),
      upsert: (project) => {
        const projects = get().projects.slice();
        const idx = projects.findIndex((p) => p.id === project.id);
        if (idx >= 0) projects[idx] = project;
        else projects.push(project);
        set({ projects });
      },
      remove: (id) => {
        const projects = get().projects.filter((p) => p.id !== id);
        const activeProjectId =
          get().activeProjectId === id
            ? (projects[0]?.id ?? '')
            : get().activeProjectId;
        set({ projects, activeProjectId });
      },
    }),
    {
      name: 'asagi-project-registry',
      storage: createJSONStorage(() => {
        // Tauri/Next.js export で SSR 段階に走らないようにガード。
        if (typeof window === 'undefined') {
          return {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
          };
        }
        return window.localStorage;
      }),
      version: 1,
    }
  )
);
