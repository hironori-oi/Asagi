import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { MessageRow, SessionRow } from './types';

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
  // sessions
  create_session: (args: { title: string; projectId: string }) => Promise<string>;
  list_sessions: (args: { projectId?: string }) => Promise<SessionRow[]>;
  get_session: (args: { id: string }) => Promise<SessionRow | null>;
  delete_session: (args: { id: string }) => Promise<void>;
  // messages
  create_message: (args: {
    sessionId: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
  }) => Promise<string>;
  list_messages: (args: { sessionId: string }) => Promise<MessageRow[]>;
  count_messages: (args: { sessionId: string }) => Promise<number>;
}

export type { SessionRow, MessageRow };
