/**
 * Asagi グローバルキーバインド定義（AS-121）。
 *
 * react-hotkeys-hook の keys 表記（mod = Cmd on macOS / Ctrl on others）。
 * 各画面の useHotkeys 呼出側でここを参照することで、表記揺れを防ぐ。
 */
export const KEYBINDINGS = {
  /** Ctrl/Cmd + K — コマンドパレットを開く（AS-114） */
  commandPalette: 'mod+k',
  /** Ctrl/Cmd + T — テーマを切替（dark <-> light、AS-116） */
  toggleTheme: 'mod+t',
  /** Ctrl/Cmd + N — 新規セッション（AS-117） */
  newSession: 'mod+n',
  /** Ctrl/Cmd + / — ヘルプモーダル（キーバインド一覧） */
  showHelp: 'mod+/',
  /** Escape — モーダル / ポップオーバを閉じる */
  escape: 'esc',
} as const;

export type KeybindingId = keyof typeof KEYBINDINGS;

/**
 * 表示用の人間可読ラベル（macOS は Cmd、それ以外は Ctrl）。
 * Web 環境（Next dev）では Ctrl を既定にし、`navigator.platform` でランタイム切替する。
 */
export function formatHotkey(key: string): string {
  if (typeof navigator === 'undefined') {
    return key.replace('mod', 'Ctrl').toUpperCase();
  }
  const isMac = /Mac|iPhone|iPad/i.test(navigator.platform);
  return key
    .split('+')
    .map((part) => {
      if (part === 'mod') return isMac ? 'Cmd' : 'Ctrl';
      if (part === 'esc') return 'Esc';
      return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' + ');
}
