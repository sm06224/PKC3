/** @vitest-environment happy-dom */
/**
 * P6e: アーカイブの復元(`restoreArchive`)。
 *
 * 🔴 この file は「**復元に test が 1 件も無かった**」ことに気づいて生まれた。
 * バックアップは「書けること」ではなく「**戻せること**」が価値なので、
 * 戻す側こそ縛る。
 *
 * ⚠ ここが見るのは `restoreArchive`(純関数)まで。鎖の decode は worker の中
 * (codec を二重に持たないため)なので、実 sqlite を通る検証は smoke が担う。
 */
import { describe, expect, it } from 'vitest';
import {
  readArchive,
  restoreArchive,
  writeArchive,
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  type ArchiveRevision,
  type Pkc3Archive,
} from '../../src/features/export/pkc3-archive';
import { ZipWriter } from '../../src/features/export/zip-writer';

const opts = (over: Partial<Parameters<typeof restoreArchive>[1]> = {}) => {
  let n = 0;
  return {
    existingLids: new Set<string>(),
    existingRelationIds: new Set<string>(),
    orderBase: 0,
    genLid: () => `new-${++n}`,
    genRelationId: () => `rel-${++n}`,
    ...over,
  };
};

function archive(over: Partial<Pkc3Archive> = {}): Pkc3Archive {
  return {
    manifest: { format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION },
    entries: [],
    relations: [],
    revisions: [],
    assets: [],
    assetSources: new Map(),
    warnings: [],
    ...over,
  };
}

const entry = (lid: string, body = 'x') => ({
  lid,
  title: lid,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  body,
});

const rev = (entryLid: string, revOrder: number, over: Partial<ArchiveRevision> = {}): ArchiveRevision => ({
  id: `${entryLid}#${revOrder}`,
  entryLid,
  revOrder,
  createdAt: null,
  title: null,
  archetype: null,
  kind: 'patch',
  snapshot: `p${revOrder}`,
  ...over,
});

describe('復元 — 履歴を鎖のまま返す', () => {
  it('🔴 履歴を捨てない(以前は件数を warning に出して落としていた)', async () => {
    const got = restoreArchive(
      archive({ entries: [entry('n1')], revisions: [rev('n1', 1), rev('n1', 2)] }),
      opts(),
    );
    expect(got.revisionChains).toHaveLength(1);
    expect(got.revisionChains[0]!.rows).toHaveLength(2);
  });

  it('🔴 rows は**新しい → 古い**(worker が tip から遡って decode する向き)', async () => {
    // 逆順で渡しても揃う ── 順序が崩れると decode が別の状態列を作る
    const got = restoreArchive(
      archive({ entries: [entry('n1')], revisions: [rev('n1', 1), rev('n1', 3), rev('n1', 2)] }),
      opts(),
    );
    expect(got.revisionChains[0]!.rows.map((r) => r.revOrder)).toEqual([3, 2, 1]);
  });

  it('🔴 lid を写し先へ写像する(他人の履歴を背負わせない)', async () => {
    // 既存に同じ lid が居ると entry は再採番される ── 履歴も同じ写像に従わないと、
    // **既存 entry の履歴に取り込んだ版が並ぶ**(P6c review H-1 で実証済みの事故)
    const got = restoreArchive(
      archive({ entries: [entry('n1')], revisions: [rev('n1', 1)] }),
      opts({ existingLids: new Set(['n1']) }),
    );
    expect(got.entries[0]!.lid).not.toBe('n1');
    expect(got.revisionChains[0]!.entryLid).toBe(got.entries[0]!.lid);
  });

  it('entry ごとに束ねる', () => {
    const got = restoreArchive(
      archive({
        entries: [entry('n1'), entry('n2')],
        revisions: [rev('n1', 1), rev('n2', 1), rev('n1', 2)],
      }),
      opts(),
    );
    expect(got.revisionChains.map((c) => [c.entryLid, c.rows.length]).sort()).toEqual([
      ['n1', 2],
      ['n2', 1],
    ]);
  });

  it('🔴 entry の無い履歴(ゴミ箱の版)は黙って落とさない', () => {
    // 鎖の起点 = tip(entries.body)が無いと decode できない ── 復元しないが言う
    const got = restoreArchive(
      archive({ entries: [entry('n1')], revisions: [rev('n1', 1), rev('gone', 1)] }),
      opts(),
    );
    expect(got.revisionChains).toHaveLength(1);
    expect(got.warnings).toContain('entry の無い履歴 1 版は復元しませんでした(ゴミ箱の版)');
  });

  it('保存形(kind / snapshot)をそのまま渡す(ここで decode しない)', () => {
    // decode を復元側に置くと、符号化側と**二重実装**になってずれる
    const got = restoreArchive(
      archive({
        entries: [entry('n1')],
        revisions: [rev('n1', 1, { kind: 'full', snapshot: '古い本文' })],
      }),
      opts(),
    );
    expect(got.revisionChains[0]!.rows[0]).toMatchObject({
      kind: 'full',
      snapshot: '古い本文',
    });
  });
});

