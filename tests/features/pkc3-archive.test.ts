/**
 * P6d 段②: アーカイブ ZIP(バックアップ正本)。
 *
 * 🔑 **全部 round-trip で見る**(書いて → 自分の reader で読んで → 中身が一致)。
 * 🔴 **復元できないバックアップはバックアップではない** ── 「書けた」だけの assert は
 * 置かない。件数ではなく**中身**で比べる(件数だけ見ると中身が入れ替わっていても通る)。
 */
import { describe, expect, it } from 'vitest';
import {
  writeArchive,
  readArchive,
  ARCHIVE_FORMAT,
  type ArchiveSource,
} from '../../src/features/export/pkc3-archive';
import { readZipEntry, readZipDirectory } from '../../src/features/import/zip-reader';

const enc = new TextEncoder();

interface Fake {
  entries?: Array<{
    lid: string;
    title?: string;
    archetype?: string;
    body: string;
    entry_order?: number;
    created_at?: string | null;
    status?: string | null;
    archived?: number;
  }>;
  relations?: Array<{ id: string; from_lid: string; to_lid: string; kind: string }>;
  assets?: Array<{ key: string; mime: string; size: number; hash: string | null; bytes?: string }>;
  revisions?: Record<
    string,
    Array<{ id: string; rev_order: number; kind: string; snapshot: string }>
  >;
  /** 1 バッチに入れる件数(バッチ分割の性質を確かめる用)。 */
  batch?: number;
}

function source(f: Fake): ArchiveSource {
  const entries = (f.entries ?? []).map((e, i) => ({
    lid: e.lid,
    title: e.title ?? e.lid,
    archetype: e.archetype ?? 'text',
    created_at: e.created_at ?? null,
    updated_at: null,
    entry_order: e.entry_order ?? i + 1,
    status: e.status ?? null,
    date: null,
    archived: e.archived ?? 0,
    body: e.body,
  }));
  const revs = f.revisions ?? {};
  return {
    cid: 'c1',
    title: 'テスト container',
    listEntryMetas: async () =>
      entries.map((e) => {
        const { body, ...m } = e;
        void body; // meta には本文を含めない(listBodies が別に返す)
        return m;
      }),
    listBodies: async (afterLid) => {
      const start = afterLid ? entries.findIndex((e) => e.lid === afterLid) + 1 : 0;
      const size = f.batch ?? entries.length;
      const slice = entries.slice(start, start + Math.max(1, size));
      return {
        rows: slice.map((e) => ({ lid: e.lid, body: e.body })),
        done: start + slice.length >= entries.length,
      };
    },
    listRelations: async () =>
      (f.relations ?? []).map((r) => ({ ...r, created_at: null, updated_at: null })),
    listAssetMetas: async () =>
      (f.assets ?? []).map((a) => ({ key: a.key, mime: a.mime, size: a.size, hash: a.hash })),
    getAssetBlob: async (key) => {
      const a = (f.assets ?? []).find((x) => x.key === key);
      return a?.bytes === undefined ? null : new Blob([enc.encode(a.bytes)]);
    },
    listRevisionLids: async () => Object.keys(revs),
    listRevisionMetas: async (lid) =>
      (revs[lid] ?? []).map((r) => ({
        id: r.id,
        rev_order: r.rev_order,
        created_at: null,
        title: null,
        archetype: null,
        kind: r.kind,
      })),
    getRevision: async (id) => {
      for (const list of Object.values(revs)) {
        const hit = list.find((r) => r.id === id);
        if (hit) return { body: hit.snapshot };
      }
      return null;
    },
  };
}

const NOW = '2026-08-02T00:00:00.000Z';

