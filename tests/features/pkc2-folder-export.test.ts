/**
 * P6c 段⑤: `pkc2-folder-export-bundle` の受理と階層の復元。
 *
 * fixture は PKC2 の writer が実際に吐く形をなぞる(2026-08-01 の read-only 調査):
 * `folders[0]` = export root(`parent_lid: null` はここだけ)/ root は `folders[]` に
 * 入るが `entries[]` には入らない / 空フォルダも入る / **親が先に来る保証は無い** /
 * v1 の archetype は 'text' / 'textlog' の 2 値だけ(v2 で `.entry.zip` が混ざる)。
 */
import { describe, expect, it } from 'vitest';
import { readFolderExportBundle } from '../../src/features/import/pkc2-folder-export';
import { buildZip, bytesOf, type FixtureEntry } from './zip-fixture';

type Synth = {
  entries: Array<{ lid: string; title: string; archetype: string; body: string }>;
  relations: Array<{ id: string; from: string; to: string; kind: string }>;
};

async function textBundle(lid: string, title = lid): Promise<Uint8Array> {
  const zip = await buildZip([
    {
      name: 'manifest.json',
      bytes: bytesOf(
        JSON.stringify({
          format: 'pkc2-text-bundle',
          version: 1,
          source_lid: lid,
          source_title: title,
          assets: {},
          compacted: false,
        }),
      ),
    },
    { name: 'body.md', bytes: bytesOf(`# ${title}\n`) },
  ]);
  return new Uint8Array(await zip.arrayBuffer());
}

const outer = (manifest: Record<string, unknown>, files: FixtureEntry[]): Promise<Blob> =>
  buildZip([
    { name: 'manifest.json', bytes: bytesOf(JSON.stringify(manifest, null, 2)) },
    ...files,
  ]);

const base = (over: Record<string, unknown>): Record<string, unknown> => ({
  format: 'pkc2-folder-export-bundle',
  version: 1,
  exported_at: '2026-07-31T00:00:00.000Z',
  source_cid: 'c-old',
  source_folder_lid: 'root',
  source_folder_title: '仕事',
  scope: 'recursive',
  text_count: 0,
  textlog_count: 0,
  compact: false,
  ...over,
});

/** child → parent。 */
const tree = (c: Synth): Record<string, string> =>
  Object.fromEntries(c.relations.map((r) => [r.to, r.from]));

