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

async function textBundle(lid: string | null, title = lid ?? 'メモ'): Promise<Uint8Array> {
  const zip = await buildZip([
    {
      name: 'manifest.json',
      bytes: bytesOf(
        JSON.stringify({
          format: 'pkc2-text-bundle',
          version: 1,
          // null なら **source_lid を書かない**(readBundleParts が定数へ落ちる形)
          ...(lid === null ? {} : { source_lid: lid }),
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

  it('🔴 内側 lid の重複でフォルダ所属が黙って消えない(review H-1)', async () => {
    // `source_lid` が無い bundle は `bundle-text` という**定数**に落ちるので、
    // 2 件あれば必ずぶつかる。convert は entry 自体は再採番して救うが、
    // **フォルダ所属だけが片方消える** ── 見て気づきにくい欠損
    const zip = await outer(
      base({
        text_count: 2,
        entries: [
          { lid: 'n1', title: 'A', archetype: 'text', filename: 'a.text.zip', parent_folder_lid: 'fa' },
          { lid: 'n2', title: 'B', archetype: 'text', filename: 'b.text.zip', parent_folder_lid: 'fb' },
        ],
        folders: [
          { lid: 'root', title: 'R', parent_lid: null },
          { lid: 'fa', title: 'FA', parent_lid: 'root' },
          { lid: 'fb', title: 'FB', parent_lid: 'root' },
        ],
      }),
      [
        { name: 'a.text.zip', bytes: await textBundle(null, 'A') },
        { name: 'b.text.zip', bytes: await textBundle(null, 'B') },
      ],
    );
    const got = await readFolderExportBundle(zip);
    // 重複自体と、所属を復元できなかったことの**両方**を言う
    expect(got.warnings.some((w) => /中身の lid が .* と同じです/.test(w))).toBe(true);
    expect(
      got.warnings.some((w) => /フォルダ所属を復元できません/.test(w)),
    ).toBe(true);
  });

  it('🔑 childOf の key は**内側の lid**(目次と中身で lid が違っても効く)', async () => {
    // reader は「目次と中身で lid が違います」warning を持っている = 実在する条件。
    // 外側 lid で引くと**全ノートのフォルダ所属が落ちる**が、fixture が全部
    // 一致していると差が出ない(review P-2)
    const zip = await outer(
      base({
        text_count: 1,
        entries: [
          { lid: 'そとの lid', title: 'A', archetype: 'text', filename: 'a.text.zip', parent_folder_lid: 'fa' },
        ],
        folders: [
          { lid: 'root', title: 'R', parent_lid: null },
          { lid: 'fa', title: 'FA', parent_lid: 'root' },
        ],
      }),
      [{ name: 'a.text.zip', bytes: await textBundle('なかの lid', 'A') }],
    );
    const got = await readFolderExportBundle(zip);
    expect(tree(got.container as Synth)['なかの lid']).toBe('fa');
  });

  it('🔴 folder lid と本体 lid の衝突で階層が全滅しない(review H-2)', async () => {
    // synthesize は folder を先に置くので convert の再採番は**本体側**に当たり、
    // 参照書換表が旧 lid → 本体の新 lid を指す ── folder の relation 端点が
    // 本体へ付け替えられて階層が消える。reader 側でずらして避ける
    const zip = await outer(
      base({
        text_count: 2,
        entries: [
          { lid: 'sub', title: 'ぶつかるノート', archetype: 'text', filename: 'x.text.zip' },
          { lid: 'n1', title: '子ノート', archetype: 'text', filename: 'n1.text.zip', parent_folder_lid: 'sub' },
        ],
        folders: [
          { lid: 'root', title: '仕事', parent_lid: null },
          { lid: 'sub', title: '2026', parent_lid: 'root' },
        ],
      }),
      [
        { name: 'x.text.zip', bytes: await textBundle('sub', 'ぶつかるノート') },
        { name: 'n1.text.zip', bytes: await textBundle('n1', '子ノート') },
      ],
    );
    const got = await readFolderExportBundle(zip);
    const c = got.container as Synth;
    const t = tree(c);
    const byTitle = new Map(c.entries.map((e) => [e.title, e.lid]));
    // 階層は保たれる ── 2026 は root の下、子ノートは 2026 の下
    expect(t[byTitle.get('2026')!]).toBe(byTitle.get('仕事'));
    expect(t[byTitle.get('子ノート')!]).toBe(byTitle.get('2026'));
    expect(got.warnings.some((w) => /lid がぶつかっています/.test(w))).toBe(true);
  });

  it('🔴 lid の無いフォルダだけの書出しは断る(0 件で成功に見せない)', async () => {
    // manifest の配列長で見ると素通りする(review M-1)
    const zip = await outer(base({ entries: [], folders: [{ title: 'なまえだけ' }] }), []);
    await expect(readFolderExportBundle(zip)).rejects.toThrow(/1 件もありませんでした/);
  });

  it('🔴 内側が全部失敗したら断る(段④ と方針を揃える / review M-2)', async () => {
    const zip = await outer(
      base({
        text_count: 1,
        entries: [{ lid: 'n1', title: 'A', archetype: 'text', filename: 'n1.text.zip' }],
        folders: [{ lid: 'root', title: 'R', parent_lid: null }],
      }),
      [{ name: 'n1.text.zip', bytes: bytesOf('壊れている') }],
    );
    await expect(readFolderExportBundle(zip)).rejects.toThrow(/1 件も取り込めませんでした/);
  });

  it('parent_lid が文字列でなければ言う(黙って最上位にしない / review M-4)', async () => {
    const zip = await outer(
      base({
        entries: [],
        folders: [
          { lid: 'root', title: 'R', parent_lid: null },
          { lid: 'a', title: 'A', parent_lid: 12345 },
        ],
      }),
      [],
    );
    const got = await readFolderExportBundle(zip);
    expect(got.warnings.some((w) => /親 lid が文字列ではありません/.test(w))).toBe(true);
  });

  it('other_count も照合する(宣言だけして読まないのは PKC2 の振る舞い / review M-5)', async () => {
    const zip = await outer(
      base({
        version: 2,
        text_count: 1,
        other_count: 5, // 実際に飛ばしたのは 1 件
        entries: [
          { lid: 'n1', title: 'A', archetype: 'text', filename: 'n1.text.zip' },
          { lid: 't1', title: 'T', archetype: 'todo', filename: 't1.entry.zip' },
        ],
        folders: [{ lid: 'root', title: 'R', parent_lid: null }],
      }),
      [
        { name: 'n1.text.zip', bytes: await textBundle('n1', 'A') },
        { name: 't1.entry.zip', bytes: bytesOf('skip') },
      ],
    );
    const got = await readFolderExportBundle(zip);
    expect(got.warnings).toContain('manifest の ノート以外 件数が中身と違います(5 ≠ 1)');
  });

  it('外側 compact が内側の件数ぶん繰り返されない(review P-3)', async () => {
    const zip = await outer(
      base({
        compact: true,
        text_count: 2,
        entries: [
          { lid: 'n1', title: 'A', archetype: 'text', filename: 'a.text.zip' },
          { lid: 'n2', title: 'B', archetype: 'text', filename: 'b.text.zip' },
        ],
        folders: [{ lid: 'root', title: 'R', parent_lid: null }],
      }),
      [
        { name: 'a.text.zip', bytes: await textBundle('n1', 'A') },
        { name: 'b.text.zip', bytes: await textBundle('n2', 'B') },
      ],
    );
    const got = await readFolderExportBundle(zip);
    expect(got.warnings.filter((w) => /compact mode/.test(w))).toHaveLength(1);
  });

  it('folders が空配列でも平坦取込 + 明示 warning(review P-4)', async () => {
    const zip = await outer(
      base({
        text_count: 1,
        entries: [{ lid: 'n1', title: 'A', archetype: 'text', filename: 'a.text.zip' }],
        folders: [],
      }),
      [{ name: 'a.text.zip', bytes: await textBundle('n1', 'A') }],
    );
    const got = await readFolderExportBundle(zip);
    expect((got.container as Synth).relations).toEqual([]);
    expect(got.warnings[0]).toMatch(/フォルダ構造を復元できませんでした/);
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
