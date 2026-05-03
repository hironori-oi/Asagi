/**
 * JSON-RPC 2.0 メッセージ型 (AS-131 / AS-135 / DEC-018-023)。
 *
 * Rust 側 `src-tauri/src/codex_sidecar/protocol.rs` と 1:1 対応する。
 *
 * **DEC-018-023 適用**: Real Codex app-server (LSP-style) の API surface に
 * 完全準拠した method 名 / event 名 / 高レベル型を定義する。
 *
 * **zod 未インストール方針**: deps 増加を避けるため、手書きの interface +
 * 型ガード関数で代替。後で zod に置換する場合は `validateXxx` 関数を
 * `XxxSchema.safeParse(x).success` に差し替えれば良い。
 */

// ---------------------------------------------------------------
// Method 定数 (Real Codex app-server 準拠)
// ---------------------------------------------------------------

export const CodexMethod = {
  // Handshake
  INITIALIZE: 'initialize',
  INITIALIZED: 'initialized',
  // Account
  ACCOUNT_READ: 'account/read',
  ACCOUNT_LOGIN_START: 'account/login/start',
  ACCOUNT_LOGIN_CANCEL: 'account/login/cancel',
  ACCOUNT_LOGOUT: 'account/logout',
  ACCOUNT_RATE_LIMITS_READ: 'account/rateLimits/read',
  // Thread
  THREAD_START: 'thread/start',
  THREAD_RESUME: 'thread/resume',
  THREAD_LIST: 'thread/list',
  THREAD_READ: 'thread/read',
  // Turn
  TURN_START: 'turn/start',
  TURN_STEER: 'turn/steer',
  TURN_INTERRUPT: 'turn/interrupt',
  // Model
  MODEL_LIST: 'model/list',
} as const;

