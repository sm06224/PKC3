import { describe, expect, it } from 'vitest';
import {
  estimateReadingTime,
  READING_TIME_THRESHOLD_CHARS,
} from '../../src/features/markdown/reading-time';

describe('estimateReadingTime ── 読了目安時間と文字数の算出 (#1137)', () => {
  it('200文字未満の短文では label が null になる', () => {
    const text = '短いメモです。';
    const res = estimateReadingTime(text);
    expect(res.charCount).toBeLessThan(READING_TIME_THRESHOLD_CHARS);
    expect(res.label).toBeNull();
  });

  it('200文字以上の日本語で約 1 分と判定される', () => {
    // 250文字の日本語
    const text = 'あ'.repeat(250);
    const res = estimateReadingTime(text);
    expect(res.charCount).toBe(250);
    expect(res.minutes).toBe(1);
    expect(res.label).toBe('約 1 分 (250 文字)');
  });

  it('1,000文字の日本語で約 2 分と判定される (500文字/分)', () => {
    const text = 'あいうえおかきくけこさしすせそたちつてと'.repeat(50); // 20字 * 50 = 1000字
    const res = estimateReadingTime(text);
    expect(res.charCount).toBe(1000);
    expect(res.minutes).toBe(2);
    expect(res.label).toBe('約 2 分 (1,000 文字)');
  });

  it('英文中心の長文で単語数 (200語/分) に基づき推定される', () => {
    // 400単語の英文
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const res = estimateReadingTime(words);
    expect(res.minutes).toBe(2);
    expect(res.label).toContain('約 2 分');
  });

  it('frontmatter が含まれている場合、frontmatter を除外して本文のみをカウントする', () => {
    const frontmatter = '---\ntitle: 長大なフロントマター\ncategory: test\ntags: [a, b, c]\n---\n';
    const body = '短い本文。';
    const res = estimateReadingTime(frontmatter + body);
    expect(res.charCount).toBe(5);
    expect(res.label).toBeNull();
  });
});
