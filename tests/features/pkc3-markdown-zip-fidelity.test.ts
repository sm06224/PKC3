/** @vitest-environment happy-dom */
/**
 * P6d 段④ の**芯**を pin する。
 *
 * 🔴 この file は review で「3 つの目玉が 1 件も守られていない」と言われて生まれた。
 * 変異試験で **survive した 3 つ**が対象:
 *   ① 元 frontmatter の保全 ② 本文のバイト忠実性 ③ manifest の件数の正しさ
 * どれも「test が壊れを捕まえない」のではなく、**既に壊れているのに鳴っていなかった**。
 *
 * 加えて、外の OS / 外の markdown ツールで**実際に開けるか**に効く性質:
 *   大文字小文字の衝突 / 書き換えの誤爆 / リンクラベルの破壊。
 */
import { describe, expect, it } from 'vitest';
import { writeMarkdownZip } from '../../src/features/export/pkc3-markdown-zip';
import { readZipDirectory, readZipText } from '../../src/features/import/zip-reader';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';

const enc = new TextEncoder();
const NOW = '2026-08-02T00:00:00.000Z';

interface Fake {
  entries?: Array<{ lid: string; title?: string; body: string }>;
  assets?: Array<{ key: string; mime: string | null; bytes?: Uint8Array }>;
  /** meta にはあるが本文が返らない lid(= 静かに消える経路)。 */
  bodilessLids?: string[];
}

function source(f: Fake): ArchiveSource {
  const entries = (f.entries ?? []).map((e, i) => ({
    lid: e.lid,
    title: e.title ?? e.lid,
    archetype: 'text',
    created_at: null,
    updated_at: null,
    entry_order: i + 1,
    status: null,
    date: null,
    archived: 0,
    body: e.body,
  }));
  const ghosts = (f.bodilessLids ?? []).map((lid, i) => ({
    lid,
    title: lid,
    archetype: 'text',
    created_at: null,
    updated_at: null,
    entry_order: entries.length + i + 1,
    status: null,
    date: null,
    archived: 0,
  }));
  return {
    cid: 'c1',
    title: 'テスト',
    listEntryMetas: async () => [
      ...entries.map((e) => {
        const { body, ...m } = e;
        void body;
        return m;
      }),
      ...ghosts,
    ],
    listBodies: async () => ({
      rows: entries.map((e) => ({ lid: e.lid, body: e.body })),
      done: true,
    }),
    listRelations: async () => [],
    listAssetMetas: async () =>
      (f.assets ?? []).map((a) => ({
        key: a.key,
        mime: a.mime,
        size: a.bytes?.length ?? 0,
        hash: null,
      })),
    getAssetBlob: async (key) => {
      const a = (f.assets ?? []).find((x) => x.key === key);
      return a?.bytes ? new Blob([a.bytes as unknown as BlobPart]) : null;
    },
    listRevisionLids: async () => [],
    listRevisionMetas: async () => [],
    getRevision: async () => null,
  };
}

async function files(blob: Blob): Promise<Map<string, string>> {
  const dir = await readZipDirectory(blob);
  const out = new Map<string, string>();
  for (const e of dir) out.set(e.name, await readZipText(blob, e));
  return out;
}

const one = async (body: string, title = 'n1'): Promise<string> => {
  const out = await writeMarkdownZip(source({ entries: [{ lid: 'n1', title, body }] }), NOW);
  return (await files(out.blob)).get(`${title}.md`)!;
};

/**
 * 🔴 ①元 frontmatter の保全。
 *
 * parse → `serializeFrontmatter` で組み直す実装は、ミニ YAML の未対応構文を
 * **無言で落としていた**(review H-1)。書くのは原文 splice、という規律を pin する。
 */
