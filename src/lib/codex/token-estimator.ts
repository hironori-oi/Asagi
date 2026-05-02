/**
 * Token estimator (DEC-018-026 ① B)。
 *
 * mock 段階での「擬似 token 数」計算を一箇所に集約する抽象。
 * 内部ロジックは単純なヒューリスティック:
 *   - 空白で split したワード数
 *   - そこに 1.3 倍の補正係数（英語の subword 分割を粗く再現）
 *   - CJK 文字 (ヒラガナ / カタカナ / 漢字 / 全角記号) は 1 字 = 1 token に近いので、
 *     CJK 文字数を別計上して合算
 *
 * このファイルは Real impl 切替時に **唯一** 差し替えれば良い。
 *
 * TODO Real impl: replace with Codex CLI usage info from turn/finish.usage
 * (リサーチ research-report-v2.md § 5 で Real protocol 上の usage 構造体を取得し、
 *  `turn/completed` の payload に含まれる `usage.outputTokens` 等を返す実装に
 *  差し替えること。本ヒューリスティックは「Real impl 不在時の体験完成度」確保のみが目的)。
 */

/** 空白区切りワードに掛ける補正係数。英語 subword 想定で 1.3 倍。 */
export const WORD_TOKEN_MULTIPLIER = 1.3;

/**
 * 擬似 token 数を返す。負値にはならず、空文字なら 0。
 *
 * 計算式:
 *   tokens = ceil(asciiWords * 1.3 + cjkChars)
 *
 * 例:
 *   - "" → 0
 *   - "hello" → ceil(1 * 1.3) = 2
 *   - "hello world from codex" → ceil(4 * 1.3) = 6
 *   - "こんにちは" → ceil(0 + 5) = 5
 *   - "Hello こんにちは" → ceil(1 * 1.3 + 5) = 7
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // CJK 文字 (ヒラガナ / カタカナ / CJK 統合漢字 / 全角句読点を含む CJK 記号)
  const cjkRegex = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g;
  const cjkChars = (text.match(cjkRegex) ?? []).length;

  // CJK を除去した残りを ASCII / 拡張ラテンとして扱い、空白 split
  const nonCjk = text.replace(cjkRegex, ' ');
  const words = nonCjk.split(/\s+/).filter((w) => w.length > 0);
  const asciiTokens = words.length * WORD_TOKEN_MULTIPLIER;

  return Math.ceil(asciiTokens + cjkChars);
}
