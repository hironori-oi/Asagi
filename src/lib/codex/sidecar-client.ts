/**
 * Codex sidecar Tauri invoke wrapper (AS-135 / DEC-018-023)。
 *
 * Rust 側 `commands/codex.rs` のコマンドに型付けして呼び出す。
 * mock mode (default) では Codex CLI 不要で完結する。
 */

import { invoke } from '@/lib/tauri/invoke';
import type {
  AccountReadResult,
  AgentSendMessageArgs,
  AgentSendMessageResult,
} from './schemas';
import { validateAccountReadResult } from './schemas';

/**
 * 指定 project の sidecar を spawn する。冪等。
 */
export async function spawnSidecar(projectId: string): Promise<void> {
  await invoke<void>('agent_spawn_sidecar', { projectId });
}

/**
 * sidecar に turn 1 ターンを送信する。
 * Real protocol 準拠で thread_id / turn_id を返却する。
 *
 * streaming token は events.ts の
 * `agent:{projectId}:item/agentMessage/delta` で受信する。
 */
export async function sendMessage(
  args: AgentSendMessageArgs,
): Promise<AgentSendMessageResult> {
  const result = await invoke<AgentSendMessageResult>('agent_send_message_v2', {
    args: {
      project_id: args.projectId,
      content: args.content,
      thread_id: args.threadId,
    },
  });
  return result;
}

/**
 * 指定 project の sidecar を shutdown する。
 */
export async function shutdownSidecar(projectId: string): Promise<void> {
  await invoke<void>('agent_shutdown_sidecar', { projectId });
}

/**
 * active な sidecar 一覧を返す。
 */
export async function listSidecars(): Promise<string[]> {
  return invoke<string[]>('agent_list_sidecars');
}

/**
 * `account/read` 経由で sidecar の account / plan 情報を取得する。
 */
export async function getSidecarStatus(projectId: string): Promise<AccountReadResult> {
  const raw = await invoke<unknown>('agent_status', { projectId });
  const validated = validateAccountReadResult(raw);
  if (!validated) {
    throw new Error(`invalid AccountReadResult shape: ${JSON.stringify(raw)}`);
  }
  return validated;
}
