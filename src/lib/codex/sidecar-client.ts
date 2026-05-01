/**
 * Codex sidecar Tauri invoke wrapper (AS-135)。
 *
 * Rust 側 `commands/codex.rs` のコマンドに型付けして呼び出す。
 * mock mode (default) では Codex CLI 不要で完結する。
 */

import { invoke } from '@/lib/tauri/invoke';
import type {
  AgentSendMessageArgs,
  AgentSendMessageResult,
  StatusResult,
} from './schemas';
import { validateStatusResult } from './schemas';

/**
 * 指定 project の sidecar を spawn する。冪等。
 */
export async function spawnSidecar(projectId: string): Promise<void> {
  await invoke<void>('agent_spawn_sidecar', { projectId });
}

/**
 * sidecar に chat 1 ターンを送信し、最終 response を取得する。
 * streaming token は events.ts の `agent:{projectId}:assistant_message_delta` で受信する。
 */
export async function sendMessage(
  args: AgentSendMessageArgs,
): Promise<AgentSendMessageResult> {
  const result = await invoke<AgentSendMessageResult>('agent_send_message_v2', {
    args: {
      project_id: args.projectId,
      content: args.content,
      session_id: args.sessionId,
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
 * 指定 project の sidecar status を取得する。
 */
export async function getSidecarStatus(projectId: string): Promise<StatusResult> {
  const raw = await invoke<unknown>('agent_status', { projectId });
  const validated = validateStatusResult(raw);
  if (!validated) {
    throw new Error(`invalid StatusResult shape: ${JSON.stringify(raw)}`);
  }
  return validated;
}
