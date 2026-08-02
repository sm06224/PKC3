/**
 * P6d 段③: 可搬 HTML。
 *
 * 🔑 **base64 を 3 バイト境界で流し込む**性質を pin する ── ここが崩れると
 * 添付が壊れる(しかも「壊れている」とは見えない)。
 * 🔴 `</script` の退避も pin ── user が本文に `</script>` と書けるので、
 * 退避が無いとその 1 文字列で **HTML 全体が壊れる**。
 */
/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import {
  writePortableHtml,
  escapeScriptEnd,
  HTML_FORMAT,
} from '../../src/features/export/pkc3-html';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';

const enc = new TextEncoder();

interface Fake {
  entries?: Array<{ lid: string; title?: string; body: string }>;
  assets?: Array<{ key: string; mime: string; bytes: Uint8Array }>;
  batch?: number;
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
  return {
    cid: 'c1',
    title: 'テスト',
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
    listRelations: async () => [],
    listAssetMetas: async () =>
      (f.assets ?? []).map((a) => ({ key: a.key, mime: a.mime, size: a.bytes.length, hash: null })),
    getAssetBlob: async (key) => {
      const a = (f.assets ?? []).find((x) => x.key === key);
      return a ? new Blob([a.bytes as unknown as BlobPart]) : null;
    },
    listRevisionLids: async () => [],
    listRevisionMetas: async () => [],
    getRevision: async () => null,
  };
}

const NOW = '2026-08-02T00:00:00.000Z';

/** 生成された HTML から `#pkc-data` の JSON を取り出す(閲覧側と同じ読み方)。 */
async function dataOf(blob: Blob): Promise<Record<string, never> & {
  entries: Array<{ lid: string; title: string; body: string }>;
  assets: Array<{ key: string; mime: string; size: number }>;
  assetData: Record<string, string>;
  title: string;
  format: string;
}> {
  const html = await blob.text();
  const m = /<script id="pkc-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('#pkc-data が見つかりません');
  // 閲覧側は素の JSON.parse で読む ── 退避は JSON の文字列として同値だから
  return JSON.parse(m[1]!) as never;
}

describe('可搬 HTML', () => {
  it('entry が往復する(閲覧側と同じ読み方で)', async () => {
    const src = source({
      entries: [
        { lid: 'n1', title: '議事録', body: '# 議事録\n本文\n' },
        { lid: 'n2', title: 'メモ', body: 'ふつうの本文' },
      ],
    });
    const out = await writePortableHtml(src, NOW);
    const d = await dataOf(out.blob);
    expect(d.format).toBe(HTML_FORMAT);
    expect(d.entries.map((e) => [e.title, e.body])).toEqual([
      ['議事録', '# 議事録\n本文\n'],
      ['メモ', 'ふつうの本文'],
    ]);
  });

  it('🔴 本文に `</script>` があっても HTML が壊れない', async () => {
    // user が普通に書ける文字列。退避が無いとここで script 要素が終わり、
    // 残りの JSON が**画面に地の文として出る**(しかも取り出せない)
    const body = '説明: `</script>` と書くと壊れるやつ\n</SCRIPT foo>\n';
    const out = await writePortableHtml(source({ entries: [{ lid: 'n1', body }] }), NOW);
    const html = await out.blob.text();
    // 生の `</script` は**閉じタグ 1 個だけ**(データ内には現れない)
    expect(html.match(/<\/script/gi)).toHaveLength(2); // データ用 + viewer 用
    const d = await dataOf(out.blob);
    expect(d.entries[0]!.body).toBe(body); // 中身は完全に保たれる
  });

  it('escapeScriptEnd は大文字小文字を問わない', () => {
    expect(escapeScriptEnd('a</script>b</SCRIPT >c')).toBe('a<\\/script>b<\\/SCRIPT >c');
    // それ以外は触らない(`<` 単独 / `</style` など)
    expect(escapeScriptEnd('x < y </style>')).toBe('x < y </style>');
  });

  it('🔑 添付が base64 で往復する(チャンク境界を跨いでも壊れない)', async () => {
    // 3 の倍数で区切らないと連結した base64 が壊れる ── チャンク 1 個ぶんを
    // 明確に超える大きさで確かめる
    const bytes = new Uint8Array(3 * 64 * 1024 + 12345);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 13) & 0xff;
    const out = await writePortableHtml(
      source({
        entries: [{ lid: 'n1', body: '![図](asset:k1)' }],
        assets: [{ key: 'k1', mime: 'image/png', bytes }],
      }),
      NOW,
    );
    const d = await dataOf(out.blob);
    // 閲覧側と同じ手順で復号する
    const bin = atob(d.assetData.k1!);
    const got = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) got[i] = bin.charCodeAt(i);
    expect(got.length).toBe(bytes.length);
    expect([...got.slice(0, 16)]).toEqual([...bytes.slice(0, 16)]);
    expect([...got.slice(-16)]).toEqual([...bytes.slice(-16)]);
    // 全長の一致(1 バイトでもずれたら base64 の境界が壊れている)
    expect(got.every((v, i) => v === bytes[i])).toBe(true);
  });

  it('添付が複数あっても取り違えない', async () => {
    const out = await writePortableHtml(
      source({
        entries: [{ lid: 'n1', body: 'x' }],
        assets: [
          { key: 'a', mime: 'image/png', bytes: enc.encode('AAAA') },
          { key: 'b', mime: 'image/webp', bytes: enc.encode('BBBBBB') },
        ],
      }),
      NOW,
    );
    const d = await dataOf(out.blob);
    expect(atob(d.assetData.a!)).toBe('AAAA');
    expect(atob(d.assetData.b!)).toBe('BBBBBB');
    expect(d.assets.map((a) => a.mime)).toEqual(['image/png', 'image/webp']);
  });

  it('本文がバッチに割れても全部入る', async () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({ lid: `n${i}`, body: `本文 ${i}` }));
    const out = await writePortableHtml(source({ entries, batch: 2 }), NOW);
    const d = await dataOf(out.blob);
    expect(d.entries.map((e) => e.body)).toEqual(entries.map((e) => e.body));
  });

  it('🔴 entry 0 件なら断る', async () => {
    await expect(writePortableHtml(source({}), NOW)).rejects.toThrow(/1 件もありません/);
  });

  it('bytes の無い添付は言う(黙って落とさない)', async () => {
    const src = source({ entries: [{ lid: 'n1', body: 'x' }] });
    const withMissing: ArchiveSource = {
      ...src,
      listAssetMetas: async () => [{ key: 'gone', mime: 'image/png', size: 1, hash: null }],
      getAssetBlob: async () => null,
    };
    const out = await writePortableHtml(withMissing, NOW);
    expect(out.warnings).toEqual(['添付の中身が見つかりませんでした: gone']);
    expect(out.counts.assets).toBe(0);
  });

  it('日本語の題名・本文が壊れない(UTF-8 の宣言込み)', async () => {
    const out = await writePortableHtml(
      source({ entries: [{ lid: 'n1', title: '打ち合わせ', body: '本文です 🎉' }] }),
      NOW,
    );
    const html = await out.blob.text();
    expect(html).toContain('<meta charset="utf-8">');
    const d = await dataOf(out.blob);
    expect(d.entries[0]).toMatchObject({ title: '打ち合わせ', body: '本文です 🎉' });
  });

  it('閲覧 UI が入っている(データだけの HTML を出さない)', async () => {
    const out = await writePortableHtml(source({ entries: [{ lid: 'n1', body: 'x' }] }), NOW);
    const html = await out.blob.text();
    expect(html).toContain('id="list"');
    expect(html).toContain('createObjectURL'); // 添付を見せる経路
  });
});