describe('アーカイブの版 — 古い版を読めるまま受ける', () => {
  /** 任意の version / revisions を持つアーカイブ ZIP を組む。 */
  async function makeZip(version: number, revisions: unknown[]): Promise<Blob> {
    const w = new ZipWriter();
    await w.add(
      'manifest.json',
      [JSON.stringify({ format: ARCHIVE_FORMAT, version, exported_at: 'X' })],
    );
    await w.add(
      'container.json',
      [
        JSON.stringify({
          meta: { cid: 'c1', title: 'T' },
          entries: [entry('n1', 'いま')],
          relations: [],
          revisions,
          assets: [],
        }),
      ],
    );
    return w.finish();
  }

  it('🔴 version 1 の `kind` は嘘 ── `full` へ正規化して受ける', async () => {
    // v1 の writer は**全文を書きながら保存形の kind を刻んでいた**。
    // そのまま渡すと、復元がパッチとして適用しようとして壊れる
    const zip = await makeZip(1, [
      { id: 'r1', entryLid: 'n1', revOrder: 1, createdAt: null, title: null, archetype: null, kind: 'patch', snapshot: '古い本文の全文' },
    ]);
    const got = await readArchive(zip);
    expect(got.revisions[0]).toMatchObject({ kind: 'full', snapshot: '古い本文の全文' });
  });

  it('version 2 の `kind` は触らない(保存形が正しく入っている)', async () => {
    const zip = await makeZip(2, [
      { id: 'r1', entryLid: 'n1', revOrder: 1, createdAt: null, title: null, archetype: null, kind: 'patch', snapshot: '{"ops":[]}' },
    ]);
    const got = await readArchive(zip);
    expect(got.revisions[0]).toMatchObject({ kind: 'patch', snapshot: '{"ops":[]}' });
  });

  it('未来の版は断る(読めたつもりにさせない)', async () => {
    await expect(readArchive(await makeZip(ARCHIVE_VERSION + 1, []))).rejects.toThrow(
      /未対応のアーカイブ版/,
    );
  });

  it('版が数値でないアーカイブも断る', async () => {
    await expect(readArchive(await makeZip('2' as unknown as number, []))).rejects.toThrow(
      /未対応のアーカイブ版/,
    );
  });
});

describe('アーカイブの版 — 書出しは新しい版で刻む', () => {
  it('manifest の version が現行 = 2', async () => {
    const src = {
      cid: 'c1',
      title: 'T',
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
      listBodies: async () => ({ rows: [{ lid: 'n1', body: 'x' }], done: true }),
      listRelations: async () => [],
      listAssetMetas: async () => [],
      getAssetBlob: async () => null,
      listRevisionLids: async () => [],
      getRevisionChain: async () => [],
    };
    const got = await readArchive((await writeArchive(src, 'NOW')).blob);
    expect(got.manifest.version).toBe(2);
  });
});
