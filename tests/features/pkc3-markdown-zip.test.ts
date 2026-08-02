/** @vitest-environment happy-dom */
/**
 * P6d 段④: md ZIP。
 *
 * 🔑 **書いたものを自分の reader で読み戻して中身を見る**(段①で確立した規律)。
 * PKC2 は writer と reader を別々に書いて食い違わせていた。
 *
 * この形式の存在意義は「**PKC3 を捨てても読める**」なので、検査の軸は
 * 「PKC3 が読めるか」ではなく **「外の markdown ビューアで開けるか」**:
 * - 添付参照が**相対パス**になっている(`asset:` のままだと外では画像が出ない)
 * - 拡張子が付いている(OS はほぼ拡張子で判定する)
 * - ファイル名が実在の OS で作れる(Windows 予約語 / 禁止文字 / 衝突)
 * - 落ちたものが**書いてある**(片道であることを user が後から確かめられる)
 */
import { describe, expect, it } from 'vitest';
import {
  writeMarkdownZip,
  slugForTitle,
  extForMime,
  MD_FORMAT,
} from '../../src/features/export/pkc3-markdown-zip';
import { readZipDirectory, readZipText, readZipEntry } from '../../src/features/import/zip-reader';
import { parseFrontmatter } from '../../src/features/markdown/frontmatter';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';

const enc = new TextEncoder();
const NOW = '2026-08-02T00:00:00.000Z';

interface Fake {
  title?: string;
  entries?: Array<{
    lid: string;
    title?: string;
    body: string;
    archetype?: string;
    created_at?: string;
    updated_at?: string;
  }>;
  assets?: Array<{ key: string; mime: string | null; bytes: Uint8Array }>;
  relations?: number;
  revisionLids?: string[];
  batch?: number;
}

function source(f: Fake): ArchiveSource {
  const entries = (f.entries ?? []).map((e, i) => ({
    lid: e.lid,
    title: e.title ?? e.lid,
    archetype: e.archetype ?? 'text',
    created_at: e.created_at ?? null,
    updated_at: e.updated_at ?? null,
    entry_order: i + 1,
    status: null,
    date: null,
    archived: 0,
    body: e.body,
  }));
  return {
    cid: 'c1',
    title: f.title ?? 'テスト',
    listEntryMetas: async () =>
      entries.map((e) => {
        const { body, ...m } = e;
        void body;
        return m;
      }),
    listBodies: async (after) => {
      const rest = after ? entries.filter((e) => e.entry_order > after.entryOrder) : entries;
      const slice = rest.slice(0, Math.max(1, f.batch ?? entries.length));
      const last = slice[slice.length - 1];
      return {
        rows: slice.map((e) => ({ lid: e.lid, body: e.body })),
        done: slice.length >= rest.length,
        ...(last ? { next: { entryOrder: last.entry_order, lid: last.lid } } : {}),
      };
    },
    listRelations: async () =>
      Array.from({ length: f.relations ?? 0 }, (_, i) => ({
        id: `r${i}`,
        from_lid: 'a',
        to_lid: 'b',
        kind: 'link',
        created_at: null,
        updated_at: null,
      })),
    listAssetMetas: async () =>
      (f.assets ?? []).map((a) => ({
        key: a.key,
        mime: a.mime,
        size: a.bytes.length,
        hash: null,
      })),
    getAssetBlob: async (key) => {
      const a = (f.assets ?? []).find((x) => x.key === key);
      return a ? new Blob([a.bytes as unknown as BlobPart]) : null;
    },
    listRevisionLids: async () => f.revisionLids ?? [],
    getRevisionChain: async () => [],
  };
}

/** 書いた ZIP を**自分の reader で**開く(この 2 つが対であることが規律)。 */
async function open(blob: Blob): Promise<{
  names: string[];
  text(name: string): Promise<string>;
  bytes(name: string): Promise<Uint8Array>;
  manifest(): Promise<Record<string, unknown>>;
}> {
  const dir = await readZipDirectory(blob);
  const byName = new Map(dir.map((e) => [e.name, e]));
  return {
    names: dir.map((e) => e.name),
    text: async (name) => readZipText(blob, byName.get(name)!),
    bytes: async (name) =>
      new Uint8Array(await (await readZipEntry(blob, byName.get(name)!)).arrayBuffer()),
    manifest: async () =>
      JSON.parse(await readZipText(blob, byName.get('manifest.json')!)) as Record<string, unknown>,
  };
}

