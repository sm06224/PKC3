/**
 * P6d 段③: 可搬 HTML。
 *
 * 🔑 **base64 を 3 バイト境界で流し込む**性質を pin する ── ここが崩れると
 * 添付が壊れる(しかも「壊れている」とは見えない)。
 * 🔴 `</script` の退避も pin ── user が本文に `</script>` と書けるので、
 * 退避が無いとその 1 文字列で **HTML 全体が壊れる**。
 */
/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';
import {
  writePortableHtml,
  escapeForScriptData,
  HTML_FORMAT,
} from '../../src/features/export/pkc3-html';
import type { ArchiveSource } from '../../src/features/export/pkc3-archive';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

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
    getRevisionChain: async () => [],
  };
}

const NOW = '2026-08-02T00:00:00.000Z';

/**
 * 描かれた HTML の**見える文字**を取り出す(P8 段⑲)。
 *
 * 🔑 本文は書出し側で描いた HTML として入るので、原文と 1 文字一致はしない
 * (見出しの `#` は消え、typographer が引用符を丸める)。ここが見たいのは
 * 「**書いた中身が読める形で届いているか**」なので、見える文字で突き合わせる。
 */
function textOf(html: string): string {
  const el = document.createElement('div');
  el.innerHTML = html;
  return (el.textContent ?? '')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
}

