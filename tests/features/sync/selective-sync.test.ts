/**
 * 🔴 **選択同期(#2066 段 5-A)── 同期の対象の閉包(`resolveSelectiveClosure`)**。
 *
 * 見る物: 直接指定 / フォルダの下の再帰 / 親子の輪で止まる / 関連(off・1hop・recursive・輪・本文のリンク・板の `entry=`)/
 * 親フォルダの骨格 / 🔴 骨格で連れてきた親フォルダの中の他のノートは巻き込まない / system 領域は対象にしない / 決定的な並びと要約。
 */
import { describe, expect, it } from 'vitest';
import { RELATED_MAX_HOPS, relatedHops, resolveSelectiveClosure, selectionDigest, type SelectiveClosureInput } from '../../../src/features/sync/selective-sync';
import { bodyRefTargets } from '../../../src/adapter/platform/storage/sync-rows';

type N = { lid: string; archetype: string; parentLid: string | null };
const note = (lid: string, parentLid: string | null = null): N => ({ lid, archetype: 'text', parentLid });
const folder = (lid: string, parentLid: string | null = null): N => ({ lid, archetype: 'folder', parentLid });

function run(over: Partial<SelectiveClosureInput> & { notes: N[] }): ReturnType<typeof resolveSelectiveClosure> {
  return resolveSelectiveClosure({ relations: [], bodyRefs: {}, directLids: [], relatedMode: 'off', ...over });
}
const asObj = (c: ReturnType<typeof resolveSelectiveClosure>): Record<string, string> => Object.fromEntries([...c.reasons].sort(([a], [b]) => (a < b ? -1 : 1)));

describe('直接指定(direct)', () => {
  it('生きている通常のノートだけを対象にする(無い lid・system 領域は除く)', () => {
    const c = run({ notes: [note('a'), note('b'), note('sys-messages')], directLids: ['a', 'missing', 'sys-messages'] });
    expect(asObj(c)).toEqual({ a: 'direct' });
    expect(c.lids).toEqual(['a']);
  });

  it('何も指定していなければ空(選択同期で何も運ばない)', () => {
    const c = run({ notes: [note('a')], directLids: [] });
    expect(c.lids).toEqual([]);
  });
});

describe('フォルダの下(descendant)', () => {
  it('フォルダを指定すると、子・孫まで再帰でたどる。外の兄弟は入らない', () => {
    const notes = [folder('P'), folder('Q', 'P'), note('q1', 'Q'), note('p1', 'P'), note('outside'), folder('R'), note('r1', 'R')];
    const c = run({ notes, directLids: ['P'] });
    expect(asObj(c)).toEqual({ P: 'direct', Q: 'descendant', p1: 'descendant', q1: 'descendant' });
  });

  it('🔴 親子が輪になっていても止まる(無限ループしない)', () => {
    const notes = [folder('X', 'Y'), folder('Y', 'X'), note('x1', 'X')];
    const c = run({ notes, directLids: ['X'] });
    expect(asObj(c)).toEqual({ X: 'direct', Y: 'descendant', x1: 'descendant' });
  });

  it('direct が子孫より優先(指定したフォルダの下に、別に指定したノートがあっても direct のまま)', () => {
    const c = run({ notes: [folder('P'), note('p1', 'P')], directLids: ['P', 'p1'] });
    expect(asObj(c)).toEqual({ P: 'direct', p1: 'direct' });
    expect(c.directAndDescendant).toEqual(new Set(['P', 'p1']));
  });
});

describe('親フォルダの骨格(ancestor)', () => {
  it('🔴 回帰: サブフォルダの中の 1 ノートを指定 → 親フォルダの鎖は付くが、親フォルダの中の他のノートは巻き込まない', () => {
    const notes = [
      folder('Top'),
      note('topSibling', 'Top'),
      folder('Sub', 'Top'),
      note('target', 'Sub'),
      note('subSibling', 'Sub'),
      folder('Deep', 'Sub'),
      note('deep1', 'Deep'),
    ];
    const c = run({ notes, directLids: ['target'] });
    expect(asObj(c)).toEqual({ Sub: 'ancestor', Top: 'ancestor', target: 'direct' });
    // 対照(空振りでない): 同じ木で Sub を指定すれば Sub の中は全部入る
    const c2 = run({ notes, directLids: ['Sub'] });
    expect(asObj(c2)).toEqual({ Deep: 'descendant', Sub: 'direct', Top: 'ancestor', deep1: 'descendant', subSibling: 'descendant', target: 'descendant' });
    expect(c2.reasons.has('topSibling'), '骨格の Top から下へたどった').toBe(false);
  });

  it('関連で来たノートの親フォルダの鎖も付く(その中の兄弟は入らない)', () => {
    const notes = [note('a'), folder('F'), note('linked', 'F'), note('fSibling', 'F')];
    const c = run({ notes, directLids: ['a'], relations: [{ from: 'a', to: 'linked', kind: 'semantic' }], relatedMode: '1hop' });
    expect(asObj(c)).toEqual({ F: 'ancestor', a: 'direct', linked: 'related' });
  });

  it('親の鎖が輪でも止まる', () => {
    const notes = [folder('A', 'B'), folder('B', 'A'), note('n', 'A')];
    // n は A の子、A と B は互いに親 ── n を指定すると A・B は骨格
    const c = run({ notes, directLids: ['n'] });
    expect(asObj(c)).toEqual({ A: 'ancestor', B: 'ancestor', n: 'direct' });
  });
});

