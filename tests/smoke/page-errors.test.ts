/**
 * 🔴 **赤が理由を持ってくるか**(#387)。
 *
 * ⚠ この helper は smoke が使うが、**純関数なので単体で検められる** ──
 *   実ブラウザでしか確かめられないと、間欠の赤でしか直せなくなる。
 */
import { describe, expect, it } from 'vitest';
import { consoleOrigin, firstAppFrame, rawFrame } from './page-errors';

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

/**
 * 🔴 **console のエラーが「どの面から出たか」を言うか**(#561)。
 *
 * ⚠ 値は**実測から写した** ── 箱の中の不正な svg を実ブラウザで踏ませたとき、
 *   `msg.location()` は `{ url: 'about:srcdoc', lineNumber: 0 }` を返した。
 */
describe('console の出所を 1 行だけ添える(#561)', () => {
  it('🔴 箱の中(sandbox の srcdoc)はそのまま名乗る', () => {
    // ⚠ ここが `about:srcdoc` と出れば「アプリではなく囲みの中身」と読める
    expect(consoleOrigin({ url: 'about:srcdoc', lineNumber: 0 })).toBe(' @ about:srcdoc');
  });

  it('🔴 アプリ本体は path で名乗る(port は落とす)', () => {
    const a = consoleOrigin({ url: 'http://localhost:1111/assets/x.js', lineNumber: 118 });
    const b = consoleOrigin({ url: 'http://localhost:2222/assets/x.js', lineNumber: 118 });
    expect(a).toBe(b);
    expect(a).toBe(' @ /assets/x.js:118');
  });

  it('🔴 採れなければ何も足さない(「不明」と書かない)', () => {
    expect(consoleOrigin(undefined)).toBe('');
    expect(consoleOrigin(null)).toBe('');
    expect(consoleOrigin({})).toBe('');
    expect(consoleOrigin({ url: '' })).toBe('');
  });

  it('⚠ 行番号 0 は付けない(「1 行目で起きた」と読めてしまう)', () => {
    expect(consoleOrigin({ url: 'about:srcdoc', lineNumber: 0 })).not.toContain(':0');
  });

  it('⚠ blob: / data: もそのまま(箱の印なので落とさない)', () => {
    expect(consoleOrigin({ url: 'blob:http://localhost:1/abc' })).toBe(
      ' @ blob:http://localhost:1/abc',
    );
  });

  it('⚠ 根の頁そのものも名乗る ── 箱と区別が付く側が大事である', () => {
    // ⚠ `firstAppFrame` は `/` を**飛ばす**(stack の中では名指しにならないので)。
    //    こちらは飛ばさない ── 「アプリの document から出た」こと自体が答えになる
    expect(consoleOrigin({ url: 'http://localhost:1/', lineNumber: 0 })).toBe(' @ /');
  });

  it('⚠ 壊れた URL でもそのまま返す(採れたものは捨てない)', () => {
    expect(consoleOrigin({ url: 'http://[bad/x.js', lineNumber: 3 })).toContain('http://[bad/x.js');
  });
});

/**
 * 🔴 **名指しできなくても stack を捨てない**(#387)。
 *
 * ⚠ #387 は **4 度観測して 4 度とも** `@ path:line` が付かなかった ── そのとき
 *   「stack が空」なのか「`<anonymous>` だけ」なのかが**区別できていない**。
 */
describe('名指しできない stack でも 1 行残す(#387)', () => {
  it('🔴 `<anonymous>` だけの stack でも、採れた 1 行を返す', () => {
    const stack = ["TypeError: x", '    at <anonymous>:1:1', '    at Array.forEach (<anonymous>)'].join(
      '\n',
    );
    // ⚠ 名指しの側は**これまでどおり空**(役割を変えていない)
    expect(firstAppFrame(stack)).toBe('');
    expect(rawFrame(stack)).toBe(' @? at <anonymous>:1:1');
  });

  it('⚠ 題名の行は返さない(`e.message` で既に出ている)', () => {
    expect(rawFrame('TypeError: 何か'), '題名を 2 度出している').toBe('');
  });

  it('🔴 stack が無ければ何も足さない(「不明」と書かない)', () => {
    expect(rawFrame(undefined)).toBe('');
    expect(rawFrame(null)).toBe('');
    expect(rawFrame('')).toBe('');
  });

  it('⚠ 長い行は切る(注入コードは 1 行が数千字になる)', () => {
    const long = `    at ${'x'.repeat(500)}`;
    const got = rawFrame(long);
    expect(got.length, '赤が読めない長さになっている').toBeLessThan(100);
    expect(got.endsWith('…'), '切ったことが分からない').toBe(true);
  });

  it('🔑 名指しできる stack では、こちらは使わない側が勝つ(呼び側の約束)', () => {
    // ⚠ 2 つの口が両方 1 行返す ── 呼び側は**名指しを優先**する(helpers.ts)
    const stack = '    at fn (http://localhost:1/a.js:2:3)';
    expect(firstAppFrame(stack)).toBe(' @ /a.js:2:3');
    expect(rawFrame(stack)).not.toBe('');
  });
});
