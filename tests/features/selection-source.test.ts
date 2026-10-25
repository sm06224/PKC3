/** @vitest-environment happy-dom */
/**
 * #1038 A1: **一覧で選んだ N 件だけを持ち出す**。
 *
 * 見るのは 5 点:
 * ① 選んだ件だけが入る(🔴 選んでいない物が 1 件も混ざらない)
 * ② 重複して選んでも 1 件 / 居ない lid は黙って落とす(全部居なければ断る)
 * ③ バックアップ: 選んだフォルダは中のノートも入る
 * ④ 閲覧用 HTML: 選んだフォルダ自身は入らず件数を言う / フォルダだけなら EmptySelectionError
 * ⑤ 添付は選んだノートが参照する物だけ / 外へ向かうつながりは落として言う / そのまま取り込み直せる
 */
import { describe, expect, it } from 'vitest';
import { EmptySelectionError, selectionSource, selectionTitle } from '../../src/features/export/selection-source';
import { readArchive, writeArchive, type ArchiveSource } from '../../src/features/export/pkc3-archive';

const NOW = '2026-10-25T00:00:00.000Z';

interface E {
  lid: string;
  title?: string;
  body: string;
  archetype?: string;
}

function fake(
  entries: E[],
  tree: Array<[string, string]> = [],
  links: Array<[string, string]> = [],
  assets: Array<{ key: string; bytes: Uint8Array }> = [],
): ArchiveSource {
  const rows = entries.map((e, i) => ({
    lid: e.lid,
    title: e.title ?? e.lid,
    archetype: e.archetype ?? 'text',
    created_at: null,
    updated_at: null,
    entry_order: i + 1,
    status: null,
    date: null,
    archived: 0,
    body: e.body,
  }));
  const relations = [
    ...tree.map(([from, to], i) => ({ id: `s${i}`, from_lid: from, to_lid: to, kind: 'structural', created_at: null, updated_at: null })),
    ...links.map(([from, to], i) => ({ id: `l${i}`, from_lid: from, to_lid: to, kind: 'link', created_at: null, updated_at: null })),
  ];
  return {
    cid: 'c1',
    title: 'コンテナ',
    listEntryMetas: async () => rows.map(({ body, ...m }) => (void body, m)),
    getBody: async (lid) => rows.find((r) => r.lid === lid)?.body ?? null,
    listBodies: async () => ({ rows: rows.map((r) => ({ lid: r.lid, body: r.body })), done: true }),
    listRelations: async () => relations,
    listAssetMetas: async () => assets.map((a) => ({ key: a.key, mime: 'image/png', size: a.bytes.length, hash: null })),
    getAssetBlob: async (key) => {
      const a = assets.find((x) => x.key === key);
      return a ? new Blob([a.bytes as unknown as BlobPart]) : null;
    },
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
  };
}

const BASE: E[] = [
  { lid: 'a', title: '見積', body: '見積の本文 asset:k1' },
  { lid: 'b', title: '議事録', body: '議事録の本文' },
  { lid: 'c', title: '他社の秘密', body: '渡してはいけない asset:k2' },
  { lid: 'f', title: '案件', archetype: 'folder', body: '' },
  { lid: 'g', title: '中のノート', body: '中の本文' },
];
const TREE: Array<[string, string]> = [['f', 'g']];
const ASSETS = [
  { key: 'k1', bytes: new Uint8Array([1]) },
  { key: 'k2', bytes: new Uint8Array([2, 2]) },
];

async function lidsOf(s: ArchiveSource): Promise<string[]> {
  const got = await readArchive((await writeArchive(s, NOW)).blob);
  return got.entries.map((e) => e.lid).sort();
}

describe('#1038 A1 選んだノートだけの書き出し', () => {
  it('🔴 ① 選んだ件だけが入り、選んでいない物は 1 件も混ざらない(添付も選んだ分だけ)', async () => {
    const { source, count } = await selectionSource(fake(BASE, TREE, [], ASSETS), ['a', 'b'], 'archive');
    expect(count).toBe(2);
    expect(await lidsOf(source)).toEqual(['a', 'b']);
    const got = await readArchive((await writeArchive(source, NOW)).blob);
    expect(JSON.stringify(got.entries)).not.toContain('渡してはいけない');
    expect((await source.listAssetMetas()).map((x) => x.key)).toEqual(['k1']);
  });

  it('② 重複は 1 件 / 居ない lid は落とす / 全部居なければ断る', async () => {
    const base = fake(BASE, TREE);
    const { source } = await selectionSource(base, ['a', 'a', 'zzz'], 'html');
    expect(await lidsOf(source)).toEqual(['a']);
    await expect(selectionSource(base, ['zzz'], 'archive')).rejects.toThrow('見つかりません');
  });

  it('③ バックアップ: 選んだフォルダは中のノートも入る(外は入らない)', async () => {
    const { source, skippedFolders } = await selectionSource(fake(BASE, TREE), ['f', 'a'], 'archive');
    expect(skippedFolders).toBe(0);
    expect(await lidsOf(source)).toEqual(['a', 'f', 'g']);
  });

  it('④ 閲覧用 HTML: フォルダ自身は入らず件数を言う / フォルダだけなら断る', async () => {
    const { source, warnings, skippedFolders } = await selectionSource(fake(BASE, TREE), ['f', 'a'], 'html');
    expect(skippedFolders).toBe(1);
    expect(await lidsOf(source)).toEqual(['a']);
    expect(warnings.some((w) => w.includes('フォルダ 1 件は入りません'))).toBe(true);
    // 対照群 ── バックアップではフォルダを落としたと言わない
    const arch = await selectionSource(fake(BASE, TREE), ['f', 'a'], 'archive');
    expect(arch.warnings.some((w) => w.includes('フォルダ'))).toBe(false);
    const err = await selectionSource(fake(BASE, TREE), ['f'], 'html').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmptySelectionError);
    expect((err as EmptySelectionError).skippedFolders).toBe(1);
  });

  it('⑤ 外へ向かうつながりは落として言う / 中で閉じているつながりは残る', async () => {
    const base = fake(BASE, TREE, [['a', 'b'], ['a', 'c']], ASSETS);
    const { source, warnings } = await selectionSource(base, ['a', 'b'], 'archive');
    expect(warnings.some((w) => w.includes('外へ向かうつながり 1 件'))).toBe(true);
    const got = await readArchive((await writeArchive(source, NOW)).blob);
    expect(got.relations.map((r) => [r.fromLid, r.toLid])).toEqual([['a', 'b']]);
  });

  it('題名(ファイル名になる): 1 件はそのノート / 複数は件数', async () => {
    expect(selectionTitle('見積', 1)).toBe('見積');
    expect(selectionTitle('見積', 3)).toBe('選んだノート3件');
    const one = await selectionSource(fake(BASE, TREE), ['b'], 'archive');
    expect(one.source.title).toBe('議事録');
    const many = await selectionSource(fake(BASE, TREE), ['a', 'b'], 'archive');
    expect(many.source.title).toBe('選んだノート2件');
  });
});
