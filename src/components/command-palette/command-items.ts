import {
  ArrowRightLeft,
  FilePlus,
  Trash2,
  Cpu,
  SunMoon,
  Languages,
  Settings,
  Keyboard,
  type LucideIcon,
} from 'lucide-react';

/**
 * CommandPalette に表示する 1 コマンドの型（AS-114）。
 *
 * - id: i18n キーと一致（`command.items.<id>` / `command.hints.<id>`）
 * - group: グループ見出し（`command.groups.<group>`）
 * - shortcut: 任意。表示用、`mod+k` 等の人間可読ラベル
 * - action: 実コマンド側で `useCommandActions()` から提供される関数で処理
 *   ここではメタ情報のみ持ち、振る舞いは command-palette.tsx で dispatch する
 */
export type CommandGroup =
  | 'project'
  | 'session'
  | 'settings'
  | 'navigation'
  | 'help';

export type CommandActionId =
  | 'switchProject'
  | 'newSession'
  | 'clearChat'
  | 'selectModel'
  | 'toggleTheme'
  | 'switchLocale'
  | 'openSettings'
  | 'showHelp';

export interface CommandItem {
  id: CommandActionId;
  group: CommandGroup;
  icon: LucideIcon;
  /** Ctrl/Cmd 表記の人間可読ショートカット（任意）。 */
  shortcut?: string;
}

/**
 * グループ順序（パレット内で表示する順）。
 */
export const COMMAND_GROUP_ORDER: CommandGroup[] = [
  'navigation',
  'project',
  'session',
  'settings',
  'help',
];

/**
 * コマンド一覧。
 * v0.1.0 では実装済み (clearChat / toggleTheme / switchLocale / openSettings / showHelp / newSession)
 * + プレースホルダ (switchProject / selectModel) の混在。
 * プレースホルダは `command-palette.tsx` 側で toast で「未実装」を通知する。
 */
export const COMMAND_ITEMS: CommandItem[] = [
  {
    id: 'switchProject',
    group: 'project',
    icon: ArrowRightLeft,
  },
  {
    id: 'newSession',
    group: 'session',
    icon: FilePlus,
    shortcut: 'mod+n',
  },
  {
    id: 'clearChat',
    group: 'session',
    icon: Trash2,
  },
  {
    id: 'selectModel',
    group: 'settings',
    icon: Cpu,
  },
  {
    id: 'toggleTheme',
    group: 'settings',
    icon: SunMoon,
    shortcut: 'mod+t',
  },
  {
    id: 'switchLocale',
    group: 'settings',
    icon: Languages,
  },
  {
    id: 'openSettings',
    group: 'settings',
    icon: Settings,
  },
  {
    id: 'showHelp',
    group: 'help',
    icon: Keyboard,
    shortcut: 'mod+/',
  },
];