/** 生成された HTML から `#pkc-data` の JSON を取り出す(閲覧側と同じ読み方)。 */
async function dataOf(blob: Blob): Promise<Record<string, never> & {
  entries: Array<{ lid: string; title: string; html: string; refs?: string[]; attach?: string[] }>;
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
    // 🔑 本文は**描かれて**入る(P8 段⑲)── かつては素の markdown 文字列を
    //    そのまま渡し、閲覧側が `<pre>` で出していた(見出しが `#` のまま)
    expect(d.entries.map((e) => e.title)).toEqual(['議事録', 'メモ']);
    expect(d.entries[0]!.html, '見出しが描かれていない').toContain('<h1');
    expect(textOf(d.entries[0]!.html)).toContain('議事録');
    expect(textOf(d.entries[0]!.html)).toContain('本文');
    expect(textOf(d.entries[1]!.html)).toContain('ふつうの本文');
    // ⚠ 原文をそのまま積んでいない(積むと配る量が倍になり、描く意味も無い)
    expect(JSON.stringify(d.entries[0]), '原文がそのまま入っている').not.toContain('# 議事録');
  });

  /**
   * 🔴 **退避の実装形ではなく「data script の中に生の `<` が 1 個も無い」性質**を pin する。
   * `</script` だけを退避していた版は、`<!--` → `<script` の並びで
   * トークナイザが double escaped 状態に入り **ページが丸ごと真っ白**になった
   * (review H1、実 Chromium 実測)。実装形を直書きで pin すると、その穴を
   * 塞ぐ変更のほうが test に落とされる。
   */
  const dataScript = async (blob: Blob): Promise<string> => {
    const html = await blob.text();
    const i = html.indexOf('>', html.indexOf('<script id="pkc-data"')) + 1;
    return html.slice(i, html.indexOf('</script>', i));
  };

  it.each([
    ['`</script>` と書くと壊れるやつ\n</SCRIPT foo>\n', '閉じタグ'],
    ['HTML のコメントは <!-- で始まる。\n<script src="x"> を書くと…', '🔴 <!-- + <script'],
    ['<!-- のあとに <script foo> が出てくる話', '🔴 同一行の <!-- + <script'],
    [`<!--${'x'.repeat(200)}<script bar>`, '🔴 200 文字離れていても'],
    ['<!-- コメント --> の話と <script> の話', '--> で復帰する形'],
  ])('🔴 本文が %j でも HTML が壊れない(%s)', async (body) => {
    const out = await writePortableHtml(source({ entries: [{ lid: 'n1', body }] }), NOW);
    // data script の中身に**生の `<` が 1 個も無い**= トークナイザは何の状態にも入れない
    expect(await dataScript(out.blob)).not.toContain('<');
    const d = await dataOf(out.blob);
    // 中身は**読める形で**保たれる。⚠ 1 文字一致では見られない ── markdown は
    // バッククォートを消し、typographer が `--` を en dash に丸める(どちらも正しい)。
    // ここで見たいのは「**生の `<` が 1 個も飲み込まれていない**」ことなので、
    // 危険な字そのものを数える(飲み込まれていたら本文が静かに欠ける)
    const angles = (t: string): number => (t.match(/</g) ?? []).length;
    expect(angles(body), 'この事例に `<` が無い(危険な字を測っていない)').toBeGreaterThan(0);
    expect(angles(textOf(d.entries[0]!.html)), '`<` が飲み込まれている').toBe(angles(body));
  });

  it('🔴 題名だけでも壊れない(1 個の script に全 entry を詰めているので合成する)', async () => {
    // 無関係な 2 つのノートの**題名**が合成して全体を壊した(review H1)
    const out = await writePortableHtml(
      source({
        entries: [
          { lid: 'n1', title: '<!-- 下書き', body: 'a' },
          { lid: 'n2', title: '<script の使い方', body: 'b' },
        ],
      }),
      NOW,
    );
    expect(await dataScript(out.blob)).not.toContain('<');
    const d = await dataOf(out.blob);
    expect(d.entries.map((e) => e.title)).toEqual(['<!-- 下書き', '<script の使い方']);
  });

  it('escapeForScriptData は `<` を退避し、値は変えない', () => {
    expect(escapeForScriptData('a</script>b<!--c')).toBe('a\\u003c/script>b\\u003c!--c');
    expect(escapeForScriptData('x > y')).toBe('x > y'); // それ以外は触らない
    // JSON の文字列としては同値 ── 読み手は素の JSON.parse でよい
    const v = { s: '<!--<script>--></script>' };
    expect(JSON.parse(escapeForScriptData(JSON.stringify(v)))).toEqual(v);
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
        entries: [{ lid: 'n1', body: '![](asset:a) と ![](asset:b)' }],
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
    expect(d.entries.map((e) => textOf(e.html).trim())).toEqual(entries.map((e) => e.body));
  });

  it('🔴 entry 0 件なら断る', async () => {
    await expect(writePortableHtml(source({}), NOW)).rejects.toThrow(/1 件もありません/);
  });

  it('bytes の無い添付は言う(黙って落とさない)', async () => {
    const src = source({ entries: [{ lid: 'n1', body: '![](asset:gone)' }] });
    const withMissing: ArchiveSource = {
      ...src,
      listAssetMetas: async () => [{ key: 'gone', mime: 'image/png', size: 1, hash: null }],
      getAssetBlob: async () => null,
    };
    const out = await writePortableHtml(withMissing, NOW);
    expect(out.warnings).toEqual(['添付の中身が見つかりませんでした: gone']);
    expect(out.counts.assets).toBe(0);
  });

  it('🔴 前進しないカーソルで無限に回らない', async () => {
    // 進まない source を掴むと `for(;;)` は永久に回り、parts が膨らんで落ちる
    // (UI は「書き出しています…」のまま)── 回り続けるより断る
    // ⚠ ガードを外すとこの test は**落ちずに止まる**(実測: 10 分でも終わらない)。
    // ハングは CI で原因が読めないので、source 側に打ち切りを持たせて
    // 「違う理由で落ちる」に変える ── どちらにせよ test は赤くなる
    const src = source({ entries: [{ lid: 'n1', body: 'a' }] });
    let calls = 0;
    const stuck: ArchiveSource = {
      ...src,
      listBodies: async () => {
        if (++calls > 50) throw new Error('打ち切り: 前進チェックが働いていない');
        return {
          rows: [{ lid: 'n1', body: 'a' }],
          done: false,
          next: { entryOrder: 1, lid: 'n1' },
        };
      },
    };
    await expect(writePortableHtml(stuck, NOW)).rejects.toThrow(/前進していません/);
    expect(calls).toBeLessThan(5); // 気づくのが早い(積み上げてから落ちない)
  });

  it('日本語の題名・本文が壊れない(UTF-8 の宣言込み)', async () => {
    const out = await writePortableHtml(
      source({ entries: [{ lid: 'n1', title: '打ち合わせ', body: '本文です 🎉' }] }),
      NOW,
    );
    const html = await out.blob.text();
    expect(html).toContain('<meta charset="utf-8">');
    const d = await dataOf(out.blob);
    expect(d.entries[0]!.title).toBe('打ち合わせ');
    expect(textOf(d.entries[0]!.html).trim()).toBe('本文です 🎉');
  });

  it('閲覧 UI が入っている(データだけの HTML を出さない)', async () => {
    const out = await writePortableHtml(source({ entries: [{ lid: 'n1', body: 'x' }] }), NOW);
    const html = await out.blob.text();
    expect(html).toContain('id="list"');
    expect(html).toContain('createObjectURL'); // 添付を見せる経路
  });
});