describe('md ZIP — 元の frontmatter を落とさない', () => {
  it('🔴 ネストした mapping が壊れない(トップレベルへ昇格させない)', async () => {
    const md = await one('---\nvars:\n  project: ALPHA-7\n  client: Acme\n---\n本文\n');
    expect(md).toContain('vars:\n  project: ALPHA-7\n  client: Acme');
    expect(md).not.toContain('vars: []');
  });

  it('🔴 ブロックスカラー(`|`)の中身が消えない', async () => {
    const md = await one('---\nsummary: |\n  1 行目\n  2 行目\n---\n本文\n');
    expect(md).toContain('summary: |\n  1 行目\n  2 行目');
  });

  it('🔴 非 ASCII のキーが消えない', async () => {
    const md = await one('---\n所有者: 太郎\n---\n本文\n');
    expect(md).toContain('所有者: 太郎');
  });

  it('コメント行が消えない', async () => {
    const md = await one('---\n# これは覚え書き\nk: v\n---\n本文\n');
    expect(md).toContain('# これは覚え書き');
  });

  it('配列・数値・真偽値が書式ごと残る', async () => {
    const md = await one('---\ntags: [仕事, 至急]\nscore: 42\ndone: true\n---\n本文\n');
    expect(md).toContain('tags: [仕事, 至急]');
    expect(md).toContain('score: 42');
    expect(md).toContain('done: true');
  });

  it('🔴 16KB を超える frontmatter でも消えない(parser が諦める領域)', async () => {
    // `parseFrontmatter` は SOFT cap 超過で meta を諦める ── その戻り値で
    // body を組み直す実装は **frontmatter ごと本文まで削っていた**
    const big = Array.from({ length: 400 }, (_, i) => `k${i}: ${'あ'.repeat(60)}`).join('\n');
    const body = `---\n${big}\n---\n本文は残る\n`;
    const md = await one(body);
    expect(md).toContain('k399: ');
    expect(md).toContain('本文は残る');
    expect(md.length).toBeGreaterThan(body.length - 50); // 削れていない
  });

  it('読み切れなかったときは黙らない(注意に出す)', async () => {
    const big = Array.from({ length: 400 }, (_, i) => `k${i}: ${'あ'.repeat(60)}`).join('\n');
    const out = await writeMarkdownZip(
      source({ entries: [{ lid: 'n1', body: `---\n${big}\n---\n本文\n` }] }),
      NOW,
    );
    expect(out.warnings.some((w) => w.includes('読み切れませんでした'))).toBe(true);
  });
});

/**
 * 🔴 ②本文のバイト忠実性。`.md` は user の文章そのものであって、
 * export が整形して返すものではない。
 */
describe('md ZIP — 本文をバイトで保つ', () => {
  it('🔴 連続する空行が潰れない', async () => {
    const md = await one('段落 1\n\n\n\n段落 2\n');
    expect(md).toContain('段落 1\n\n\n\n段落 2\n');
  });

  it('🔴 frontmatter 直後の空行が消えない', async () => {
    const md = await one('---\nk: v\n---\n\n\n本文\n');
    expect(md).toContain('---\n\n\n本文\n');
  });

  it('🔴 frontmatter に見える水平線が frontmatter として食われない', async () => {
    // 先頭が `---` でない本文中の `---` は**ただの水平線**
    const md = await one('前置き\n\n---\n\nうしろ\n');
    expect(md).toContain('前置き\n\n---\n\nうしろ\n');
  });

  it('🔴 先頭が `---` の本文(fence が閉じない)を食い潰さない', async () => {
    const body = '---\n本文の水平線ではなく、frontmatter に見える行\n---\nつづき\n';
    const md = await one(body);
    // 元の 3 行が全部生きている(先頭段落が消えていた ── review H-1b)
    expect(md).toContain('本文の水平線ではなく、frontmatter に見える行');
    expect(md).toContain('つづき');
  });

  it('CRLF が LF に正規化されない', async () => {
    const md = await one('---\r\nk: v\r\n---\r\n1 行目\r\n2 行目\r\n');
    expect(md).toContain('1 行目\r\n2 行目\r\n');
  });

  it('末尾の空白・タブが削られない', async () => {
    const md = await one('行末に空白  \n\tタブ始まり\n');
    expect(md).toContain('行末に空白  \n\tタブ始まり\n');
  });
});

