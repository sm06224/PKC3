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
import { collectExistingLids } from '../../src/features/import/existing-lids';

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
    tagColors: [],
    trash: [],
    trashRelations: [],
    trashRevisions: [],
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
  contentHash: null,
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

  it('🔴 ノートの無い履歴(ゴミ箱の版)は黙って落とさない', () => {
    // 鎖の起点 = tip(entries.body)が無いと decode できない ── 復元しないが言う
    const got = restoreArchive(
      archive({ entries: [entry('n1')], revisions: [rev('n1', 1), rev('gone', 1)] }),
      opts(),
    );
    expect(got.revisionChains).toHaveLength(1);
    expect(got.warnings).toContain('ノートの無い履歴 1 版は復元しませんでした(ゴミ箱の版)');
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
      /PKC3 が読めるバックアップのバージョン/,
    );
  });

  it('版が数値でないアーカイブも断る', async () => {
    await expect(readArchive(await makeZip('2' as unknown as number, []))).rejects.toThrow(
      /PKC3 が読めるバックアップのバージョン/,
    );
  });
});

describe('アーカイブの版 — 書き出しは新しい版で刻む', () => {
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

describe('つなぐ先の無いつながり(#1087)', () => {
  it('🔴 内部の ID ではなく、残っている側のノートの題名で言う', () => {
    const got = restoreArchive(
      archive({
        entries: [{ ...entry('a'), title: '議事録' }],
        relations: [
          { id: 'rel-secret-1', fromLid: 'a', toLid: 'gone', kind: 'structural', createdAt: null, updatedAt: null },
        ],
      }),
      opts(),
    );
    expect(got.relations).toHaveLength(0);
    expect(got.warnings).toContain('「議事録」から、つなぐ先のノートが無いつながりを除きました');
    expect(got.warnings.join('\n'), '内部の ID が出ている').not.toContain('rel-secret-1');
  });
});

describe('復元 — 作成・更新時刻と system 領域の lid (#1087)', () => {
  it('🔴 作成・更新時刻を運ぶ(無ければ null)', () => {
    const got = restoreArchive(
      archive({
        entries: [
          { ...entry('n1'), createdAt: '2020-01-02 03:04:05', updatedAt: '2021-02-03 04:05:06' },
          entry('n2'),
        ],
      }),
      opts(),
    );
    expect(got.entries.map((e) => [e.createdAt, e.updatedAt])).toEqual([
      ['2020-01-02 03:04:05', '2021-02-03 04:05:06'],
      [null, null],
    ]);
  });

  it('🔴 細工したバックアップの sys-messages / sys-jobs は、メッセージのノートを上書きせず付け替わる', async () => {
    const existingLids = await collectExistingLids({
      fromState: () => [],
      entryLids: async () => [],
      revisionLids: async () => [],
    });
    const got = restoreArchive(
      archive({ entries: [entry('sys-messages'), entry('sys-jobs'), entry('n1')] }),
      opts({ existingLids }),
    );
    expect(got.entries.map((e) => e.lid), 'system の lid のまま取り込まれる').toEqual(['new-1', 'new-2', 'n1']);
  });
});

describe('注意のまとめ(#1087)', () => {
  it('🔴 付け替えた ID は旧→新の対で並べず、件数の 1 行で言う(内部の ID を出さない)', () => {
    const got = restoreArchive(
      archive({ entries: [entry('s1'), entry('s2'), entry('s3')] }),
      opts({ existingLids: new Set(['s1', 's2']) }),
    );
    // 🔴 題名で言う(#1643)。この fixture は題名 = 旧 ID なので、題名として出ているのは「s1」「s2」
    expect(got.warnings.filter((w) => w.includes('同じ ID でした'))).toEqual([
      '「s1」「s2」は、いまのノートと同じ ID でした。別のノートとして追加しました(いまのノートは変わっていません)',
    ]);
    expect(got.warnings.join('\n'), '付け替え先の ID を出している').not.toMatch(/new-/);
  });

  it('🔴 題名で言い、内部の ID は出さない。多いときは先頭 3 件と「ほか N 件」(#1643 依頼 38-5)', () => {
    const named = (lid: string, title: string) => ({ ...entry(lid), title });
    const lids = ['k1', 'k2', 'k3', 'k4', 'k5'];
    const got = restoreArchive(
      archive({ entries: lids.map((l, i) => named(l, `メモ${String(i + 1)}`)) }),
      opts({ existingLids: new Set(lids) }),
    );
    expect(got.warnings).toEqual([
      '「メモ1」「メモ2」「メモ3」ほか 2 件は、いまのノートと同じ ID でした。別のノートとして追加しました(いまのノートは変わっていません)',
    ]);
    expect(got.warnings.join('\n')).not.toMatch(/k\d|new-/);
    // 対照群: 題名の無いノートは「(無題)」と言う
    const blank = restoreArchive(archive({ entries: [named('b1', '')] }), opts({ existingLids: new Set(['b1']) }));
    expect(blank.warnings[0]).toMatch(/^「\(無題\)」は、いまのノートと同じ ID でした/);
  });

  it('いまのノートと重なった分と、ファイルの中で重なった分は別の行で言う(「いまのノートと同じ」と偽らない)', () => {
    const named = (lid: string, title: string) => ({ ...entry(lid), title });
    const got = restoreArchive(
      archive({ entries: [named('e1', '既存と重なる'), named('d', 'ファイル内 1'), named('d', 'ファイル内 2')] }),
      opts({ existingLids: new Set(['e1']) }),
    );
    expect(got.warnings).toEqual([
      '「既存と重なる」は、いまのノートと同じ ID でした。別のノートとして追加しました(いまのノートは変わっていません)',
      '1 件のノートは ID が重なっていたので付け直しました',
    ]);
  });

  it('バックアップの中で ID が重なったノートも、同じ 1 行に数える。重ならなければ行は出ない', () => {
    const dup = restoreArchive(archive({ entries: [entry('d'), entry('d')] }), opts());
    expect(dup.warnings).toEqual(['1 件のノートは ID が重なっていたので付け直しました']);
    const clean = restoreArchive(archive({ entries: [entry('p'), entry('q')] }), opts());
    expect(clean.warnings).toEqual([]);
  });

  it('つなぐ先の無いつながりが複数なら件数の 1 行', () => {
    const rel = (id: string, to: string) => ({ id, fromLid: 'a', toLid: to, kind: 'structural', createdAt: null, updatedAt: null });
    const got = restoreArchive(
      archive({ entries: [entry('a')], relations: [rel('1', 'x'), rel('2', 'y')] }),
      opts(),
    );
    expect(got.warnings).toEqual(['つなぐ先のノートが無いつながり 2 本を除きました']);
  });
});
