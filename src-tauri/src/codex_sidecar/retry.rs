//! Outer Retry Layer (DEC-018-045 QW2 / F1, AS-201.1)。
//!
//! `MultiSidecarManager::spawn_for_with_retry` から使われる
//! decorrelated jitter backoff の純粋計算層。tokio 不要 / no I/O。
//!
//! # 研究根拠
//!
//! research-m2-stability-pre § 2.3「decorrelated jitter (AWS pattern)」を
//! Asagi の **spawn-level outer retry** に適用。turn-level retry は
//! DEC-018-027 で Asagi 側からは行わない（CLI 内部に委譲）ため、本ポリシーは
//! あくまで「sidecar プロセス起動の失敗を 3 回までリカバリ」する用途に限定。
//!
//! # 既定値（contract.rs から取得）
//!
//!   - `base_ms`     ... 200 ms
//!   - `cap_ms`      ... 10_000 ms
//!   - `max_retries` ... 3 回（R-QW-2 厳守）
//!
//! # decorrelated jitter (AWS pseudo-rust)
//!
//! ```text
//! sleep_n+1 = min(cap, random_between(base, sleep_n * 3))
//! ```
//!
//! 古典 exponential backoff (sleep_n+1 = min(cap, base * 2^n)) と異なり、
//! クライアント間で sleep が脱同期するため thundering herd を回避できる。

use std::time::Duration;

use super::contract::{SPAWN_RETRY_BASE_MS, SPAWN_RETRY_CAP_MS, SPAWN_RETRY_MAX};

/// retry 1 回ぶんの sleep を決めるポリシー。
///
/// `Default::default()` は `contract.rs` の値を参照する（hardcode 違反防止）。
#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    pub base_ms: u64,
    pub cap_ms: u64,
    pub max_retries: usize,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            base_ms: SPAWN_RETRY_BASE_MS,
            cap_ms: SPAWN_RETRY_CAP_MS,
            max_retries: SPAWN_RETRY_MAX,
        }
    }
}

impl RetryPolicy {
    /// test 用に短い間隔の policy を返す。
    pub fn for_test() -> Self {
        Self {
            base_ms: 10,
            cap_ms: 100,
            max_retries: 3,
        }
    }

    /// 次回 sleep 時間を decorrelated jitter で計算する。
    ///
    /// `last_sleep_ms` は前回の sleep（初回は 0 を渡す）。
    /// 戻り値は `[base_ms, cap_ms]` の範囲に収まる ms 値。
    ///
    /// 計算式: `min(cap_ms, random_between(base_ms, max(base_ms, last_sleep_ms) * 3))`
    pub fn next_sleep_ms(&self, last_sleep_ms: u64) -> u64 {
        next_sleep_decorrelated(last_sleep_ms, self.base_ms, self.cap_ms)
    }

    /// `next_sleep_ms` の Duration 版。
    pub fn next_sleep(&self, last_sleep_ms: u64) -> Duration {
        Duration::from_millis(self.next_sleep_ms(last_sleep_ms))
    }
}

/// pure decorrelated jitter 計算。
///
/// std::time も tokio も使わず、`std::time::SystemTime::now().subsec_nanos()` を
/// 線形合同擬似乱数の seed として消費する。crate 依存ゼロ（rand 不要）。
pub fn next_sleep_decorrelated(last_sleep_ms: u64, base_ms: u64, cap_ms: u64) -> u64 {
    let lower = base_ms.max(1);
    // upper = max(lower, last_sleep * 3)、ただし overflow guard
    let upper_raw = last_sleep_ms.saturating_mul(3).max(lower);
    let upper = upper_raw.min(cap_ms);
    if upper <= lower {
        return upper;
    }
    let span = upper - lower + 1;
    let r = pseudo_rand_u64();
    lower + (r % span)
}