/**
 * 🔴 この module の**芯**:「全量を heap に載せない」。
 *
 * チャンクに割っても、符号化した**文字列を配列に積んだら**最後の `new Blob(parts)`
 * まで全部が heap に常駐する ── 16MB の添付で 21.34MB 常駐していた(review H2)。
 * チャンク化が抑えるのは*変換時のピーク*だけで、保持量は一切抑えない。
 *
 * ⚠ 出来上がった Blob からは中身の構成を見られないので、**構成部品を捕まえる**。
 * `Blob` を丸ごと差し替えるのではなく**継承**する(CLAUDE.md: グローバルを
 * 壊すと本物のエラーがそこに紛れる)。
 */
describe('可搬 HTML — heap に載せない', () => {
  /** 最後に組み立てた Blob の構成部品を返す。 */
  async function partsOfResult(run: () => Promise<{ blob: Blob }>): Promise<BlobPart[]> {
    const seen: BlobPart[][] = [];
    const Real = globalThis.Blob;
    class Spy extends Real {
      constructor(parts?: BlobPart[], opts?: BlobPropertyBag) {
        super(parts, opts);
        if (parts) seen.push(parts);
      }
    }
    vi.stubGlobal('Blob', Spy);
    try {
      await run();
    } finally {
      vi.unstubAllGlobals();
    }
    return seen[seen.length - 1]!; // 最後 = 出力 HTML そのもの
  }

  it('🔴 添付の base64 が文字列として常駐しない(Blob 化して手放す)', async () => {
    // チャンク 4 個ぶん。base64 にすると約 1MB になる
    const bytes = new Uint8Array(3 * 64 * 1024 * 4);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const parts = await partsOfResult(() =>
      writePortableHtml(
        source({
          entries: [{ lid: 'n1', body: '![](asset:k1)' }],
          assets: [{ key: 'k1', mime: 'image/png', bytes }],
        }),
        NOW,
      ),
    );
    const strChars = parts
      .filter((p): p is string => typeof p === 'string')
      .reduce((n, s) => n + s.length, 0);
    // 文字列で残ってよいのは骨組み(doctype / JSON の括弧 / 閲覧 UI)だけ。
    // base64 が 1 個でも文字列で残っていれば 80KB 以上になる
    expect(strChars).toBeLessThan(8 * 1024);
    // 添付の bytes は Blob の側に居る(= 出力自体は欠けていない)
    const blobBytes = parts
      .filter((p): p is Blob => p instanceof Blob)
      .reduce((n, b) => n + b.size, 0);
    expect(blobBytes).toBeGreaterThan(bytes.length); // base64 は 4/3 に膨らむ
  });

  it('🔴 本文もバッチごとに手放す(全本文が文字列で残らない)', async () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({
      lid: `n${i}`,
      body: 'あ'.repeat(2000),
    }));
    const parts = await partsOfResult(() => writePortableHtml(source({ entries, batch: 4 }), NOW));
    const strChars = parts
      .filter((p): p is string => typeof p === 'string')
      .reduce((n, s) => n + s.length, 0);
    expect(strChars).toBeLessThan(8 * 1024); // 本文だけで 80,000 文字ある
  });
});

/**
 * 🔴 これは**人に配るファイル**。バックアップと違い、消したノートの添付まで
 * 焼き込んではいけない(review H3: 削除済みノートの添付が完全な形で載っていた)。
 */
