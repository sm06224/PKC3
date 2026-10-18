/**
 * 台帳 #1852 束 F2 / 依頼 105-2・297 A: **ゴミ箱の中のノートも、バックアップに入れて、ゴミ箱に入った状態で戻す**。
 *
 * 見るのは 3 つ:
 *  1. 書き出し → 読み → 付け替え(`restoreArchive`)で、ゴミ箱のノートが生きたノートに混ざらず別の鍵で往復する
 *  2. 🔴 **前の版の読み方を再現**して、新しく書いたバックアップを前の版が読んでも中身が消えず、注意も出ない
 *  3. 🔴 旧い版が書いたバックアップ(ゴミ箱の鍵が無い)を、新しい版が今までどおり読める
 *
 * ⚠ 実 sqlite を通る面(ゴミ箱の中へ積む `restoreTrashNotes`)は `tests/adapter/storage-worker-trash-restore.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import {
  readArchive,
  restoreArchive,
  writeArchive,
  type ArchiveSource,
} from '../../src/features/export/pkc3-archive';
import { formatArchivePreviewMessage, peekArchivePreview } from '../../src/features/import/archive-preview';
import { readZipDirectory, readZipEntry } from '../../src/features/import/zip-reader';

const NOW = '2026-10-18T00:00:00.000Z';

function source(over: Partial<ArchiveSource> = {}): ArchiveSource {
  const metas = [
    { lid: 'live1', order: 1 },
    { lid: 'live2', order: 2 },
  ];
  return {
    cid: 'c1',
    title: 'テスト',
    listEntryMetas: async () =>
      metas.map((m) => ({
        lid: m.lid,
        title: `題名 ${m.lid}`,
        archetype: 'text',
        created_at: '2026-01-01 00:00:00',
        updated_at: '2026-01-02 00:00:00',
        entry_order: m.order,
        status: null,
        date: null,
        archived: 0,
      })),
    listBodies: async () => ({ rows: metas.map((m) => ({ lid: m.lid, body: `本文 ${m.lid} entry:trash1` })), done: true }),
    listRelations: async () => [
      { id: 'r-live', from_lid: 'live1', to_lid: 'live2', kind: 'semantic', created_at: null, updated_at: null },
      // ゴミ箱のノートに触るつながり(居場所の辺 + 意味リンク)
      { id: 'r-in', from_lid: 'live1', to_lid: 'trash1', kind: 'structural', created_at: null, updated_at: null },
      { id: 'r-out', from_lid: 'trash1', to_lid: 'live2', kind: 'semantic', created_at: null, updated_at: null },
      // 本当に消えた lid への辺(壊れている物)── どちらにも入れない
      { id: 'r-ghost', from_lid: 'live1', to_lid: 'purged', kind: 'semantic', created_at: null, updated_at: null },
    ],
    listAssetMetas: async () => [],
    getAssetBlob: async () => null,
    listRevisionLids: async () => ['live1', 'trash1'],
    getRevisionChain: async (lid) =>
      lid === 'trash1'
        ? [
            // 頭 = ゴミ箱へ移した時点の全文
            { revOrder: 3, createdAt: '2026-03-01 00:00:00', title: '捨てた題名', archetype: 'text', kind: 'full', snapshot: '捨てた本文 v3', contentHash: 'h3' },
            { revOrder: 2, createdAt: '2026-02-01 00:00:00', title: '捨てた題名', archetype: 'text', kind: 'full', snapshot: '捨てた本文 v2', contentHash: 'h2' },
            { revOrder: 1, createdAt: '2026-01-15 00:00:00', title: null, archetype: null, kind: 'patch', snapshot: '@@ -1 +1 @@', contentHash: null },
          ]
        : [{ revOrder: 1, createdAt: '2026-01-10 00:00:00', title: null, archetype: null, kind: 'full', snapshot: '昔の live1', contentHash: null }],
    listTrashHeads: async () => [
      {
        lid: 'trash1',
        title: '捨てた題名',
        archetype: 'text',
        created_at: '2026-01-03 00:00:00',
        updated_at: '2026-02-20 00:00:00',
        entry_order: 7,
        trashed_at: '2026-03-01 00:00:00',
      },
    ],
    ...over,
  };
}

const opts = (existing: string[] = []) => {
  let n = 0;
  return {
    existingLids: new Set(existing),
    existingRelationIds: new Set<string>(),
    orderBase: 100,
    genLid: () => `new-${++n}`,
    genRelationId: () => `rel-${++n}`,
  };
};

async function containerOf(blob: Blob): Promise<Record<string, unknown>> {
  const dir = await readZipDirectory(blob);
  const e = await readZipEntry(blob, dir.find((x) => x.name === 'container.json')!);
  return JSON.parse(await e.text()) as Record<string, unknown>;
}

describe('ゴミ箱のノートを書き出す', () => {
  it('🔴 生きたノートには混ぜず、別の鍵(trash / trashRelations / trashRevisions)で運ぶ', async () => {
    const out = await writeArchive(source(), NOW);
    expect(out.counts).toMatchObject({ entries: 2, trash: 1 });
    const c = await containerOf(out.blob);
    expect((c['entries'] as Array<{ lid: string }>).map((e) => e.lid)).toEqual(['live1', 'live2']);
    const trash = c['trash'] as Array<Record<string, unknown>>;
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({
      lid: 'trash1',
      title: '捨てた題名',
      body: '捨てた本文 v3', // 頭の全文
      createdAt: '2026-01-03 00:00:00',
      updatedAt: '2026-02-20 00:00:00',
      entryOrder: 7,
      trashedAt: '2026-03-01 00:00:00',
    });
    // 頭より古い版だけが trashRevisions(頭の全文を二重に持たない)
    expect((c['trashRevisions'] as Array<{ revOrder: number }>).map((r) => r.revOrder)).toEqual([2, 1]);
    // つながりは触る物だけが trashRelations。生きたもの同士は relations。壊れた物(消えた lid への辺)はどちらにも入れない
    expect((c['relations'] as Array<{ id: string }>).map((r) => r.id)).toEqual(['r-live']);
    expect((c['trashRelations'] as Array<{ id: string }>).map((r) => r.id)).toEqual(['r-in', 'r-out']);
    // 生きたノートの履歴(revisions)にゴミ箱の版は混ざらない
    expect((c['revisions'] as Array<{ entryLid: string }>).map((r) => r.entryLid)).toEqual(['live1']);
  });

  it('対照群: ゴミ箱の頭を返さない源(1 ノート / フォルダの書き出し)は、ゴミ箱を運ばない(鍵ごと書かない)', async () => {
    const { listTrashHeads, ...noTrash } = source();
    void listTrashHeads;
    const out = await writeArchive(noTrash as ArchiveSource, NOW);
    const c = await containerOf(out.blob);
    expect(Object.keys(c)).not.toContain('trash');
    expect(Object.keys(c)).not.toContain('trashRelations');
    expect(out.counts.trash).toBe(0);
    const dir = await readZipDirectory(out.blob);
    const m = JSON.parse(await (await readZipEntry(out.blob, dir.find((x) => x.name === 'manifest.json')!)).text()) as {
      counts: Record<string, number>;
    };
    expect(Object.keys(m.counts), 'ゴミ箱が無いときは概要も今までと同じ形').toEqual(['entries', 'relations', 'revisions', 'assets']);
  });

  it('頭が全文でない(読めない)ゴミ箱のノートは、黙って落とさず注意に出す', async () => {
    const bad = source({
      getRevisionChain: async (lid) =>
        lid === 'trash1'
          ? [{ revOrder: 1, createdAt: null, title: null, archetype: null, kind: 'patch', snapshot: '@@', contentHash: null }]
          : [],
    });
    const out = await writeArchive(bad, NOW);
    expect(out.counts.trash).toBe(0);
    expect(out.warnings.join('\n')).toContain('ゴミ箱の中の読み出せないノートを飛ばしました: 捨てた題名');
  });
});

describe('ゴミ箱のノートを読んで、戻す形にする', () => {
  it('🔴 往復する(ゴミ箱の物は restoreArchive.trash に、生きたノートの entries には出ない)。注意も出ない', async () => {
    const got = restoreArchive(await readArchive((await writeArchive(source(), NOW)).blob), opts());
    expect(got.entries.map((e) => e.lid)).toEqual(['live1', 'live2']);
    expect(got.trash).toHaveLength(1);
    const t = got.trash[0]!;
    expect(t).toMatchObject({
      lid: 'trash1',
      title: '捨てた題名',
      body: '捨てた本文 v3',
      createdAt: '2026-01-03 00:00:00',
      updatedAt: '2026-02-20 00:00:00',
      trashedAt: '2026-03-01 00:00:00',
    });
    // 書き出した側の並びの位置は持ち込まない(こちらの並びとは別物)── 戻すときは末尾に付く
    expect(t.entryOrder).toBeNull();
    expect(t.rows.map((r) => r.revOrder)).toEqual([2, 1]); // 新しい → 古い
    // つながり: 生きたもの同士 + ゴミ箱に触る物の両方が戻る(「つなぐ先が無い」の注意は出ない = 297 の症状)
    expect(got.relations.map((r) => r.id).sort()).toEqual(['r-in', 'r-live', 'r-out']);
    expect(got.warnings).toEqual([]);
    expect(got.revisionChains.map((c) => c.entryLid)).toEqual(['live1']);
  });

  it('🔴 lid が既存と衝突したら、ゴミ箱のノートも付け替える(つながりと履歴の持ち主も付いてくる)', async () => {
    const got = restoreArchive(await readArchive((await writeArchive(source(), NOW)).blob), opts(['trash1', 'live1']));
    const t = got.trash[0]!;
    expect(t.lid).not.toBe('trash1');
    expect(got.lidRemap.map((p) => p[0])).toContain('trash1');
    const inRel = got.relations.find((r) => r.id === 'r-in')!;
    expect(inRel.toLid, 'つながりは付け替えた先を指す').toBe(t.lid);
  });

  it('壊れたバックアップ: ゴミ箱の版の持ち主が居ないときは、件数を言って落とす(黙って捨てない)', async () => {
    const archive = await readArchive((await writeArchive(source(), NOW)).blob);
    archive.trash = [];
    const got = restoreArchive(archive, opts());
    expect(got.warnings.join('\n')).toContain('ノートの無い履歴 2 版は復元しませんでした');
  });
});

describe('🔴 互換: 前の版の読み方を再現する', () => {
  /**
   * 前の版(ゴミ箱の鍵を知らない版)の `readArchive` + `restoreArchive` が見る範囲を再現する:
   * container.json の entries / relations / revisions / assets / tagColors だけを読む。manifest.counts は
   * entries / relations / revisions だけ照合する(知らない鍵は読み飛ばす)。
   */
  async function oldReaderView(blob: Blob): Promise<{
    entries: string[];
    relations: string[];
    revisionLids: string[];
    countMismatch: string[];
    unknownKeys: string[];
  }> {
    const c = await containerOf(blob);
    const dir = await readZipDirectory(blob);
    const m = JSON.parse(await (await readZipEntry(blob, dir.find((x) => x.name === 'manifest.json')!)).text()) as {
      format: string;
      version: number;
      counts: Record<string, number>;
    };
    expect(m.format).toBe('pkc3-archive');
    expect(m.version).toBeLessThanOrEqual(2); // 前の版が受ける上限(版を上げていない)
    const entries = (c['entries'] as Array<{ lid: string }>).map((e) => e.lid);
    const relations = (c['relations'] as Array<{ id: string }>).map((r) => r.id);
    const revs = (c['revisions'] as Array<{ entryLid: string }>) ?? [];
    const known = new Set(['meta', 'entries', 'relations', 'revisions', 'assets', 'tagColors']);
    const countMismatch: string[] = [];
    for (const [k, actual] of [
      ['entries', entries.length],
      ['relations', relations.length],
      ['revisions', revs.length],
    ] as const) {
      if (typeof m.counts[k] === 'number' && m.counts[k] !== actual) countMismatch.push(k);
    }
    return {
      entries,
      relations,
      revisionLids: revs.map((r) => r.entryLid),
      countMismatch,
      unknownKeys: Object.keys(c).filter((k) => !known.has(k)),
    };
  }

  it('新しく書いたゴミ箱つきのバックアップを前の版が読むと、今までと同じ中身(生きたノート・つながり・履歴)が戻り、何も消えず、注意も出ない', async () => {
    const withTrash = await oldReaderView((await writeArchive(source(), NOW)).blob);
    // 対照群: ゴミ箱を運ばない源 = 前の版が書いた物と同じ
    const { listTrashHeads, ...noTrash } = source();
    void listTrashHeads;
    const before = await oldReaderView((await writeArchive(noTrash as ArchiveSource, NOW)).blob);
    expect(withTrash.entries).toEqual(before.entries);
    expect(withTrash.relations).toEqual(before.relations);
    expect(withTrash.revisionLids).toEqual(before.revisionLids);
    expect(withTrash.entries, '生きたノートが落ちていない').toEqual(['live1', 'live2']);
    // 概要の数が前の版の照合と食い違わない(= 「記録された数と実際の数が合いません」の注意が出ない)
    expect(withTrash.countMismatch).toEqual([]);
    // ゴミ箱の鍵は前の版には「知らない鍵」= 読み飛ばされるだけ。ゴミ箱の物が生きたノートとして一覧に現れない
    expect(withTrash.unknownKeys.sort()).toEqual(['trash', 'trashRelations', 'trashRevisions']);
    expect(withTrash.entries).not.toContain('trash1');
  });

  it('旧い版が書いたバックアップ(ゴミ箱の鍵が無い)を、新しい版が今までどおり読める', async () => {
    const { listTrashHeads, ...noTrash } = source();
    void listTrashHeads;
    const got = await readArchive((await writeArchive(noTrash as ArchiveSource, NOW)).blob);
    expect(got.trash).toEqual([]);
    expect(got.trashRelations).toEqual([]);
    expect(got.trashRevisions).toEqual([]);
    const restored = restoreArchive(got, opts());
    expect(restored.trash).toEqual([]);
    expect(restored.entries.map((e) => e.lid)).toEqual(['live1', 'live2']);
  });
});

describe('取り込み前の確認でゴミ箱のノートを言う', () => {
  it('概要の件数(trash)が確認の窓に出る。ゴミ箱が無いバックアップでは行ごと出ない', async () => {
    const withTrash = await peekArchivePreview((await writeArchive(source(), NOW)).blob);
    expect(withTrash!.trashCount).toBe(1);
    expect(withTrash!.noteCount, 'ゴミ箱のノートは「ノート N 件」に数えない').toBe(2);
    expect(formatArchivePreviewMessage(withTrash!)).toContain('ゴミ箱のノート 1 件(ゴミ箱に入った状態で戻ります)');
    const { listTrashHeads, ...noTrash } = source();
    void listTrashHeads;
    const without = await peekArchivePreview((await writeArchive(noTrash as ArchiveSource, NOW)).blob);
    expect(without!.trashCount).toBe(0);
    expect(formatArchivePreviewMessage(without!)).not.toContain('ゴミ箱');
  });
});
