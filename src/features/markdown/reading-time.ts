/**
 * 🔴 **長文ノートの読了目安時間と文字数の算出** (#1137)。
 *
 * 設計:
 * - frontmatter は除外して実質本文のみを計算対象とする。
 * - 読書速度基準:
 *   - 日本語 (CJK 文字): 約 500 文字 / 分
 *   - 欧文 (単語): 約 200 単語 / 分
 * - 閾値: 200 文字未満の短文メモでは余計なノイズにならないよう非表示 (label: null) とする。
 *
 * 🔴 **1 走査にした**(#1467 段 3-j、2026-10-10)。
 * 以前は正規表現 4 本(`\s+` の除去 / CJK の数え / CJK を空白に置く写し / 単語の数え)で本文を
 * 4 回なめ、720 KB(20,000 行)のノートで **1 回 280 ms**。追記 1 回で右の列(`formatBodyStats`)と
 * 題名の下(`paintReadingTime`)が同じ本文で呼ぶので、描き直しのたびに 2〜3 回分が主スレッドに乗っていた
 * (CPU profile で inspector の render 291 ms のうち 280 ms がここ)。
 * いまは 1 文字ずつ 1 回だけ読み、文字列の写しを作らない(720 KB で 1 回 約 10 ms)。
 * ⚠ 直前の答えを控える memo は置かない ── 別のノートへ移っても前の本文 720 KB を握り続ける形になり、
 *   「生成物はライフサイクル終端で即破棄」(user 指示 2026-07-27)に反する。控えで買えるのは 1 描き直し 20〜45 ms で、
 *   1 走査にしたぶん(280 → 約 10 ms)で足りる(着地前レビュー 2026-10-10)。
 * ⚠ 数え方は以前の正規表現と**同じ結果**でなければならない ── test が旧実装(参照)と総当たりで突き合わせる。
 */
import { bodyBelowFrontmatter } from './frontmatter';

export interface ReadingTimeEstimate {
  /** 読了目安分数 (分) */
  readonly minutes: number;
  /** 実質文字数 (空白・改行を除く) */
  readonly charCount: number;
  /** 表示用ラベル (閾値未満は null) */
  readonly label: string | null;
}

/** バッジを表示する最小文字数の閾値 */
export const READING_TIME_THRESHOLD_CHARS = 200;

/** JS の `\s` と同じ集合(UTF-16 の 1 単位で判定) */
function isWhitespace(c: number): boolean {
  return (
    c === 0x20 ||
    (c >= 0x09 && c <= 0x0d) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** 旧 `CJK_REGEX` と同じ範囲: ひらがな・カタカナ / 拡張 A / 統合漢字 / 互換漢字 */
function isCjk(c: number): boolean {
  return (
    (c >= 0x3040 && c <= 0x30ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xf900 && c <= 0xfaff)
  );
}

/** `[a-zA-Z0-9_]`(正規表現の `\w`) */
function isWordChar(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
}

/** 1 走査で数えた 3 つ(test が旧 regex の数え方と突き合わせる単位) */
export interface ReadingUnits {
  /** 空白(`\s`)を除いた UTF-16 単位の数 */
  readonly charCount: number;
  /** CJK の字数 */
  readonly cjkCount: number;
  /** `[a-zA-Z0-9_-]` の連なりのうち `\w` を 1 字でも含む物の数 */
  readonly wordCount: number;
}

/** frontmatter を除いた本文 `content` を 1 回だけなめて数える(写しを作らない) */
export function countReadingUnits(content: string): ReadingUnits {
  let charCount = 0;
  let cjkCount = 0;
  let wordCount = 0;
  let inRun = false;
  let runHasWord = false;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    if (!isWhitespace(c)) charCount += 1;
    if (isCjk(c)) {
      cjkCount += 1;
      if (inRun && runHasWord) wordCount += 1;
      inRun = false;
      runHasWord = false;
      continue;
    }
    if (isWordChar(c) || c === 0x2d) {
      inRun = true;
      if (c !== 0x2d) runHasWord = true;
      continue;
    }
    if (inRun && runHasWord) wordCount += 1;
    inRun = false;
    runHasWord = false;
  }
  if (inRun && runHasWord) wordCount += 1;
  return { charCount, cjkCount, wordCount };
}

/**
 * Markdown 本文から実質文字数と読了目安時間を算出する。
 *
 * 単語の数え方は旧 `\b[a-zA-Z0-9_-]+\b`(CJK を空白に置いた後)と同じ ──
 * `[a-zA-Z0-9_-]` の連なり 1 つを、その中に `\w` が 1 字でも在れば 1 語と数える
 * (`-` だけの連なりは 0 語。`foo--bar` も `foo--` も 1 語)。
 */
export function estimateReadingTime(markdown: string): ReadingTimeEstimate {
  const { charCount, cjkCount, wordCount } = countReadingUnits(bodyBelowFrontmatter(markdown));

  let result: ReadingTimeEstimate;
  if (charCount < READING_TIME_THRESHOLD_CHARS) {
    result = { minutes: 0, charCount, label: null };
  } else {
    const estimatedMinutes = cjkCount / 500 + wordCount / 200;
    const minutes = Math.max(1, Math.ceil(estimatedMinutes));
    const formattedChars = charCount.toLocaleString('ja-JP');
    result = { minutes, charCount, label: `約 ${minutes} 分 (${formattedChars} 文字)` };
  }
  return result;
}