describe('可搬 HTML — 参照されていない添付を載せない', () => {
  it('🔴 どの本文からも参照されない添付は入らない(黙って落とさず数を言う)', async () => {
    const out = await writePortableHtml(
      source({
        entries: [{ lid: 'n1', title: '公開してよいノート', body: 'これは共有してよい本文' }],
        assets: [{ key: 'ast-deleted', mime: 'text/plain', bytes: enc.encode('SECRET-PAYROLL') }],
      }),
      NOW,
    );
    const html = await out.blob.text();
    expect(html).not.toContain(btoa('SECRET-PAYROLL'));
    expect(out.counts.assets).toBe(0);
    expect(out.warnings).toEqual([
      'どの本文からも参照されていない添付 1 件は含めませんでした',
    ]);
  });

  it('frontmatter からしか参照されない添付は**残す**(添付 entry を殺さない)', async () => {
    const out = await writePortableHtml(
      source({
        entries: [{ lid: 'a1', body: '---\nattachment.asset_key: ast-a\n---\n' }],
        assets: [{ key: 'ast-a', mime: 'image/png', bytes: enc.encode('PNG') }],
      }),
      NOW,
    );
    expect(out.counts.assets).toBe(1);
    expect(out.warnings).toEqual([]);
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
    expect(d.entries[0]).not.toHaveProperty('fm');
  });

  /**
   * 🔴 **書出し側に「4 つめのルール」を作らない**(review M2)。
   * `body.startsWith('---\n')` のような手軽なガードは本物の `parseFrontmatter`
   * より狭く、**アプリでは見えている添付が書出しでは消える** ── この PR が
   * 「smoke で踏んで直した」と宣言しているのと同じ症状の再発だった。
   * 判定は本物 1 つに寄せる、という性質をここで pin する。
   */
  it.each([
    ['--- \nattachment.asset_key: ast-a\n---\n本文', '開始 fence の末尾に空白'],
    ['---\r\nattachment.asset_key: ast-a\r\n---\r\n本文', 'CRLF'],
    ['---\nattachment.asset_key: ast-a\n--- \n本文', '終了 fence の末尾に空白'],
  ])('🔴 本物の parser が受理する形は全部拾う(%j / %s)', async (body) => {
    const out = await writePortableHtml(
      source({
        entries: [{ lid: 'a1', body }],
        assets: [{ key: 'ast-a', mime: 'image/png', bytes: enc.encode('PNG') }],
      }),
      NOW,
    );
    const d = await dataOf(out.blob);
    expect((d.entries[0] as { attach?: string[] }).attach).toEqual(['ast-a']);
    expect(out.counts.assets).toBe(1); // keep-set からも漏れない
  });

  it('添付の表示名を asset meta に載せる(1 ノートに 2 添付でも見分けられる)', async () => {
    const body =
      '---\nattachment.name: 見積A.pdf\nattachment.asset_key: ast-a\n---\n';
    const out = await writePortableHtml(
      source({
        entries: [{ lid: 'a1', title: '見積の件', body }],
        assets: [{ key: 'ast-a', mime: 'application/pdf', bytes: enc.encode('PDF') }],
      }),
      NOW,
    );
    const d = await dataOf(out.blob);
    expect(d.assets[0]).toMatchObject({ key: 'ast-a', name: '見積A.pdf' });
  });
});

/**
 * P8 段⑲: 本文を描く仕事は**差し替えられる**(= アプリはワーカーへ逃がせる)。
 *
 * > user 指示 2026-08-03(不可侵)「基本的に重い処理はワーカーにしてください」
 *
 * ⚠ 「引数がある」だけでは足りない ── **渡したものが実際に使われる**ことと、
 * 渡さなかったときも**同じ描画**になることの両方を見る。
 */
