import { invoke } from './invoke';

/**
 * Asagi 設定永続化 (AS-META-06) — TS wrapper.
 *
 * Rust 側 commands::{get,set,list}_setting に thin wrapper。
 * Tauri 非接続環境 (next dev 単体) では throw → 呼び出し側で fallback 推奨。
 *
 * localStorage との整理:
 *   - localStorage は frontend ephemeral (Welcome step 等)
 *   - tauri store は app-wide persistent (theme / locale / lastActiveProjectId 等)
 */

/** 既知の設定キー (`SettingKey` Rust enum と同期)。 */
export const SETTING_KEYS = {
  theme: 'theme',
  locale: 'locale',
  lastActiveProjectId: 'lastActiveProjectId',
  lastActiveSessionId: 'lastActiveSessionId',
  windowWidth: 'windowWidth',
  windowHeight: 'windowHeight',
  preferredModel: 'preferredModel',
  reasoningEffort: 'reasoningEffort',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

export type SettingValue =
  | string
  | number
  | boolean
  | null
  | Record<string, unknown>
  | unknown[];

export async function getSetting<T extends SettingValue = SettingValue>(
  key: SettingKey
): Promise<T | null> {
  const v = await invoke<T | null>('get_setting', { key });
  return v ?? null;
}

export async function setSetting(key: SettingKey, value: SettingValue): Promise<void> {
  await invoke<void>('set_setting', { args: { key, value } });
}

export async function listSettings(): Promise<Record<string, SettingValue>> {
  return invoke<Record<string, SettingValue>>('list_settings');
}

/**
 * Tauri 非接続環境を許容する safe wrapper。
 * 失敗時は null / undefined を返してログにのみ出す。
 */
export async function getSettingSafe<T extends SettingValue = SettingValue>(
  key: SettingKey,
  fallback: T | null = null
): Promise<T | null> {
  try {
    return await getSetting<T>(key);
  } catch {
    return fallback;
  }
}

export async function setSettingSafe(key: SettingKey, value: SettingValue): Promise<boolean> {
  try {
    await setSetting(key, value);
    return true;
  } catch {
    return false;
  }
}
