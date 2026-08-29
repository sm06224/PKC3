/**
 * `features/split-frames.ts`(#505 段②)。
 *
 * ⚠ **「規則を別の綴りで書き直す」test にしない**(CLAUDE.md 2026-08-22)──
 * 期待値は**実装と別の観測**から作る。ここでは「入れた物が出てくるか」
 * 「外した物が消えるか」「幅から出る枠数が単調か」を見る。
 */
import { describe, expect, it } from 'vitest';
import {
  fittingSplitFrames,
  knownSplitLids,
  normalizeSplitLids,
  parseSplitLids,
  pinSplitLid,
  serializeSplitLids,
  SPLIT_FRAME_GAP_PX,
  SPLIT_FRAME_MAX,
  SPLIT_PINNED_MAX,
  unpinSplitLid,
} from '@features/split-frames';
import {
  READ_COLUMN_BASE_FONT_PX,
  READ_COLUMN_GAP_PX,
  readColumnMinPx,
} from '@features/read-columns';

/** 本文の標準の大きさ(px)。⚠ **13 を書かない** ── 実装から引く(CLAUDE.md §7)。 */
const BASE = READ_COLUMN_BASE_FONT_PX;

describe('留める / 外す(双方向)', () => {
  it('留めた物は出てくる', () => {
    expect(pinSplitLid([], 'a')).toEqual(['a']);
  });

  it('🔴 外せる ── 置けるなら外せる(user 指示 2026-08-23)', () => {
    const pinned = pinSplitLid(pinSplitLid([], 'a'), 'b');
    expect(pinned).toEqual(['a', 'b']);
    expect(unpinSplitLid(pinned, 'a')).toEqual(['b']);
  });

  it('同じ物を 2 度留めても増えず、並びも動かない', () => {
    const cur = ['a', 'b'];
    expect(pinSplitLid(cur, 'a')).toBe(cur); // 参照ごと同じ = 指紋が動かない
  });

  it('⚠ 上限に達したら足さない(古い物を黙って落とさない)', () => {
    let cur: readonly string[] = [];
    for (let i = 0; i < SPLIT_PINNED_MAX; i += 1) cur = pinSplitLid(cur, `p${i}`);
    expect(cur).toHaveLength(SPLIT_PINNED_MAX);
    const after = pinSplitLid(cur, 'over');
    expect(after).toBe(cur);
    expect(after).not.toContain('over');
    // ⚠ 前提: 満杯だったこと(空振りで通っていない)
    expect(cur).toContain(`p${SPLIT_PINNED_MAX - 1}`);
  });

  it('居ない物を外しても、配列は同じ参照のまま', () => {
    const cur = ['a'];
    expect(unpinSplitLid(cur, 'zzz')).toBe(cur);
  });

  it('空文字は留まらない', () => {
    expect(pinSplitLid([], '')).toEqual([]);
    expect(normalizeSplitLids(['', 'a', ''])).toEqual(['a']);
  });

  it('重複は畳まれ、上限で切られる', () => {
    const many = Array.from({ length: SPLIT_PINNED_MAX + 5 }, (_, i) => `x${i}`);
    expect(normalizeSplitLids([...many, ...many])).toHaveLength(SPLIT_PINNED_MAX);
  });
});

describe('消えたノートを指し続けない', () => {
  it('知らない lid は出す前に落ちる', () => {
    expect(knownSplitLids(['a', 'gone'], new Set(['a']))).toEqual(['a']);
  });

  it('全部知っているなら同じ参照(描き直しを起こさない)', () => {
    const cur = ['a', 'b'];
    expect(knownSplitLids(cur, new Set(['a', 'b']))).toBe(cur);
  });

  it('Map でも引ける(entryMetas をそのまま渡せる)', () => {
    const metas = new Map([['a', { title: 'A' }]]);
    expect(knownSplitLids(['a', 'b'], metas)).toEqual(['a']);
  });
});

describe('狭い画面 ── 枠は「減る」。丸ごと 1 枠へ落ちない', () => {
  const min = readColumnMinPx(BASE);

  it('🔴 3 枠は入らないが 2 枠は入る幅では、2 枠になる', () => {
    const w = min * 2 + SPLIT_FRAME_GAP_PX; // ちょうど 2 枠
    // ⚠ 前提: 3 枠には足りないこと(空振り防止)
    expect(w).toBeLessThan(min * 3 + SPLIT_FRAME_GAP_PX * 2);
    expect(fittingSplitFrames(w, 3, BASE)).toBe(2);
  });

  it('2 枠にも足りなければ 1 枠', () => {
    expect(fittingSplitFrames(min * 2 - 1, 4, BASE)).toBe(1);
  });

  it('広ければ望んだ数がそのまま出る', () => {
    const w = min * SPLIT_FRAME_MAX + SPLIT_FRAME_GAP_PX * (SPLIT_FRAME_MAX - 1);
    expect(fittingSplitFrames(w, SPLIT_FRAME_MAX, BASE)).toBe(SPLIT_FRAME_MAX);
  });

  it('⚠ 幅に対して単調 ── 広げて枠が減ることはない', () => {
    let prev = 1;
    for (let w = 100; w <= min * 5; w += 37) {
      const n = fittingSplitFrames(w, SPLIT_FRAME_MAX, BASE);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });

  it('🔴 文字を大きくすると、同じ幅で枠は減る(#509 と同じ向き)', () => {
    const w = min * 3 + SPLIT_FRAME_GAP_PX * 2;
    expect(fittingSplitFrames(w, 3, BASE)).toBe(3);
    expect(fittingSplitFrames(w, 3, BASE * 1.4)).toBeLessThan(3);
  });

  it('測れない幅では 1 枠(0 を「入る」と読まない)', () => {
    expect(fittingSplitFrames(0, 3, BASE)).toBe(1);
    expect(fittingSplitFrames(Number.NaN, 3, BASE)).toBe(1);
  });

  it('上限を超える要求は上限で頭打ち', () => {
    expect(fittingSplitFrames(1e6, 99, BASE)).toBe(SPLIT_FRAME_MAX);
  });
});

describe('保存の往復', () => {
  it('書いて読むと同じ', () => {
    const cur = ['a', 'b'];
    expect(parseSplitLids(serializeSplitLids(cur))).toEqual(cur);
  });

  it('壊れていても例外を投げず、空になる', () => {
    expect(parseSplitLids(null)).toEqual([]);
    expect(parseSplitLids('')).toEqual([]);
    expect(parseSplitLids('   ')).toEqual([]);
  });
});

describe('すき間は段組みと同じ --s5(2 つ目の 16 を書かない)', () => {
  it('同じ値である', () => {
    expect(SPLIT_FRAME_GAP_PX).toBe(READ_COLUMN_GAP_PX);
  });
});
