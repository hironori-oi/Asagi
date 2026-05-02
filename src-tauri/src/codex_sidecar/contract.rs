//! Codex CLI 0.128.0 実機契約定数（DEC-018-033 codify）。
//!
//! Phase 0 POC #2〜#5（2026-05-02 オーナー実機 Win11 / Codex CLI 0.128.0 / Pro 5x）で
//! 実測確定した、Codex CLI `app-server` JSON-RPC への正しい起動引数 / method 名 /
//! type 名 / field 名 / プロセス制御挙動を **単一の真実の源** として固定する。
//!
//! # 厳守事項（DEC-018-034 / PM § 6.5）
//!
//! - Real impl 側（`real.rs` / `multi.rs`）で schema 関連の文字列リテラルを
//!   ハードコードしてはならない。**必ず本モジュールの定数を import して使う**こと。
//! - Review 部門は real.rs / multi.rs / auth_watchdog.rs において、本ファイル外で
//!   `"app-server"` / `"thread/started"` / `"agentMessage"` / `"item/agentMessage/delta"` /
//!   `"turn/completed"` / `"image_url"` 等の生文字列リテラルを発見した場合は reject すること。
//!
//! # 変更時の手順
//!
//! 1. AS-Q-03（codex-schema-watch）が新スキーマを検知した時点でまず本モジュールを更新
//! 2. `decisions.md` に DEC-018-033 改訂を起票（旧→新の差分と起因 release 番号を明記）
//! 3. `codex-schema/snapshots/<日付>.ts` のうち最新版に対応するベースラインタグを
//!    `0.128.0-asagi-contract-v1` から繰り上げ更新（v2 / v3 ...）
//!
//! # 由来
//!
//! - `reports/poc-phase0-result.md` § 3
//! - `decisions.md` DEC-018-033（5 schema discovery codify）
//! - `risks.md` v1.4 R-WBS-1（Codex 0.129 系 release drift）

// =============================================================================
// AUTO-GENERATED FROM POC #2-#5 (2026-05-02)
// 変更時は AS-Q-03 codex-schema-watch CI の baseline 更新と DEC-018-033 改訂を伴うこと
// Schema baseline tag: 0.128.0-asagi-contract-v1
// =============================================================================

/// Codex app-server 起動引数。
///
/// **`--listen stdio` ではなく `--listen stdio://`（URL スキーム必須）**。
/// POC #2 で `stdio` 単独指定は ENOENT で即落ちすることを実機確認した。
/// リサーチ v1/v2 では未指摘だった挙動 → DEC-018-033 ① で codify。
pub const CODEX_APP_SERVER_ARGS: &[&str] = &["app-server", "--listen", "stdio://"];

/// Windows での実体 codex.exe パス（npm `@openai/codex` グローバルインストール時、
/// `%APPDATA%` 直下からの相対）。
///
/// `codex` cmd ラッパ経由で spawn すると JobObject 結合がラッパ PID にしか効かず
/// 実体プロセスが breakaway する事例が POC #5 で確認されたため、
/// **必ず本パスの実体 .exe を直接 spawn** する（DEC-018-033 ②）。
pub const CODEX_BIN_WIN_RELATIVE: &str =
    "npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe";

/// `thread.id` 取得 race 対策のための `thread/started` notification method 名。
///
/// `thread/start` request の response.result に `thread.id` が乗らないケースが
/// POC #3 で観測されたため、**notification 経由の polling を必須化**する
/// （DEC-018-033 ③）。
pub const THREAD_ID_NOTIFICATION_METHOD: &str = "thread/started";

/// `thread/started` notification を待つ際の polling 間隔（ms）。
pub const THREAD_ID_POLL_INTERVAL_MS: u64 = 100;

/// `thread/started` notification を待つ際の最大待機時間（ms）。
/// 2 秒以内に届かなければ `thread/start` 失敗とみなす。
pub const THREAD_ID_POLL_MAX_MS: u64 = 2000;

