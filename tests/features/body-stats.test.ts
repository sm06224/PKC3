import { describe, expect, it } from 'vitest';
import { formatBodyStats } from '../../src/features/stats/body-stats';

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