export const CodexEvent = {
  // Thread lifecycle
  THREAD_STARTED: 'thread/started',
  THREAD_STATUS_CHANGED: 'thread/status/changed',
  // Turn lifecycle
  TURN_STARTED: 'turn/started',
  TURN_COMPLETED: 'turn/completed',
  // Item streaming
  ITEM_STARTED: 'item/started',
  ITEM_COMPLETED: 'item/completed',
  ITEM_AGENT_MESSAGE_DELTA: 'item/agentMessage/delta',
  ITEM_REASONING_TEXT_DELTA: 'item/reasoning/textDelta',
  // Approvals
  ITEM_COMMAND_EXEC_REQUEST_APPROVAL: 'item/commandExecution/requestApproval',
  ITEM_FILE_CHANGE_REQUEST_APPROVAL: 'item/fileChange/requestApproval',
  // Account
  ACCOUNT_UPDATED: 'account/updated',
  ACCOUNT_RATE_LIMITS_UPDATED: 'account/rateLimits/updated',
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
// Initialize handshake
// ---------------------------------------------------------------

export interface ClientInfo {
  name: string;
  title: string;
  version: string;
}

export interface ClientCapabilities {
  experimentalApi?: boolean;
  optOutNotificationMethods?: string[];
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities: ClientCapabilities;
}

export interface InitializeResult {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

// ---------------------------------------------------------------
// Thread / Turn
// ---------------------------------------------------------------

export interface ThreadStartParams {
  model: string;
  cwd?: string;
  approvalPolicy?: string;
  sandbox?: unknown;
}

export interface ThreadInfo {
  id: string;
  preview?: string;
  ephemeral: boolean;
  modelProvider?: string;
  createdAt?: string;
}

export interface ThreadStartResult {
  thread: ThreadInfo;
}

/** Real schema 準拠の InputItem (turn/start.input の各要素)。 */
export type InputItem =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string };

export interface TurnStartParams {
  threadId: string;
  input: InputItem[];
  model?: string;
  effort?: string;
}

export interface TurnInfo {
  id: string;
  /** "inProgress" | "completed" | "interrupted" */
  status: string;
  items: unknown[];
  error?: unknown;
}

export interface TurnStartResult {
  turn: TurnInfo;
}

// ---------------------------------------------------------------
// Notification 高レベル型
// ---------------------------------------------------------------

export interface ItemAgentMessageDeltaParams {
  itemId: string;
  delta: string;
}

export interface TurnCompletedParams {
  turn: TurnInfo;
}

// ---------------------------------------------------------------
// Account
// ---------------------------------------------------------------

export interface AccountInfo {
  /** "apikey" | "chatgpt" | "chatgptAuthTokens" */
  type: string;
  email?: string;
  planType?: string;
}

export interface AccountReadResult {
  account: AccountInfo | null;
  requiresOpenaiAuth: boolean;
  /**
   * DEC-018-045 QW1 (AS-200.1): OAuth access token の expiry (Unix epoch seconds)。
   * Real CLI が返さないケースは `null` / `undefined` で fail-soft（既存挙動を維持）。
   */
  accessTokenExpiresAt?: number | null;
  /**
   * DEC-018-045 QW1 (AS-200.1): OAuth refresh token の expiry (Unix epoch seconds)。
   */
  refreshTokenExpiresAt?: number | null;
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

export function validateThreadStartResult(x: unknown): ThreadStartResult | null {
  if (!isObject(x)) return null;
  if (!isObject(x.thread)) return null;
  if (typeof x.thread.id !== 'string') return null;
  return x as unknown as ThreadStartResult;
}

export function validateTurnStartResult(x: unknown): TurnStartResult | null {
  if (!isObject(x)) return null;
  if (!isObject(x.turn)) return null;
  if (typeof x.turn.id !== 'string') return null;
  if (typeof x.turn.status !== 'string') return null;
  return x as unknown as TurnStartResult;
}

export function validateAccountReadResult(x: unknown): AccountReadResult | null {
  if (!isObject(x)) return null;
  if (typeof x.requiresOpenaiAuth !== 'boolean') return null;
  return x as unknown as AccountReadResult;
}

export function validateItemAgentMessageDeltaParams(
  x: unknown,
): ItemAgentMessageDeltaParams | null {
  if (!isObject(x)) return null;
  if (typeof x.itemId !== 'string') return null;
  if (typeof x.delta !== 'string') return null;
  return { itemId: x.itemId, delta: x.delta };
}

export function validateTurnCompletedParams(x: unknown): TurnCompletedParams | null {
  if (!isObject(x)) return null;
  if (!isObject(x.turn)) return null;
  if (typeof x.turn.id !== 'string') return null;
  if (typeof x.turn.status !== 'string') return null;
  return x as unknown as TurnCompletedParams;
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
  /** 既存 thread を継続する場合に指定。省略時は新規 thread/start。 */
  threadId?: string;
}

export interface AgentSendMessageResult {
  thread_id: string;
  turn_id: string;
}

export interface AgentShutdownArgs {
  projectId: string;
}

// ---------------------------------------------------------------
// DEC-018-045 QW2 (AS-201.3): Spawn retry event payload
// ---------------------------------------------------------------

/**
 * `agent:{projectId}:spawn-retry` event payload。
 *
 * Rust 側 `SpawnAttemptEventPayload` (`commands/codex.rs`) と camelCase で 1:1。
 * `attempt` は 1-based、`max_retries` は policy 設定値（既定 3）。
 * 最終試行失敗時は `next_sleep_ms === null` で attempt = max_retries の event が来る。
 */
export interface SpawnAttemptEvent {
  attempt: number;
  maxRetries: number;
  lastError: string | null;
  nextSleepMs: number | null;
}

export function validateSpawnAttemptEvent(x: unknown): SpawnAttemptEvent | null {
  if (!isObject(x)) return null;
  if (typeof x.attempt !== 'number') return null;
  if (typeof x.maxRetries !== 'number') return null;
  return {
    attempt: x.attempt,
    maxRetries: x.maxRetries,
    lastError:
      typeof x.lastError === 'string'
        ? x.lastError
        : x.lastError === null
          ? null
          : null,
    nextSleepMs: typeof x.nextSleepMs === 'number' ? x.nextSleepMs : null,
  };
}