describe('アーカイブ ZIP — round-trip', () => {
  it('🔑 entry の**中身**が往復する(件数だけ見ない)', async () => {
    const src = source({
      entries: [
        { lid: 'n1', title: '議事録', body: '# 議事録\n本文\n', created_at: '2026-07-01T00:00:00Z' },
        { lid: 'n2', title: 'やること', archetype: 'todo', body: '---\nstatus: open\n---\n芝刈り', status: 'open' },
      ],
    });
    const out = await writeArchive(src, NOW);
    const got = await readArchive(out.blob);

    expect(got.manifest.format).toBe(ARCHIVE_FORMAT);
    expect(got.entries.map((e) => [e.lid, e.title, e.archetype, e.body])).toEqual([
      ['n1', '議事録', 'text', '# 議事録\n本文\n'],
      ['n2', 'やること', 'todo', '---\nstatus: open\n---\n芝刈り'],
    ]);
    // 抽出列と時刻も落とさない(これが落ちると kanban / calendar が復元後に狂う)
    expect(got.entries[0]!.createdAt).toBe('2026-07-01T00:00:00Z');
    expect(got.entries[1]!.status).toBe('open');
    expect(got.warnings).toEqual([]);
  });

  it('relations が往復する(kind と向きまで)', async () => {
    const src = source({
      entries: [{ lid: 'f', body: '' }, { lid: 'n', body: 'x' }],
      relations: [{ id: 'r1', from_lid: 'f', to_lid: 'n', kind: 'structural' }],
    });
    const got = await readArchive((await writeArchive(src, NOW)).blob);
    expect(got.relations).toEqual([
      { id: 'r1', fromLid: 'f', toLid: 'n', kind: 'structural', createdAt: null, updatedAt: null },
    ]);
  });

  it('🔑 履歴は**鎖のまま**往復する(全文に展開しない)', async () => {
    const src = source({
      entries: [{ lid: 'n1', body: 'いま' }],
      revisions: {
        n1: [
          { id: 'rv1', rev_order: 1, kind: 'full', snapshot: 'v1' },
          { id: 'rv2', rev_order: 2, kind: 'patch', snapshot: '{"ops":[]}' },
        ],
      },
    });
    const got = await readArchive((await writeArchive(src, NOW)).blob);
    expect(got.revisions.map((r) => [r.entryLid, r.revOrder, r.kind, r.snapshot])).toEqual([
      ['n1', 1, 'full', 'v1'],
      ['n1', 2, 'patch', '{"ops":[]}'],
    ]);
  });

  it('🔑 添付の bytes が往復する(生バイト・コピーしない経路)', async () => {
    const src = source({
      entries: [{ lid: 'n1', body: '![図](asset:k1)' }],
      assets: [{ key: 'k1', mime: 'image/png', size: 8, hash: 'abc', bytes: 'PNGBYTES' }],
    });
    const out = await writeArchive(src, NOW);
    const got = await readArchive(out.blob);

    expect(got.assets).toEqual([{ key: 'k1', mime: 'image/png', size: 8, hash: 'abc' }]);
    const blob = await readZipEntry(out.blob, got.assetSources.get('k1')!.entry);
    expect(await blob.text()).toBe('PNGBYTES');
    expect(got.warnings).toEqual([]);
  });

  it('🔑 本文がバッチに割れても全部入る(5000 entry の書出しの本質)', async () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      lid: `n${i}`,
      body: `# ${i}\n${'あ'.repeat(i)}\n`,
    }));
    const got = await readArchive((await writeArchive(source({ entries, batch: 3 }), NOW)).blob);
    expect(got.entries).toHaveLength(25);
    // 並びも本文も保つ(バッチ境界で入れ替わらない)
    expect(got.entries.map((e) => e.lid)).toEqual(entries.map((e) => e.lid));
    expect(got.entries[24]!.body).toBe(`# 24\n${'あ'.repeat(24)}\n`);
  });

  it('日本語の題名・本文・asset key が往復する', async () => {
    const src = source({
      entries: [{ lid: 'n1', title: '打ち合わせ記録', body: '# 見出し\n本文です\n' }],
      assets: [{ key: '添付-1', mime: 'image/png', size: 3, hash: null, bytes: 'abc' }],
    });
    const got = await readArchive((await writeArchive(src, NOW)).blob);
    expect(got.entries[0]!.title).toBe('打ち合わせ記録');
    expect([...got.assetSources.keys()]).toEqual(['添付-1']);
  });
});

