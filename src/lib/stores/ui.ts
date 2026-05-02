import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * 全体 UI のオーバーレイ表示状態（AS-114 / AS-116 / AS-120 / AS-121 / AS-UX-05 / AS-UX-11）。
 *
 * - commandPalette: Ctrl+K で開く shadcn/cmdk Command palette
 * - settings: 設定モーダル（vaul Drawer）
 * - help: キーバインド一覧モーダル
 * - sidebarActiveTab: AS-UX-05 / DEC-018-037 §① / DEC-018-040 4-tab Sidebar の選択タブ。
 *   AS-UX-11 で Inspector 撤去 + Rules タブ追加により 4 タブ化（Sessions/Files/Rules/Runtime）。
 *   localStorage に persist し、再起動後も復元する。
 * - sidebarCollapsed: AS-UX-05 / Sumi DEC-082 翻訳。Cmd+B で 256px <-> 48px トグル。
 *
 * グローバル state にすることでキーバインドフックからもメニューからも開閉可能にする。
 */
export type SidebarTab = 'sessions' | 'files' | 'rules' | 'runtime';

interface UiState {
  commandPaletteOpen: boolean;
  settingsOpen: boolean;
  helpOpen: boolean;
  sidebarActiveTab: SidebarTab;
  sidebarCollapsed: boolean;
  setCommandPaletteOpen: (open: boolean) => void;
  toggleCommandPalette: () => void;
  setSettingsOpen: (open: boolean) => void;
  toggleSettings: () => void;
  setHelpOpen: (open: boolean) => void;
  toggleHelp: () => void;
  setSidebarActiveTab: (tab: SidebarTab) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebarCollapsed: () => void;
  closeAll: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      commandPaletteOpen: false,
      settingsOpen: false,
      helpOpen: false,
      sidebarActiveTab: 'sessions',
      sidebarCollapsed: false,
      setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
      toggleCommandPalette: () =>
        set({ commandPaletteOpen: !get().commandPaletteOpen }),
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      toggleSettings: () => set({ settingsOpen: !get().settingsOpen }),
      setHelpOpen: (helpOpen) => set({ helpOpen }),
      toggleHelp: () => set({ helpOpen: !get().helpOpen }),
      setSidebarActiveTab: (sidebarActiveTab) => set({ sidebarActiveTab }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      toggleSidebarCollapsed: () =>
        set({ sidebarCollapsed: !get().sidebarCollapsed }),
      closeAll: () =>
        set({ commandPaletteOpen: false, settingsOpen: false, helpOpen: false }),
    }),
    {
      name: 'asagi-ui',
      storage: createJSONStorage(() => {
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
      // overlay 系 state は永続化しない（Sidebar の永続のみ意味がある）
      partialize: (state) => ({
        sidebarActiveTab: state.sidebarActiveTab,
        sidebarCollapsed: state.sidebarCollapsed,
      }),
    }
  )
);