describe('readFolderExportBundle', () => {
  it('folder entry + structural relation を組む(fromLid = 親)', async () => {
    const zip = await outer(
      base({
        text_count: 1,
        entries: [
          { lid: 'n1', title: 'メモ', archetype: 'text', filename: 'n1.text.zip', parent_folder_lid: 'sub' },
        ],
        // ⚠ **親が先に来ない**並び(PKC2 はトポロジカルソートしていない)
        folders: [
          { lid: 'root', title: '仕事', parent_lid: null },
          { lid: 'sub', title: '2026', parent_lid: 'root' },
        ],
      }),
      [{ name: 'n1.text.zip', bytes: await textBundle('n1', 'メモ') }],
    );
    const got = await readFolderExportBundle(zip);
    const c = got.container as Synth;

    // folder は entry として作られる(export root 自身も含む)
    expect(c.entries.filter((e) => e.archetype === 'folder').map((e) => e.title)).toEqual([
      '仕事',
      '2026',
    ]);
    expect(tree(c)).toEqual({ sub: 'root', n1: 'sub' });
    expect(c.relations.every((r) => r.kind === 'structural')).toBe(true);
    // relation id は空にしない ── 空だと convert で全部衝突して 1 本しか残らない
    expect(c.relations.every((r) => r.id !== '')).toBe(true);
    expect(got.warnings).toEqual([]);
  });

  it('空フォルダも作る(PKC2 は無言で消していた)', async () => {
    const zip = await outer(
      base({
        entries: [],
        folders: [
          { lid: 'root', title: '仕事', parent_lid: null },
          { lid: 'empty', title: '空っぽ', parent_lid: 'root' },
        ],
      }),
      [],
    );
    const c = (await readFolderExportBundle(zip)).container as Synth;
    expect(c.entries.map((e) => e.title)).toEqual(['仕事', '空っぽ']);
  });

  it('🔴 循環があっても階層を丸ごとは捨てない(PKC2 は全部平坦にしていた)', async () => {
    const zip = await outer(
      base({
        text_count: 1,
        entries: [
          { lid: 'n1', title: 'メモ', archetype: 'text', filename: 'n1.text.zip', parent_folder_lid: 'b' },
        ],
        folders: [
          { lid: 'root', title: '仕事', parent_lid: null },
          { lid: 'a', title: 'A', parent_lid: 'b' },
          { lid: 'b', title: 'B', parent_lid: 'a' }, // a ⇄ b
        ],
      }),
      [{ name: 'n1.text.zip', bytes: await textBundle('n1', 'メモ') }],
    );
    const got = await readFolderExportBundle(zip);
    const t = tree(got.container as Synth);
    // ノートは B の下に残り、A / B のどちらかが root 直下になる
    expect(t.n1).toBe('b');
    const roots = ['root', 'a', 'b'].filter((l) => t[l] === undefined);
    expect(roots.length).toBeGreaterThan(0); // 1 つも無ければ filer から全部消える
    expect(got.warnings.some((w) => /循環/.test(w))).toBe(true);
  });

  it('folders が無い旧 bundle は平坦取込 ── ただし**必ず言う**', async () => {
    const zip = await outer(
      base({
        text_count: 1,
        entries: [{ lid: 'n1', title: 'メモ', archetype: 'text', filename: 'n1.text.zip' }],
      }),
      [{ name: 'n1.text.zip', bytes: await textBundle('n1', 'メモ') }],
    );
    const got = await readFolderExportBundle(zip);
    expect((got.container as Synth).relations).toEqual([]);
    expect(got.warnings[0]).toMatch(/フォルダ構造を復元できませんでした/);
    // 平坦でも本体は入る
    expect((got.container as Synth).entries.map((e) => e.lid)).toEqual(['n1']);
  });

  it('v2 の `.entry.zip` は名指しで飛ばして残りは取り込む(PKC2 は無言 skip)', async () => {
    const zip = await outer(
      base({
        version: 2,
        text_count: 1,
        other_count: 1,
        entries: [
          { lid: 'n1', title: 'メモ', archetype: 'text', filename: 'n1.text.zip', parent_folder_lid: 'root' },
          { lid: 't1', title: 'やること', archetype: 'todo', filename: 'todo-t1.entry.zip' },
        ],
        folders: [{ lid: 'root', title: '仕事', parent_lid: null }],
      }),
      [
        { name: 'n1.text.zip', bytes: await textBundle('n1', 'メモ') },
        { name: 'todo-t1.entry.zip', bytes: bytesOf('中身は段⑥で読む') },
      ],
    );
    const got = await readFolderExportBundle(zip);
    const c = got.container as Synth;
    expect(c.entries.map((e) => e.lid)).toEqual(['root', 'n1']);
    expect(got.warnings.some((w) => /todo-t1\.entry\.zip/.test(w))).toBe(true);
  });

  it('🔑 飛ばした件があっても本体と親フォルダの対応がずれない', async () => {
    // PKC2 の実バグ: preview は manifest 添字・取込は「飛ばして詰めた配列」で、
    // planner が圧縮配列を選択添字で引いていた ── 選んだ entry が落ちて
    // 選ばなかった entry が入る。組で持てば添字空間が存在しない
    const zip = await outer(
      base({
        version: 2,
        text_count: 2,
        other_count: 1,
        entries: [
          { lid: 'x', title: 'とばす', archetype: 'todo', filename: 'x.entry.zip' },
          { lid: 'n1', title: 'A', archetype: 'text', filename: 'n1.text.zip', parent_folder_lid: 'fa' },
          { lid: 'n2', title: 'B', archetype: 'text', filename: 'n2.text.zip', parent_folder_lid: 'fb' },
        ],
        folders: [
          { lid: 'root', title: 'R', parent_lid: null },
          { lid: 'fa', title: 'FA', parent_lid: 'root' },
          { lid: 'fb', title: 'FB', parent_lid: 'root' },
        ],
      }),
      [
        { name: 'x.entry.zip', bytes: bytesOf('skip') },
        { name: 'n1.text.zip', bytes: await textBundle('n1', 'A') },
        { name: 'n2.text.zip', bytes: await textBundle('n2', 'B') },
      ],
    );
    const t = tree((await readFolderExportBundle(zip)).container as Synth);
    // ⚠ ここが 1 つずれると「A が FB の下」になる
    expect(t.n1).toBe('fa');
    expect(t.n2).toBe('fb');
  });

  it('archetype が空の entry は 1 件だけ飛ばす(PKC2 は全体を落としていた)', async () => {
    const zip = await outer(
      base({
        text_count: 1,
        entries: [
          { lid: 'bad', title: '?', filename: 'bad.zip' },
          { lid: 'n1', title: 'メモ', archetype: 'text', filename: 'n1.text.zip' },
        ],
        folders: [{ lid: 'root', title: 'R', parent_lid: null }],
      }),
      [
        { name: 'bad.zip', bytes: bytesOf('x') },
        { name: 'n1.text.zip', bytes: await textBundle('n1', 'メモ') },
      ],
    );
    const got = await readFolderExportBundle(zip);
    expect((got.container as Synth).entries.map((e) => e.lid)).toEqual(['root', 'n1']);
    expect(got.warnings.some((w) => /archetype が書かれていません/.test(w))).toBe(true);
  });

  it('format / version を名指しで検査する(v1 と v2 は受ける)', async () => {
    const wrong = await outer(base({ format: 'pkc2-package', entries: [] }), []);
    await expect(readFolderExportBundle(wrong)).rejects.toThrow(/folder-export-bundle のみ/);
    const v3 = await outer(base({ version: 3, entries: [] }), []);
    await expect(readFolderExportBundle(v3)).rejects.toThrow(/version/);
  });

  it('🔴 取り込めるものが 1 件も無ければ断る(0 件で成功に見せない)', async () => {
    const zip = await outer(base({ entries: [], folders: [] }), []);
    await expect(readFolderExportBundle(zip)).rejects.toThrow(/1 件もありませんでした/);
  });

  it('件数の不一致は warning に出す(PKC2 は読んでさえいない)', async () => {
    const zip = await outer(
      base({
        text_count: 7,
        entries: [{ lid: 'n1', title: 'メモ', archetype: 'text', filename: 'n1.text.zip' }],
        folders: [{ lid: 'root', title: 'R', parent_lid: null }],
      }),
      [{ name: 'n1.text.zip', bytes: await textBundle('n1', 'メモ') }],
    );
    const got = await readFolderExportBundle(zip);
    expect(got.warnings).toContain('manifest の text 件数が中身と違います(7 ≠ 1)');
  });
});
