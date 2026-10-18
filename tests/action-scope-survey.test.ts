/**
 * 🔴 **「指さないと始められない操作」の全数仕分けを腐らせない**(#582 R1)。
 *
 * 1. 受け手を 1 つ残らず仕分けている(実在しない受け手・二重割り当ては assign() が投げる)
 * 2. 名指しの錨(5 種それぞれの代表が変わっていない)
 * 3. 点引数(P1)が過半ではない(= 推薦「パレットが床」が立つ条件)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error -- CI script は素の .mjs(ビルド対象外)
import { receivers as receiversRaw } from '../scripts/action-outlets.mjs';
import {
  E,
  P1,
  P2,
  V,
  assign as assignRaw,
  classify as classifyRaw,
  counts as countsRaw,
  // @ts-expect-error -- CI script は素の .mjs(ビルド対象外)
} from '../scripts/action-scope-survey.mjs';

type Cls = 'P1' | 'P2' | 'E' | 'V' | 'N';
const receivers = receiversRaw as () => string[];
const classify = classifyRaw as () => Map<string, Cls>;
const counts = countsRaw as () => Record<Cls, number>;
const assign = assignRaw as (
  all: readonly string[],
  groups: readonly (readonly [string, readonly string[]])[],
) => Map<string, string>;

const DOC = 'docs/development/operation-model-2026-08.md';

function docCounts(): Record<Cls, number> {
  const text = readFileSync(DOC, 'utf-8');
  const at = text.indexOf('### 7.1');
  if (at < 0) throw new Error(`${DOC} に §7.1 が無い(doc の形が変わった)`);
  const seg = text.slice(at, text.indexOf('\n## ', at) < 0 ? text.length : text.indexOf('\n## ', at));
  const out = {} as Record<Cls, number>;
  for (const [key, label] of [
    ['P1', 'P1 真の点'],
    ['P2', 'P2 現在地で代替'],
    ['E', 'E 列挙'],
    ['V', 'V 値'],
    ['N', 'N 名詞'],
  ] as const) {
    const m = new RegExp(`^\\| \\*\\*${label}\\*\\* \\| \\*{0,2}(\\d+)`, 'm').exec(seg);
    if (m === null || m[1] === undefined) throw new Error(`§7.1 の表に「${label}」の行が無い`);
    out[key] = Number(m[1]);
  }
  return out;
}

describe('#582 R1 ── 受け手の引数の仕分け', () => {
  it('🔴 受け手を 1 つ残らず仕分けている(実在しない受け手・二重割り当てが無い)', () => {
    const map = classify();
    expect(map.size, '仕分けが受け手と揃っていない').toBe(receivers().length);
  });

  it('🔴 種別ごとの件数が仕分け表と一致し、空振りしていない', () => {
    const c = counts();
    expect(c.P1).toBe((P1 as string[]).length);
    expect(c.P2).toBe((P2 as string[]).length);
    expect(c.E).toBe((E as string[]).length);
    expect(c.V).toBe((V as string[]).length);
    expect(c.N).toBe(receivers().length - c.P1 - c.P2 - c.E - c.V);
    expect(c.N).toBeGreaterThan(150);
  });

  it('🔴 名指しの錨 ── 件数が同じまま入れ替わっても落ちる', () => {
    const m = classify();
    expect(m.get('edit-cell'), '表のセルは、どのセルを押したかが要る').toBe('P1');
    expect(m.get('select-entry'), '行の選択は selectedLid で代替できる').toBe('P2');
    expect(m.get('set-view'), '面の切替は閉じた選択肢').toBe('E');
    expect(m.get('set-app-icon'), 'アイコンは欄の値(対象は selectedLid)').toBe('V');
    expect(m.get('open-palette'), 'パレットを開くのに引数は要らない').toBe('N');
  });

  it('🔴 doc §7.1 の表が 5 種別すべてを持ち、点引数が過半ではない', () => {
    const dc = docCounts();
    for (const k of ['P1', 'P2', 'E', 'V', 'N'] as const) {
      expect(dc[k], `doc §7.1 の ${k} が 0`).toBeGreaterThan(0);
    }
    const c = counts();
    const total = (Object.values(c) as number[]).reduce((a, b) => a + b, 0);
    expect(c.P1 * 2, `点引数が過半になった(${c.P1}/${total})── doc §7 条件①により推薦を見直す`)
      .toBeLessThan(total);
  });
});

describe('#582 R1 ── 仕分けの門', () => {
  it('🔴 実在しない受け手を割り当てたら投げる(綴り違いが静かに N へ落ちない)', () => {
    expect(() => assign(['a', 'b'], [['P1', ['a', 'typo-b']]])).toThrow(/実在しない受け手/);
  });

  it('🔴 同じ受け手を 2 度割り当てたら投げる', () => {
    expect(() => assign(['a'], [['P1', ['a']], ['E', ['a']]])).toThrow(/二重に割り当てた/);
  });

  it('⚠ 割り当てなかったものは N になる(対照群 ── 門が何でも投げるのではない)', () => {
    expect(assign(['a', 'b'], [['P1', ['a']]])).toEqual(new Map([['a', 'P1'], ['b', 'N']]));
  });
});
