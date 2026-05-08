/**
 * deferred-shutdown helper tests (AS-HOTFIX-QW8 / DEC-018-049 defensive
 * hardening, Bug ② 再発防止)。
 *
 * 12 ケース網羅:
 *   1. 初期状態 (pendingKey === null)
 *   2. schedule 単発 → 200ms 後に fn 実行
 *   3. schedule → cancel(同 key) → fn 実行されず (StrictMode 想定)
 *   4. schedule → cancel(別 key) → no-op、fn は実行される
 *   5. schedule(k1) → schedule(k2) → 古い timer は破棄、新 timer のみ実行
 *   6. schedule → 自然到達後 cancel → false 返却 (no-op)
 *   7. cancel 単独 → false 返却
 *   8. flush → pending 強制クリア、fn 実行されず
 *   9. async fn (Promise<void>) でも tick 後に呼び出される
 *  10. fn 内 throw でも timer 状態は壊れない
 *  11. delayMs カスタム (50ms) でも正しく動く
 *  12. schedule → cancel → 再 schedule (StrictMode 復帰想定): 新規 timer で実行
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDeferredShutdown } from '../deferred-shutdown';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createDeferredShutdown', () => {
  it('case 1: 初期状態は pendingKey === null', () => {
    const ds = createDeferredShutdown();
    expect(ds.pendingKey()).toBeNull();
  });

  it('case 2: schedule 単発 → 200ms 後に fn が呼ばれる', () => {
    const ds = createDeferredShutdown(200);
    const fn = vi.fn();
    ds.schedule('p1', fn);
    expect(ds.pendingKey()).toBe('p1');
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(199);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(ds.pendingKey()).toBeNull();
  });

  it('case 3: schedule → cancel(同 key) → fn は呼ばれない (StrictMode remount 想定)', () => {
    const ds = createDeferredShutdown(200);
    const fn = vi.fn();
    ds.schedule('p1', fn);
    expect(ds.cancel('p1')).toBe(true);
    expect(ds.pendingKey()).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('case 4: schedule(p1) → cancel(p2) は no-op、p1 fn は実行される (project 切替 cancel 防止)', () => {
    const ds = createDeferredShutdown(200);
    const fn = vi.fn();
    ds.schedule('p1', fn);
    expect(ds.cancel('p2')).toBe(false);
    expect(ds.pendingKey()).toBe('p1');
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('case 5: schedule(k1) → schedule(k2) → k1 fn は破棄、k2 fn のみ実行', () => {
    const ds = createDeferredShutdown(200);
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    ds.schedule('p1', fn1);
    ds.schedule('p2', fn2);
    expect(ds.pendingKey()).toBe('p2');
    vi.advanceTimersByTime(200);
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it('case 6: 自然到達後の cancel は false (no-op)', () => {
    const ds = createDeferredShutdown(200);
    const fn = vi.fn();
    ds.schedule('p1', fn);
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(ds.cancel('p1')).toBe(false);
  });

  it('case 7: schedule なしの cancel は false', () => {
    const ds = createDeferredShutdown();
    expect(ds.cancel('any')).toBe(false);
  });

  it('case 8: flush → pending 強制クリア、fn は呼ばれない', () => {
    const ds = createDeferredShutdown(200);
    const fn = vi.fn();
    ds.schedule('p1', fn);
    ds.flush();
    expect(ds.pendingKey()).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('case 9: async fn (Promise<void>) も timer 到達で呼ばれる', () => {
    const ds = createDeferredShutdown(200);
    const fn = vi.fn(async () => {
      // simulate async shutdown
      await Promise.resolve();
    });
    ds.schedule('p1', fn);
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('case 10: fn 内 throw でも pending 状態は壊れない (次の schedule が動く)', () => {
    const ds = createDeferredShutdown(200);
    const throwingFn = vi.fn(() => {
      throw new Error('shutdown failed');
    });
    ds.schedule('p1', throwingFn);
    vi.advanceTimersByTime(200);
    expect(throwingFn).toHaveBeenCalledTimes(1);
    expect(ds.pendingKey()).toBeNull();

    // 続いて新しい schedule が正常動作することを確認
    const okFn = vi.fn();
    ds.schedule('p2', okFn);
    expect(ds.pendingKey()).toBe('p2');
    vi.advanceTimersByTime(200);
    expect(okFn).toHaveBeenCalledTimes(1);
  });

  it('case 11: delayMs カスタム (50ms) でも正しく動く', () => {
    const ds = createDeferredShutdown(50);
    const fn = vi.fn();
    ds.schedule('p1', fn);
    vi.advanceTimersByTime(49);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('case 12: schedule → cancel → 再 schedule (StrictMode 復帰想定): 新規 timer で実行', () => {
    const ds = createDeferredShutdown(200);
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    // mount #1 cleanup → schedule
    ds.schedule('p1', fn1);
    // mount #2: 同 key で cancel
    expect(ds.cancel('p1')).toBe(true);
    // 真の unmount: 再 schedule
    ds.schedule('p1', fn2);
    expect(ds.pendingKey()).toBe('p1');
    vi.advanceTimersByTime(200);
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledTimes(1);
  });
});
