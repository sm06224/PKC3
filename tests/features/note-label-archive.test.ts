/** @vitest-environment node */
/**
 * 🔴 ノートの色ラベル(#1982 段 4)が**バックアップ → 取り込みで戻る**こと、と純関数(正規化・付け外し・絞り込み)。
 */
import { describe, expect, it } from 'vitest';
import {
  readArchive,
  restoreArchive,
  writeArchive,
  type ArchiveSource,
} from '../../src/features/export/pkc3-archive';
import { subsetSource } from '../../src/features/export/folder-source';
import { singleEntrySource } from '../../src/features/export/single-entry-source';
import {
  filterByLabel,
  isNoteLabelColor,
  normalizeNoteLabels,
  noteLabelName,
  setLabel,
  type NoteLabelEntry,
} from '../../src/features/note-label';
import { entryFilterOf, matchesEntry, NO_KINDS } from '../../src/features/filter/title-filter';

function source(labels: NoteLabelEntry[] | undefined): ArchiveSource {
  const meta = (lid: string, n: number) => ({
    lid,
    title: lid,
    archetype: 'text',
    created_at: null,
    updated_at: null,
    entry_order: n,
    status: null,
    date: null,
    archived: 0,
  });
  return {
    cid: 'c1',
    title: 't',
    listEntryMetas: async () => [meta('n1', 1), meta('n2', 2), meta('n3', 3)],
    listBodies: async () => ({ rows: ['n1', 'n2', 'n3'].map((lid) => ({ lid, body: 'x' })), done: true }),
    listRelations: async () => [],
    listAssetMetas: async () => [],
    getAssetBlob: async () => null,
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
    ...(labels === undefined ? {} : { listNoteLabels: async () => labels }),
  };
}

const opts = (existing: string[] = []) => {
  let n = 0;
  return {
    existingLids: new Set<string>(existing),
    existingRelationIds: new Set<string>(),
    orderBase: 0,
    genLid: () => `new-${++n}`,
    genRelationId: () => `rel-${++n}`,
  };
};

async function containerJson(blob: Blob): Promise<string> {
  const { readZipDirectory, readZipText } = await import('../../src/features/import/zip-reader');
  const dir = await readZipDirectory(blob);
  return readZipText(blob, dir.find((e) => e.name === 'container.json')!);
}

describe('色ラベル ── バックアップの往復', () => {
  it('🔑 書いた色が取り込み側に出てくる(復元まで通す)', async () => {
    const out = await writeArchive(source([{ lid: 'n3', color: 5 }, { lid: 'n1', color: 2 }]), '2026-11-20T00:00:00.000Z');
    const archive = await readArchive(out.blob);
    expect(archive.noteLabels).toEqual([{ lid: 'n3', color: 5 }, { lid: 'n1', color: 2 }]);
    expect(restoreArchive(archive, opts()).noteLabels).toEqual([{ lid: 'n3', color: 5 }, { lid: 'n1', color: 2 }]);
  });

  it('1 つも無いときは noteLabels を書かない / 在れば書く(対照群)。ピン留めと同居しても JSON が壊れない', async () => {
    for (const none of [[], undefined]) {
      const out = await writeArchive(source(none), '2026-11-20T00:00:00.000Z');
      expect(await containerJson(out.blob)).not.toContain('noteLabels');
      expect((await readArchive(out.blob)).noteLabels).toEqual([]);
    }
    const some = await writeArchive({ ...source([{ lid: 'n1', color: 1 }]), listNotePins: async () => ['n2'] }, '2026-11-20T00:00:00.000Z');
    expect(await containerJson(some.blob)).toContain('"noteLabels"');
    const back = await readArchive(some.blob);
    expect(back.noteLabels).toEqual([{ lid: 'n1', color: 1 }]);
    expect(back.notePins).toEqual(['n2']);
  });

  it('🔴 書き出すノートに無い lid は書かない', async () => {
    const out = await writeArchive(source([{ lid: 'n1', color: 3 }, { lid: 'ghost', color: 3 }]), '2026-11-20T00:00:00.000Z');
    expect((await readArchive(out.blob)).noteLabels).toEqual([{ lid: 'n1', color: 3 }]);
  });

  it('🔴 取り込みで lid が付け替わったら、色も付け替え後の lid へ写る', async () => {
    const out = await writeArchive(source([{ lid: 'n1', color: 4 }, { lid: 'n2', color: 6 }]), '2026-11-20T00:00:00.000Z');
    const r = restoreArchive(await readArchive(out.blob), opts(['n1']));
    const moved = r.lidRemap.find(([from]) => from === 'n1');
    expect(moved, '前提: n1 が付け替えられている').toBeDefined();
    expect(r.noteLabels).toEqual([{ lid: moved![1], color: 4 }, { lid: 'n2', color: 6 }]);
  });

  it('🔴 部分の書き出し(1 ノート / 選んだノート)は含まれるノートの色だけを運ぶ', async () => {
    const base = source([{ lid: 'n1', color: 1 }, { lid: 'n2', color: 2 }, { lid: 'n3', color: 3 }]);
    const sub = await subsetSource(base, {
      rawMetas: await base.listEntryMetas(),
      rawRelations: [],
      lids: new Set(['n2', 'n3']),
      title: 's',
      danglingWarning: () => '',
    });
    expect(await sub.source.listNoteLabels?.()).toEqual([{ lid: 'n2', color: 2 }, { lid: 'n3', color: 3 }]);
    const single = await singleEntrySource(base, 'n1');
    expect(await single.source.listNoteLabels?.()).toEqual([{ lid: 'n1', color: 1 }]);
    const other = await singleEntrySource(source(undefined), 'n1');
    expect(other.source.listNoteLabels).toBeUndefined();
  });
});

