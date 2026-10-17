/** @vitest-environment node */
/**
 * 🔴 タグの色(#1457)が**バックアップ → 取り込みで戻る**こと。
 *
 * 守るもの:①書いた色が `readArchive` → `restoreArchive` で同じ綴りのまま出てくる
 * ②色が 1 つも無いバックアップは `tagColors` キーを書かない(旧い読み手と同じ形)
 * ③`#rrggbb` でない値は取り込まず、言う ④色の無い旧バックアップも読める
 * ⑤部分の書き出し(源が色を持たない)には色が混ざらない。
 * 守っていないもの:worker の表への書込(`storage-worker-tag-color.test.ts`)と、
 * 取り込みでいまの色を残す配線(`import-tag-color.test.ts`)。
 */
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  readArchive,
  restoreArchive,
  writeArchive,
  type ArchiveSource,
} from '../../src/features/export/pkc3-archive';
import { singleEntrySource } from '../../src/features/export/single-entry-source';
import { ZipWriter } from '../../src/features/export/zip-writer';
import type { TagColorEntry } from '../../src/features/tag-color';

function source(colors: TagColorEntry[] | undefined): ArchiveSource {
  return {
    cid: 'c1',
    title: 't',
    listEntryMetas: async () => [
      {
        lid: 'n1',
        title: 'n1',
        archetype: 'text',
        created_at: null,
        updated_at: null,
        entry_order: 1,
        status: null,
        date: null,
        archived: 0,
      },
    ],
    listBodies: async () => ({
      rows: [{ lid: 'n1', body: '---\ntags: [買い物]\n---\n' }],
      done: true,
    }),
    listRelations: async () => [],
    listAssetMetas: async () => [],
    getAssetBlob: async () => null,
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
    ...(colors === undefined ? {} : { listTagColors: async () => colors }),
  };
}

const opts = () => {
  let n = 0;
  return {
    existingLids: new Set<string>(),
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

describe('タグの色 ── バックアップの往復', () => {
  it('🔑 書いた色が、同じ綴りのまま取り込み側に出てくる', async () => {
    const colors = [
      { tag: '買い物', color: '#ff8800' },
      { tag: 'Work', color: '#0044cc' },
    ];
    const out = await writeArchive(source(colors), '2026-10-10T00:00:00.000Z');
    const archive = await readArchive(out.blob);
    expect(archive.tagColors).toEqual(colors);
    expect(restoreArchive(archive, opts()).tagColors).toEqual(colors);
    expect(archive.warnings).toEqual([]);
  });

  it('色が 1 つも無いとき、container.json に tagColors を書かない', async () => {
    const none = await writeArchive(source([]), '2026-10-10T00:00:00.000Z');
    expect(await containerJson(none.blob)).not.toContain('tagColors');
    const absent = await writeArchive(source(undefined), '2026-10-10T00:00:00.000Z');
    expect(await containerJson(absent.blob)).not.toContain('tagColors');
    expect((await readArchive(absent.blob)).tagColors).toEqual([]);
    // 対照群: 色が在れば書かれる(上が「書き忘れ」で緑になっていない)
    const some = await writeArchive(source([{ tag: 'a', color: '#123456' }]), '2026-10-10T00:00:00.000Z');
    expect(await containerJson(some.blob)).toContain('"tagColors"');
  });

  it('🔴 #rrggbb でない色・形の違う要素は取り込まず、件数を言う', async () => {
    const w = new ZipWriter();
    await w.add('manifest.json', [
      JSON.stringify({ format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, cid: 'c', title: 't' }),
    ]);
    await w.add('container.json', [
      JSON.stringify({
        entries: [{ lid: 'n1', title: 'n', archetype: 'text', body: '', entryOrder: 1 }],
        tagColors: [
          { tag: 'ok', color: '#ABCDEF' },
          { tag: 'bad', color: 'red' },
          { tag: 'bad2', color: '#fff' },
          { color: '#000000' },
        ],
      }),
    ]);
    const archive = await readArchive(w.finish());
    expect(archive.tagColors).toEqual([{ tag: 'ok', color: '#abcdef' }]);
    expect(archive.warnings.join('\n')).toContain('3 件');
  });

  it('色の無い旧バックアップ(キー自体が無い)も読める', async () => {
    const w = new ZipWriter();
    await w.add('manifest.json', [
      JSON.stringify({ format: ARCHIVE_FORMAT, version: 2, cid: 'c', title: 't' }),
    ]);
    await w.add('container.json', [
      JSON.stringify({ entries: [{ lid: 'n1', title: 'n', archetype: 'text', body: '', entryOrder: 1 }] }),
    ]);
    const archive = await readArchive(w.finish());
    expect(archive.tagColors).toEqual([]);
    expect(archive.warnings).toEqual([]);
  });

  it('部分の書き出し(1 ノート)には、関係の無いタグの色が混ざらない', async () => {
    const base = source([{ tag: '秘密のタグ', color: '#112233' }]);
    const { source: part } = await singleEntrySource(base, 'n1');
    const out = await writeArchive(part, '2026-10-10T00:00:00.000Z');
    expect(await containerJson(out.blob)).not.toContain('秘密のタグ');
    // 対照群: 全体のバックアップには入る
    const full = await writeArchive(base, '2026-10-10T00:00:00.000Z');
    expect(await containerJson(full.blob)).toContain('秘密のタグ');
  });
});

describe('タグの色 ── 本文中のタグ(#買い物)も部分の書き出しで色が残る(#1087)', () => {
  const rel = (id: string, to: string) => ({
    id,
    from_lid: 'f',
    to_lid: to,
    kind: 'structural',
    created_at: null,
    updated_at: null,
  });
  const m = (lid: string, archetype: string, order: number) => ({
    lid,
    title: lid,
    archetype,
    created_at: null,
    updated_at: null,
    entry_order: order,
    status: null,
    date: null,
    archived: 0,
  });
  function base(bodies: Record<string, string>): ArchiveSource {
    return {
      ...source([
        { tag: '買い物', color: '#ff8800' },
        { tag: '家事', color: '#0044cc' },
      ]),
      listEntryMetas: async () => [m('f', 'folder', 1), m('n1', 'text', 2), m('n2', 'text', 3)],
      listBodies: async () => ({
        rows: Object.entries(bodies).map(([lid, body]) => ({ lid, body })),
        done: true,
      }),
      getBody: async (lid: string) => bodies[lid] ?? null,
      listRelations: async () => [rel('r1', 'n1'), rel('r2', 'n2')] as never,
    } as ArchiveSource;
  }
  const bodies = { f: '', n1: '# 題\n\n#買い物\n', n2: '---\ntags: [家事]\n---\n' };

  it('1 ノートの書き出し: 本文中の #タグ の色が付いてくる(文書タグの色は対照群)', async () => {
    const body = await singleEntrySource(base(bodies), 'n1');
    expect(await body.source.listTagColors?.()).toEqual([{ tag: '買い物', color: '#ff8800' }]);
    const fm = await singleEntrySource(base(bodies), 'n2');
    expect(await fm.source.listTagColors?.()).toEqual([{ tag: '家事', color: '#0044cc' }]);
  });

  it('フォルダの書き出し: 本文中のタグの色も、文書タグの色も付いてくる', async () => {
    const { folderSource } = await import('../../src/features/export/folder-source');
    const f = await folderSource(base(bodies), 'f');
    const colors = (await f.source.listTagColors?.()) ?? [];
    expect(colors.map((c) => c.tag).sort()).toEqual(['家事', '買い物']);
  });
});