/** 🔴 ③manifest の件数が実態と一致する(嘘の数字を刻まない)。 */
describe('md ZIP — manifest の件数が実態と合う', () => {
  it('🔴 entry_count が**実際に入った `.md` の数**と一致する', async () => {
    const out = await writeMarkdownZip(
      source({
        entries: [
          { lid: 'n1', body: 'a' },
          { lid: 'n2', body: 'b' },
        ],
        bodilessLids: ['ghost1', 'ghost2'], // 一覧にはあるが本文が返らない
      }),
      NOW,
    );
    const f = await files(out.blob);
    const mdCount = [...f.keys()].filter((n) => n.endsWith('.md')).length;
    const manifest = JSON.parse(f.get('manifest.json')!) as { entry_count: number };
    expect(mdCount).toBe(2);
    expect(manifest.entry_count).toBe(mdCount);
  });

  it('🔴 本文が取れなかった entry は黙って消さない', async () => {
    const out = await writeMarkdownZip(
      source({ entries: [{ lid: 'n1', body: 'a' }], bodilessLids: ['ghost1', 'ghost2'] }),
      NOW,
    );
    expect(out.warnings).toContain('一覧にあって本文が取れなかった entry が 2 件あります');
  });
});

/**
 * 🔴 大文字小文字だけ違う名前。macOS / Windows は同一視するので、
 * 両方入れると**展開した時点でノートが消える**(review H-3 で実測)。
 */
describe('md ZIP — 大文字小文字を同一視する OS で消えない', () => {
  it('🔴 題名の大小違いが別ファイルになる', async () => {
    const out = await writeMarkdownZip(
      source({
        entries: [
          { lid: 'n1', title: 'Memo', body: 'A' },
          { lid: 'n2', title: 'memo', body: 'B' },
          { lid: 'n3', title: 'MEMO', body: 'C' },
        ],
      }),
      NOW,
    );
    const f = await files(out.blob);
    const md = [...f.keys()].filter((n) => n.endsWith('.md'));
    expect(md).toHaveLength(3);
    // **小文字に畳んでも**一意 = どの OS でも 3 件残る
    expect(new Set(md.map((n) => n.toLowerCase())).size).toBe(3);
    // 中身が取り違わっていない
    expect([...f.values()].filter((v) => v.includes('A'))).toHaveLength(1);
  });

  it('🔴 添付 key の大小違いが別ファイルになる(別画像で上書きさせない)', async () => {
    const out = await writeMarkdownZip(
      source({
        entries: [{ lid: 'n1', body: '![](asset:AST-1)\n![](asset:ast-1)\n' }],
        assets: [
          { key: 'AST-1', mime: 'image/png', bytes: enc.encode('UPPER') },
          { key: 'ast-1', mime: 'image/png', bytes: enc.encode('lower') },
        ],
      }),
      NOW,
    );
    const f = await files(out.blob);
    const paths = [...f.keys()].filter((n) => n.startsWith('assets/'));
    expect(paths).toHaveLength(2);
    expect(new Set(paths.map((p) => p.toLowerCase())).size).toBe(2);
    expect([...f.values()]).toContain('UPPER');
    expect([...f.values()]).toContain('lower');
  });
});

/**
 * 🔴 書き換えは**リンク/画像の宛先だけ**。生テキストを舐めると、
 * 書式の説明文や URL が改変される(review H-2 で実測)。
 */