describe('色ラベルの純関数', () => {
  it('正規化: 壊れた行(範囲外の色・空の lid・重複・配列でない)は落ちる', () => {
    expect(
      normalizeNoteLabels([{ lid: 'a', color: 1 }, { lid: 'a', color: 2 }, { lid: '', color: 1 }, { lid: 'b', color: 9 }, { lid: 'c', color: 1.5 }, null, 3]),
    ).toEqual([{ lid: 'a', color: 1 }]);
    expect(normalizeNoteLabels('x')).toEqual([]);
    expect(isNoteLabelColor(8)).toBe(true);
    expect(isNoteLabelColor(0)).toBe(false);
    expect(noteLabelName(3)).toBe('緑');
  });

  it('付ける・付け替える・外す(両方向)', () => {
    const a = setLabel(new Map(), 'n1', 3);
    expect(a.get('n1')).toBe(3);
    const b = setLabel(a, 'n1', 5);
    expect(b.get('n1')).toBe(5);
    const c = setLabel(b, 'n1', null);
    expect(c.has('n1')).toBe(false);
    expect(a.get('n1'), '元の表は動かさない').toBe(3);
    expect(setLabel(a, 'n1', 99).get('n1'), '範囲外は付かない').toBe(3);
  });

  it('絞り込み: 色が一致する行だけ / null は全部 / matchesEntry も同じ答え(規則は 1 か所)', () => {
    const items = [{ lid: 'a' }, { lid: 'b' }, { lid: 'c' }];
    const labels = new Map([['a', 2], ['b', 5], ['c', 2]]);
    expect(filterByLabel(items, labels, 2).map((i) => i.lid)).toEqual(['a', 'c']);
    expect(filterByLabel(items, labels, null)).toHaveLength(3);
    expect(filterByLabel(items, labels, 7)).toHaveLength(0);
    const f = entryFilterOf('', null, NO_KINDS, { color: 2, labels });
    const through = items.filter((i) => matchesEntry({ ...i, title: i.lid, archetype: 'text' }, f));
    expect(through.map((i) => i.lid)).toEqual(['a', 'c']);
    // 語が空でも効く / 語があれば AND
    const withQuery = entryFilterOf('a', null, NO_KINDS, { color: 2, labels });
    expect(matchesEntry({ lid: 'a', title: 'a', archetype: 'text' }, withQuery)).toBe(true);
    expect(matchesEntry({ lid: 'b', title: 'a', archetype: 'text' }, withQuery)).toBe(false);
  });
});
