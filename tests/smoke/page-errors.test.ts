/**
 * 🔴 **赤が理由を持ってくるか**(#387)。
 *
 * ⚠ この helper は smoke が使うが、**純関数なので単体で検められる** ──
 *   実ブラウザでしか確かめられないと、間欠の赤でしか直せなくなる。
 */
import { describe, expect, it } from 'vitest';
import { firstAppFrame } from './page-errors';

/** 実 Chromium の stack(#387 の 2 度目の観測から形を写した)。 */
const REAL = [
  "TypeError: Failed to execute 'open' on 'Window': The provided callback is no longer runnable.",
  '    at http://localhost:41235/assets/index-D3qL.js:118:2049',
  '    at Array.forEach (<anonymous>)',
].join('\n');

describe('例外の出所を 1 行だけ添える(#387)', () => {
  it('🔴 出所を名指しできる最初のフレームを返す', () => {
    expect(firstAppFrame(REAL)).toBe(' @ /assets/index-D3qL.js:118:2049');
  });

  it('🔴 port は落とす(走るたびに変わる字を残さない)', () => {
    // ⚠ 残すと**同じ赤が毎回違う字面**になり、前回の観測と突き合わせられない
    const a = firstAppFrame('at http://localhost:1111/assets/x.js:1:2');
    const b = firstAppFrame('at http://localhost:2222/assets/x.js:1:2');
    expect(a).toBe(b);
    expect(a).toBe(' @ /assets/x.js:1:2');
  });

  it('🔴 stack が無ければ何も足さない(「不明」と書かない)', () => {
    // ⚠ 「不明」と書くと、*採れなかった*のか*そこが根*なのかが区別できない
    expect(firstAppFrame(undefined)).toBe('');
    expect(firstAppFrame(null)).toBe('');
    expect(firstAppFrame('')).toBe('');
  });

  it('🔴 名指しできないフレームしか無ければ何も足さない', () => {
    expect(firstAppFrame('Error: x\n    at Array.forEach (<anonymous>)')).toBe('');
    expect(firstAppFrame('Error: x\n    at <anonymous>:1:1')).toBe('');
  });

  it('⚠ 根の頁そのもの(`/`)は名指しにならないので飛ばす', () => {
    expect(firstAppFrame('at http://localhost:1/\n    at http://localhost:1/a.js:2:3')).toBe(
      ' @ /a.js:2:3',
    );
  });

  it('⚠ 括弧つきの書き方でも拾う', () => {
    expect(firstAppFrame('    at fn (http://localhost:1/b.js:4:5)')).toBe(' @ /b.js:4:5');
  });

  it('⚠ 壊れた URL でもそのまま返す(採れたものは捨てない)', () => {
    expect(firstAppFrame('at http://[bad/x.js:1:1')).toContain('http://[bad/x.js:1:1');
  });
});
