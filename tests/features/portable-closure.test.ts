/**
 * 🔴 **「PKC3 入り HTML(選んだ N 件)」の閉包**(#1038 A2)。
 * 選んだ物 + 参照先(推移的)+ 添付 + 祖先フォルダ。兄弟・無関係な物は入らない。外へ出るつながりは件数を言う。
 */
import { describe, expect, it } from 'vitest';
import { EmptyClosureError, portableClosure, type ClosureSource } from '../../src/features/export/portable-closure';

interface N {
  lid: string;
  title: string;
  archetype?: string;
  body: string;
  order: number;
}

function source(notes: N[], rels: Array<[string, string, string]>, assets: string[]): ClosureSource {
  return {
    cid: 'c1',
    listEntryMetas: async () =>
      notes.map((n) => ({
        lid: n.lid,
        title: n.title,
        archetype: n.archetype ?? 'text',
        created_at: null,
        updated_at: null,
        entry_order: n.order,
        status: null,
        date: null,
        archived: 0,
      })),
    listRelations: async () =>
      rels.map(([from, to, kind], i) => ({ id: `r${i}`, from_lid: from, to_lid: to, kind, created_at: null, updated_at: null })),
    listAssetMetas: async () => assets.map((key) => ({ key, mime: 'image/png', size: 1, hash: null })),
    getBody: async (lid) => notes.find((n) => n.lid === lid)?.body ?? null,
    listBodies: async () => ({ rows: [], done: true }),
  };
}

const notes: N[] = [
  { lid: 'root', title: '根', archetype: 'folder', body: '', order: 1 },
  { lid: 'sub', title: '子フォルダ', archetype: 'folder', body: '', order: 2 },
  { lid: 'sel', title: '選んだ', body: '参照 [乙](entry:ref1) と ![](asset:img-a)', order: 3 },
  { lid: 'ref1', title: '乙', body: '乙から [丁](entry:ref2)', order: 4 },
  { lid: 'ref2', title: '丁', body: '丁 asset:img-b', order: 5 },
  { lid: 'sib', title: '兄弟', body: '兄弟 asset:img-c', order: 6 },
  { lid: 'other', title: '無関係', body: 'x', order: 7 },
];
const rels: Array<[string, string, string]> = [
  ['root', 'sub', 'structural'],
  ['sub', 'sel', 'structural'],
  ['sub', 'sib', 'structural'],
  ['sel', 'other', 'semantic'],
  ['sel', 'ref1', 'semantic'],
];

describe('portableClosure', () => {
  it('選んだ + 参照先(推移的)+ 祖先フォルダ + 添付だけ。兄弟・無関係・その添付は入らない', async () => {
    const c = await portableClosure(source(notes, rels, ['img-a', 'img-b', 'img-c']), ['sel']);
    expect([...c.lids].sort()).toEqual(['ref1', 'ref2', 'root', 'sel', 'sub']);
    expect(c.assetKeys.sort(), '推移的な参照先の添付も入り、兄弟の添付は入らない').toEqual(['img-a', 'img-b']);
    expect(c.selected).toBe(1);
    expect(c.referenced).toBe(2);
    expect(c.ancestors).toBe(2);
    expect(c.droppedRelations, 'sub→sib と sel→other が外へ出る').toBe(2);
    expect(c.warnings.join('\n')).toContain('2 件');
    expect(c.title).toBe('選んだ');
  });

  it('選んだフォルダは中のノートごと入る(兄弟も)', async () => {
    const c = await portableClosure(source(notes, rels, []), ['sub']);
    expect([...c.lids].sort()).toEqual(['ref1', 'ref2', 'root', 'sel', 'sib', 'sub']);
    expect(c.droppedRelations, 'sel→other(本文に参照の無い関連)').toBe(1);
    expect(c.warnings.length).toBe(1);
  });

  it('複数選ぶと題名は件数、存在しない lid は無視、全部無ければ断る', async () => {
    const s = source(notes, rels, []);
    expect((await portableClosure(s, ['sel', 'nope', 'sib'])).title).toBe('選んだノート2件');
    await expect(portableClosure(s, ['nope'])).rejects.toBeInstanceOf(EmptyClosureError);
  });

  it('参照が循環していても止まる', async () => {
    const loop: N[] = [
      { lid: 'p', title: 'p', body: '[q](entry:q)', order: 1 },
      { lid: 'q', title: 'q', body: '[p](entry:p)', order: 2 },
    ];
    const c = await portableClosure(source(loop, [], []), ['p']);
    expect([...c.lids].sort()).toEqual(['p', 'q']);
  });
});