/// std 依存だけで動く擬似乱数。スレッド/CPU の subsec ナノ秒 + プロセス時間を
/// 簡易 LCG で攪拌する。retry ジッタ用途のみで暗号用途不可。
fn pseudo_rand_u64() -> u64 {
    use std::time::SystemTime;
    let now = SystemTime::now();
    let nanos = now
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0)
        ^ (std::process::id() as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    // splitmix64 1 step
    let mut x = nanos.wrapping_add(0x9E37_79B9_7F4A_7C15);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}

/// retry 試行ごとの状態（Tauri event payload と外部公開 API で共有）。
#[derive(Debug, Clone)]
pub struct SpawnAttempt {
    /// 1-based の試行回数（1 = 初回、`max_retries` 到達まで）。
    pub attempt: usize,
    /// `max_retries` 設定値（policy から伝播）。
    pub max_retries: usize,
    /// 直前の試行の error 内容。初回は None。
    pub last_error: Option<String>,
    /// 次回試行までの sleep ms。最終試行 / 成功時は None。
    pub next_sleep_ms: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AS-201.1 DoD ①-1: jitter は `[base, upper]` 範囲に収まる。
    #[test]
    fn next_sleep_within_range() {
        let p = RetryPolicy::for_test();
        for last in [0u64, 10, 50, 100] {
            for _ in 0..200 {
                let s = p.next_sleep_ms(last);
                assert!(
                    s >= p.base_ms && s <= p.cap_ms,
                    "out of range: last={last} got={s} base={} cap={}",
                    p.base_ms,
                    p.cap_ms
                );
            }
        }
    }

    /// AS-201.1 DoD ①-2: cap 到達後は `[base, cap]` に収束。
    #[test]
    fn next_sleep_converges_to_cap() {
        let p = RetryPolicy::for_test(); // base=10, cap=100
        // last_sleep を cap より十分大きい値で何度回しても cap 内に収まる
        for _ in 0..500 {
            let s = p.next_sleep_ms(10_000);
            assert!(
                s <= p.cap_ms,
                "must be capped: got={s} cap={}",
                p.cap_ms
            );
            assert!(s >= p.base_ms);
        }
    }

    /// AS-201.1 DoD ①-3: 100 回試行で thundering herd 回避（標準偏差 > 一定）。
    /// 同じ last_sleep で複数回計算しても値がばらつくこと。
    #[test]
    fn next_sleep_is_jittered_not_constant() {
        let p = RetryPolicy::for_test();
        let samples: Vec<u64> = (0..100).map(|_| p.next_sleep_ms(50)).collect();
        let mean = samples.iter().sum::<u64>() as f64 / samples.len() as f64;
        let variance = samples
            .iter()
            .map(|s| {
                let diff = (*s as f64) - mean;
                diff * diff
            })
            .sum::<f64>()
            / samples.len() as f64;
        let stdev = variance.sqrt();
        // base=10, cap=100, last=50 → upper=min(100, 150)=100, lower=10
        // 期待標準偏差 ~ 26 (uniform [10,100] なら ~26)。緩めに 5 以上で thundering 回避と判定。
        assert!(
            stdev > 5.0,
            "jitter must produce variance: stdev={stdev} samples={samples:?}"
        );
    }

    /// AS-201.1 DoD ②: `RetryPolicy::Default` が contract.rs const と一致。
    #[test]
    fn default_policy_matches_contract_constants() {
        let p = RetryPolicy::default();
        assert_eq!(p.base_ms, SPAWN_RETRY_BASE_MS);
        assert_eq!(p.cap_ms, SPAWN_RETRY_CAP_MS);
        assert_eq!(p.max_retries, SPAWN_RETRY_MAX);
    }

    /// AS-201.1 DoD ③: pure 計算 (no tokio / no std::sync)。
    /// 単独 thread から呼んでも問題ない、複数 thread でも内部 lock なしで動くこと。
    #[test]
    fn no_internal_lock_safe_for_concurrent_call() {
        // 4 thread から同時に 100 回ずつ呼んで panic / hang しないこと
        let handles: Vec<_> = (0..4)
            .map(|_| {
                std::thread::spawn(|| {
                    let p = RetryPolicy::for_test();
                    for _ in 0..100 {
                        let _ = p.next_sleep_ms(10);
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
    }
}