describe('md ZIP — 外で読める形になっているか', () => {
  it('1 entry = 1 `.md`(題名がファイル名になる)', async () => {
    const out = await writeMarkdownZip(
      source({
        entries: [
          { lid: 'n1', title: '議事録', body: '# 議事録\n本文\n' },
          { lid: 'n2', title: '買い物メモ', body: '- 牛乳\n' },
        ],
      }),
      NOW,
    );
    const z = await open(out.blob);
    expect(z.names.sort()).toEqual(['manifest.json', '議事録.md', '買い物メモ.md'].sort());
    expect(await z.text('買い物メモ.md')).toContain('- 牛乳');
  });

  it('frontmatter は最小(title / archetype / 日付)', async () => {
    const out = await writeMarkdownZip(
      source({
        entries: [
          {
            lid: 'n1',
            title: '議事録',
            body: '本文\n',
            created_at: '2026-07-01T00:00:00Z',
            updated_at: '2026-07-02T00:00:00Z',
          },
        ],
      }),
      NOW,
    );
    const md = await (await open(out.blob)).text('議事録.md');
    // ⚠ 日時は quote される(`:` を含む値を裸で書くと YAML は別物に読む)
    expect(md).toBe(
      '---\ntitle: 議事録\narchetype: text\ncreated_at: "2026-07-01T00:00:00Z"\n' +
        'updated_at: "2026-07-02T00:00:00Z"\n---\n本文\n',
    );
  });

  it('🔑 出した frontmatter が**読み戻せる**(書けても読めなければ意味が無い)', async () => {
    // quote の有無・改行・記号を含む値が、parser を通して元の文字列に戻るか。
    // ⚠ ここが崩れると「外のツールでは題名が化ける」型の壊れ方をする
    const out = await writeMarkdownZip(
      source({
        entries: [
          {
            lid: 'n1',
            title: 'A: B — 「引用」#1',
            body: '本文\n',
            created_at: '2026-07-01T00:00:00Z',
          },
        ],
      }),
      NOW,
    );
    const md = await (await open(out.blob)).text(`${slugForTitle('A: B — 「引用」#1')}.md`);
    const r = parseFrontmatter(md);
    expect(r.found).toBe(true);
    expect(r.meta['title']).toBe('A: B — 「引用」#1');
    expect(r.meta['created_at']).toBe('2026-07-01T00:00:00Z');
    expect(r.body).toBe('本文\n');
  });

  it('日付が無いノートは日付の行を出さない(null を書かない)', async () => {
    const out = await writeMarkdownZip(source({ entries: [{ lid: 'n1', body: 'x' }] }), NOW);
    const md = await (await open(out.blob)).text('n1.md');
    expect(md).not.toContain('created_at');
    expect(md).not.toContain('null');
  });

  it('🔑 本文の `asset:<key>` が**相対パス**になる(外では書き換えないと出ない)', async () => {
    const out = await writeMarkdownZip(
      source({
        entries: [{ lid: 'n1', title: '図解', body: '説明\n![図](asset:ast-1)\n' }],
        assets: [{ key: 'ast-1', mime: 'image/png', bytes: enc.encode('PNG') }],
      }),
      NOW,
    );
    const z = await open(out.blob);
    const md = await z.text('図解.md');
    expect(md).toContain('![図](assets/ast-1.png)');
    expect(md).not.toContain('asset:');
    // 参照先が**実在する**(リンク切れの markdown を出さない)
    expect(z.names).toContain('assets/ast-1.png');
    expect(await z.text('assets/ast-1.png')).toBe('PNG');
  });

  it('🔴 中身の無い添付は参照を**そのまま残す**(黙って壊さない)', async () => {
    const src = source({
      entries: [{ lid: 'n1', body: '![](asset:ast-gone)' }],
      assets: [{ key: 'ast-gone', mime: 'image/png', bytes: enc.encode('x') }],
    });
    const out = await writeMarkdownZip({ ...src, getAssetBlob: async () => null }, NOW);
    const z = await open(out.blob);
    expect(await z.text('n1.md')).toContain('assets/ast-gone.png'); // 参照は書き換わる
    expect(z.names).not.toContain('assets/ast-gone.png'); // 中身は無い
    expect(out.warnings).toContain('添付の中身が見つかりませんでした: ast-gone');
    expect((await z.manifest()).missing_assets).toEqual(['ast-gone']);
  });

  it('知らない key の参照は書き換えない(存在しない相対パスを作らない)', async () => {
    const out = await writeMarkdownZip(
      source({ entries: [{ lid: 'n1', body: '![](asset:ast-unknown)' }] }),
      NOW,
    );
    expect(await (await open(out.blob)).text('n1.md')).toContain('asset:ast-unknown');
  });

  it('🔴 添付 entry(body が frontmatter だけ)が**空の .md** にならない', async () => {
    const body =
      '---\nattachment.name: 見積.pdf\nattachment.mime: application/pdf\n' +
      'attachment.asset_key: ast-p\n---\n';
    const out = await writeMarkdownZip(
      source({
        entries: [{ lid: 'a1', title: '見積の件', body, archetype: 'attachment' }],
        assets: [{ key: 'ast-p', mime: 'application/pdf', bytes: enc.encode('PDF') }],
      }),
      NOW,
    );
    const z = await open(out.blob);
    const md = await z.text('見積の件.md');
    expect(md).toContain('[見積.pdf](assets/ast-p.pdf)'); // 中身へ辿り着ける
    expect(md).not.toContain('!['); // pdf は画像ではない
    expect(z.names).toContain('assets/ast-p.pdf');
  });

  it('画像の添付 entry は `![...]`(そのまま表示される)', async () => {
    const body = '---\nattachment.name: dot.png\nattachment.asset_key: ast-i\n---\n';
    const out = await writeMarkdownZip(
      source({
        entries: [{ lid: 'a1', body, archetype: 'attachment' }],
        assets: [{ key: 'ast-i', mime: 'image/png', bytes: enc.encode('PNG') }],
      }),
      NOW,
    );
    expect(await (await open(out.blob)).text('a1.md')).toContain('![dot.png](assets/ast-i.png)');
  });

  it('本文が既にその添付を出しているなら二重に出さない', async () => {
    const body =
      '---\nattachment.asset_key: ast-i\n---\n![](asset:ast-i)\n';
    const out = await writeMarkdownZip(
      source({
        entries: [{ lid: 'a1', body, archetype: 'attachment' }],
        assets: [{ key: 'ast-i', mime: 'image/png', bytes: enc.encode('PNG') }],
      }),
      NOW,
    );
    const md = await (await open(out.blob)).text('a1.md');
    expect(md.match(/assets\/ast-i\.png/g)).toHaveLength(1);
  });

  it('参照されていない添付は入れない(数を言う)', async () => {
    const out = await writeMarkdownZip(
      source({
        entries: [{ lid: 'n1', body: 'ふつうの本文' }],
        assets: [{ key: 'ast-orphan', mime: 'image/png', bytes: enc.encode('SECRET') }],
      }),
      NOW,
    );
    const z = await open(out.blob);
    expect(z.names).not.toContain('assets/ast-orphan.png');
    expect(out.warnings).toContain('どの本文からも参照されていない添付 1 件は含めませんでした');
  });
});

