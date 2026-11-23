import { describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '@core/model/entry-meta';
import {
  currentFolderPathText,
  filterFolderPathCandidates,
  listFolderPathCandidates,
  normalizeFolderPath,
  resolveFolderPath,
} from '@features/filer/folder-path';

let order = 0;
const meta = (lid: string, title: string, archetype = 'folder'): EntryMeta => ({
  lid,
  title,
  archetype,
  createdAt: null,
  updatedAt: null,
  entryOrder: order++,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
} as unknown as EntryMeta);
const rel = (from: string, to: string): Relation =>
  ({ id: `${from}-${to}`, kind: 'structural', fromLid: from, toLid: to }) as unknown as Relation;
const build = (ms: EntryMeta[], rs: Relation[]) => ({
  metas: new Map(ms.map((m) => [m.lid, m])) as ReadonlyMap<string, EntryMeta>,
  rels: rs,
});

/** ルート / 資料 / 下  と  ルート / 仕事 */
const tree = () => {
  order = 0;
  return build(
    [meta('a', '資料'), meta('b', '下'), meta('c', '仕事'), meta('t', 'メモ', 'text')],
    [rel('a', 'b'), rel('a', 't')],
  );
};

describe('normalizeFolderPath', () => {
  it('末尾の / ・空白・全角の区切りを揃える', () => {
    expect(normalizeFolderPath(' ルート / 資料 /下/ ')).toBe('ルート/資料/下');
    expect(normalizeFolderPath('ルート／資料›下')).toBe('ルート/資料/下');
    expect(normalizeFolderPath('//')).toBe('');
  });
});

describe('listFolderPathCandidates', () => {
  it('ルートが先頭・画面の並び(深さ優先)・ノートは出さない', () => {
    const { metas, rels } = tree();
    const c = listFolderPathCandidates(metas, rels);
    expect(c.map((x) => x.path)).toEqual(['ルート', 'ルート/資料', 'ルート/資料/下', 'ルート/仕事']);
    expect(c[0]!.lid).toBeNull();
    expect(c.every((x) => !x.ambiguous)).toBe(true);
  });
  it('同名は label で見分けられ、lid へ戻せる', () => {
    order = 0;
    const { metas, rels } = build([meta('a', '資料'), meta('x', '同'), meta('y', '同'), meta('n', 'n', 'text')], [rel('a', 'x'), rel('a', 'y'), rel('y', 'n')]);
    const c = listFolderPathCandidates(metas, rels).filter((x) => x.path === 'ルート/資料/同');
    expect(c).toHaveLength(2);
    expect(c.every((x) => x.ambiguous)).toBe(true);
    expect(new Set(c.map((x) => x.label)).size).toBe(2);
    expect(c.map((x) => x.lid)).toEqual(['x', 'y']);
    expect(c[1]!.label).toContain('2 番目');
    expect(c[1]!.label).toContain('1 件');
  });
  it('スマートフォルダは末尾にだけ現れる(入れるので候補に含む)', () => {
    order = 0;
    const { metas, rels } = build([meta('a', '資料'), meta('s', '条件', 'smart')], [rel('a', 's')]);
    expect(listFolderPathCandidates(metas, rels).map((x) => x.path)).toContain('ルート/資料/条件');
  });
  it('輪の中のフォルダも出す(入れなくならない)', () => {
    order = 0;
    const { metas, rels } = build([meta('p', 'P'), meta('q', 'Q')], [rel('p', 'q'), rel('q', 'p')]);
    expect(listFolderPathCandidates(metas, rels).map((x) => x.lid)).toEqual(expect.arrayContaining(['p', 'q']));
  });
  it('ゴミ箱に入ったフォルダ(entryMetas に居ない)は出ない', () => {
    const { metas, rels } = tree();
    const without = new Map(metas);
    without.delete('c');
    expect(listFolderPathCandidates(without, rels).map((x) => x.lid)).not.toContain('c');
    expect(resolveFolderPath('ルート/仕事', without, rels).kind).toBe('none');
  });
});

describe('resolveFolderPath', () => {
  it('入れ子・ルート・「ルート/」省略・末尾の /・空白', () => {
    const { metas, rels } = tree();
    expect(resolveFolderPath('ルート/資料/下', metas, rels)).toMatchObject({ kind: 'ok', lid: 'b' });
    expect(resolveFolderPath('資料/下', metas, rels)).toMatchObject({ kind: 'ok', lid: 'b' });
    expect(resolveFolderPath(' ルート / 資料 / ', metas, rels)).toMatchObject({ kind: 'ok', lid: 'a' });
    expect(resolveFolderPath('ルート', metas, rels)).toMatchObject({ kind: 'ok', lid: null });
    expect(resolveFolderPath('/', metas, rels)).toMatchObject({ kind: 'ok', lid: null });
    expect(resolveFolderPath('', metas, rels)).toMatchObject({ kind: 'ok', lid: null });
  });
  it('無い道・部分一致・大小違い・ノートの道は入らない(none)', () => {
    const { metas, rels } = tree();
    expect(resolveFolderPath('ルート/資', metas, rels).kind).toBe('none');
    expect(resolveFolderPath('ルート/無い', metas, rels).kind).toBe('none');
    expect(resolveFolderPath('ルート/資料/メモ', metas, rels).kind).toBe('none');
    order = 0;
    const m = build([meta('a', 'Docs')], []);
    expect(resolveFolderPath('docs', m.metas, m.rels).kind).toBe('none');
  });
  it('違う段の同名は、道が違うので別々に引ける', () => {
    order = 0;
    const { metas, rels } = build([meta('a', '同'), meta('b', '同')], [rel('a', 'b')]);
    expect(resolveFolderPath('ルート/同', metas, rels)).toMatchObject({ kind: 'ok', lid: 'a' });
    expect(resolveFolderPath('ルート/同/同', metas, rels)).toMatchObject({ kind: 'ok', lid: 'b' });
  });
  it('同じ段の同名は ambiguous ── 入らず、候補を返す。候補の表示で引き直すと 1 つに決まる', () => {
    order = 0;
    const { metas, rels } = build([meta('x', '同'), meta('y', '同')], []);
    const r = resolveFolderPath('ルート/同', metas, rels);
    expect(r.kind).toBe('ambiguous');
    if (r.kind !== 'ambiguous') return;
    expect(r.candidates.map((c) => c.lid)).toEqual(['x', 'y']);
    for (const c of r.candidates) {
      expect(resolveFolderPath(c.label, metas, rels)).toMatchObject({ kind: 'ok', lid: c.lid });
    }
  });
  it('題名に / を含むフォルダと入れ子は、同じ字なので ambiguous', () => {
    order = 0;
    const { metas, rels } = build([meta('a', 'a'), meta('b', 'b'), meta('ab', 'a/b')], [rel('a', 'b')]);
    expect(resolveFolderPath('ルート/a/b', metas, rels).kind).toBe('ambiguous');
  });
  it('スマートフォルダへも入れる', () => {
    order = 0;
    const { metas, rels } = build([meta('s', '条件', 'smart')], []);
    expect(resolveFolderPath('条件', metas, rels)).toMatchObject({ kind: 'ok', lid: 's' });
  });
});

describe('currentFolderPathText / filterFolderPathCandidates', () => {
  it('いまの場所の道の字(ルートは「ルート」)', () => {
    const { metas, rels } = tree();
    expect(currentFolderPathText(null, metas, rels)).toBe('ルート');
    expect(currentFolderPathText('b', metas, rels)).toBe('ルート/資料/下');
  });
  it('候補は部分一致で絞る(上限あり)', () => {
    const { metas, rels } = tree();
    const all = listFolderPathCandidates(metas, rels);
    expect(filterFolderPathCandidates(all, '資料').map((c) => c.path)).toEqual(['ルート/資料', 'ルート/資料/下']);
    expect(filterFolderPathCandidates(all, '').length).toBe(all.length);
    expect(filterFolderPathCandidates(all, '', 2)).toHaveLength(2);
  });
});

describe('見分けの付かない道(空題名・区切りの字・3 件以上)', () => {
  it('空題名のフォルダは「（無題）」で道を作る ── ルートと取り違えず、ルートは常に一意に解決する', () => {
    order = 0;
    const { metas, rels } = build([meta('e', ''), meta('w', '  '), meta('s', '／'), meta('r', 'ルート')], []);
    const c = listFolderPathCandidates(metas, rels);
    expect(c.filter((x) => x.lid !== null).every((x) => x.path.startsWith('ルート/'))).toBe(true);
    expect(c.find((x) => x.lid === 'e')!.path).toBe('ルート/（無題）');
    // 3 件の空題名は同じ字になるが、見分けのラベルで 1 つずつ選べる
    const untitled = c.filter((x) => x.path === 'ルート/（無題）');
    expect(untitled.map((x) => x.lid)).toEqual(['e', 'w', 's']);
    expect(new Set(untitled.map((x) => x.label)).size).toBe(3);
    for (const u of untitled) expect(resolveFolderPath(u.label, metas, rels)).toMatchObject({ kind: 'ok', lid: u.lid });
    expect(resolveFolderPath('ルート/（無題）', metas, rels).kind).toBe('ambiguous');
    // ルートは常に一意(題名が「ルート」のフォルダが居ても)
    expect(resolveFolderPath('ルート', metas, rels)).toMatchObject({ kind: 'ok', lid: null });
    expect(resolveFolderPath('ルート/ルート', metas, rels)).toMatchObject({ kind: 'ok', lid: 'r' });
  });
  it('区切りの字(／ › /)を題名に含むフォルダは、衝突したとき候補から選べる', () => {
    order = 0;
    const { metas, rels } = build(
      [meta('a', 'a'), meta('b', 'b'), meta('s1', 'a/b'), meta('s2', 'a／b'), meta('s3', 'a›b')],
      [rel('a', 'b')],
    );
    const r = resolveFolderPath('ルート/a/b', metas, rels);
    expect(r.kind).toBe('ambiguous');
    if (r.kind !== 'ambiguous') return;
    expect(r.candidates.map((x) => x.lid)).toEqual(['b', 's1', 's2', 's3']);
    expect(new Set(r.candidates.map((x) => x.label)).size).toBe(4);
    for (const c of r.candidates) expect(resolveFolderPath(c.label, metas, rels)).toMatchObject({ kind: 'ok', lid: c.lid });
  });
  it('同じ道が 3 件以上 ── 1・2・3 番目で見分けられ、現在地の初期値も見分けの付く表示になる', () => {
    order = 0;
    const { metas, rels } = build([meta('x', '同'), meta('y', '同'), meta('z', '同')], []);
    const c = listFolderPathCandidates(metas, rels).filter((x) => x.path === 'ルート/同');
    expect(c).toHaveLength(3);
    expect(c.map((x) => x.label.includes(`${c.indexOf(x) + 1} 番目`))).toEqual([true, true, true]);
    for (const x of c) {
      expect(resolveFolderPath(x.label, metas, rels)).toMatchObject({ kind: 'ok', lid: x.lid });
      // 初期値(現在地)でそのまま Enter しても、その 1 つへ解決できる
      expect(resolveFolderPath(currentFolderPathText(x.lid, metas, rels), metas, rels)).toMatchObject({ kind: 'ok', lid: x.lid });
    }
    const r = resolveFolderPath('ルート/同', metas, rels);
    expect(r.kind === 'ambiguous' && r.candidates).toHaveLength(3);
  });
});