describe('本文を描く仕事の逃がし方', () => {
  it('🔴 渡した描画器が**実際に使われる**(件数ぶん呼ばれる)', async () => {
    const seen: string[] = [];
    const out = await writePortableHtml(
      source({
        entries: [
          { lid: 'n1', body: '# あ\n' },
          { lid: 'n2', body: '# い\n' },
        ],
      }),
      NOW,
      (text) => {
        seen.push(text);
        return Promise.resolve('<p data-from-worker>置き換え</p>');
      },
    );
    expect(seen, '渡した描画器が呼ばれていない').toEqual(['# あ\n', '# い\n']);
    const d = await dataOf(out.blob);
    expect(d.entries[0]!.html, '渡した描画器の結果が使われていない').toContain('data-from-worker');
  });

  it('⚠ frontmatter は描画器に渡さない(メタは本文ではない)', async () => {
    const seen: string[] = [];
    await writePortableHtml(
      source({ entries: [{ lid: 'a1', body: '---\nattachment.name: x.png\n---\n本文\n' }] }),
      NOW,
      (text) => {
        seen.push(text);
        return Promise.resolve('');
      },
    );
    expect(seen[0], 'frontmatter を本文として描いている').toBe('本文\n');
  });

  it('⚠ 渡さなくても同じ HTML になる(ワーカーは速さの話で、正しさの話ではない)', async () => {
    const body = '## 見出し\n\n- あ\n';
    const a = await dataOf((await writePortableHtml(source({ entries: [{ lid: 'n1', body }] }), NOW)).blob);
    const b = await dataOf(
      (
        await writePortableHtml(source({ entries: [{ lid: 'n1', body }] }), NOW, (t) =>
          Promise.resolve(renderMarkdown(t)),
        )
      ).blob,
    );
    expect(a.entries[0]!.html).toBe(b.entries[0]!.html);
  });
});

/**
 * 閲覧側(インライン JS)を**そのまま実行**して確かめる。
 * ⚠ 「script 文字列に createObjectURL が含まれる」型の assert では、
 * 実際に描けるかは何も分からない ── 動かして DOM を見る。
 */