/**
 * 🔴 **添付 entry の body は frontmatter だけ**で `asset:` 参照を含まない。
 * 本文だけを走査する閲覧側からは「添付ゼロのノート」に見える ── smoke で実際に踏んだ。
 * 書き出し側が `attach` として解決する、という**この PR の要**を pin する。
 */
describe('可搬 HTML — 本文の外にある添付参照', () => {
  const fm = (k: string): string =>
    `---\nattachment.name: dot.png\nattachment.mime: image/png\nattachment.asset_key: ${k}\n---\n`;

  it('🔴 添付 entry(frontmatter だけの body)に attach が出る', async () => {
    const out = await writePortableHtml(
      source({
        entries: [{ lid: 'a1', title: 'dot.png', body: fm('ast-abc') }],
        assets: [{ key: 'ast-abc', mime: 'image/png', bytes: enc.encode('PNG') }],
      }),
      NOW,
    );
    const d = await dataOf(out.blob);
    expect((d.entries[0] as { attach?: string[] }).attach).toEqual(['ast-abc']);
  });

  it('archetype を知らなくても *_asset_key を拾う(将来 field も落とさない)', async () => {
    const body =
      '---\nattachment.asset_key: ast-a\nattachment.app_icon_asset_key: ast-i\n---\n説明\n';
    const out = await writePortableHtml(source({ entries: [{ lid: 'a1', body }] }), NOW);
    const d = await dataOf(out.blob);
    expect((d.entries[0] as { attach?: string[] }).attach).toEqual(['ast-a', 'ast-i']);
  });

  it('同じ key が 2 つの field にあっても 1 回だけ', async () => {
    const body = '---\nattachment.asset_key: ast-a\nattachment.app_icon_asset_key: ast-a\n---\n';
    const out = await writePortableHtml(source({ entries: [{ lid: 'a1', body }] }), NOW);
    const d = await dataOf(out.blob);
    expect((d.entries[0] as { attach?: string[] }).attach).toEqual(['ast-a']);
  });

  it('frontmatter の無い本文には attach を付けない(JSON を無駄に太らせない)', async () => {
    const out = await writePortableHtml(
      source({ entries: [{ lid: 'n1', body: '# ふつうのノート\n' }] }),
      NOW,
    );
    const d = await dataOf(out.blob);
    expect(d.entries[0]).not.toHaveProperty('attach');
  });
});

