import { listen, type UnlistenFn, type EventCallback } from '@tauri-apps/api/event';

/**
 * Tauri event listen wrapper。
 * Multi-Sidecar Architecture（M2）では prefix `agent:{projectId}:*` を採用予定。
 * M1 では project_id = "default" 固定。
 */
export async function on<T>(eventName: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  return listen<T>(eventName, handler);
}

/**
 * Codex sidecar 関連イベント（POC 通過後に発火）。
 * 設計: dev-v0.1.0-scaffold-design.md § 1.2
 */
export const AgentEvents = {
  ready: (projectId: string) => `agent:${projectId}:ready`,
  assistantMessageDelta: (projectId: string) => `agent:${projectId}:assistant_message_delta`,
  toolUse: (projectId: string) => `agent:${projectId}:tool_use`,
  complete: (projectId: string) => `agent:${projectId}:complete`,
  error: (projectId: string) => `agent:${projectId}:error`,
} as const;