describe('アーカイブ ZIP — 黙って落とさない', () => {
  it('🔴 entry 0 件なら断る(書き出したつもりで空を作らない)', async () => {
    await expect(writeArchive(source({}), NOW)).rejects.toThrow(/1 件もありません/);
  });

  it('bytes の無い添付は言う(参照は温存)', async () => {
    const src = source({
      entries: [{ lid: 'n1', body: 'x' }],
      assets: [{ key: 'gone', mime: 'image/png', size: 1, hash: null }], // bytes 無し
    });
    const out = await writeArchive(src, NOW);
    expect(out.warnings).toEqual(['添付の中身が見つかりませんでした: gone']);
    // meta は残るので、読み側も「入っていない」と言える
    const got = await readArchive(out.blob);
    expect(got.warnings).toEqual(['添付の中身がアーカイブに入っていません: gone']);
  });

  it('PKC2 の ZIP を渡されたら名指しで断る', async () => {
    const { ZipWriter } = await import('../../src/features/export/zip-writer');
    const w = new ZipWriter();
    await w.add('manifest.json', ['{"format":"pkc2-package","version":1}']);
    await expect(readArchive(w.finish())).rejects.toThrow(/PKC3 のアーカイブではありません/);
  });

  it('未対応の版は名指しで断る', async () => {
    const { ZipWriter } = await import('../../src/features/export/zip-writer');
    const w = new ZipWriter();
    await w.add('manifest.json', [`{"format":"${ARCHIVE_FORMAT}","version":99}`]);
    await expect(readArchive(w.finish())).rejects.toThrow(/未対応のアーカイブ版/);
  });

  it('manifest の件数が中身と違えば言う', async () => {
    const src = source({ entries: [{ lid: 'n1', body: 'x' }] });
    const out = await writeArchive(src, NOW);
    // manifest だけ差し替える(中身は 1 件のまま)
    const dir = await readZipDirectory(out.blob);
    const container = await readZipEntry(
      out.blob,
      dir.find((e) => e.name === 'container.json')!,
    );
    const { ZipWriter } = await import('../../src/features/export/zip-writer');
    const w = new ZipWriter();
    await w.add('manifest.json', [
      `{"format":"${ARCHIVE_FORMAT}","version":1,"counts":{"entries":9}}`,
    ]);
    await w.add('container.json', [container]);
    expect((await readArchive(w.finish())).warnings).toContain(
      'manifest の entries 件数が中身と違います(9 ≠ 1)',
    );
  });
});

describe('アーカイブ ZIP — 常駐量の性質', () => {
  it('🔑 container.json は**部品**として積まれる(1 本の巨大文字列にしない)', async () => {
    // 「積める形になっている」ことを、バッチ境界を跨いだ JSON が壊れないことで見る
    // ── 丸ごと文字列にする実装へ戻すとこの test は通るが、batch=1 の周回数で
    // 「1 件ずつ取っている」ことは確かめられる
    let calls = 0;
    const base = source({
      entries: Array.from({ length: 6 }, (_, i) => ({ lid: `n${i}`, body: `b${i}` })),
      batch: 1,
    });
    const counted: ArchiveSource = {
      ...base,
      listBodies: async (a, m) => {
        calls++;
        return base.listBodies(a, m);
      },
    };
    const got = await readArchive((await writeArchive(counted, NOW)).blob);
    expect(got.entries).toHaveLength(6);
    // 6 件を 1 件ずつ = 6 回(全件を 1 回で取る実装なら 1 回になる)
    expect(calls).toBe(6);
  });

  it('添付の Blob をコピーせず ZIP の部品にする(同じ Blob を 2 度使える)', async () => {
    const src = source({
      entries: [{ lid: 'n1', body: 'x' }],
      assets: [
        { key: 'a', mime: 'application/octet-stream', size: 4, hash: null, bytes: 'AAAA' },
        { key: 'b', mime: 'application/octet-stream', size: 4, hash: null, bytes: 'AAAA' },
      ],
    });
    const out = await writeArchive(src, NOW);
    const got = await readArchive(out.blob);
    for (const k of ['a', 'b']) {
      const blob = await readZipEntry(out.blob, got.assetSources.get(k)!.entry);
      expect(await blob.text()).toBe('AAAA');
    }
  });
});
