'use client';

/**
 * Typing indicator (DEC-018-026 ① A) — 趣のある「滴の波紋」磨き込み版。
 *
 * ChatPane の MessageList 末尾に inline placeholder bubble として表示する
 * 「Asagi が考えています…」インジケータ。
 *
 * 表示条件 (CodexContext 経由):
 *   - status が `streaming`
 *   - かつ `awaitingFirstDelta` が true（最初の delta が来ていない）
 *
 * ChatStatusBadge と二重表示にならないよう、badge は header、
 * indicator は MessageList 末尾と役割分離する。
 *
 * --- アニメ意匠（DEC-018-026 磨き込みラウンド）
 *
 * 旧: tailwind `animate-bounce` を 3 dot に 0/150/300ms 等間隔で適用
 * 新: γ ロゴ「浅葱滴 (asagi-drop)」のメタファーを継承する `asagi-drop-ripple`
 *     keyframe を 3 粒に素数比 delay (0 / 240 / 470ms) で適用。
 *
 * 趣 5 原則の適用箇所:
 *   ① 不完全美: 等間隔でない素数比 delay（globals.css）
 *   ② 余白:     bubble padding を緩め、粒間 gap 2px で詰めすぎない
 *   ③ 即興性:   asymmetric easing で機械感を消す（globals.css）
 *   ④ 経年変化: opacity 0.30→0.85→0.40 の「灯って消える」呼吸
 *   ⑤ 静謐:    asagi accent + 透明度抑制、bubble の border / bg も 40% 程度
 *
 * prefers-reduced-motion 対応:
 *   - globals.css の `.asagi-drop` で animation: none 化
 *   - bubble 自体は表示維持（テキスト + 静的 dot で「考えています」状態は伝わる）
 */

import { useTranslations } from 'next-intl';
import { Bot } from 'lucide-react';
import { useCodexContext } from './codex-context';
import { cn } from '@/lib/utils';

export function TypingIndicator() {
  const ctx = useCodexContext();
  const t = useTranslations('chat');
  if (!ctx) return null;
  const visible = ctx.status === 'streaming' && ctx.awaitingFirstDelta;
  if (!visible) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="chat-typing-indicator"
      className={cn(
        // surface を薄め、border も控えめに（静謐）
        'flex gap-3 rounded-lg border border-border/30 bg-surface/40 p-3',
      )}
    >
      <div
        aria-hidden
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent"
      >
        <Bot strokeWidth={1.5} className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground/80">
          Codex
        </div>
        <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <span>{t('thinking')}</span>
          <span
            aria-hidden
            data-testid="chat-typing-ripple"
            className="inline-flex items-center gap-[3px] leading-none"
          >
            <span className="asagi-drop" />
            <span className="asagi-drop" />
            <span className="asagi-drop" />
          </span>
        </div>
      </div>
    </div>
  );
}
