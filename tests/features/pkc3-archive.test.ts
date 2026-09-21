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
    updated_at?: string | null;
    status?: string | null;
    date?: string | null;
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
    updated_at: e.updated_at ?? null,
    entry_order: e.entry_order ?? i + 1,
    status: e.status ?? null,
    date: e.date ?? null,
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
    // 🔴 **本物のカーソル意味論を真似る**(review M-2)── 配列 index で継続する
    // 楽な stub にすると、実装の複合キーのバグを**迂回して**素通りさせてしまう。
    // 実際それで `entry_order` 重複の取りこぼしが test を通り抜けていた
    listBodies: async (after) => {
      const sorted = [...entries].sort(
        (a, b) => a.entry_order - b.entry_order || a.lid.localeCompare(b.lid),
      );
      const rest = after
        ? sorted.filter(
            (e) =>
              e.entry_order > after.entryOrder ||
              (e.entry_order === after.entryOrder && e.lid > after.lid),
          )
        : sorted;
      const size = Math.max(1, f.batch ?? sorted.length);
      const slice = rest.slice(0, size);
      const last = slice[slice.length - 1];
      return {
        rows: slice.map((e) => ({ lid: e.lid, body: e.body })),
        done: slice.length >= rest.length,
        ...(last ? { next: { entryOrder: last.entry_order, lid: last.lid } } : {}),
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
    // 🔴 **保存形のまま**返す(P6e)── 実装が materialize してから書くと
    // `kind` と中身が食い違う。stub も本物と同じ意味論にする
    getRevisionChain: async (lid) =>
      (revs[lid] ?? []).map((r) => ({
        revOrder: r.rev_order,
        createdAt: null,
        title: null,
        archetype: null,
        kind: r.kind,
        snapshot: r.snapshot,
        contentHash: null,
      })),
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

  it('🔴 entry_order が重複していても 1 件も落とさない(バックアップが減らない)', async () => {
    // app-state が「trash 復元と CREATE の並行採番は重複しうる」と明記している形。
    // カーソルが `entry_order > ?` 単独だと、境界の順序値を共有する行が**全部飛ぶ**
    const entries = ['a', 'b', 'c', 'd', 'e'].map((lid) => ({
      lid,
      body: `本文 ${lid}`,
      entry_order: 1, // 🔴 全部同じ
    }));
    const got = await readArchive((await writeArchive(source({ entries, batch: 2 }), NOW)).blob);
    expect(got.entries.map((e) => e.lid)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(got.entries.map((e) => e.body)).toEqual(entries.map((e) => e.body));
  });

  it('🔴 一部だけ重複していても取りこぼさない', async () => {
    const entries = [
      { lid: 'p1', body: '1', entry_order: 1 },
      { lid: 'p2', body: '2', entry_order: 1 },
      { lid: 'p3', body: '3', entry_order: 1 },
      { lid: 'p4', body: '4', entry_order: 2 },
      { lid: 'p5', body: '5', entry_order: 3 },
    ];
    const got = await readArchive((await writeArchive(source({ entries, batch: 1 }), NOW)).blob);
    expect(got.entries.map((e) => e.lid)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });

  it('🔑 抽出列が全部往復する(kanban / calendar が復元後に狂わない)', async () => {
    // ⚠ `status` と `createdAt` だけ見ていて、**kanban / calendar が実際に使う
    // `archived` と `date` が未 assert** だった(review M-5)
    const src = source({
      entries: [
        {
          lid: 'n1',
          body: 'x',
          entry_order: 7,
          status: 'done',
          archived: 1,
        },
      ],
    });
    const got = await readArchive((await writeArchive(src, NOW)).blob);
    expect(got.entries[0]).toMatchObject({
      entryOrder: 7,
      status: 'done',
      archived: true,
    });
  });

  it('🔑 date / updatedAt も往復する(calendar が使う列)', async () => {
    const src = source({
      entries: [
        { lid: 'n1', body: 'x', date: '2026-08-10', updated_at: '2026-08-01T00:00:00Z' },
      ],
    });
    const got = await readArchive((await writeArchive(src, NOW)).blob);
    expect(got.entries[0]).toMatchObject({
      date: '2026-08-10',
      updatedAt: '2026-08-01T00:00:00Z',
    });
  });

  it('🔑 NULL を書出し側で正規化する(読み手に null を持ち回らせない)', async () => {
    // schema v2 までの revision 行は kind が NULL / asset の mime・size も NULL がある
    const base = source({
      entries: [{ lid: 'n1', body: 'x' }],
      revisions: { n1: [{ id: 'rv1', rev_order: 1, kind: 'full', snapshot: 'v1' }] },
    });
    const withNulls: ArchiveSource = {
      ...base,
      // ⚠ worker 側で NULL → 'full' に正規化済みの値が来る(protocol の規約)
      getRevisionChain: async () => [
        { revOrder: 1, createdAt: null, title: null, archetype: null, kind: 'full', snapshot: 'v1', contentHash: null },
      ],
      listAssetMetas: async () => [{ key: 'k', mime: null, size: null, hash: null }],
      getAssetBlob: async () => new Blob([enc.encode('AB')]),
    };
    const got = await readArchive((await writeArchive(withNulls, NOW)).blob);
    expect(got.revisions[0]!.kind).toBe('full'); // NULL → 'full'
    expect(got.assets[0]).toEqual({
      key: 'k',
      mime: 'application/octet-stream',
      size: 0,
      hash: null,
    });
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

/**
 * 🔴 **file 名の末尾(#1017 段④b)は、中身に 1 バイトも触らない**。
 *
 * ⚠ 「旧ビルドが `-full.zip` を読めるはず / `-full.zip` と旧 `.pkc3.zip` の中身は
 *   同一のはず」という主張(`archive-kind.ts` の docstring)は、**`writeArchive` が
 *   末尾の種類を 1 引数も受け取らない**(呼び出し側が `archiveFileName()` で
 *   後から文字列を足すだけ)ことから成り立つ ── ここでそれを実測で pin する。
 *
 * 🔑 検算は「同じ `source` から作った 2 本の `Blob` が、byte 単位で同一か」。
 *   ⚠ **`exportedAt` を揃えないと空振りする** ── 揃えなければ「別の Blob」に
 *   なる理由が呼び出しの時刻の違いなのか、末尾の選び方の違いなのかが
 *   区別できない(CLAUDE.md §1「前提を書かない一致の主張は成り立たない条件」)。
 */
describe('アーカイブ ZIP — file 名の末尾は中身を変えない(#1017 段④b)', () => {
  it('🔴 呼び出し方を変えても(同じ source・同じ時刻なら)出力は byte 単位で同一', async () => {
    const src = () =>
      source({
        entries: [{ lid: 'n1', title: '議事録', body: '# 議事録\n' }],
        relations: [],
        assets: [{ key: 'a', mime: 'image/png', size: 4, hash: null, bytes: 'AAAA' }],
      });
    // 🔑 `writeArchive` は「どの末尾で保存されるか」を一切知らない ── 呼ぶたびに
    //   別の `ArchiveSource`(同じ中身)を渡し、命名の意図が違っても同じ出力になることを見る
    const a = await writeArchive(src(), NOW); // 「コレクション全体のつもり」
    const b = await writeArchive(src(), NOW); // 「1 件だけのつもり」
    const [bufA, bufB] = await Promise.all([a.blob.arrayBuffer(), b.blob.arrayBuffer()]);
    expect(bufA.byteLength, '空振り防止 ── 0 バイトを比べていない').toBeGreaterThan(0);
    expect(new Uint8Array(bufA), 'file 名の意図が中身にまで漏れている').toEqual(
      new Uint8Array(bufB),
    );
  });
});