describe('md ZIP — asset 参照の書き換えが誤爆しない', () => {
  const withAsset = async (body: string): Promise<string> => {
    const out = await writeMarkdownZip(
      source({
        entries: [{ lid: 'n1', body }],
        assets: [{ key: 'ast-1', mime: 'image/png', bytes: enc.encode('PNG') }],
      }),
      NOW,
    );
    return (await files(out.blob)).get('n1.md')!;
  };

  it('宛先は書き換える(これが本命)', async () => {
    expect(await withAsset('![図](asset:ast-1)\n')).toContain('![図](assets/ast-1.png)');
  });

  it('題名つきのリンクでも宛先だけ替える', async () => {
    expect(await withAsset('[x](asset:ast-1 "説明")\n')).toContain('[x](assets/ast-1.png "説明")');
  });

  it('`<...>` で囲まれた宛先も替える', async () => {
    expect(await withAsset('[x](<asset:ast-1>)\n')).toContain('[x](assets/ast-1.png)');
  });

  it('🔴 コードフェンスの中は触らない(書式の説明文が改変される)', async () => {
    const md = await withAsset('```\n説明: asset:ast-1 と書く\n```\n');
    expect(md).toContain('説明: asset:ast-1 と書く');
  });

  it('🔴 フェンス内の `![](asset:…)` も触らない(例として書いた行)', async () => {
    const md = await withAsset('~~~markdown\n![図](asset:ast-1)\n~~~\n');
    expect(md).toContain('![図](asset:ast-1)');
  });

  it('🔴 インラインコードの中は触らない', async () => {
    const md = await withAsset('`asset:ast-1` と書きます\n');
    expect(md).toContain('`asset:ast-1` と書きます');
  });

  it('🔴 URL の一部を壊さない', async () => {
    const md = await withAsset('[x](https://example.com/asset:ast-1/path)\n');
    expect(md).toContain('https://example.com/asset:ast-1/path');
  });

  it('🔴 素の文章に書いた `asset:` を勝手にパスにしない', async () => {
    const md = await withAsset('素の文章に asset:ast-1 と書く\n');
    expect(md).toContain('素の文章に asset:ast-1 と書く');
  });

  it('フェンスの後ろは通常どおり書き換わる(フェンスで止まらない)', async () => {
    const md = await withAsset('```\nasset:ast-1\n```\n\n![図](asset:ast-1)\n');
    expect(md).toContain('```\nasset:ast-1\n```');
    expect(md).toContain('![図](assets/ast-1.png)');
  });
});

describe('md ZIP — 添付への導線を壊さない', () => {
  it('🔴 名前に `]` が入っていてもリンクが死なない', async () => {
    const out = await writeMarkdownZip(
      source({
        entries: [
          { lid: 'a1', title: '見積', body: '---\nattachment.name: 見積]最新.pdf\nattachment.asset_key: ast-1\n---\n' },
        ],
        assets: [{ key: 'ast-1', mime: 'application/pdf', bytes: enc.encode('PDF') }],
      }),
      NOW,
    );
    const md = (await files(out.blob)).get('見積.md')!;
    // `[見積]` でリンクが閉じると、添付への唯一の導線が死ぬ
    expect(md).toContain('\\]');
    expect(md).toMatch(/\[見積\\\]最新\.pdf\]\(assets\/ast-1\.pdf\)/);
  });

  it('frontmatter に埋もれた参照でも添付を落とさない', async () => {
    // `attachment.extra` のような**素の key ではない**場所に居る参照。
    // 拾えないと「参照されていない」扱いで**添付が消える**
    const body = '---\nattachment.extra: {"icon_key":"ast-9"}\n---\n本文\n';
    const out = await writeMarkdownZip(
      source({
        entries: [{ lid: 'n1', body }],
        assets: [{ key: 'ast-9', mime: 'image/png', bytes: enc.encode('ICON') }],
      }),
      NOW,
    );
    expect(out.counts.assets).toBe(1);
    expect(out.warnings).toEqual([]);
  });
});

describe('md ZIP — 注意を出しすぎない', () => {
  it('同種の注意は上限で畳み、畳んだ件数を言う', async () => {
    // 3000 件ぶんの `<li>` を作らせない。⚠ ただし**黙って減らさない**
    const entries = Array.from({ length: 25 }, (_, i) => ({
      lid: `n${i}`,
      title: `題名${i}`,
      body: `---\ntitle: 別の題名\n---\n本文\n`,
    }));
    const out = await writeMarkdownZip(source({ entries }), NOW);
    const overwrites = out.warnings.filter((w) => w.includes('上書きしました'));
    expect(overwrites).toHaveLength(10);
    expect(out.warnings.some((w) => /ほか 15 件/.test(w))).toBe(true);
  });
});
