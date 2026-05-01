import { invoke as tauriInvoke } from '@tauri-apps/api/core';

/**
 * Tauri command の型付き invoke wrapper。
 * Rust 側 `commands/mod.rs` の handler 名と一致させる。
 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return tauriInvoke<T>(cmd, args);
}

/**
 * 既知 commands の型定義（M1 段階）。
 * Codex sidecar 系は POC 通過後に追加。
 */
export interface Commands {
  db_init: () => Promise<void>;
  create_session: (args: { title: string; projectId: string }) => Promise<string>;
  list_sessions: (args: { projectId?: string }) => Promise<SessionRow[]>;
  get_session: (args: { id: string }) => Promise<SessionRow | null>;
  delete_session: (args: { id: string }) => Promise<void>;
}

export interface SessionRow {
  id: string;
  title: string;
  project_id: string;
  created_at: string;
  updated_at: string;
}
