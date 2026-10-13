/**
 * #1087: findOpenEnds の「行 → 囲い」を 1 回の表にした。
 * 🔑 期待値は直す前の探し方(行ごとに containerAtLine)をここへ書き写したもの ── 全数で突き合わせる。
 */
import { describe, expect, it } from 'vitest';
import { containerAtLine, findOpenEnds, scanContainers } from '../../../src/features/markdown/source-blocks';

function before(text: string): string[] {
  // 囲いの中の行を、直す前の探し方で数える(行内の判定は同じ関数に任せ、ここは囲いの当て方だけ比べる)
  const spans = scanContainers(text);
  const lines = text.split(/\r\n|\n|\r/);
  return lines.map((_, i) => {
    const c = containerAtLine(spans, i);
    return c === null ? '-' : `${c.kind}:${c.start}`;
  });
}

const PIECES = ['本文', '**太', '`x', '[リンク', '```js', '```', ':::note', ':::', '~~~', '> 引用', '- [ ] やる', ''];

function randomDoc(seed: number, n: number): string {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return Array.from({ length: n }, () => PIECES[Math.floor(rnd() * PIECES.length)]!).join('\n');
}

describe('#1087 findOpenEnds の囲いの表', () => {
  it('🔴 無作為な本文 300 本で、直す前の探し方と同じ答えになる(閉じ忘れを含む)', () => {
    let fenced = 0;
    let marks = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const text = randomDoc(seed, 40);
      const spans = scanContainers(text);
      if (spans.some((a) => a.kind === 'fence')) fenced += 1;
      // 期待: 直す前の探し方で囲いの中と読まれた行は、行内の印を出さない(fence)
      const want = before(text);
      const got = findOpenEnds(text);
      for (const o of got) {
        if (o.kind !== 'inline') continue;
        marks += 1;
        expect(want[o.line]!.startsWith('fence'), `seed ${seed} 行 ${o.line}: 囲いの中なのに行内の印を出した`).toBe(false);
      }
      // 期待の側からも見る: 囲いの外で行内が閉じていない行は、印が出る
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const odd = (lines[i]!.split('**').length - 1) % 2 === 1;
        if (!odd || want[i] !== '-') continue;
        expect(
          got.some((o) => o.line === i && o.kind === 'inline'),
          `seed ${seed} 行 ${i}: 囲いの外の閉じていない ** に印が出ない`,
        ).toBe(true);
      }
    }
    expect(fenced, '空振り防止: 囲いのある本文が少なすぎる').toBeGreaterThan(100);
    expect(marks, '空振り防止: 行内の印が 1 つも出ていない').toBeGreaterThan(100);
  });
});