describe('md ZIP — 片道であることを書き残す', () => {
  it('🔴 manifest が「戻せない」と落ちた件数を持つ', async () => {
    const out = await writeMarkdownZip(
      source({
        entries: [{ lid: 'n1', body: 'x' }],
        relations: 3,
        revisionLids: ['n1', 'n2'],
      }),
      NOW,
    );
    expect(await (await open(out.blob)).manifest()).toMatchObject({
      format: MD_FORMAT,
      reversible: false,
      entry_count: 1,
      dropped: { relations: 3, revision_entries: 2 },
    });
  });

  it('落ちるものは画面にも言う(manifest を開かないと分からない形にしない)', async () => {
    const out = await writeMarkdownZip(
      source({ entries: [{ lid: 'n1', body: 'x' }], relations: 3, revisionLids: ['n1'] }),
      NOW,
    );
    expect(out.warnings).toContain('関連 3 件は markdown に居場所が無いので落ちます');
    expect(out.warnings).toContain('履歴を持つノート 1 件の履歴は落ちます');
    expect(out.dropped).toEqual({ relations: 3, revisionEntries: 1 });
  });

  it('落ちるものが無いなら黙る(毎回出る注意は読まれなくなる)', async () => {
    const out = await writeMarkdownZip(source({ entries: [{ lid: 'n1', body: 'x' }] }), NOW);
    expect(out.warnings).toEqual([]);
  });

  it('frontmatter の値を上書きしたら言う(user が書いた値が消える)', async () => {
    const out = await writeMarkdownZip(
      source({ entries: [{ lid: 'n1', title: '正しい題名', body: '---\ntitle: 古い題名\n---\n' }] }),
      NOW,
    );
    expect(out.warnings).toEqual([
      'frontmatter の title を entry の値で上書きしました: 正しい題名',
    ]);
    expect(await (await open(out.blob)).text('正しい題名.md')).toContain('title: 正しい題名');
  });

  it('同じ値なら上書きを言わない(毎回鳴る注意にしない)', async () => {
    const out = await writeMarkdownZip(
      source({ entries: [{ lid: 'n1', title: '題名', body: '---\ntitle: 題名\n---\n' }] }),
      NOW,
    );
    expect(out.warnings).toEqual([]);
  });
});

