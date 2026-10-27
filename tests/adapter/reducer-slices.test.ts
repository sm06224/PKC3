/**
 * #1383: reducer の slice 分割の整合 pin。
 * 網羅は tsc が見る(`Extract<Dispatchable, …>` と switch)── ここでは「分割が実在し、
 * 領域をまたいで同じ action を二重に持っていない」ことと、reduceCore の列挙と slice の中身が揃うことを見る。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { reducerSliceFiles } from '../helpers/reducer-source';

const CORE = readFileSync('src/adapter/state/app-state.ts', 'utf-8');

function labelsOf(src: string): string[] {
  return [...src.matchAll(/^ {4}case '([A-Z0-9_]+)':/gm)].map((m) => m[1] as string);
}

describe('reducer slices (#1383)', () => {
  const files = reducerSliceFiles();

  it('slice が実在する(空振り防止)', () => {
    // 等値で pin(slice を足す・消すときは、ここと reduceCore の列挙を一緒に直す)
    expect(files.length).toBe(22);
  });

  it.each(files)('%s: 型の union・自分の switch・reduceCore の列挙が同じ action 集合', (f) => {
    const src = readFileSync(f, 'utf-8');
    const union = /export type \w+Action = Extract<Dispatchable, \{ type: ([^}]+) \}>;/.exec(src);
    expect(union, '型の union が見つからない').not.toBeNull();
    const fromType = [...(union?.[1] ?? '').matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1] as string).sort();
    const fromSwitch = labelsOf(src).sort();
    expect(fromSwitch).toEqual(fromType);
    const fn = /export function (reduce\w+)\(/.exec(src)?.[1] ?? '';
    expect(fn).not.toBe('');
    // reduceCore 側: この関数へ渡す label が全部並んでいる
    const at = CORE.indexOf(`return ${fn}(state, action);`);
    expect(at, `reduceCore が ${fn} を呼んでいない`).toBeGreaterThan(0);
    const before = CORE.slice(0, at);
    const tail = before.slice(before.lastIndexOf(';\n'));
    const fromCore = labelsOf(tail).sort();
    expect(fromCore).toEqual(fromType);
  });

  it('同じ action を 2 つの slice が持たない', () => {
    const all = files.flatMap((f) => labelsOf(readFileSync(f, 'utf-8')));
    expect(all.length).toBe(248);
    expect(new Set(all).size).toBe(all.length);
  });

  it('reduceCore の列挙に同じ label が 2 度出ない(数えて pin。Set にして隠さない)', () => {
    const core = labelsOf(CORE.slice(CORE.indexOf('function reduceCore(')));
    const slices = files.flatMap((f) => labelsOf(readFileSync(f, 'utf-8')));
    expect(core.length).toBe(slices.length);
    expect(new Set(core).size).toBe(core.length);
  });

  it('reduceCore には case 本体が残っていない(label の列挙と slice への委譲だけ)', () => {
    const body = CORE.slice(CORE.indexOf('function reduceCore('));
    const end = body.indexOf('\n}\n');
    const lines = body
      .slice(0, end)
      .split('\n')
      .slice(5)
      .filter((l) => l.trim() !== '' && l !== '  }');
    const other = lines.filter((l) => !/^ {4}case '[A-Z0-9_]+':$/.test(l) && !/^ {6}return reduce\w+\(state, action\);$/.test(l));
    expect(other).toEqual([]);
    expect(lines.length).toBeGreaterThan(244);
  });

  it('slice の label は全部 reduceCore に列挙されている(列挙漏れで届かない case が無い)', () => {
    const rest = new Set(labelsOf(CORE.slice(CORE.indexOf('function reduceCore('))));
    for (const f of files) for (const l of labelsOf(readFileSync(f, 'utf-8'))) {
      expect(rest.has(l), `${f}: ${l}`).toBe(true);
    }
  });
});
