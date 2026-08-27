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
import { DOCUMENT_GLOBAL_ATTRS } from '../../src/features/markdown/document-globals';
import { WARN_CAP } from '../../src/features/export/warn-cap';
import { MAX_FENCE_ASSET_BYTES } from '../../src/features/markdown/fence-asset';
import { readFileSync } from 'node:fs';
import { extractBodyCss } from '../../build/body-css';

/** 焼いた CSS の正本(書き出し側と同じものを作って突合する)。 */
const APP_CSS = readFileSync('src/styles/app.css', 'utf8');
const TOKENS_CSS = readFileSync('src/styles/tokens.css', 'utf8');

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
  entries: Array<{
    lid: string;
    title: string;
    html: string;
    refs?: string[];
    attach?: string[];
    /** 文書属性(書字方向など)── user 報告 2-7 で載せるようにした */
    attrs?: Record<string, string>;
  }>;
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

  /**
   * 🔴 **注意は同種 10 件で畳む**(#202)。
   *
   * ⚠ 直す前はここだけ素の `push` で、**バックアップと Markdown ZIP には効いている
   * 規則が閲覧用 HTML にだけ無かった** ── 1 件につき 1 行積む所が 2 つあるので、
   * 該当が多い文書では注意が件数ぶん出る(`warn-cap.ts` 冒頭が「200 行の注意で
   * 3 列が数十 px に潰れた」事故を記録している)。
   * 🔑 **畳んだ件数が出ることまで**見る ── `finish()` の呼び忘れは
   * 「10 件までは出るが、超えたことは誰も知らない」になる。
   */
  it('🔴 中身の無い添付が多くても、注意は 10 件 + 件数に畳む', async () => {
    const n = WARN_CAP + 7;
    const keys = Array.from({ length: n }, (_, i) => `gone${i}`);
    const src = source({
      entries: [{ lid: 'n1', body: keys.map((k) => `![](asset:${k})`).join('\n\n') }],
    });
    const withMissing: ArchiveSource = {
      ...src,
      listAssetMetas: async () =>
        keys.map((key) => ({ key, mime: 'image/png', size: 1, hash: null })),
      getAssetBlob: async () => null,
    };
    const out = await writePortableHtml(withMissing, NOW);
    const lines = out.warnings.filter((w) => w.startsWith('添付の中身が見つかりませんでした'));
    expect(lines, '10 件で畳んでいない').toHaveLength(WARN_CAP);
    expect(out.warnings.at(-1), '畳んだ件数を言っていない').toBe(
      `中身の見つからない添付はほか ${n - WARN_CAP} 件あります`,
    );
  });

  it('🔴 一覧に無い entry の注意も同じ規則で畳む(経路ごとに乗せ忘れない)', async () => {
    const n = WARN_CAP + 3;
    const src = source({ entries: [{ lid: 'n1', body: 'a' }] });
    let done = false;
    const orphans: ArchiveSource = {
      ...src,
      // ⚠ **一覧に出ない lid の本文**を返す(= 飛ばされる側)
      listBodies: async () => {
        if (done) return { rows: [], done: true };
        done = true;
        return {
          // ⚠ **1 件だけ一覧に在る lid を混ぜる** ── 全部 ghost だと
          //    「書き出せる entry が 0 件」で先に断られ、注意まで到達しない
          rows: [
            { lid: 'n1', body: 'a' },
            ...Array.from({ length: n }, (_, i) => ({ lid: `ghost${i}`, body: 'x' })),
          ],
          done: true,
        };
      },
    };
    const out = await writePortableHtml(orphans, NOW);
    const lines = out.warnings.filter((w) => w.startsWith('本文はあるが一覧に無い'));
    expect(lines, '10 件で畳んでいない').toHaveLength(WARN_CAP);
    expect(out.warnings.at(-1)).toBe(`一覧に無い entry の注意はほか ${n - WARN_CAP} 件あります`);
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

  /** 部品のうち**文字列で残っているぶん**の文字数。 */
  const strCharsOf = (parts: BlobPart[]): number =>
    parts.filter((p): p is string => typeof p === 'string').reduce((n, s) => n + s.length, 0);

  /**
   * 🔴 **固定の閾値で測らない**(2026-08-05 に踏んだ)。ここは元々
   * `strChars < 8KB` だったが、その 8KB は「骨組み(doctype / JSON の括弧 /
   * **閲覧 UI の全文**)」を含む値である ── F-1 で閲覧 UI に印刷と目次を足したら
   * **中身の話は何も変わっていないのに落ちた**。
   *
   * 見たいのは「**払い出しが文字列で残らないか**」なので、
   * **大きい払い出しと小さい払い出しの差**で見る(骨組みは相殺される)。
   * ⚠ これは閾値の引き上げではなく**計器の作り直し**である ── 引き上げると、
   * 次に骨組みが育ったときまた同じ判断を迫られ、いずれ本物の漏れを通す。
   */
  const strCharsDelta = (big: BlobPart[], small: BlobPart[]): number =>
    strCharsOf(big) - strCharsOf(small);

  it('🔴 添付の base64 が文字列として常駐しない(Blob 化して手放す)', async () => {
    const run = (n: number) => {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
      return partsOfResult(() =>
        writePortableHtml(
          source({
            entries: [{ lid: 'n1', body: '![](asset:k1)' }],
            assets: [{ key: 'k1', mime: 'image/png', bytes }],
          }),
          NOW,
        ),
      );
    };
    // チャンク 4 個ぶん(base64 で約 1MB)/ 対照群はその 1/8。
    // ⚠ **桁数を揃える**(どちらも 6 桁)── 添付 meta の `size` は文字列で入るので、
    //    桁数が違うと差が 0 にならない(実際 786432 と 3 で 5 文字ずれた)。
    //    桁を揃えれば「差 0」を厳密に主張できる
    const big = await run(786_432);
    const small = await run(100_002);
    expect(String(786_432).length).toBe(String(100_002).length); // 桁を揃えた前提の pin
    // ⚠ 差が 0 = 添付の大きさは**文字列に一切影響していない**
    expect(strCharsDelta(big, small), 'base64 が文字列で残っている').toBe(0);
    // 添付の bytes は Blob の側に居る(= 出力自体は欠けていない)
    const bytesOf = (parts: BlobPart[]) =>
      parts.filter((p): p is Blob => p instanceof Blob).reduce((n, b) => n + b.size, 0);
    expect(bytesOf(big)).toBeGreaterThan(786_432); // base64 は 4/3 に膨らむ
    // ⚠ 空振り防止 ── Blob 側は確かに 60 万文字以上違う(差 0 が偶然でないことの担保)
    expect(bytesOf(big) - bytesOf(small)).toBeGreaterThan(600_000);
  });

  it('🔴 本文もバッチごとに手放す(全本文が文字列で残らない)', async () => {
    const run = (len: number) =>
      partsOfResult(() =>
        writePortableHtml(
          source({
            entries: Array.from({ length: 40 }, (_, i) => ({
              lid: `n${i}`,
              body: 'あ'.repeat(len),
            })),
            batch: 4,
          }),
          NOW,
        ),
      );
    const big = await run(2000); // 本文だけで 80,000 文字
    const small = await run(1);
    expect(strCharsDelta(big, small), '本文が文字列で残っている').toBe(0);
    // ⚠ 空振り防止 ── 本文は Blob の側で確かに増えている
    const bytesOf = (parts: BlobPart[]) =>
      parts.filter((p): p is Blob => p instanceof Blob).reduce((n, b) => n + b.size, 0);
    expect(bytesOf(big)).toBeGreaterThan(bytesOf(small) + 100_000);
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

  /**
   * 🔴 **音・動画は配った先でも、その場で聞ける / 見られる**(#413 段②)。
   *
   * ⚠ **アプリだけ直すと「画面では聞けるのに、渡した相手は聞けない」**になる ──
   *   同じ値を複数の描画経路へ渡すものは、経路ごとに pin する(CLAUDE.md §7)。
   * ⚠ 種類の判定は**書き出す側**が焼いた答え(`kind`)である ── 閲覧側は
   *   別の実行系なので、そこで判定を書くと規則が 2 か所になる。
   */
  const wav = { key: 'ast-a', mime: 'audio/webm', bytes: enc.encode('AUDIOBYTES') };

  it('🔴 添付 entry の音は、再生機と保存の導線の両方が出る (#413 段②)', async () => {
    const body =
      '---\nattachment.name: rec.webm\nattachment.mime: audio/webm\nattachment.asset_key: ast-a\n---\n';
    await run(
      (
        await writePortableHtml(
          source({ entries: [{ lid: 'a1', title: 'rec.webm', body }], assets: [wav] }),
          NOW,
        )
      ).blob,
    );
    const med = document.querySelectorAll('#body [data-pkc-field="body-media"]');
    expect(med, '配った HTML で再生機が出ていない').toHaveLength(1);
    expect(med[0]!.tagName, '音なのに音の器ではない').toBe('AUDIO');
    expect(med[0]!.getAttribute('src'), '中身を差していない').toMatch(/^blob:/);
    // ⚠ **飾りの印**(本文 CSS は class で当たる ── 器の印では焼かれない)
    expect(med[0]!.className, '飾りの印が付いていない').toBe('pkc-body-media');
    // 🔴 **保存の道を消していない**(器で置き換えない)
    const a = document.querySelector('#body a') as HTMLAnchorElement;
    expect(a.getAttribute('download'), '保存の導線が消えた').toBe('rec.webm');
    // ⚠ **URL は 1 本**(PDF と同じ規律 ── 1 つの添付に 2 本作らない)
    expect(a.getAttribute('href'), '再生機と別の URL を作っている').toBe(
      med[0]!.getAttribute('src'),
    );
  });

  it('🔴 本文の `[名前](asset:鍵)` の隣にも再生機が出る (#413 段②)', async () => {
    await run(
      (
        await writePortableHtml(
          source({ entries: [{ lid: 'n1', body: '会議:\n\n[rec.webm](asset:ast-a)\n' }], assets: [wav] }),
          NOW,
        )
      ).blob,
    );
    const link = document.querySelector('#body a[data-pkc-asset-key]') as HTMLAnchorElement;
    expect(link, 'リンクが消えた').not.toBeNull();
    const med = link.nextElementSibling;
    expect(med?.getAttribute('data-pkc-field'), 'リンクの隣に再生機が無い').toBe('body-media');
    expect(med!.getAttribute('src'), 'リンクと別の URL を作っている').toBe(link.getAttribute('href'));
  });

  it('⚠ 対照群 ── 音・動画でない添付には再生機を置かない (#413 段②)', async () => {
    await run(
      (
        await writePortableHtml(
          source({
            entries: [{ lid: 'n1', body: '[memo.bin](asset:ast-b)\n' }],
            assets: [{ key: 'ast-b', mime: 'application/octet-stream', bytes: enc.encode('BIN') }],
          }),
          NOW,
        )
      ).blob,
    );
    expect(
      document.querySelectorAll('#body [data-pkc-field="body-media"]'),
      '音でも動画でもないものに再生機を置いた',
    ).toHaveLength(0);
    expect(document.querySelector('#body a[download]'), '保存の導線まで消えた').not.toBeNull();
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

  /**
   * 🔴 **PDF 1 件につき ObjectURL は 1 本**(2026-08-15、着地前レビューで指摘)。
   *
   * ⚠ 直す前は `<object>` と、その中の fallback の `<a download>` で
   * `urlFor()` を **2 回**呼んでおり、PDF 1 件ごとに
   * `atob` → `Uint8Array` → `Blob` が **2 組**できていた。fallback の `<a>` は
   * ブラウザが PDF を出せなかったときにしか見えないのに、**復号は常に走る** ──
   * とくに「全体を印刷」では container 内の全 PDF ぶんが同時に生きる。
   * ゼロコピー・生成物の即破棄(2026-07-27、不可侵)と逆向きだった。
   */
  it('🔴 PDF は object と fallback で ObjectURL を 1 本しか作らない', async () => {
    const create = vi.spyOn(URL, 'createObjectURL');
    try {
      await run(
        (
          await writePortableHtml(
            source({
              entries: [
                {
                  lid: 'a1',
                  title: '見積',
                  body: '---\nattachment.asset_key: ast-p\nattachment.name: 見積.pdf\n---\n',
                },
              ],
              assets: [{ key: 'ast-p', mime: 'application/pdf', bytes: enc.encode('PDF') }],
            }),
            NOW,
          )
        ).blob,
      );
      // 前提: PDF が object で出ている(空振り防止 ── 出ていなければ 1 本なのは当然)
      const obj = document.querySelector('#body object[type="application/pdf"]');
      expect(obj, '前提: PDF が object で出ていない').not.toBeNull();
      expect(obj!.querySelector('a[download]'), '前提: fallback の導線が無い').not.toBeNull();
      expect(create.mock.calls.length, 'PDF 1 件で ObjectURL を 2 本作っている').toBe(1);
    } finally {
      create.mockRestore();
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

/**
 * F-1: **印刷できる・折りたたみ目次つき**の単一 HTML。
 * user 要望 2026-08-05「印刷も可能な折りたたみ TOC 付単一 HTML のバンドル機能」。
 *
 * ⚠ 閲覧側を**実行して DOM を見る**(script 文字列の grep では何も分からない)。
 * ⚠ `@media print` が実際に効くかは happy-dom では測れない ──
 *   そこは `tests/smoke/portable-print.smoke.spec.ts` が実 Chromium の
 *   `emulateMedia({media:'print'})` で見る。ここでは**組み立て**を見る。
 */
describe('可搬 HTML — 目次と印刷(F-1)', () => {
  /** 生成 HTML から DOM を組み立て、インライン script を実行する。 */
  async function open(blob: Blob): Promise<void> {
    const html = await blob.text();
    const dataJson = /<script id="pkc-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
      html,
    )![1]!;
    const viewer = /<script>\n([\s\S]*?)\n<\/script>$/.exec(html)![1]!;
    const markup = /<\/script>([\s\S]*?)<script>/.exec(html.slice(html.indexOf('</script>')))![1]!;
    document.body.innerHTML = markup;
    document.body.removeAttribute('data-print');
    const data = document.createElement('script');
    data.id = 'pkc-data';
    data.type = 'application/json';
    data.textContent = dataJson;
    document.body.appendChild(data);
    new Function(viewer)();
    await new Promise((r) => setTimeout(r, 0));
  }

  const DOC = source({
    entries: [
      {
        lid: 'n1',
        title: '設計',
        body: '# 全体\n本文\n## 保存\nああ\n### 器\nいい\n#### 深い見出し\nうう\n',
      },
      { lid: 'n2', title: '同名', body: '# 全体\nこちらも「全体」という見出し\n' },
      { lid: 'n3', title: '見出し無し', body: 'ただの本文\n' },
    ],
  });

  it('折りたたみの器がある(ノート一覧・この文書の目次)', async () => {
    await open((await writePortableHtml(DOC, NOW)).blob);
    const ds = document.querySelectorAll('nav details');
    expect(ds).toHaveLength(2);
    // 既定は開いている(畳めることが要件で、畳んだ状態が既定ではない)
    expect(Array.from(ds).every((d) => (d as HTMLDetailsElement).open)).toBe(true);
    expect(document.querySelector('#dnotes summary')?.textContent).toBe('ノート');
    expect(document.querySelector('#dtoc summary')?.textContent).toBe('この文書の目次');
    // ノート一覧は畳める器の中に入った(以前は nav 直下)
    expect(document.querySelector('#dnotes #list')).not.toBeNull();
  });

  it('🔴 目次は h1〜h3 を深さつきで並べる(h4 は入れない)', async () => {
    await open((await writePortableHtml(DOC, NOW)).blob);
    const items = Array.from(document.querySelectorAll('#toc li')).map((li) => [
      li.getAttribute('data-l'),
      li.textContent,
    ]);
    expect(items).toEqual([
      ['1', '全体'],
      ['2', '保存'],
      ['3', '器'],
    ]);
    // ⚠ h4 を入れない理由は「飛べないから」── 描画側が id を振るのは h1〜h3
    expect(document.querySelector('#body h4')?.id ?? '').toBe('');
    expect(document.getElementById('tocempty')!.hidden).toBe(true);
  });

  it('目次の行を押すと、その見出しへ移る', async () => {
    await open((await writePortableHtml(DOC, NOW)).blob);
    const h = document.querySelector<HTMLElement>('#body h2')!;
    const spy = vi.fn();
    (h as unknown as { scrollIntoView: () => void }).scrollIntoView = spy;
    document.querySelectorAll<HTMLButtonElement>('#toc li button')[1]!.click();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('見出しが無いノートは「見出しがありません」と言う(空の器を残さない)', async () => {
    await open((await writePortableHtml(DOC, NOW)).blob);
    document.querySelectorAll<HTMLButtonElement>('#list button')[2]!.click();
    expect(document.querySelectorAll('#toc li')).toHaveLength(0);
    expect(document.getElementById('tocempty')!.hidden).toBe(false);
  });

  it('🔴 紙の目次は「実在する id」を指す(飛べないリンクを作らない)', async () => {
    await open((await writePortableHtml(DOC, NOW)).blob);
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('#ptoc a'));
    expect(links).toHaveLength(3);
    for (const a of links) {
      const id = a.getAttribute('href')!.slice(1);
      expect(id, '空の href').not.toBe('');
      expect(document.querySelector(`#body [id="${id}"]`), `${id} が本文に無い`).not.toBeNull();
    }
    // 画面の目次と紙の目次は**同じ見出し列**から作る(2 か所で別に拾わない)
    expect(links.map((a) => a.textContent)).toEqual(
      Array.from(document.querySelectorAll('#toc li button')).map((b) => b.textContent),
    );
  });

  describe('全体を印刷', () => {
    it('全件を 1 つの document に組む(目次の節 + ノートごとの節)', async () => {
      await open((await writePortableHtml(DOC, NOW)).blob);
      expect(document.getElementById('printall')!.textContent).toBe('全体を印刷(3 件)');
      document.getElementById('printall')!.click();
      const secs = document.querySelectorAll('#all section');
      expect(secs).toHaveLength(4); // 目次 + 3 件
      expect(document.body.getAttribute('data-print')).toBe('all');
      // 本文の体裁は class で当てる(id を 2 個作らない)
      expect(document.querySelectorAll('#all .b')).toHaveLength(3);
      expect(document.querySelectorAll('#all [id="body"]'), 'id が重複している').toHaveLength(0);
      expect(document.querySelector('#all section:nth-child(3) h2')?.textContent).toBe('同名');
    });

    it('🔴 別ノートの同名見出しが同じ id にならない(目次が全部 1 件目へ飛ぶのを防ぐ)', async () => {
      await open((await writePortableHtml(DOC, NOW)).blob);
      document.getElementById('printall')!.click();
      const ids = Array.from(document.querySelectorAll('#all [id]')).map((el) => el.id);
      expect(ids.length).toBeGreaterThan(4);
      expect(new Set(ids).size, `id が重複: ${ids.join()}`).toBe(ids.length);
      // ⚠ 「全体」という見出しは 2 件のノートに在る ── 書出し側の slug は同じになる
      const zentai = Array.from(document.querySelectorAll('#all h1')).filter(
        (h) => h.textContent === '全体',
      );
      expect(zentai).toHaveLength(2);
      expect(zentai[0]!.id).not.toBe(zentai[1]!.id);
    });

    it('🔴 ノート名が 1 段目、その見出しは 1 段下げる(同じ段に並べない)', async () => {
      await open((await writePortableHtml(DOC, NOW)).blob);
      document.getElementById('printall')!.click();
      const rows = Array.from(
        document.querySelectorAll('#all section:first-child li'),
      ).map((li) => [li.getAttribute('data-l'), li.className, li.textContent]);
      // ノート名(class n・1 段目)→ その h1 は 2 段目、h2 は 3 段目、h3 は 4 段目
      expect(rows).toEqual([
        ['1', 'n', '設計'],
        ['2', '', '全体'],
        ['3', '', '保存'],
        ['4', '', '器'],
        ['1', 'n', '同名'],
        ['2', '', '全体'],
        ['1', 'n', '見出し無し'],
      ]);
      // ⚠ 体裁は #ptoc だけでなく **ol.x にも当てる**(実機で全体印刷の目次が
      //    既定の連番つき青リンクのまま出た)
      expect(document.querySelector('#all section:first-child ol')?.className).toBe('x');
    });

    it('🔴 目次のリンクは、その節の実在 id を指す', async () => {
      await open((await writePortableHtml(DOC, NOW)).blob);
      document.getElementById('printall')!.click();
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('#all section:first-child a'));
      // ノート 3 件 + 見出し 4 件(1 件目に h1/h2/h3、2 件目に h1、3 件目は無し)
      expect(links.length).toBe(7);
      // ⚠ ノートの行は必ず全件ある(見出しの数に埋もれていない)
      expect(
        links.filter((a) => (a.getAttribute('href') ?? '').startsWith('#pe-')).length,
      ).toBe(3);
      for (const a of links) {
        const id = a.getAttribute('href')!.slice(1);
        expect(document.querySelector(`#all [id="${id}"]`), `${id} が無い`).not.toBeNull();
      }
    });

    it('🔴 印刷が終わったら捨てる(組んだ DOM と object URL を残さない)', async () => {
      const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      try {
        await open(
          (
            await writePortableHtml(
              source({
                entries: [
                  { lid: 'a1', title: '図', body: '![](asset:ast-p)' },
                  { lid: 'a2', title: '図 2', body: '![](asset:ast-p)' },
                ],
                assets: [{ key: 'ast-p', mime: 'image/png', bytes: enc.encode('PNGBYTES') }],
              }),
              NOW,
            )
          ).blob,
        );
        revoke.mockClear();
        document.getElementById('printall')!.click();
        expect(document.querySelectorAll('#all img').length).toBe(2);
        expect(revoke, '組む前に画面のぶんを捨ててはいけない').not.toHaveBeenCalled();

        window.dispatchEvent(new Event('afterprint'));
        expect(document.getElementById('all')!.childNodes.length).toBe(0);
        expect(document.body.hasAttribute('data-print')).toBe(false);
        expect(revoke.mock.calls.length, '紙用の object URL を捨てていない').toBe(2);
        // ⚠ 画面のぶんは**生きている**(寿命が混ざっていない)
        expect(document.querySelector('#body img')?.getAttribute('src')).toMatch(/^blob:/);
      } finally {
        revoke.mockRestore();
      }
    });

    it('読みに戻った時点でも捨てる(afterprint が来ない環境でも残さない)', async () => {
      await open((await writePortableHtml(DOC, NOW)).blob);
      document.getElementById('printall')!.click();
      expect(document.querySelectorAll('#all section').length).toBe(4);
      document.querySelectorAll<HTMLButtonElement>('#list button')[1]!.click();
      expect(document.getElementById('all')!.childNodes.length).toBe(0);
      expect(document.body.hasAttribute('data-print')).toBe(false);
    });
  });

  it('🔴 紙では折りたたみを開き、印刷後に元へ戻す(畳んでいた状態を壊さない)', async () => {
    await open((await writePortableHtml(DOC, NOW)).blob);
    const dtoc = document.getElementById('dtoc') as HTMLDetailsElement;
    const dnotes = document.getElementById('dnotes') as HTMLDetailsElement;
    dtoc.open = false; // user が畳んだ状態
    window.dispatchEvent(new Event('beforeprint'));
    expect(dtoc.open, '紙で畳んだままになっている').toBe(true);
    expect(dnotes.open).toBe(true);
    window.dispatchEvent(new Event('afterprint'));
    expect(dtoc.open, '畳んでいた状態に戻っていない').toBe(false);
    expect(dnotes.open, '開いていたものを畳んでしまった').toBe(true);
  });
});

/**
 * 閲覧側は**押しても何も起きない操作子を残さない**。
 *
 * 🔴 描画はアプリと同じ関数なので、コード・表・図に付く「コピー」ボタン
 * (`data-pkc-action="copy-md-block"`)がそのまま焼き込まれる。閲覧側に binder は
 * 無いので**沈黙する飾り**になり、紙にも `⧉` が印字される(F-1 の実機確認で発見)。
 */
describe('可搬 HTML — 沈黙する操作子を残さない', () => {
  async function openDoc(blob: Blob): Promise<void> {
    const html = await blob.text();
    const dataJson = /<script id="pkc-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
      html,
    )![1]!;
    const viewer = /<script>\n([\s\S]*?)\n<\/script>$/.exec(html)![1]!;
    const markup = /<\/script>([\s\S]*?)<script>/.exec(html.slice(html.indexOf('</script>')))![1]!;
    document.body.innerHTML = markup;
    document.body.removeAttribute('data-print');
    const data = document.createElement('script');
    data.id = 'pkc-data';
    data.type = 'application/json';
    data.textContent = dataJson;
    document.body.appendChild(data);
    new Function(viewer)();
    await new Promise((r) => setTimeout(r, 0));
  }

  const WITH_BLOCKS = source({
    entries: [
      {
        lid: 'n1',
        title: '表とコード',
        body: '| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n',
      },
    ],
  });

  it('🔴 コピーボタンは残らない(本文の中身は残る)', async () => {
    const out = await writePortableHtml(WITH_BLOCKS, NOW);
    // ⚠ 空振り防止 ── **書き出しデータには在る**(描画はアプリと同じ関数だから)。
    //    ここが 0 件なら「消えている」ことは何も証明しない
    const d = await dataOf(out.blob);
    expect(
      (d.entries[0]!.html.match(/copy-md-block/g) ?? []).length,
      '描画データにコピーボタンが無い(この test は何も測っていない)',
    ).toBe(2);

    await openDoc(out.blob);
    expect(document.querySelectorAll('#body [data-pkc-action]')).toHaveLength(0);
    expect(document.getElementById('body')!.textContent).not.toContain('⧉');
    // 中身は消えていない(ボタンだけ取る ── 表とコードは残る)
    expect(document.querySelectorAll('#body table')).toHaveLength(1);
    expect(document.querySelectorAll('#body pre')).toHaveLength(1);
    expect(document.getElementById('body')!.textContent).toContain('const x = 1;');
  });

  it('🔴 全体印刷で組んだぶんにも残らない(紙に ⧉ を出さない)', async () => {
    await openDoc((await writePortableHtml(WITH_BLOCKS, NOW)).blob);
    document.getElementById('printall')!.click();
    expect(document.querySelectorAll('#all [data-pkc-action]')).toHaveLength(0);
    expect(document.getElementById('all')!.textContent).not.toContain('⧉');
    expect(document.querySelectorAll('#all table')).toHaveLength(1);
  });
});

/**
 * 🔴 fence の「描画 / 原文」切替が閲覧側で成立しているか(F-1 で紙にも波及して判明)。
 *
 * 閲覧用 HTML は `.b` 前置きの独自 CSS しか持っておらず、CSS-only トグルの規則が
 * **1 行も無かった** ── CSS-only の機構は「規則がある」が前提なので、規則の無い面に
 * 置くと **両方出る**方向に倒れる。表の下に原文が丸ごと出て、押しても効かない
 * チェックボックスが並び、**印刷すると二重に刷られる**。
 *
 * ⚠ ここは happy-dom では**効きを測れない**(CSS を評価しない)。
 *   本当に隠れるかは `tests/smoke/import.smoke.spec.ts` が実 Chromium の
 *   computed style で見る。ここでは「規則が在ること」と「向きが app.css と同じこと」を守る。
 */
describe('可搬 HTML — fence の描画 / 原文の切替', () => {
  const styleOf = async (blob: Blob): Promise<string> => {
    const html = await blob.text();
    const i = html.indexOf('<style>');
    return html.slice(i, html.indexOf('</style>', i));
  };

  // ⚠ **両方の形を入れる** ── 既定(`csv` = mode `both`)は切替つき、
  //    `csv-render` は切替が無く原文を常に隠す形。片方だけだと、もう一方の
  //    規則が消えても気づけない
  const WITH_FENCE = source({
    entries: [
      { lid: 'n1', title: 'csv', body: '```csv\n列A,列B\n1,2\n```\n' },
      { lid: 'n2', title: 'csv-render', body: '```csv-render\n列A,列B\n1,2\n```\n' },
    ],
  });

  it('🔴 書き出しは実際に切替つきの fence を吐く(この検査が空振りしていない)', async () => {
    const d = await dataOf((await writePortableHtml(WITH_FENCE, NOW)).blob);
    // ⚠ ここが 0 件なら、下の CSS 検査は何も守っていない
    expect(d.entries[0]!.html, '描画/原文の切替が出ていない').toContain('pkc-render-source');
    expect(d.entries[0]!.html, '切替つきの形が出ていない').toContain('pkc-render-toggle-input');
    expect(d.entries[0]!.html).toContain('pkc-render-slot');
    // 切替の無い形(`-render`)も測っている ── こちらは原文を常に隠す規則が守る
    expect(d.entries[1]!.html).toContain('data-pkc-render-mode="render"');
    expect(d.entries[1]!.html, '切替の無い形にも原文が入っている前提').toContain(
      'pkc-render-source',
    );
    expect(d.entries[1]!.html).not.toContain('pkc-render-toggle-input');
  });

  it('🔴 原文を既定で隠す規則が在り、向きが app.css と同じ(checked = 原文面)', async () => {
    const css = await styleOf((await writePortableHtml(WITH_FENCE, NOW)).blob);
    /**
     * ⚠ **前置きは `.pkc-md-rendered`**(2026-08-07)。かつては `.b` 前置きの複製が
     * この規則を持っていたが、焼いた側と**同じプロパティの重複**だったので
     * 掃除で消した(実測で 171,255 点すべて一致 ── 1 度も効いていなかった)。
     * 🔑 見るべきは**配る `<style>` に規則が在るか**であって、どちらの前置きかではない。
     */
    expect(css, '原文を隠す規則が無い(表の下に原文が出る)').toContain(
      '.pkc-md-rendered .pkc-render-toggle-input:not(:checked) ~ .pkc-render-source',
    );
    expect(css, '描画を隠す規則が無い(切替が効かない)').toContain(
      '.pkc-md-rendered .pkc-render-toggle-input:checked ~ .pkc-render-slot',
    );
    // ⚠ 焼いた側は結合子の前後を詰める(抜き出し器の正規化)── 字面をそのまま書く
    expect(css).toContain(".pkc-md-rendered [data-pkc-render-mode='render']>.pkc-render-source");
  });

  it('🔴 向きがアプリと一致している(同じファイルで見えるものが食い違わない)', () => {
    // ⚠ **アプリ側の正本と突き合わせる** ── 片方だけ直すと、アプリでは描画・
    //    閲覧側では原文、という食い違いが静かに生まれる
    const app = readFileSync('src/styles/app.css', 'utf-8');
    const pairs: Array<[string, string]> = [
      ['.pkc-md-rendered .pkc-render-toggle-input:not(:checked) ~ .pkc-render-source', 'not(:checked) ~ .pkc-render-source'],
      ['.pkc-md-rendered .pkc-render-toggle-input:checked ~ .pkc-render-slot', ':checked ~ .pkc-render-slot'],
    ];
    for (const [appSel] of pairs) {
      expect(app, `app.css の正本が変わった: ${appSel}`).toContain(appSel);
    }
  });

  it('紙では切替の見た目を出さない(操作できない紙に操作子を刷らない)', async () => {
    const css = await styleOf((await writePortableHtml(WITH_FENCE, NOW)).blob);
    const print = css.slice(css.indexOf('@media print{'));
    expect(print).toContain('.b .pkc-render-toggle{display:none}');
  });
});

/**
 * 🔴 **配る HTML と画面で同じものが見える**(2026-08-06。user 報告 2-5 / 2-7)。
 *
 * 直す前:
 *  - `{{vars.x}}` が**生のまま**配られていた(描画器に `vars` を渡していなかった)
 *  - `heading-number: true` の文書に**番号が付かなかった**
 *  - 書字方向などの文書属性が**画面だけ**に当たっていた
 *  - `html` fence の高さを受ける側が**居なかった** ── iframe は height:0 = 不可視
 */
describe('可搬 HTML — 画面と同じ材料で描く', () => {
  it('🔴 `vars` を描画器に渡す(生の `{{vars.x}}` を配らない)', async () => {
    const seen: Array<{ text: string; vars?: Record<string, string> }> = [];
    const out = await writePortableHtml(
      source({
        entries: [{ lid: 'v1', body: '---\nvars.name: 佐藤\n---\nこんにちは {{vars.name}} さん\n' }],
      }),
      NOW,
      (text, opts) => {
        seen.push({ text, vars: opts?.vars });
        return Promise.resolve(renderMarkdown(text, opts));
      },
    );
    expect(seen[0]!.vars, 'vars を渡していない').toMatchObject({ name: '佐藤' });
    const d = await dataOf(out.blob);
    expect(d.entries[0]!.html, '生の {{vars.name}} が配られている').not.toContain('{{vars.name}}');
    expect(d.entries[0]!.html).toContain('佐藤');
  });

  it('🔴 見出しの自動採番を描画器に渡す', async () => {
    const seen: Array<{ start: number } | null | undefined> = [];
    const out = await writePortableHtml(
      source({ entries: [{ lid: 'h1', body: '---\nheading-number: true\n---\n## 節\n' }] }),
      NOW,
      (text, opts) => {
        seen.push(opts?.headingNumber);
        return Promise.resolve(renderMarkdown(text, opts));
      },
    );
    expect(seen[0], '見出し番号の設定を渡していない').toEqual({ start: 1 });
    const d = await dataOf(out.blob);
    expect(d.entries[0]!.html, '番号が付いていない').toMatch(/0?\.?1/);
  });

  it('🔴 文書属性(書字方向)を entry に載せる', async () => {
    const out = await writePortableHtml(
      source({ entries: [{ lid: 'd1', body: '---\ndirection: rtl\n---\n本文\n' }] }),
      NOW,
    );
    const d = await dataOf(out.blob);
    expect(d.entries[0]!.attrs, '文書属性が載っていない').toMatchObject({ dir: 'rtl' });
  });

  it('属性の無い文書には `attrs` を付けない(空の field を配らない)', async () => {
    const out = await writePortableHtml(source({ entries: [{ lid: 'p1', body: '本文\n' }] }), NOW);
    const d = await dataOf(out.blob);
    expect('attrs' in (d.entries[0] as object)).toBe(false);
  });

  /**
   * 🔴 **閲覧側が前のノートの書字方向を消す**(2026-08-06)。本文の器(`#body`)は
   * 使い回しなので、`setAttribute` だけだと `align: right` / `writing: vertical` /
   * `dir="rtl"` のノートを見た後、宣言の無いノートが**前の文書の見え方で描かれる**。
   * 直す前は `removeAttribute` が `data-print` の 1 か所にしか無かった。
   * ⚠ 一覧は画面側 `DOCUMENT_GLOBAL_ATTRS` と揃える(片面だけ足す事故を止める)。
   */
  it('🔴 閲覧側が文書属性を当てる前に消す(前のノートの書字方向が残らない)', async () => {
    const out = await writePortableHtml(source({ entries: [{ lid: 'q1', body: '本文\n' }] }), NOW);
    const text = await out.blob.text();
    for (const k of DOCUMENT_GLOBAL_ATTRS) {
      expect(text, `閲覧側が ${k} を消していない`).toContain(k);
    }
    const clear = text.indexOf('removeAttribute(GA[');
    expect(clear, '当てる前に消す処理が無い').toBeGreaterThan(-1);
    /**
     * ⚠ **順序が本体**である ── 消すのが後だと、当てた値まで消えて
     * **全部の宣言が無効になる**(しかも「消す処理は在る」ので grep では通る)。
     */
    const apply = text.indexOf('box.setAttribute(ak,e.attrs[ak])');
    expect(apply, '属性を当てる処理が見つからない').toBeGreaterThan(-1);
    expect(clear, '消すのが当てるより後になっている(宣言が全部無効になる)').toBeLessThan(apply);
  });

  /**
   * 🔴 **書き出す HTML に外部画像を焼くのは「常にオン」のときだけ**
   * (2026-08-06、user 裁定)。
   *
   * ⚠ 書き出した HTML は**別の人が開く文書**である。開いた人は追跡に同意して
   *   いないので、既定では焼かない ── URL は属性に残るので情報は失われない。
   * ⚠ 閲覧側の script が**自分で `src` を入れない**ことも見る。入れたら、この
   *   判断が閲覧の瞬間に無かったことになる(そして test は「属性が在る」で通る)。
   */
  describe('外部の画像', () => {
    const BODY = '![絵](https://example.com/x.png)\n\n```html\n<b>箱</b>\n```\n';

    it('既定では焼かない(URL は属性に残り、箱の CSP も閉じる)', async () => {
      const out = await writePortableHtml(source({ entries: [{ lid: 'e1', body: BODY }] }), NOW);
      const d = await dataOf(out.blob);
      const html = d.entries[0]!.html;
      // ⚠ 文字列で `src="https://…"` を探すと `data-pkc-external-src="…"` に
      //    **部分一致して常に真**になる ── DOM で属性そのものを見る
      const el = document.createElement('div');
      el.innerHTML = html;
      const img = el.querySelector('img')!;
      expect(img, 'そもそも画像が出ていない').not.toBeNull();
      expect(img.getAttribute('data-pkc-external-src')).toBe('https://example.com/x.png');
      expect(img.hasAttribute('src')).toBe(false);
      expect(html, '箱が出ていない').toContain('data-pkc-html-render-id');
      expect(html).toContain('img-src data: blob:');
    });

    it('「常にオン」なら焼く(本文と箱が揃って開く)', async () => {
      const out = await writePortableHtml(
        source({ entries: [{ lid: 'e1', body: BODY }] }),
        NOW,
        undefined,
        true,
      );
      const d = await dataOf(out.blob);
      const html = d.entries[0]!.html;
      const el = document.createElement('div');
      el.innerHTML = html;
      const img = el.querySelector('img')!;
      expect(img.getAttribute('src')).toBe('https://example.com/x.png');
      expect(img.hasAttribute('data-pkc-external-src')).toBe(false);
      expect(html).toContain('img-src * data: blob:');
    });

    it('閲覧側は退避した URL を `src` へ戻さない(見た目だけ与える)', async () => {
      const out = await writePortableHtml(source({ entries: [{ lid: 'e1', body: BODY }] }), NOW);
      const text = await out.blob.text();
      // 器の見た目は在る(無いと寸法 0 で「消えた」に見える)
      expect(text, '読み込んでいない画像の見た目が無い').toContain('.pkc-external-img:not([src])');
      // ⚠ 復元する処理は**無い**
      expect(text).not.toContain('data-pkc-external-src]');
      expect(text).not.toContain("getAttribute('data-pkc-external-src')");
    });
  });

  it('🔴 閲覧側が `html` fence の高さを受ける(height:0 の不可視にしない)', async () => {
    const out = await writePortableHtml(source({ entries: [{ lid: 'x1', body: '本文\n' }] }), NOW);
    const text = await out.blob.text();
    // 受け口が在る(無いと囲いの中の文書は高さ 0 のまま)
    expect(text, '高さを受ける口が無い').toContain('pkc-html-render-resize');
    expect(text).toContain('data-pkc-html-render-id');
    // ⚠ 上限も画面側と同じ(暴走する中身に画面を占領させない)
    expect(text).toContain('Math.min(5000');
  });
});

/**
 * 🔴 **本文の見た目の正本は app.css**(2026-08-07)。
 *
 * 直す前、書き出した HTML の `.pkc-*` の規則は **10 個**しか無かった(`app.css` は 71 個)。
 * 実ブラウザの 21 の観測点のうち **17 が違って**いた ── `:::note` / `:::danger` は枠も
 * 地も無く本文の段落と見分けが付かず、タスク行は丸ポチとチェック欄が二重に出て、
 * 圏点が付かず、`_3`(空行 3 つ)の高さが 0 だった。
 *
 * ⚠ ここは**生成した blob** を見る(ソースの字面ではない)── 焼き込みは build 時の
 * virtual module 経由なので、ソースを grep しても「入ったか」は分からない。
 * ⚠ 値が実際に効くかは実ブラウザ(`tests/smoke/export-body-css.smoke.spec.ts`)が
 *   computed style で見る。ここは**載っているか**と**勝ち手の順**を見る。
 */
describe('可搬 HTML — 本文の CSS を app.css から焼く', () => {
  const DOC = source({
    entries: [
      { lid: 'b1', title: '記法', body: ':::note\n注意\n:::\n\n- [ ] やること\n\n前\n\n_3\n\n後\n' },
      { lid: 'b2', title: 'もう 1 件', body: '# 見出し\n本文\n' },
    ],
  });

  /** `<style>` の中身だけを取り出す(規則の**並び**を見るため)。 */
  async function styleOf(): Promise<string> {
    const html = await (await writePortableHtml(DOC, NOW)).blob.text();
    const m = /<style>([\s\S]*?)<\/style>/.exec(html);
    expect(m, '<style> が無い').not.toBeNull();
    return m![1]!;
  }

  it('🔴 app.css の本文の規則が焼かれている(代表が代替物で満たせない形で)', async () => {
    const css = await styleOf();
    // ⚠ 「`.pkc-` が N 個」では守れない ── 前から 10 個は在った。**中身**で見る
    for (const [sel, decl] of [
      ['.pkc-md-rendered .pkc-section-callout', 'border-left'],
      ['.pkc-md-rendered .pkc-section-danger', 'color-mix'],
      ['.pkc-md-rendered li.pkc-task-item', 'list-style:none'],
      ['.pkc-md-rendered .pkc-blank-line', 'var(--pkc-blank-count,1)'],
      ['.pkc-md-rendered .pkc-em-dot', 'text-emphasis'],
      ['.pkc-md-rendered .pkc-toc-formal', 'background'],
    ] as const) {
      const at = css.indexOf(sel);
      expect(at, `${sel} の規則が焼かれていない`).toBeGreaterThan(0);
      expect(css.slice(at, css.indexOf('}', at)), `${sel} に ${decl} が無い`).toContain(decl);
    }
  });

  /**
   * 🔴 **トークンも一緒に焼く**。規則だけ写すと `var()` が computed-value time で無効に
   * なり、**先行する規則へ fall back しない** ── `.b` 側の余白や罫線まで消えて、
   * **何もしないより悪くなる**(実測)。
   */
  it('🔴 トークンが 3 層(配色・幾何・暗い環境)そろって焼かれている', async () => {
    const css = await styleOf();
    for (const name of ['--fg:', '--border:', '--surface-2:', '--accent:']) {
      expect(css, `配色 ${name} が無い`).toContain(name);
    }
    for (const name of ['--s5:', '--radius:', '--font-mono:']) {
      expect(css, `幾何 ${name} が無い(宣言ごと無効になる)`).toContain(name);
    }
    // ⚠ 静的に light で潰していない ── 暗い環境で白箱に白文字になる(実測)
    expect(css, '暗い環境の層が無い').toContain('@media (prefers-color-scheme:dark){:root{');
  });

  /**
   * 🔴 **未定義の `var()` が 1 つも無い**。`<style>` 全体で見る ── 焼いた規則が
   * 参照するトークンは、同じ `<style>` の中で定義されていなければならない。
   */
  it('🔴 焼いた規則が参照するトークンが全部同じ style の中で定義されている', async () => {
    const css = await styleOf();
    const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
    expect(defined.size, 'トークンが 1 つも定義されていない(この検査は空振り)').toBeGreaterThan(
      15,
    );
    const used = [...css.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)]
      // 既定値つき(`var(--x, 1)`)は未定義でも壊れない
      .filter((m) => m[2] === ')')
      .map((m) => m[1]!);
    expect(used.length, 'var() を 1 つも使っていない(この検査は空振り)').toBeGreaterThan(20);
    const missing = [...new Set(used.filter((v) => !defined.has(v)))].sort();
    expect(missing, `未定義の var(宣言ごと無効になる): ${missing.join(', ')}`).toEqual([]);
  });

  /**
   * 🔴 **並びが勝ち手を決める**。`.b h1` と `.pkc-md-rendered h1` は詳細度が同じ
   * (0,1,1)なので、**後に来た側が勝つ**。焼いた分を手前に置くと `.b` の古い値が
   * 勝ち、この仕掛けは丸ごと無意味になる ── しかも「規則は載っている」ので
   * 存在を数える検査は全部通る。
   */
  it('🔴 焼いた規則が `.b` の規則より後に在る(app.css が正本になる)', async () => {
    const css = await styleOf();
    /**
     * 🔴 **「`.b` で始まる規則だけ」「行頭のものだけ」では守れない**
     * (2026-08-07、レビュー 2 巡目で直した)。
     *
     * 直す前は `/^\.b[ .[>{,:][^{]*\{/gm` で数えていた。実測で**5 つの変異が全部緑**:
     * 2 字下げ(`@media print` の中は元からこの書き方)/ 同一行の 2 本目 / `.b~*` /
     * **`#body{…}`**(id 詳細度で焼いた分に全勝)/ タブ区切り。とくに 1 番目は
     * 「a8c4144 が `@media print` から削除したばかりの `color:inherit` を、
     * 勝つ位置に置き直す編集」そのものである。
     *
     * 🔑 **主張している不変条件を、そのまま検査する** ── 「焼いた分の後ろには、
     * 許した 2 本以外の規則が 1 つも無い」。だから **`.b` に限らず全セレクタ**を
     * 数え上げる。焼いた CSS の位置は**抜き出し器を呼んで突合**する
     * (`indexOf` の目印より確実で、「一字一句そのまま載っている」も同時に pin できる)。
     */
    const baked = extractBodyCss(APP_CSS, TOKENS_CSS).css;
    const at = css.indexOf(baked);
    expect(at, '焼いた CSS がそのままの字面で載っていない').toBeGreaterThan(0);
    // 焼いた分より前に `.b` の規則が並んでいる(空振り防止)
    // ⚠ 2026-08-07 の掃除で重複 38 本を消したので下限を 20 → 10 へ。
    //   守っているのは「`.b` の節がそもそも在る」ことで、本数ではない
    expect(
      [...css.slice(0, at).matchAll(/\.b[ .[>{,:~+]/g)].length,
      '.b の規則が見つからない(この検査は空振り)',
    ).toBeGreaterThan(10);
    /**
     * ⚠ 焼いた分の**後ろ**に置いてよいのは「**この面に対応物が無い**」ものだけ。
     * ここが増え始めたら、正本がまた 2 本に戻っている。
     */
    const tail = css.slice(at + baked.length).replace(/\/\*[\s\S]*?\*\//g, '');
    const sels = [...tail.matchAll(/(?:^|\})\s*([^{}]+?)\s*\{/g)].map((m) => m[1]!.trim());
    expect(
      sels.sort(),
      '焼いた分の後ろに規則が増えている(そこだけ app.css に勝ってしまう)',
    ).toEqual(['.b .pkc-render-toggle', '.b a.f']);
    // ⚠ `@media` で包んで後ろに置く抜け道も塞ぐ(prelude は上の走査に出ない)
    expect(tail, '焼いた分の後ろに @media を置いている').not.toContain('@media');
  });

  /**
   * 🔴 **添付のボタンの class 名が、CSS の側と揃っている**(2026-08-07、レビュー 2 巡目)。
   *
   * smoke の `a.f` の観測は**自前で `class='f'` の要素を作って**継承を見る ── 本物の
   * 経路(`view()` が作るダウンロードボタン)を 1 度も通らないので、
   * `a.className='f'` を `'dl'` に変える 1 行で**本物だけが緑の下線リンクに戻る**のに
   * smoke は緑のままになる。だから**生成した blob の中で 2 つが噛み合っていること**を
   * ここで pin する(CLAUDE.md「同じ判定が 2 か所に生えたら parity test を置く」)。
   */
  it('🔴 添付のボタンを作る側と、その体裁を書く側で class 名が一致している', async () => {
    const html = await (await writePortableHtml(DOC, NOW)).blob.text();
    const made = /(?:^|[^\w])a\.className='([^']+)'/.exec(html)?.[1];
    expect(made, '添付のボタンを作る箇所が見つからない(この検査は空振り)').toBeTruthy();
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    expect(css, `a.${made} の体裁が CSS に無い(名前がずれた)`).toContain(`a.${made}{`);
    // ⚠ 焼いた本文のリンク色に食われないための 1 本 ── これが要点
    expect(css, '添付のボタンの色を戻す規則が無い').toContain(`.b a.${made}{color:inherit}`);
  });

  /**
   * 🔴 **本文の器は 2 か所ある**(CLAUDE.md「同じ値を複数の描画経路へ渡すものは
   * 経路ごとに pin する」)── 1 件表示の `#body` と、「全体を印刷」が組む箱。
   * 片方だけに class を足すと、**紙だけ素の見た目**で出る(誰も見ていない経路)。
   */
  it('🔴 1 件表示の器に pkc-md-rendered が付いている', async () => {
    const html = await (await writePortableHtml(DOC, NOW)).blob.text();
    document.body.innerHTML = /<main>[\s\S]*?<\/main>/.exec(html)![0]!;
    const box = document.getElementById('body')!;
    expect([...box.classList].sort(), '器の class が足りない').toEqual(['b', 'pkc-md-rendered']);
    // 🔴 読み幅(2026-08-08 の統一)は **data-pkc-prose 起点**で焼かれてくる
    //    ── 印が落ちると、この面だけ本文が全幅に伸びる。
    // ⚠ 2 巡目レビューで直した: ここは長く `data-pkc-field='detail-body'` を
    //    「読み幅の当たり先」として pin していたが、いまその属性は**誰も読まない**
    //    (`body-css` は field の規則を 1 本も焼かない)── 嘘の理由で固定していた。
    expect(box.hasAttribute('data-pkc-prose'), '読み幅の当たり先が無い').toBe(true);
  });

  it('🔴 「全体を印刷」が組む器にも pkc-md-rendered が付いている', async () => {
    const html = await (await writePortableHtml(DOC, NOW)).blob.text();
    const dataJson = /<script id="pkc-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
      html,
    )![1]!;
    const viewer = /<script>\n([\s\S]*?)\n<\/script>$/.exec(html)![1]!;
    document.body.innerHTML = /<\/script>([\s\S]*?)<script>/.exec(
      html.slice(html.indexOf('</script>')),
    )![1]!;
    const data = document.createElement('script');
    data.id = 'pkc-data';
    data.type = 'application/json';
    data.textContent = dataJson;
    document.body.appendChild(data);
    new Function(viewer)();
    await new Promise((r) => setTimeout(r, 0));
    document.getElementById('printall')!.click();
    const boxes = [...document.querySelectorAll('#all > section > div')];
    expect(boxes.length, '全体印刷の本文の箱が無い(この検査は空振り)').toBe(2);
    for (const box of boxes) {
      expect([...box.classList].sort(), '紙の本文の器の class が足りない').toEqual([
        'b',
        'pkc-md-rendered',
      ]);
      // 🔴 読み幅の当たり先(2026-08-08)── ここに無いと全体印刷だけ全幅で出る。
      // ⚠ 印は `data-pkc-prose`(2 巡目レビューで訂正。field ではない)
      expect(box.hasAttribute('data-pkc-prose'), '紙の器に読み幅が当たらない').toBe(true);
    }
  });
});

/**
 * 🔴 **囲みが指している添付は、書き出しのときに焼き込む**(#444 段②)。
 *
 * ⚠ 配った HTML には hydrator が居ない ── 焼かなければ器のまま
 *   「この囲みの中身は添付に在ります」だけが残り、**持ち出したら中身が消える**。
 *   PKC の芯(自己完結して持ち出せる)に正面から反する。
 */
describe('囲みが指す添付を焼き込む(#444 段②)', () => {
  const bytes = (t: string): Uint8Array => new TextEncoder().encode(t);

  /**
   * 🔑 比べる相手は **本文に直接書いたときの描画** ── 実装の綴りを写した
   *   期待値ではなく、**もう 1 本の実際の経路**の出力である(CLAUDE.md §1
   *   「期待値は別の綴りではなく別の観測から作る」)。
   * ⚠ 焼き込みが**言語を選ばない**ことを見たいので、表・図・素のコードで回す。
   */
  for (const c of [
    { info: 'csv', text: 'あ,い\n1,2' },
    { info: 'mermaid', text: 'graph TD;A-->B;' },
    { info: 'js', text: 'const x = 1;' },
  ]) {
    it(`🔴 「${c.info}」の添付が、本文に書いたのと同じ形で配る HTML に入る`, async () => {
      const out = await writePortableHtml(
        source({
          entries: [{ lid: 'e1', body: `\`\`\`${c.info} asset:ast-t\n控え\n\`\`\`` }],
          assets: [{ key: 'ast-t', mime: 'text/plain', bytes: bytes(c.text) }],
        }),
        NOW,
      );
      const got = (await dataOf(out.blob)).entries[0]!.html;
      expect(got, '器のまま配っている(中身が消えた)').not.toContain(
        'data-pkc-fence-asset-pending',
      );
      expect(got, '控えの字を配っている(添付を読んでいない)').not.toContain('控え');
      expect(got).toBe(renderMarkdown(`\`\`\`${c.info}\n${c.text}\n\`\`\``));
    });
  }

  it('⚠ 読めない添付は器のまま残り、注意にも出る(黙って空にしない)', async () => {
    const out = await writePortableHtml(
      source({ entries: [{ lid: 'e1', body: '```csv asset:ast-gone\n控え\n```' }] }),
      NOW,
    );
    const html = await out.blob.text();
    expect(html, '中身が無いのに器まで消えた').toContain('data-pkc-fence-asset-pending');
    expect(out.warnings.some((w) => w.includes('ast-gone'))).toBe(true);
  });

  it('🔴 上限を超える添付は読まない(定常の話 ── 不可侵指示 2026-08-03)', async () => {
    const big = new Uint8Array(MAX_FENCE_ASSET_BYTES + 1);
    big.fill(65);
    const out = await writePortableHtml(
      source({
        entries: [{ lid: 'e1', body: '```js asset:ast-big\n控え\n```' }],
        assets: [{ key: 'ast-big', mime: 'text/plain', bytes: big }],
      }),
      NOW,
    );
    const html = await out.blob.text();
    expect(html).toContain('data-pkc-fence-asset-pending');
    expect(out.warnings.some((w) => w.includes('大きすぎます'))).toBe(true);
    // ⚠ 空振り防止 ── 上限を外せば読めた大きさである(1 バイト超えているだけ)
    expect(big.length).toBe(MAX_FENCE_ASSET_BYTES + 1);
  });

  it('⚠ 囲みが指していない添付は字にしない(全添付を読まない)', async () => {
    const reads: string[] = [];
    const src = source({
      entries: [{ lid: 'e1', body: '```csv asset:ast-t\n控え\n```\n\n![](asset:ast-img)' }],
      assets: [
        { key: 'ast-t', mime: 'text/csv', bytes: bytes('あ,い') },
        { key: 'ast-img', mime: 'image/png', bytes: bytes('PNG') },
      ],
    });
    const spy: ArchiveSource = {
      ...src,
      getAssetBlob: async (k) => {
        reads.push(k);
        return src.getAssetBlob(k);
      },
    };
    const out = await writePortableHtml(spy, NOW);
    await out.blob.text();
    // 🔑 画像の bytes は**配るために**読まれる ── ここで見たいのは
    //    「**字にするための読み**が囲みの鍵だけか」なので、その 1 回目を見る
    expect(reads[0], '囲みが指していない添付を先に字にしている').toBe('ast-t');
  });
});
