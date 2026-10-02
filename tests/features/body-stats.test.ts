import { describe, expect, it } from 'vitest';
import {
  formatBodyStats,
  formatSelectionStats,
  formatTaskProgress,
  selectionLineCount,
} from '../../src/features/stats/body-stats';

/**
 * 🔴 右の列の読了目安は、題名の下と**同じ 1 本の算出**(#1087、裁定 2026-10-01)。
 *
 * ⚠ 期待値は `reading-time.ts` の関数を**呼ばずに**、規則(日本語 500 字/分・英語 200 語/分・
 *   空白と改行は数えない・200 字未満は出さない)から手で出した数で書く ──
 *   実装の呼び出しを写すと、実装が 500 字/分へ戻っても同じ値で一致してしまう。
 */
describe('formatBodyStats ── 文字数と読了目安(#1112 / #1087)', () => {
  it('null は「—」/ 0 文字は「0 文字」(読了目安は出さない)', () => {
    expect(formatBodyStats(null)).toBe('—');
    expect(formatBodyStats(0)).toBe('0 文字');
    expect(formatBodyStats(-1, 'x')).toBe('0 文字');
  });

  it('🔴 英単語 1,000 個 → 約 5 分(英語は 200 語/分。生の長さ 5,000 ÷ 500 で「10 分」と出ない)', () => {
    const body = 'word '.repeat(1000);
    expect(body.length).toBe(5000);
    expect(formatBodyStats(body.length, body)).toBe('5,000 文字 (読了 約 5 分)');
  });

  it('🔴 日本語 2,500 字 → 約 5 分(500 字/分)', () => {
    const body = 'あ'.repeat(2500);
    expect(formatBodyStats(body.length, body)).toBe('2,500 文字 (読了 約 5 分)');
  });

  it('🔴 「あ」+改行 ×300 → 約 1 分(改行は読む時間に数えない。生の長さ 600 ÷ 500 で「2 分」と出ない)', () => {
    const body = 'あ\n'.repeat(300);
    expect(body.length).toBe(600);
    expect(formatBodyStats(body.length, body)).toBe('600 文字 (読了 約 1 分)');
  });

  it('🔴 先頭の設定行(frontmatter)は読む時間に数えない', () => {
    const fm = '---\ntitle: ' + 'x'.repeat(2000) + '\n---\n';
    const body = fm + 'あ'.repeat(250);
    // 本文の実質は 250 字 → 1 分。設定行まで数えると 2,000 字ぶん増えて 5 分になる
    expect(formatBodyStats(body.length, body)).toBe(
      `${body.length.toLocaleString('ja-JP')} 文字 (読了 約 1 分)`,
    );
  });

  it('🔴 日本語 10 字(200 字未満)→ 分数を出さず「10 文字」だけ(題名の下と同じ)', () => {
    const body = 'あいうえおかきくけこ';
    expect(formatBodyStats(body.length, body)).toBe('10 文字');
  });

  it('🔴 本文が手元に無いとき(閉じている)は分数を出さない ── 字数だけから 2 本目の算出で埋めない', () => {
    expect(formatBodyStats(1200)).toBe('1,200 文字');
    expect(formatBodyStats(1200, null)).toBe('1,200 文字');
  });

  it('「N 文字」は生の長さのまま(カンマ区切り)', () => {
    const body = 'あ'.repeat(10000);
    expect(formatBodyStats(body.length, body)).toBe('10,000 文字 (読了 約 20 分)');
  });
});

describe('formatTaskProgress ── チェック項目の進み具合(#1216)', () => {
  it('「済み / 全部 完了 (割合%)」', () => {
    expect(formatTaskProgress(10, 4)).toBe('4 / 10 完了 (40%)');
    expect(formatTaskProgress(1, 1)).toBe('1 / 1 完了 (100%)');
    expect(formatTaskProgress(5, 0)).toBe('0 / 5 完了 (0%)');
  });

  it('🔴 割合は切り捨て(99.5% を 100% と出さない)', () => {
    expect(formatTaskProgress(200, 199)).toBe('199 / 200 完了 (99%)');
    expect(formatTaskProgress(3, 2)).toBe('2 / 3 完了 (66%)');
    expect(formatTaskProgress(3, 1)).toBe('1 / 3 完了 (33%)');
    expect(formatTaskProgress(8, 7)).toBe('7 / 8 完了 (87%)');
  });

  it('🔴 0 件は null(0 / 0 を出さず、呼ぶ側が行ごと畳む)', () => {
    expect(formatTaskProgress(0, 0)).toBeNull();
    expect(formatTaskProgress(Number.NaN, 0)).toBeNull();
  });

  it('全部より多い済みは全部に丸める(100% を超えない)', () => {
    expect(formatTaskProgress(2, 5)).toBe('2 / 2 完了 (100%)');
  });
});

/**
 * 🔴 選んだ範囲の行数と整形(#1215)。
 *
 * ⚠ 期待値は**手で数えた値**(実装の `indexOf` 式を写さない)。
 */
describe('selectionLineCount ── 選んだ範囲の行数(#1215)', () => {
  const t = 'abc\ndef\nghi';
  it('選んでいなければ 0', () => {
    expect(selectionLineCount(t, 2, 2)).toBe(0);
    expect(selectionLineCount(t, 5, 3)).toBe(0);
  });
  it('区切りの数 + 1', () => {
    expect(selectionLineCount(t, 0, 2)).toBe(1);
    expect(selectionLineCount(t, 2, 5)).toBe(2); // c ⏎ d
    expect(selectionLineCount(t, 0, t.length)).toBe(3);
  });
  it('🔴 末尾の改行で選択が終わるときは、次の行を数えない', () => {
    expect(selectionLineCount(t, 0, 4)).toBe(1); // 'abc\n'
    expect(selectionLineCount(t, 0, 8)).toBe(2); // 'abc\ndef\n'
    // 対照群: 改行の次の 1 字まで選べば次の行に入る
    expect(selectionLineCount(t, 0, 5)).toBe(2);
    expect(selectionLineCount(t, 0, 9)).toBe(3);
  });
  it('改行だけを選んでも 1 行 / 空行をまたぐ改行 2 つは 2 行', () => {
    expect(selectionLineCount('a\n\nb', 1, 2)).toBe(1);
    expect(selectionLineCount('a\n\nb', 1, 3)).toBe(2);
  });
});

describe('formatSelectionStats ── 帯に出す字(#1215)', () => {
  it('「選択: N 文字(M 行)」。桁区切りは formatBodyStats と同じ ja-JP', () => {
    expect(formatSelectionStats(142, 3)).toBe('選択: 142 文字(3 行)');
    expect(formatSelectionStats(12345, 1200)).toBe('選択: 12,345 文字(1,200 行)');
    // 単位の字は右の列と同じ「文字」
    expect(formatBodyStats(12345)).toContain('12,345 文字');
  });
  it('選んでいない(0 以下)は空 ── 枠は残るが字は無い', () => {
    expect(formatSelectionStats(0, 0)).toBe('');
    expect(formatSelectionStats(-3, 2)).toBe('');
  });
});
