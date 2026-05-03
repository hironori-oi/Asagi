'use client';

/**
 * ChatPane ヘッダ右肩に表示する Auth Watchdog バッジ
 * (DEC-018-028 QW1 / F3, リサーチ § 3.6)。
 *
 * Rust 側 AuthWatchdog の state を購読し、
 *   - authenticated (warning=false): 緑 dot
 *   - authenticated (warning=true) : 黄 dot + 「残 N 分」+ 「再ログイン」CTA
 *   - requires_reauth: 赤 dot + 「再ログイン」CTA + 「今すぐ確認」CTA
 *   - error: 黄 dot + tooltip にエラー文
 *   - unknown: 灰 dot
 * を ChatStatusBadge と並べて表示する。
 *
 * DEC-018-045 QW1 (AS-200.3): expiry warning のサブ状態と「再ログイン」CTA を追加。
 * 「再ログイン」は `auth_open_login` 経由で `account/login/start` を呼び、
 * authUrl を既定ブラウザで開く（mock では mock OAuth URL）。
 *
 * Real impl 切替後、本コンポーネントは無修正で動く。
 */

import { useTranslations } from 'next-intl';
import { logger } from '@/lib/logger';
import { useProjectStore } from '@/lib/stores/project';
import { useAuthWatchdog, type AuthKind } from '@/lib/codex/use-auth-watchdog';
import { cn } from '@/lib/utils';

const STATUS_DOT: Record<AuthKind, string> = {
  unknown: 'bg-muted-foreground/40',
  authenticated: 'bg-success',
  requires_reauth: 'bg-destructive animate-pulse',
  error: 'bg-warning',
};

export function AuthBadge() {
  const activeId = useProjectStore((s) => s.activeProjectId);
  const t = useTranslations('chat.auth');
  const auth = useAuthWatchdog(activeId);

  // activeProjectId 未確定時は何も描画しない (ChatStatusBadge と同じ規約)。
  if (!activeId) return null;

  // expiry warning は authenticated のサブ状態だが、UI 上は warning dot を優先。
  const dot = auth.expiryWarning
    ? 'bg-warning animate-pulse'
    : (STATUS_DOT[auth.kind] ?? STATUS_DOT.unknown);

  const label = (() => {
    if (auth.expiryWarning && auth.expiryRemainingMinutes !== null) {
      try {
        return t('expiryWarning', { minutes: auth.expiryRemainingMinutes });
      } catch {
        return `Expiring in ${auth.expiryRemainingMinutes} min`;
      }
    }
    try {
      return t(auth.kind);
    } catch {
      return auth.kind;
    }
  })();

  // tooltip: error / requires_reauth は内訳を出す
  const title = (() => {
    if (auth.state.kind === 'error') return auth.state.last_error;
    if (auth.state.kind === 'requires_reauth') return auth.state.reason;
    if (auth.state.kind === 'authenticated') {
      const base = `${auth.state.user} (${auth.state.plan})`;
      if (auth.expiryWarning && auth.expiryRemainingMinutes !== null) {
        return `${base} — expiring in ${auth.expiryRemainingMinutes} min`;
      }
      return base;
    }
    return label;
  })();

  // 再ログイン CTA を出すかどうか（warning または requires_reauth）
  const shouldShowReloginCta = auth.requiresReauth || auth.expiryWarning;

  const handleRelogin = () => {
    void auth.openLogin().catch((e) => {
      logger.warn('[auth-badge] openLogin failed', e);
    });
  };

  // data-* attribute に warning を露出することで E2E / smoke 側が capture 可能。
  return (
    <div
      role="status"
      aria-label={`Auth ${auth.kind}${auth.expiryWarning ? ' (expiring)' : ''}`}
      data-testid="auth-badge"
      data-auth={auth.kind}
      data-expiry-warning={auth.expiryWarning ? '1' : '0'}
      title={title}
      className="flex items-center gap-1.5 rounded-full border border-border/60 bg-surface-elevated/60 px-2 py-0.5 text-[11px] text-muted-foreground"
    >
      <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      <span>{label}</span>
      {shouldShowReloginCta && (
        <button
          type="button"
          onClick={handleRelogin}
          data-testid="auth-badge-relogin"
          className={cn(
            'ml-1 rounded px-1.5 py-0 text-[10px]',
            auth.requiresReauth
              ? 'border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20'
              : 'border border-warning/40 bg-warning/10 text-warning hover:bg-warning/20',
          )}
        >
          {(() => {
            try {
              return t('relogin');
            } catch {
              return 'Re-login';
            }
          })()}
        </button>
      )}
      {auth.requiresReauth && (
        <button
          type="button"
          onClick={() => {
            void auth.forceCheck();
          }}
          data-testid="auth-badge-force-check"
          className="ml-1 rounded border border-destructive/40 bg-destructive/10 px-1.5 py-0 text-[10px] text-destructive hover:bg-destructive/20"
        >
          {(() => {
            try {
              return t('checkNow');
            } catch {
              return 'Check now';
            }
          })()}
        </button>
      )}
    </div>
  );
}
