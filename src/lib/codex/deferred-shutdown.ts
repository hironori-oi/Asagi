/**
 * Deferred-cancellable shutdown helper (AS-HOTFIX-QW8 / DEC-018-049 defensive
 * hardening).
 *
 * 背景: React StrictMode dev は useEffect を意図的に
 * `mount → cleanup → mount` の順で 2 回走らせる。Codex sidecar の `spawn()` は
 * Rust 側 `spawn_for_with_factory` で write-lock を ~3s 保持するため、
 * cleanup #1 の `shutdown()` が間に挟まると broadcast::Sender が drop し
 * `notification stream closed for {pid}` ログ + Codex 応答無し問題（Bug ②）が
 * 発生していた。
 *
 * このユーティリティは「shutdown を 200ms 遅延予約 → 同 key の remount で
 * cancel」というパターンを純関数として切り出し、ChatPane だけでなく将来の
 * sidecar life-cycle host (terminal pane / multi-thread workspace 等) でも
 * 同じ pattern を再利用できるようにする。
 *
 * 状態遷移:
 *   schedule(k1, fn1) → pending = { k1, timer1 }
 *   cancel(k1)        → pending = null, timer1 cleared
 *   schedule(k2, fn2) → pending = { k2, timer2 } (timer1 が生きていれば clear)
 *   timer 到達        → pending == { kX, timerX } なら fn 実行 + pending=null
 *
 * Edge cases:
 *   - 同一 key で 2 回 schedule: 古い timer が clear され新 timer に置換
 *   - cancel(other_key): no-op (false 返却)
 *   - schedule 後 cancel 前に timer 自然到達: fn 実行 + pending null
 *   - Promise を返す fn: 失敗してもデフォルト握りつぶし。呼び出し側で try/catch 推奨
 *
 * @see chat-pane.tsx の使用箇所
 * @see deferred-shutdown.test.ts (12 ケース網羅)
 * @see DEC-018-049 / PIT-010 Meta-Lesson #7 / AS-HOTFIX-QW8
 */

export interface DeferredShutdown {
  /**
   * `key` をキーに `fn` を `delayMs` 後に実行する予約を立てる。
   * 既に何か pending があれば古い timer を clear して新規に置換する
   * （古い fn は実行されない）。
   */
  schedule(key: string, fn: () => void | Promise<void>): void;
  /**
   * 現在 pending 中の予約が `key` と一致するなら timer を clear し pending を
   * クリアする。同 key の StrictMode remount で利用。
   * @returns cancel した場合 true、no-op の場合 false
   */
  cancel(key: string): boolean;
  /** 現在の pending key (テスト/診断用)。pending なし → null */
  pendingKey(): string | null;
  /**
   * test/teardown 用: pending を強制 clear（fn は呼ばれない）。
   * 通常の実装コードでは使用不要。Window unload や Tauri shutdown 経路で
   * 早期クリーンアップしたい場合の escape hatch.
   */
  flush(): void;
}

/**
 * 新規 DeferredShutdown インスタンスを作る。
 * @param delayMs setTimeout の遅延 (default 200ms = StrictMode の二重 mount を
 *   許容する最小値、DEC-018-049 で実機検証済み)
 */
export function createDeferredShutdown(delayMs = 200): DeferredShutdown {
  let pending: { key: string; timer: ReturnType<typeof setTimeout> } | null =
    null;

  const clear = () => {
    if (pending) {
      clearTimeout(pending.timer);
      pending = null;
    }
  };

  return {
    schedule(key, fn) {
      // 既存 pending があれば古い timer を clear（古い fn は実行されない）
      clear();
      const timer = setTimeout(() => {
        // 自然到達: pending を nullify してから fn を実行
        // (fn 内で再帰的に schedule された場合の整合性確保)
        if (pending && pending.key === key) {
          pending = null;
        }
        try {
          // void Promise<void> は握りつぶす（呼び出し側で error 監視推奨）
          void fn();
        } catch {
          // sync throw も握りつぶす（shutdown failure はログ済 by codex layer）
        }
      }, delayMs);
      pending = { key, timer };
    },
    cancel(key) {
      if (pending && pending.key === key) {
        clear();
        return true;
      }
      return false;
    },
    pendingKey() {
      return pending?.key ?? null;
    },
    flush() {
      clear();
    },
  };
}