describe('関連(related)', () => {
  const chain = [note('a'), note('b'), note('c'), note('d')];
  const rels = [
    { from: 'a', to: 'b', kind: 'semantic' },
    { from: 'c', to: 'b', kind: 'semantic' }, // 向きを問わない(b ← c)
    { from: 'c', to: 'd', kind: 'semantic' },
  ];

  it("'off' は 0 段(関連を連れてこない)", () => {
    expect(run({ notes: chain, relations: rels, directLids: ['a'], relatedMode: 'off' }).lids).toEqual(['a']);
  });

  it("'1hop' は 1 段だけ", () => {
    expect(asObj(run({ notes: chain, relations: rels, directLids: ['a'], relatedMode: '1hop' }))).toEqual({ a: 'direct', b: 'related' });
  });

  it("'recursive' は向きを問わずたどる(輪でも止まる)", () => {
    const loop = [...rels, { from: 'd', to: 'a', kind: 'semantic' }];
    expect(asObj(run({ notes: chain, relations: loop, directLids: ['a'], relatedMode: 'recursive' }))).toEqual({ a: 'direct', b: 'related', c: 'related', d: 'related' });
  });

  it(`'recursive' の上限は ${RELATED_MAX_HOPS} 段`, () => {
    const notes = Array.from({ length: 12 }, (_, i) => note(`n${i}`));
    const relations = Array.from({ length: 11 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}`, kind: 'semantic' }));
    const c = run({ notes, relations, directLids: ['n0'], relatedMode: 'recursive' });
    expect(c.lids.length).toBe(1 + RELATED_MAX_HOPS);
    expect(c.reasons.has(`n${RELATED_MAX_HOPS}`)).toBe(true);
    expect(c.reasons.has(`n${RELATED_MAX_HOPS + 1}`)).toBe(false);
    expect(relatedHops('off')).toBe(0);
    expect(relatedHops('1hop')).toBe(1);
  });

  it('structural・知らない種類のつながりはたどらない', () => {
    const c = run({
      notes: chain,
      relations: [
        { from: 'a', to: 'b', kind: 'structural' },
        { from: 'a', to: 'c', kind: 'no-such-kind' },
      ],
      directLids: ['a'],
      relatedMode: 'recursive',
    });
    expect(c.lids).toEqual(['a']);
  });

  it('本文の参照は from → to の向きだけ(相手から指されていても連れてこない)', () => {
    const c1 = run({ notes: chain, bodyRefs: { a: ['b'] }, directLids: ['a'], relatedMode: '1hop' });
    expect(asObj(c1)).toEqual({ a: 'direct', b: 'related' });
    const c2 = run({ notes: chain, bodyRefs: { b: ['a'] }, directLids: ['a'], relatedMode: '1hop' });
    expect(c2.lids).toEqual(['a']);
  });

  it('関連で来たフォルダからは下へたどらない', () => {
    const notes = [note('a'), folder('F'), note('f1', 'F')];
    const c = run({ notes, relations: [{ from: 'a', to: 'F', kind: 'semantic' }], directLids: ['a'], relatedMode: 'recursive' });
    expect(asObj(c)).toEqual({ F: 'related', a: 'direct' });
  });

  it('関連の起点は direct ∪ descendant(フォルダの中のノートのつながりもたどる)', () => {
    const notes = [folder('P'), note('p1', 'P'), note('x')];
    const c = run({ notes, relations: [{ from: 'p1', to: 'x', kind: 'semantic' }], directLids: ['P'], relatedMode: '1hop' });
    expect(asObj(c)).toEqual({ P: 'direct', p1: 'descendant', x: 'related' });
  });

  it('system 領域のノートへの関連は連れてこない', () => {
    const c = run({ notes: [note('a'), note('sys-jobs')], bodyRefs: { a: ['sys-jobs'] }, relations: [{ from: 'a', to: 'sys-jobs', kind: 'semantic' }], directLids: ['a'], relatedMode: '1hop' });
    expect(c.lids).toEqual(['a']);
  });
});

describe('本文の参照の抜き出し(worker が指紋を測る読みで使う)', () => {
  it('リンク(`entry:`)と板の `entry=` の両方を拾う。字で書いただけ・コードの中は拾わない', () => {
    const body = ['[次へ](entry:L1)', '<entry:L2>', '::: {.pkc-place entry=L3}', ':::', 'entry:L4 と書いただけ', '```', '[x](entry:L5)', '```'].join('\n');
    expect(bodyRefTargets(body, 'c1').sort()).toEqual(['L1', 'L2', 'L3']);
  });
});

describe('並びと要約', () => {
  it('lids は昇順(入力の順に依らない)・同じ集合なら同じ要約・集合が違えば別の要約', () => {
    const notes = [note('z'), note('a'), note('m')];
    const c1 = run({ notes, directLids: ['z', 'a'] });
    const c2 = run({ notes: [...notes].reverse(), directLids: ['a', 'z', 'a'] });
    expect(c1.lids).toEqual(['a', 'z']);
    expect(c2.lids).toEqual(c1.lids);
    expect(c2.digest).toBe(c1.digest);
    expect(run({ notes, directLids: ['a'] }).digest).not.toBe(c1.digest);
    expect(selectionDigest(['z', 'a'])).toBe(c1.digest);
  });
});
