'use client';

/**
 * ChatPane ヘッダ右肩に表示する Auth Watchdog バッジ
 * (DEC-018-028 QW1 / F3, リサーチ § 3.6)。
 *
 * Rust 側 AuthWatchdog の state を購読し、
 *   - authenticated: 緑 dot
 *   - requires_reauth: 赤 dot + 「再ログイン」CTA
 *   - error: 黄 dot + tooltip にエラー文
 *   - unknown: 灰 dot
 * を ChatStatusBadge と並べて表示する。
 *
 * `requires_reauth` 状態だけは「今すぐ確認」ボタンも露出し、
 * UI から `auth_watchdog_force_check` を即座に叩けるようにする。
 *
 * Real impl 切替後、本コンポーネントは無修正で動く。
 */

import { useTranslations } from 'next-intl';
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

  const dot = STATUS_DOT[auth.kind] ?? STATUS_DOT.unknown;
  const label = (() => {
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
      return `${auth.state.user} (${auth.state.plan})`;
    }
    return label;
  })();

  return (
    <div
      role="status"
      aria-label={`Auth ${auth.kind}`}
      data-testid="auth-badge"
      data-auth={auth.kind}
      title={title}
      className="flex items-center gap-1.5 rounded-full border border-border/60 bg-surface-elevated/60 px-2 py-0.5 text-[11px] text-muted-foreground"
    >
      <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      <span>{label}</span>
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
