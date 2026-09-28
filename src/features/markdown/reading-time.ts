/**
 * 🔴 **長文ノートの読了目安時間と文字数の算出** (#1137)。
 *
 * 設計:
 * - frontmatter は除外して実質本文のみを計算対象とする。
 * - 読書速度基準:
 *   - 日本語 (CJK 文字): 約 500 文字 / 分
 *   - 欧文 (単語): 約 200 単語 / 分
 * - 閾値: 200 文字未満の短文メモでは余計なノイズにならないよう非表示 (label: null) とする。
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

const CJK_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const WORD_REGEX = /\b[a-zA-Z0-9_-]+\b/g;

/**
 * Markdown 本文から実質文字数と読了目安時間を算出する。
 */
export function estimateReadingTime(markdown: string): ReadingTimeEstimate {
  const content = bodyBelowFrontmatter(markdown);
  // 空白・改行を除去した実質文字数
  const stripped = content.replace(/\s+/g, '');
  const charCount = stripped.length;

  if (charCount < READING_TIME_THRESHOLD_CHARS) {
    return {
      minutes: 0,
      charCount,
      label: null,
    };
  }

  const cjkMatches = content.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;

  // CJK 以外の単語数
  const withoutCjk = content.replace(CJK_REGEX, ' ');
  const words = withoutCjk.match(WORD_REGEX);
  const wordCount = words ? words.length : 0;

  const estimatedMinutes = cjkCount / 500 + wordCount / 200;
  const minutes = Math.max(1, Math.ceil(estimatedMinutes));

  const formattedChars = charCount.toLocaleString('ja-JP');
  const label = `約 ${minutes} 分 (${formattedChars} 文字)`;

  return {
    minutes,
    charCount,
    label,
  };
}