/**
 * 閲覧側(インライン JS)を**そのまま実行**して確かめる。
 * ⚠ 「script 文字列に createObjectURL が含まれる」型の assert では、
 * 実際に描けるかは何も分からない ── 動かして DOM を見る。
 */
describe('可搬 HTML — 閲覧側を実行する', () => {
  /** 生成 HTML から DOM を組み立て、インライン script を実行する。 */
  async function run(blob: Blob): Promise<void> {
    const html = await blob.text();
    const dataJson = /<script id="pkc-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
      html,
    )![1]!;
    // 閲覧側 script は**最後の** script 要素
    const viewer = /<script>\n([\s\S]*?)\n<\/script>$/.exec(html)![1]!;
    const markup = /<\/script>([\s\S]*?)<script>/.exec(html.slice(html.indexOf('</script>')))![1]!;
    document.body.innerHTML = markup;
    const data = document.createElement('script');
    data.id = 'pkc-data';
    data.type = 'application/json';
    data.textContent = dataJson; // 退避された `<\/script` は JSON として同値
    document.body.appendChild(data);
    new Function(viewer)();
    await new Promise((r) => setTimeout(r, 0)); // 先頭 entry の自動表示を待つ
  }

  const png = { key: 'ast-p', mime: 'image/png', bytes: enc.encode('PNGBYTES') };

  it('🔴 添付 entry の画像が描かれる(frontmatter 経由の参照)', async () => {
    const body =
      '---\nattachment.name: dot.png\nattachment.mime: image/png\nattachment.asset_key: ast-p\n---\n';
    await run(
      (await writePortableHtml(source({ entries: [{ lid: 'a1', title: 'dot.png', body }], assets: [png] }), NOW)).blob,
    );
    const imgs = document.querySelectorAll('#body img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.getAttribute('src')).toMatch(/^blob:/);
    // frontmatter は本文として垂れ流さない(メタであって読み物ではない)
    expect(document.getElementById('body')!.textContent).not.toContain('attachment.asset_key');
  });

  it('画像でない添付は保存できる導線にする(開けないまま黙らせない)', async () => {
    const body = '---\nattachment.name: memo.bin\nattachment.asset_key: ast-b\n---\n';
    await run(
      (
        await writePortableHtml(
          source({
            entries: [{ lid: 'a1', title: 'memo.bin', body }],
            assets: [{ key: 'ast-b', mime: 'application/octet-stream', bytes: enc.encode('BIN') }],
          }),
          NOW,
        )
      ).blob,
    );
    expect(document.querySelectorAll('#body img')).toHaveLength(0);
    const a = document.querySelector('#body a') as HTMLAnchorElement;
    expect(a.getAttribute('download')).toBe('memo.bin');
    expect(a.getAttribute('href')).toMatch(/^blob:/);
  });

  it('本文中の `![](asset:key)` も画像になる(markdown 経由の参照)', async () => {
    await run(
      (
        await writePortableHtml(
          source({ entries: [{ lid: 'n1', body: '図:\n![](asset:ast-p)\n以上' }], assets: [png] }),
          NOW,
        )
      ).blob,
    );
    expect(document.querySelectorAll('#body img')).toHaveLength(1);
    expect(document.getElementById('body')!.textContent).toContain('以上');
  });

  it('🔴 中身の無い参照は `asset:` のまま見せる(key だけ剥き出しにしない)', async () => {
    await run(
      (await writePortableHtml(source({ entries: [{ lid: 'n1', body: 'x![](asset:ast-none)y' }] }), NOW)).blob,
    );
    expect(document.getElementById('body')!.textContent).toContain('asset:ast-none');
  });

  it('同じ添付を本文と frontmatter の両方が指しても 2 回描かない', async () => {
    const body = `---\nattachment.asset_key: ast-p\n---\n![](asset:ast-p)\n`;
    await run(
      (await writePortableHtml(source({ entries: [{ lid: 'a1', body }], assets: [png] }), NOW)).blob,
    );
    expect(document.querySelectorAll('#body img')).toHaveLength(1);
  });

  it('一覧から選ぶと本文が入れ替わる(選択状態も動く)', async () => {
    await run(
      (
        await writePortableHtml(
          source({
            entries: [
              { lid: 'n1', title: '一つ目', body: 'AAA' },
              { lid: 'n2', title: '二つ目', body: 'BBB' },
            ],
          }),
          NOW,
        )
      ).blob,
    );
    const btns = document.querySelectorAll<HTMLButtonElement>('#list button');
    expect(btns).toHaveLength(2);
    expect(document.getElementById('body')!.textContent).toBe('AAA');
    btns[1]!.click();
    expect(document.getElementById('title')!.textContent).toBe('二つ目');
    expect(document.getElementById('body')!.textContent).toBe('BBB');
    expect(btns[1]!.getAttribute('aria-current')).toBe('true');
    expect(btns[0]!.getAttribute('aria-current')).toBe('false');
  });
});
