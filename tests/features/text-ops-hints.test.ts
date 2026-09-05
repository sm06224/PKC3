/**
 * 🔴 **書式の表は、op ごとに「何が起きるか」の説明を持つ**(#717)。
 *
 * ⚠ 直す前は帯の 14 個に説明が 1 つも無く、「表」「番号」の 1 語で何が起きるか
 *   読めなかった。説明の正本は `FORMAT_OPS.hint`(描く側は引くだけ)── ここが見るのは
 *   **表の側**:全 op に説明が在り、字(label)と同じ語で済ませていないこと。
 *   帯に実際に載ったか(`title`)は `tests/adapter/format-bar-titles.test.ts` が見る。
 */
import { describe, expect, it } from 'vitest';
import { BAR_FORMAT_OPS, FORMAT_OPS } from '../../src/features/markdown/text-ops';

describe('書式の表の説明(#717)', () => {
  it('🔴 全 op が説明を持ち、字の言い直しになっていない', () => {
    // 空振り防止 ── 表が空なら「全部持っている」は自明に通る
    expect(FORMAT_OPS.length).toBeGreaterThan(10);
    for (const { op, label, hint } of FORMAT_OPS) {
      expect(hint.length, `${op} の説明が短すぎる(「${hint}」)`).toBeGreaterThanOrEqual(8);
      // ⚠ 「太字」の説明が「太字」では、乗せても何も増えない
      expect(hint, `${op} の説明が字と同じ`).not.toBe(label);
      // ⚠ 文言は**起きること**で書く ── 文の形(〜します)で終わる
      expect(hint, `${op} の説明が「起きること」の文になっていない`).toMatch(/(します|ます)[)]?$/);
    }
  });

  it('🔴 帯に並ぶ字は重複しない(同じ字が 2 つ在ると、押すまで違いが読めない)', () => {
    const labels = BAR_FORMAT_OPS.map((o) => o.label);
    expect(labels.length).toBeGreaterThan(10);
    expect(new Set(labels).size, `重複: ${labels.join(' / ')}`).toBe(labels.length);
  });
});
