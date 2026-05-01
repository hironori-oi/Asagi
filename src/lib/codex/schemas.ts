/**
 * JSON-RPC 2.0 メッセージ型 (AS-131 / AS-135 TS 側)。
 *
 * Rust 側 `src-tauri/src/codex_sidecar/protocol.rs` と 1:1 対応する。
 *
 * **zod 未インストール方針**: deps 増加を避けるため、手書きの interface +
 * 型ガード関数で代替。後で zod に置換する場合は `validateXxx` 関数を
 * `XxxSchema.safeParse(x).success` に差し替えれば良い。
 */

// ---------------------------------------------------------------
// Method 定数 (Rust の codex_sidecar::protocol::method と一致)
// ---------------------------------------------------------------

export const CodexMethod = {
  LOGIN: 'codex/login',
  CHAT: 'codex/chat',
  CANCEL: 'codex/cancel',
  STATUS: 'codex/status',
  IMAGE_PASTE: 'codex/imagePaste',
} as const;

export const CodexEvent = {
  ASSISTANT_MESSAGE_DELTA: 'codex/event/assistant_message_delta',
  DONE: 'codex/event/done',
  ERROR: 'codex/event/error',
  READY: 'codex/event/ready',
} as const;

// ---------------------------------------------------------------
// 基本型
// ---------------------------------------------------------------

export interface CodexRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: unknown;
}

export interface CodexResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: CodexError;
}

export interface CodexError {
  code: number;
  message: string;
  data?: unknown;
}

export interface CodexNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

// ---------------------------------------------------------------
// 高レベル param / result 型
// ---------------------------------------------------------------

export interface ChatParams {
  session_id: string;
  content: string;
  images?: string[];
}

export interface ChatResult {
  message_id: string;
  full_text: string;
}

export interface AssistantMessageDeltaParams {
  session_id: string;
  message_id: string;
  delta: string;
}

export interface DoneParams {
  session_id: string;
  message_id: string;
}

export interface StatusResult {
  alive: boolean;
  model: string;
  plan: string;
}

export interface LoginResult {
  ok: boolean;
  user: string;
}

export interface ImagePasteResult {
  sha256: string;
  bytes: number;
}

// ---------------------------------------------------------------
// 型ガード関数（後で zod に置換可能な抽象）
// ---------------------------------------------------------------

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function validateCodexResponse(x: unknown): CodexResponse | null {
  if (!isObject(x)) return null;
  if (x.jsonrpc !== '2.0') return null;
  if (typeof x.id !== 'string') return null;
  // result または error のいずれか
  if (x.error !== undefined) {
    if (!isObject(x.error)) return null;
    if (typeof x.error.code !== 'number') return null;
    if (typeof x.error.message !== 'string') return null;
  }
  return x as unknown as CodexResponse;
}

export function validateCodexNotification(x: unknown): CodexNotification | null {
  if (!isObject(x)) return null;
  if (x.jsonrpc !== '2.0') return null;
  if (typeof x.method !== 'string') return null;
  return x as unknown as CodexNotification;
}

export function validateChatResult(x: unknown): ChatResult | null {
  if (!isObject(x)) return null;
  if (typeof x.message_id !== 'string') return null;
  if (typeof x.full_text !== 'string') return null;
  return { message_id: x.message_id, full_text: x.full_text };
}

export function validateStatusResult(x: unknown): StatusResult | null {
  if (!isObject(x)) return null;
  if (typeof x.alive !== 'boolean') return null;
  if (typeof x.model !== 'string') return null;
  if (typeof x.plan !== 'string') return null;
  return { alive: x.alive, model: x.model, plan: x.plan };
}

export function validateAssistantMessageDeltaParams(
  x: unknown,
): AssistantMessageDeltaParams | null {
  if (!isObject(x)) return null;
  if (typeof x.session_id !== 'string') return null;
  if (typeof x.message_id !== 'string') return null;
  if (typeof x.delta !== 'string') return null;
  return {
    session_id: x.session_id,
    message_id: x.message_id,
    delta: x.delta,
  };
}

export function validateDoneParams(x: unknown): DoneParams | null {
  if (!isObject(x)) return null;
  if (typeof x.session_id !== 'string') return null;
  if (typeof x.message_id !== 'string') return null;
  return { session_id: x.session_id, message_id: x.message_id };
}

// ---------------------------------------------------------------
// Tauri command 引数 / 戻り値型
// ---------------------------------------------------------------

export interface AgentSpawnArgs {
  projectId: string;
}

export interface AgentSendMessageArgs {
  projectId: string;
  content: string;
  sessionId?: string;
}

export interface AgentSendMessageResult {
  message_id: string;
  full_text: string;
}

export interface AgentShutdownArgs {
  projectId: string;
}