/// `item/completed` notification における assistant 応答の type 識別子。
///
/// **旧版想定の `assistantMessage` は誤り**。POC #3 で実機は `agentMessage` を返却。
/// `userMessage` の `item/completed` も先に流れるため、type を限定しないと自分の
/// 入力を完了扱いしてしまう。DEC-018-033 ④ で固定。
pub const ITEM_COMPLETED_AGENT_TYPE: &str = "agentMessage";

/// streaming delta notification の method 名（DEC-018-033 ⑤）。
///
/// **`item/assistantMessage/delta` ではなく `item/agentMessage/delta`**。
pub const ITEM_DELTA_METHOD: &str = "item/agentMessage/delta";

/// turn 完了通知の method 名。
pub const TURN_COMPLETED_METHOD: &str = "turn/completed";

/// 画像 input message item の type 識別子。
///
/// `{ "type": "image", "url": "data:image/png;base64,..." }` が正解。
/// Responses API 風の `image_url` ではない（POC #4 で実機確認）。
pub const IMAGE_INPUT_TYPE: &str = "image";

/// 画像 input message item の url field 名。
///
/// **`image_url` ではなく `url`**。data URL 形式（`data:image/png;base64,...`）を
/// そのまま渡せる（DEC-018-030 base64 fallback と整合）。
pub const IMAGE_URL_FIELD: &str = "url";

/// JobObject 制御モード。
///
/// `CREATE_BREAKAWAY_FROM_JOB` を試行する。親シェル Job が拒否しても fallback で
/// nested Job として動作し、`KILL_ON_JOB_CLOSE` は Win11 で正しく機能することが
/// POC #5 で実証済み（リサーチ RAs-12 完全解消）。
pub const JOB_USE_BREAKAWAY: bool = true;

#[cfg(test)]
mod tests {
    use super::*;

    /// AS-140.0 完了条件: contract 定数が POC #2-#5 の実測値と完全一致すること。
    /// 文字列リテラルが実装ファイル側で誤改変されていないかを golden test として担保する。
    #[test]
    fn contract_constants_match_poc_phase0_truth() {
        assert_eq!(
            CODEX_APP_SERVER_ARGS,
            &["app-server", "--listen", "stdio://"]
        );
        assert!(CODEX_BIN_WIN_RELATIVE.ends_with("codex.exe"));
        assert!(CODEX_BIN_WIN_RELATIVE.contains("@openai\\codex-win32-x64"));
        assert_eq!(THREAD_ID_NOTIFICATION_METHOD, "thread/started");
        assert_eq!(THREAD_ID_POLL_INTERVAL_MS, 100);
        assert_eq!(THREAD_ID_POLL_MAX_MS, 2000);
        assert_eq!(ITEM_COMPLETED_AGENT_TYPE, "agentMessage");
        assert_eq!(ITEM_DELTA_METHOD, "item/agentMessage/delta");
        assert_eq!(TURN_COMPLETED_METHOD, "turn/completed");
        assert_eq!(IMAGE_INPUT_TYPE, "image");
        assert_eq!(IMAGE_URL_FIELD, "url");
        // JOB_USE_BREAKAWAY は const bool ＝ コンパイル時に値固定。
        // ランタイム assert! は clippy::assertions_on_constants に該当するため
        // const evaluation context で同等の golden 表明を行う。
        const _: () = assert!(JOB_USE_BREAKAWAY);
    }

    /// schema 違反の早期検知: 旧版/誤った値で固定されていないこと（DEC-018-033 trap）。
    #[test]
    fn contract_does_not_regress_to_pre_poc_assumptions() {
        // 旧誤値 1: --listen stdio (URL スキームなし) は POC #2 で ENOENT
        assert!(!CODEX_APP_SERVER_ARGS.contains(&"stdio"));
        // 旧誤値 2: assistantMessage は POC #3 で否定
        assert_ne!(ITEM_COMPLETED_AGENT_TYPE, "assistantMessage");
        assert_ne!(ITEM_DELTA_METHOD, "item/assistantMessage/delta");
        // 旧誤値 3: image_url は POC #4 で否定
        assert_ne!(IMAGE_URL_FIELD, "image_url");
    }
}
