/** @vitest-environment node */
/**
 * 🔴 ノートのピン留め(#1377)が**バックアップ → 取り込みで戻る**こと。
 *
 * 守るもの:①書いたピンが `readArchive` → `restoreArchive` で留めた順のまま出る ②1 つも無ければ `notePins` キーを書かない
 * ③書き出すノートに無い lid は書かない ④付け替えた lid へ写る ⑤旧いバックアップ・壊れた要素は空 ⑥部分の書き出しには混ざらない。
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

function source(pins: string[] | undefined): ArchiveSource {
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
    listBodies: async () => ({
      rows: ['n1', 'n2', 'n3'].map((lid) => ({ lid, body: 'x' })),
      done: true,
    }),
    listRelations: async () => [],
    listAssetMetas: async () => [],
    getAssetBlob: async () => null,
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
    ...(pins === undefined ? {} : { listNotePins: async () => pins }),
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

describe('ノートのピン留め ── バックアップの往復', () => {
  it('🔑 書いたピンが、留めた順のまま取り込み側に出てくる', async () => {
    const out = await writeArchive(source(['n3', 'n1']), '2026-10-10T00:00:00.000Z');
    const archive = await readArchive(out.blob);
    expect(archive.notePins).toEqual(['n3', 'n1']);
    expect(restoreArchive(archive, opts()).notePins).toEqual(['n3', 'n1']);
  });

  it('1 つも無いときは notePins を書かない(旧い読み手と同じ形)/ 在れば書く(対照群)', async () => {
    for (const none of [[], undefined]) {
      const out = await writeArchive(source(none), '2026-10-10T00:00:00.000Z');
      expect(await containerJson(out.blob)).not.toContain('notePins');
      expect((await readArchive(out.blob)).notePins).toEqual([]);
    }
    const some = await writeArchive(source(['n1']), '2026-10-10T00:00:00.000Z');
    expect(await containerJson(some.blob)).toContain('"notePins"');
  });

  it('🔴 書き出すノートに無い lid は書かない', async () => {
    const out = await writeArchive(source(['n1', 'ghost']), '2026-10-10T00:00:00.000Z');
    expect((await readArchive(out.blob)).notePins).toEqual(['n1']);
  });

  it('🔴 取り込みで lid が付け替わったら、ピンも付け替え後の lid へ写る(元の lid を指さない)', async () => {
    const out = await writeArchive(source(['n1', 'n2']), '2026-10-10T00:00:00.000Z');
    const archive = await readArchive(out.blob);
    // n1 だけ既存と衝突する ── 付け替えられる
    const r = restoreArchive(archive, opts(['n1']));
    const moved = r.lidRemap.find(([from]) => from === 'n1');
    expect(moved, '前提: n1 が付け替えられている').toBeDefined();
    expect(r.notePins).toEqual([moved![1], 'n2']);
  });

  it('壊れた要素(文字列でない・空・重複)は落とす', async () => {
    const w = new ZipWriter();
    await w.add('manifest.json', [
      JSON.stringify({ format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, cid: 'c', title: 't' }),
    ]);
    await w.add('container.json', [
      JSON.stringify({
        entries: [{ lid: 'n1', title: 'n', archetype: 'text', body: '', entryOrder: 1 }],
        notePins: ['n1', 'n1', '', 3, null],
      }),
    ]);
    const archive = await readArchive(await w.finish());
    expect(archive.notePins).toEqual(['n1']);
  });

  it('部分の書き出し(1 ノート)にはピンが混ざらない', async () => {
    const base = source(['n1']);
    expect(base.listNotePins, '前提: 源はピンを持っている').toBeDefined();
    const single = await singleEntrySource(base, 'n1');
    expect(single.source.listNotePins, '1 ノートの書き出しにピンが混ざる').toBeUndefined();
  });
});
