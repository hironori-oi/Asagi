import { listen, type UnlistenFn, type EventCallback } from '@tauri-apps/api/event';

/**
 * Tauri event listen wrapper。
 *
 * Multi-Sidecar Architecture (DEC-018-023): event 名は
 * `agent:{projectId}:{realMethod}` 形式で emit される。
 * Tauri v2 event 名バリデーションは `[a-zA-Z0-9-_:/]+` を許容するため
 * `item/agentMessage/delta` 等の `/` を含む Real method 名をそのまま渡せる。
 */
export async function on<T>(eventName: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  return listen<T>(eventName, handler);
}

/**
 * Codex sidecar 関連イベント (DEC-018-023, Real Codex app-server 準拠)。
 *
 * Tauri 側 `commands/codex.rs::forward_notification` で emit される
 * `agent:{projectId}:{realMethod}` を購読するためのヘルパー。
 */
export const AgentEvents = {
  // Thread lifecycle
  threadStarted: (projectId: string) => `agent:${projectId}:thread/started`,
  threadStatusChanged: (projectId: string) => `agent:${projectId}:thread/status/changed`,
  // Turn lifecycle
  turnStarted: (projectId: string) => `agent:${projectId}:turn/started`,
  turnCompleted: (projectId: string) => `agent:${projectId}:turn/completed`,
  // Item streaming
  itemStarted: (projectId: string) => `agent:${projectId}:item/started`,
  itemCompleted: (projectId: string) => `agent:${projectId}:item/completed`,
  itemAgentMessageDelta: (projectId: string) =>
    `agent:${projectId}:item/agentMessage/delta`,
  itemReasoningTextDelta: (projectId: string) =>
    `agent:${projectId}:item/reasoning/textDelta`,
  // Approvals
  itemCommandExecRequestApproval: (projectId: string) =>
    `agent:${projectId}:item/commandExecution/requestApproval`,
  itemFileChangeRequestApproval: (projectId: string) =>
    `agent:${projectId}:item/fileChange/requestApproval`,
  // Account
  accountUpdated: (projectId: string) => `agent:${projectId}:account/updated`,
  accountRateLimitsUpdated: (projectId: string) =>
    `agent:${projectId}:account/rateLimits/updated`,
} as const;
