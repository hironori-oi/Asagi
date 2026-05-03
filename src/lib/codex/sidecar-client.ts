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
 * DEC-018-026 ① C: 現在実行中の turn を中断する。
 *
 * Real Codex app-server `turn/interrupt` 仕様:
 *   params: `{ threadId: string, turnId?: string }`
 *
 * mock 側でも同シグネチャを受理し、Tauri command `agent_interrupt` 経由で
 * `turn/interrupt` request を送る。失敗時は throw。
 */
export interface AgentInterruptArgs {
  projectId: string;
  threadId?: string;
  turnId?: string;
}

export async function interruptTurn(args: AgentInterruptArgs): Promise<void> {
  await invoke<void>('agent_interrupt', {
    args: {
      project_id: args.projectId,
      thread_id: args.threadId,
      turn_id: args.turnId,
    },
  });
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

// --------------------------------------------------------------------------
// DEC-018-028 QW1 (F3 Auth Watchdog) Tauri command wrappers
// --------------------------------------------------------------------------

/**
 * Rust 側 `AuthState` (serde tag = "kind", snake_case) と一致する判別 union。
 * Real impl 切替後も schema は不変。
 */
export type AuthWatchdogState =
  | { kind: 'unknown' }
  | {
      kind: 'authenticated';
      last_checked_unix: number;
      plan: string;
      user: string;
      /**
       * DEC-018-045 QW1 (AS-200.2): access token の expiry (Unix sec)。
       * CLI が返さない場合 / fail-soft では null/undefined。
       * camelCase は Rust 側 `#[serde(rename = "accessExpiresAtUnix")]` に対応。
       */
      accessExpiresAtUnix?: number | null;
      /**
       * DEC-018-045 QW1 (AS-200.2): expiry が threshold (30min) 以内なら true。
       * `accessExpiresAtUnix == null` の時は false 固定 (fail-soft)。
       */
      expiryWarning?: boolean;
    }
  | {
      kind: 'requires_reauth';
      detected_at_unix: number;
      reason: string;
    }
  | {
      kind: 'error';
      last_error: string;
      since_unix: number;
    };

/**
 * Rust `AuthStateChangedPayload` と一致する event payload。
 * Tauri event `auth:{projectId}:state_changed` で受信する。
 */
export interface AuthStateChangedPayload {
  from: string;
  to: string;
  state: AuthWatchdogState;
  reason: string;
}

export const AuthEvents = {
  stateChanged: (projectId: string) => `auth:${projectId}:state_changed`,
} as const;

// DEC-018-045 QW2/QW3: spawn-retry / lazy-spawn / idle-shutdown event 名は
// `@/lib/tauri/events` の `AgentEvents` に追加済み。本 module からは re-export
// しない（既存 import パスを増やさず、events.ts に統一する方針）。

/** Watchdog start (idempotent)。lib.rs で自動起動するが UI からも操作可能。 */
export async function authWatchdogStart(): Promise<void> {
  await invoke<void>('auth_watchdog_start');
}

/** Watchdog stop (idempotent)。 */
export async function authWatchdogStop(): Promise<void> {
  await invoke<void>('auth_watchdog_stop');
}

/** UI の「今すぐ確認」ボタン用。state 変化があれば event で通知。 */
export async function authWatchdogForceCheck(projectId: string): Promise<void> {
  await invoke<void>('auth_watchdog_force_check', { projectId });
}

/** 現在の AuthState を取得（UI 起動時の seed）。 */
export async function authWatchdogGetState(
  projectId: string,
): Promise<AuthWatchdogState> {
  return invoke<AuthWatchdogState>('auth_watchdog_get_state', { projectId });
}

/**
 * DEC-018-045 QW1 (AS-200.3): 再ログインモーダル / warning toast から呼ぶ
 * 「Codex の再ログインを開始する」Tauri command。
 *
 * Rust 側は `account/login/start` を invoke し、返却された authUrl を
 * 既定ブラウザで開く（mock では mock OAuth URL になる）。
 * 失敗時は throw し、UI 側は toast でエラー表示する。
 */
export async function authOpenLogin(projectId: string): Promise<void> {
  await invoke<void>('auth_open_login', { projectId });
}

// --------------------------------------------------------------------------
// AS-144 / DEC-018-036: Sidecar mode runtime switch (mock <-> real)
// --------------------------------------------------------------------------

/**
 * Sidecar mode 値。Rust 側 `SidecarMode` (mod.rs) と一致。
 *   - `mock`: 本物の Codex CLI 不要、in-process MockCodexSidecar
 *   - `real`: Codex CLI 0.128.0 を spawn、`codex login` 完了済が前提
 */
export type SidecarMode = 'mock' | 'real';

/**
 * Rust `SidecarModeResult` (commands/codex.rs) と一致する Tauri command 戻り値。
 * `tauri::generate_handler!` macro 経由で `static str` がそのまま `string` で
 * 返却されるため field 名は `mode` 固定。
 */
interface SidecarModeResult {
  mode: SidecarMode;
}

/**
 * 現在の sidecar mode を取得（UI 起動時の seed）。
 *
 * 起動時の値は Rust 側で `SidecarMode::from_env()` により `ASAGI_SIDECAR_MODE`
 * 環境変数（未設定なら `mock`）から決まる。`setSidecarMode` で UI から切替後は
 * 最新値が返る。
 */
export async function getSidecarMode(): Promise<SidecarMode> {
  const r = await invoke<SidecarModeResult>('agent_get_sidecar_mode');
  return r.mode;
}

/**
 * Sidecar mode を runtime で切替える（mock <-> real）。
 *
 * 既存 sidecar は触らない（再 spawn まで現行モードで継続動作）。
 * 完全切替には呼出側で「全 project shutdown → setSidecarMode → spawn」を
 * 順に実行する必要がある。invalid な値は throw。
 */
export async function setSidecarMode(mode: SidecarMode): Promise<SidecarMode> {
  const r = await invoke<SidecarModeResult>('agent_set_sidecar_mode', {
    args: { mode },
  });
  return r.mode;
}
