/**
 * Asagi logger (AS-META-07).
 *
 * Frontend 用の薄い console wrapper。
 * - development: console に直接書込み (色分け前提)
 * - production: Tauri 接続なら invoke('log', ...) でファイル出力 (将来 AS で実装)、
 *               未接続なら console.warn 1 行で fallback
 *
 * level 名は tracing crate と揃え、後で Rust 側 sink に流しやすくする。
 */

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [key: string]: unknown;
}

const isProd = typeof process !== 'undefined' && process.env.NODE_ENV === 'production';

function emit(level: LogLevel, message: string, context?: LogContext): void {
  const tag = `[asagi:${level}]`;
  const fullMessage = context
    ? `${tag} ${message} ${safeStringify(context)}`
    : `${tag} ${message}`;

  // production でも console は最低限残す (Tauri DevTools は production でも開ける)。
  // 本ファイルは logger 実装ゆえ、no-console ルール対象外として運用する
  // (ESLint flat config の rules で console は warn-only / 本ファイルのみ ok)。
  switch (level) {
    case 'trace':
    case 'debug':
      if (!isProd) {
        console.debug(fullMessage);
      }
      break;
    case 'info':
      console.info(fullMessage);
      break;
    case 'warn':
      console.warn(fullMessage);
      break;
    case 'error':
      console.error(fullMessage);
      break;
  }

  // 将来: production 時に Tauri command で file sink に流す。
  // 現状は無効化 (POC 通過後の sink 実装を待つ)。
}

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return '[unserializable]';
  }
}

export const logger = {
  trace: (msg: string, ctx?: LogContext) => emit('trace', msg, ctx),
  debug: (msg: string, ctx?: LogContext) => emit('debug', msg, ctx),
  info: (msg: string, ctx?: LogContext) => emit('info', msg, ctx),
  warn: (msg: string, ctx?: LogContext) => emit('warn', msg, ctx),
  error: (msg: string, ctx?: LogContext) => emit('error', msg, ctx),
};

export type { LogContext, LogLevel };
