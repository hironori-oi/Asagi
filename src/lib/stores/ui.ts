import { create } from 'zustand';

/**
 * 全体 UI のオーバーレイ表示状態（AS-114 / AS-116 / AS-120 / AS-121）。
 *
 * - commandPalette: Ctrl+K で開く shadcn/cmdk Command palette
 * - settings: 設定モーダル（vaul Drawer）
 * - help: キーバインド一覧モーダル
 *
 * グローバル state にすることでキーバインドフックからもメニューからも開閉可能にする。
 */
interface UiState {
  commandPaletteOpen: boolean;
  settingsOpen: boolean;
  helpOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;
  toggleCommandPalette: () => void;
  setSettingsOpen: (open: boolean) => void;
  toggleSettings: () => void;
  setHelpOpen: (open: boolean) => void;
  toggleHelp: () => void;
  closeAll: () => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  commandPaletteOpen: false,
  settingsOpen: false,
  helpOpen: false,
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
  toggleCommandPalette: () =>
    set({ commandPaletteOpen: !get().commandPaletteOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  toggleSettings: () => set({ settingsOpen: !get().settingsOpen }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  toggleHelp: () => set({ helpOpen: !get().helpOpen }),
  closeAll: () =>
    set({ commandPaletteOpen: false, settingsOpen: false, helpOpen: false }),
}));