describe('md ZIP — 実在の OS で開けるファイル名', () => {
  it.each([
    ['議事録 2026-07', '議事録 2026-07'],
    ['a/b:c*d?e"f<g>h|i', 'a-b-c-d-e-f-g-h-i'],
    ['   ', 'untitled'],
    ['', 'untitled'],
    ['...', 'untitled'],
    ['メモ 🎉', 'メモ 🎉'], // サロゲートペアを割らない
    ['CON', 'CON-'], // Windows は `CON.md` を作れない
    ['nul', 'nul-'],
    // ⚠ Win32 は**最初のドットより前**でデバイス解決する ── `con.txt.md` も作れない
    ['con.txt', 'con.txt-'],
    ['NUL.log', 'NUL.log-'],
    ['console', 'console'], // 予約語で**始まる**だけの名前は触らない
    ['x'.repeat(200), 'x'.repeat(60)],
  ])('slugForTitle(%j) → %j', (title, expected) => {
    expect(slugForTitle(title)).toBe(expected);
  });

  it('🔴 同題のノートは `-2` を**拡張子の直前**に挿す(後勝ちで消さない)', async () => {
    const out = await writeMarkdownZip(
      source({
        entries: [
          { lid: 'n1', title: 'メモ', body: '1 番目' },
          { lid: 'n2', title: 'メモ', body: '2 番目' },
          { lid: 'n3', title: 'メモ', body: '3 番目' },
        ],
      }),
      NOW,
    );
    const z = await open(out.blob);
    expect(z.names.filter((n) => n.endsWith('.md')).sort()).toEqual([
      'メモ-2.md',
      'メモ-3.md',
      'メモ.md',
    ]);
    // 中身が取り違わっていない(名前だけ揃っても意味が無い)
    expect(await z.text('メモ.md')).toContain('1 番目');
    expect(await z.text('メモ-2.md')).toContain('2 番目');
    expect(await z.text('メモ-3.md')).toContain('3 番目');
  });

  it('🔑 日本語のファイル名が自分の reader で読み戻せる(bit 11 に頼らない)', async () => {
    // P6c で「bit 11 は読まない・妥当な UTF-8 かで決める」と決めたので、
    // **書いた名前を自分で読める**ことを確かめる(設計 doc §4-D)
    const out = await writeMarkdownZip(
      source({ entries: [{ lid: 'n1', title: '打ち合わせ議事録', body: '本文' }] }),
      NOW,
    );
    expect((await open(out.blob)).names).toContain('打ち合わせ議事録.md');
  });

  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['application/pdf', 'pdf'],
    ['text/plain; charset=utf-8', 'txt'], // パラメータ付きでも効く
    ['IMAGE/PNG', 'png'], // 大文字小文字を問わない
    ['application/x-unknown-thing', 'bin'], // 嘘の拡張子を付けない
    [null, 'bin'],
  ])('extForMime(%j) → %j', (mime, expected) => {
    expect(extForMime(mime)).toBe(expected);
  });
});

describe('md ZIP — 断るべきときに断る', () => {
  it('🔴 entry 0 件なら断る', async () => {
    await expect(writeMarkdownZip(source({}), NOW)).rejects.toThrow(/1 件もありません/);
  });

  it('🔴 前進しないカーソルで無限に回らない', async () => {
    const src = source({ entries: [{ lid: 'n1', body: 'a' }] });
    let calls = 0;
    const stuck: ArchiveSource = {
      ...src,
      listBodies: async () => {
        if (++calls > 50) throw new Error('打ち切り: 前進チェックが働いていない');
        return { rows: [{ lid: 'n1', body: 'a' }], done: false, next: { entryOrder: 1, lid: 'n1' } };
      },
    };
    await expect(writeMarkdownZip(stuck, NOW)).rejects.toThrow(/前進していません/);
    expect(calls).toBeLessThan(5);
  });

  it('本文がバッチに割れても全部入る', async () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      lid: `n${i}`,
      title: `ノート${i}`,
      body: `本文 ${i}`,
    }));
    const out = await writeMarkdownZip(source({ entries, batch: 2 }), NOW);
    const z = await open(out.blob);
    expect(z.names.filter((n) => n.endsWith('.md'))).toHaveLength(12);
    expect(await z.text('ノート11.md')).toContain('本文 11');
  });
});

describe('md ZIP — バイト列を壊さない', () => {
  it('添付のバイト列がそのまま入る(base64 も再圧縮も挟まない)', async () => {
    const bytes = new Uint8Array(5000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    const out = await writeMarkdownZip(
      source({
        entries: [{ lid: 'n1', body: '![](asset:ast-b)' }],
        assets: [{ key: 'ast-b', mime: 'application/octet-stream', bytes }],
      }),
      NOW,
    );
    const got = await (await open(out.blob)).bytes('assets/ast-b.bin');
    expect(got.length).toBe(bytes.length);
    expect(got.every((v, i) => v === bytes[i])).toBe(true);
  });
});
