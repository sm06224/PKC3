import { describe, expect, it } from 'vitest';
import {
  estimateReadingMinutes,
  formatBodyStats,
  READING_SPEED_CPM,
} from '../../src/features/stats/body-stats';

describe('body-stats #1112', () => {
  it('標準読書速度は 500 文字/分', () => {
    expect(READING_SPEED_CPM).toBe(500);
  });

  describe('estimateReadingMinutes', () => {
    it('0 文字以下は 0 分', () => {
      expect(estimateReadingMinutes(0)).toBe(0);
      expect(estimateReadingMinutes(-5)).toBe(0);
    });

    it('1 文字〜500 文字は 1 分', () => {
      expect(estimateReadingMinutes(1)).toBe(1);
      expect(estimateReadingMinutes(250)).toBe(1);
      expect(estimateReadingMinutes(500)).toBe(1);
    });

    it('501 文字〜1000 文字は 2 分', () => {
      expect(estimateReadingMinutes(501)).toBe(2);
      expect(estimateReadingMinutes(1000)).toBe(2);
    });

    it('カスタム CPM でも正しく計算できる', () => {
      expect(estimateReadingMinutes(600, 600)).toBe(1);
      expect(estimateReadingMinutes(601, 600)).toBe(2);
    });
  });

  describe('formatBodyStats', () => {
    it('null の場合は「—」を返す', () => {
      expect(formatBodyStats(null)).toBe('—');
    });

    it('0 文字の場合は「0 文字」を返す（読了目安は出さない）', () => {
      expect(formatBodyStats(0)).toBe('0 文字');
    });

    it('1文字以上のときは文字数（カンマ区切り）と読了目安を返す', () => {
      expect(formatBodyStats(350)).toBe('350 文字 (読了 約 1 分)');
      expect(formatBodyStats(1500)).toBe('1,500 文字 (読了 約 3 分)');
      expect(formatBodyStats(10000)).toBe('10,000 文字 (読了 約 20 分)');
    });
  });
});