describe('可搬 HTML — 閲覧側を実行する', () => {
  /** 生成 HTML から DOM を組み立て、インライン script を実行する。 */
  async function run(blob: Blob, mutate?: (json: string) => string): Promise<void> {
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
    data.textContent = mutate ? mutate(dataJson) : dataJson;
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

  /**
   * P8 段⑲: 🔴 **書いたとおりの形で読める**。
   *
   * 直す前は本文を丸ごと `<pre>` に入れていたので、見出しも表も箇条書きも
   * **記号のまま**だった ── 「単体で開いて読める」と案内している当のファイルが
   * 一番読みにくい、という状態。⚠ 観測点は「HTML に h2 の字が在るか」ではなく
   * **組み上がった DOM の要素**である。
   */
  it('🔴 見出し・箇条書き・表・コードが**構造として**出る', async () => {
    await run(
      (
        await writePortableHtml(
          source({
            entries: [
              {
                lid: 'n1',
                body: '## 見出し\n\n- あ\n- い\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n',
              },
            ],
          }),
          NOW,
        )
      ).blob,
    );
    const box = document.getElementById('body')!;
    expect(box.querySelector('h2'), '見出しが出ていない').not.toBeNull();
    expect(box.querySelectorAll('li'), '箇条書きが出ていない').toHaveLength(2);
    expect(box.querySelectorAll('table td'), '表が出ていない').toHaveLength(2);
    expect(box.querySelector('pre code'), 'コードが出ていない').not.toBeNull();
    // 記号がそのまま残っていない(= `<pre>` に流し込んだ形に戻っていない)
    expect(box.textContent, 'markdown の記号がそのまま出ている').not.toContain('## 見出し');
  });

  /**
   * ⚠ 図は**原文のまま**見せる(閲覧側に mermaid を積まない)。器が空のまま
   * 残ると「何も無い」ように見えるので、原文が読めることを見る。
   */
  it('🔴 図は原文が読める形で出る(空の器を残さない)', async () => {
    await run(
      (
        await writePortableHtml(
          source({ entries: [{ lid: 'n1', body: '```mermaid\ngraph TD\n  A-->B\n```\n' }] }),
          NOW,
        )
      ).blob,
    );
    const box = document.getElementById('body')!;
    expect(box.textContent, '図の原文が読めない').toContain('graph TD');
    expect(box.querySelector('[data-pkc-mermaid-src] pre'), '図の器が空のまま').not.toBeNull();
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
    expect(document.getElementById('body')!.textContent!.trim()).toBe('AAA');
    btns[1]!.click();
    expect(document.getElementById('title')!.textContent).toBe('二つ目');
    expect(document.getElementById('body')!.textContent!.trim()).toBe('BBB');
    expect(btns[1]!.getAttribute('aria-current')).toBe('true');
    expect(btns[0]!.getAttribute('aria-current')).toBe('false');
  });

  it('CRLF の frontmatter も畳まれる(閲覧側に判定を持たせない)', async () => {
    // 閲覧側で自前に `---\n` を探していた版はここで frontmatter を垂れ流した
    const body = '---\r\nattachment.asset_key: ast-p\r\n---\r\n読める本文';
    await run(
      (await writePortableHtml(source({ entries: [{ lid: 'a1', body }], assets: [png] }), NOW)).blob,
    );
    const text = document.getElementById('body')!.textContent!;
    expect(text).toContain('読める本文');
    expect(text).not.toContain('attachment.asset_key');
  });

  it('添付の名前で保存できる(題名ではなく元のファイル名)', async () => {
    const body =
      '---\nattachment.name: 見積A.pdf\nattachment.asset_key: ast-x\n---\n';
    await run(
      (
        await writePortableHtml(
          source({
            entries: [{ lid: 'a1', title: '見積の件', body }],
            assets: [{ key: 'ast-x', mime: 'application/pdf', bytes: enc.encode('PDF') }],
          }),
          NOW,
        )
      ).blob,
    );
    // 題名を使うと、1 ノートに 2 添付あるとき同名・拡張子なしで落ちてくる
    expect(document.querySelector<HTMLAnchorElement>('#body a')!.getAttribute('download')).toBe(
      '見積A.pdf',
    );
  });

  /**
   * 🔴 「ゼロコピー・生成物のライフサイクル終端での即破棄」(user 指示 2026-07-27、不可侵)。
   * 起動時に全添付を復号する版は、本文 1 行を読みたいだけでメインスレッドが止まった。
   */
  it('🔴 開いた添付だけ復号し、離れたら捨てる', async () => {
    const create = vi.spyOn(URL, 'createObjectURL');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    try {
      const fm = (k: string): string => `---\nattachment.asset_key: ${k}\n---\n`;
      await run(
        (
          await writePortableHtml(
            source({
              entries: [
                { lid: 'a1', title: '一枚目', body: fm('ast-1') },
                { lid: 'a2', title: '二枚目', body: fm('ast-2') },
              ],
              assets: [
                { key: 'ast-1', mime: 'image/png', bytes: enc.encode('ONE') },
                { key: 'ast-2', mime: 'image/png', bytes: enc.encode('TWO') },
              ],
            }),
            NOW,
          )
        ).blob,
      );
      // 開いているのは 1 件目だけ ── 2 件目はまだ復号しない
      expect(create).toHaveBeenCalledTimes(1);
      expect(revoke).not.toHaveBeenCalled();

      document.querySelectorAll<HTMLButtonElement>('#list button')[1]!.click();
      expect(create).toHaveBeenCalledTimes(2);
      expect(revoke).toHaveBeenCalledTimes(1); // 離れた 1 件目は捨てる
      expect(document.querySelectorAll('#body img')).toHaveLength(1);
    } finally {
      create.mockRestore();
      revoke.mockRestore();
    }
  });

  it('🔴 データが壊れていても理由を出す(黙って真っ白にしない)', async () => {
    // DL が途中で終わったファイル = JSON が切れている
    await run(
      (await writePortableHtml(source({ entries: [{ lid: 'n1', body: 'x' }] }), NOW)).blob,
      (json) => json.slice(0, Math.floor(json.length / 2)),
    );
    const fail = document.getElementById('fail');
    expect(fail?.textContent).toContain('このファイルを表示できませんでした');
    expect(fail?.textContent).toContain('ダウンロードが途中で終わっている');
  });
});
