/**
 * 🔴 **可搬単一 HTML を書き出す**(#400 段④)。
 *
 * ⚠ ここが守るのは「**雛形の中を字面で探さない**」である ── 雛形の 6.5 MB の
 * ほとんどはアプリ本体の JS で、そこには**書き出しのコード自身の文字列**が
 * 入っている。`fold.mjs` はこの罠でアプリを 1 度真っ白にした。
 */
import { describe, expect, it } from 'vitest';
import {
  bundleTagHtml,
  PORTABLE_HEAD_SCAN,
  stampHead,
  writePortableBundle,
} from '../../src/features/export/portable-bundle';
import { MAX_EMBED_TEXT_CHARS } from '../../src/features/storage/image-export-limit';
import {
  IMAGE_PART_BYTES,
  parseBundleTag,
  type PortableBundle,
} from '../../src/features/portable/bundle';
import { archiveSuffix } from '../../src/features/export/archive-kind';

const OLD: PortableBundle = { id: 'pkcb-template', exportedAt: 0 };
const NEW: PortableBundle = { id: 'pkcb-0011223344556677', exportedAt: 1_700_000_000_000 };

/**
 * 雛形の形を真似る。
 * 🔴 **アプリの JS の中にも同じ綴りを入れる** ── 本物がそうだからである
 * (この綴りを持つコードが、そのまま畳まれて入っている)。
 */
const template = (over: { body?: string } = {}): string =>
  `<!doctype html><html lang="ja"><head>${bundleTagHtml(OLD)}` +
  `<title>PKC3</title>` +
  `<script type="module">var s='<script type="application/json" data-pkc-bundle>'+'x';var e='</body>';</script>` +
  `</head><body>${over.body ?? '<div data-pkc-slot="root"></div>'}</body></html>`;

const nothing = (async function* (): AsyncGenerator<{
  key: string;
  mime: string;
  blob: Blob;
}> {})();

describe('印の差し替え', () => {
  it('雛形の印を、この書き出しの印にする', () => {
    const head = stampHead(template().slice(0, PORTABLE_HEAD_SCAN), NEW);
    expect(parseBundleTag(head.match(/data-pkc-bundle>([^<]*)</)![1]!)).toEqual(NEW);
  });

  it('🔴 印が頭に 1 件で無ければ落とす(黙って差し替えない)', () => {
    expect(() => stampHead('<html><head></head>', NEW)).toThrow(/0 件/);
    expect(() => stampHead(bundleTagHtml(OLD) + bundleTagHtml(OLD), NEW)).toThrow(/2 件/);
  });

  it('🔴 頭より後ろにある「本物と同じ形の印」は見ない', async () => {
    /**
     * ⚠ 上の fixture の JS は **`TAG_RE` に当たらない綴り**だったので、
     *   `PORTABLE_HEAD_SCAN` を 1000 倍にしても素通りしていた
     *   (変異試験 M24 が SURVIVED で教えた)── **範囲の門が 1 度も効いていない**。
     * 🔑 だから「頭の外に、当たってしまう形の印を置く」fixture を作る。
     */
    const decoy =
      `<script type="application/json" data-pkc-bundle>{"id":"pkcb-decoy00001","exportedAt":1}` +
      `</` + `script>`;
    /**
     * 🔴 **詰め物の長さを定数から作らない**(変異試験 M24 が 2 度 SURVIVED で教えた)。
     * ⚠ 1 稿目は `'x'.repeat(PORTABLE_HEAD_SCAN)` と書いたので、
     *   **定数を 1000 倍にすると詰め物も 1000 倍**になり、囮は常に範囲の外に居た
     *   ── 期待値を「実装と同じ値」から作ると、同じ盲点を共有する(CLAUDE.md §1)。
     * 🔑 詰め物は**素の数**にし、前提(定数がそれより小さいこと)を assert する。
     */
    const PAD = 8_000;
    expect(PORTABLE_HEAD_SCAN, '前提が崩れた(頭の範囲が詰め物より広い)').toBeLessThan(PAD);
    const padded = template({ body: 'x'.repeat(PAD) + decoy });
    // 空振り防止 ── 囮は本当に頭の外に在る
    expect(padded.indexOf(decoy)).toBeGreaterThan(PORTABLE_HEAD_SCAN);
    const out = await writePortableBundle({
      template: padded,
      bundle: NEW,
      image: new Uint8Array([1]),
      assets: nothing,
    });
    const html = await out.blob.text();
    // 差し替わったのは頭の 1 件だけ ── 囮はそのまま残っている
    expect(html).toContain('"id":"pkcb-decoy00001"');
    expect(html).toContain(`"id":"${NEW.id}"`);
    expect(html).not.toContain('"id":"pkcb-template"');
  });

  it('🔴 頭しか見ない ── JS の中の同じ綴りには当たらない', async () => {
    const out = await writePortableBundle({
      template: template(),
      bundle: NEW,
      image: new Uint8Array([1, 2, 3]),
      assets: nothing,
    });
    const html = await out.blob.text();
    // 新しい印は 1 件だけ。古い印は消えている
    expect([...html.matchAll(/data-pkc-bundle>\{/g)]).toHaveLength(1);
    expect(html).toContain(`"id":"${NEW.id}"`);
    expect(html).not.toContain('"id":"pkcb-template"');
    // 🔑 アプリの JS は 1 バイトも変わっていない
    expect(html).toContain(`var s='<script type="application/json" data-pkc-bundle>'+'x';`);
  });
});

describe('中身を差し込む', () => {
  it('DB 画像が base64 で入る(往復する)', async () => {
    const image = new Uint8Array([0, 1, 2, 250, 251, 255, 7]);
    const out = await writePortableBundle({
      template: template(),
      bundle: NEW,
      image,
      assets: nothing,
    });
    const html = await out.blob.text();
    const b64 = html.match(/data-pkc-db-image="0\/1">([^<]*)</)![1]!;
    expect(Array.from(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))).toEqual(
      Array.from(image),
    );
    expect(out.imageBytes).toBe(image.byteLength);
  });

  it('🔴 大きい画像でも 1 バイトも狂わない(3 の倍数で区切る規則)', async () => {
    // ⚠ チャンクの境目が 3 の倍数でないと、**繋いだ結果が別物になる** ──
    //   症状は「開いたら DB が壊れている」で、小さい fixture では出ない
    const n = 3 * 64 * 1024 + 7; // チャンク 1 個ぶん + 端数
    const image = new Uint8Array(n);
    for (let i = 0; i < n; i++) image[i] = (i * 31) % 256;
    const out = await writePortableBundle({
      template: template(),
      bundle: NEW,
      image,
      assets: nothing,
    });
    const html = await out.blob.text();
    const b64 = html.match(/data-pkc-db-image="0\/1">([^<]*)</)![1]!;
    const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(back.byteLength).toBe(n);
    // 全部比べる(末尾だけ見ると、境目の狂いを見逃す)
    expect(back).toEqual(image);
  });

  it('🔴 大きい DB 画像は IMAGE_PART_BYTES ごとの <script> に割れ、印が 番号/総数 で並ぶ (#1416 §7-4)', async () => {
    // ⚠ 1 本に入れると、開くとき HTML の読み手が二乗で遅くなる(150MB で 27 秒)── 割ることが本題
    const n = IMAGE_PART_BYTES * 2 + 5; // 3 要素 + 端数(最後だけ `=` が出る)
    const image = new Uint8Array(n);
    for (let i = 0; i < n; i++) image[i] = (i * 131 + (i >> 8)) % 256;
    const out = await writePortableBundle({ template: template(), bundle: NEW, image, assets: nothing });
    const html = await out.blob.text();
    const hits = [...html.matchAll(/data-pkc-db-image="([^"]*)">([^<]*)</g)];
    expect(hits.map((m) => m[1])).toEqual(['0/3', '1/3', '2/3']);
    // 割った単位が効いている(1 要素の字数 = 元 bytes の 4/3)
    expect(hits[0]![2]!.length).toBe((IMAGE_PART_BYTES / 3) * 4);
    expect(hits[1]![2]!.length).toBe((IMAGE_PART_BYTES / 3) * 4);
    // `=` が出るのは最後の要素だけ(= 各要素を独立に復号できる)
    expect(hits[0]![2]).not.toContain('=');
    expect(hits[1]![2]).not.toContain('=');
    expect(hits[2]![2]).toContain('=');
    // 繋いで復号すると 1 バイトも違わない
    const bin = atob(hits.map((m) => m[2]).join(''));
    expect(bin.length).toBe(n);
    // ⚠ 全部比べる(`toEqual` で 6MB の配列を比べると遅いので、字ごとに見て最初の食い違いだけ言う)
    let firstDiff = -1;
    for (let i = 0; i < n; i++) {
      if (bin.charCodeAt(i) !== image[i]) {
        firstDiff = i;
        break;
      }
    }
    expect(firstDiff, '最初に食い違う位置').toBe(-1);
  });

  it('IMAGE_PART_BYTES ちょうどの画像は 1 要素(境目で空の要素を作らない)', async () => {
    const image = new Uint8Array(IMAGE_PART_BYTES).fill(9);
    const out = await writePortableBundle({ template: template(), bundle: NEW, image, assets: nothing });
    const marks = [...(await out.blob.text()).matchAll(/data-pkc-db-image="([^"]*)"/g)].map((m) => m[1]);
    expect(marks).toEqual(['0/1']);
  });

  it('添付が key と mime つきで入る', async () => {
    async function* one(): AsyncGenerator<{ key: string; mime: string; blob: Blob }> {
      yield { key: 'ast-abc', mime: 'image/png', blob: new Blob([new Uint8Array([9, 8])]) };
    }
    const out = await writePortableBundle({
      template: template(),
      bundle: NEW,
      image: new Uint8Array([1]),
      assets: one(),
    });
    const html = await out.blob.text();
    expect(out.assets).toBe(1);
    expect(html).toContain('data-pkc-asset="ast-abc"');
    expect(html).toContain('data-pkc-asset-mime="image/png"');
  });

  it('🔴 扱えない key は、落とさず名指しで注意する(残りは焼く)', async () => {
    async function* two(): AsyncGenerator<{ key: string; mime: string; blob: Blob }> {
      yield { key: 'a"onerror=x', mime: 'image/png', blob: new Blob(['x']) };
      yield { key: 'ast-ok', mime: 'image/png', blob: new Blob(['y']) };
    }
    const out = await writePortableBundle({
      template: template(),
      bundle: NEW,
      image: new Uint8Array([1]),
      assets: two(),
    });
    expect(out.assets).toBe(1);
    expect(out.warnings.join()).toContain('a"onerror=x');
    // 🔑 属性を抜け出す字は 1 つも入っていない
    expect(await out.blob.text()).not.toContain('onerror=');
  });

  it('mime に紛れ込んだ字は落とす(属性を抜け出させない)', async () => {
    async function* bad(): AsyncGenerator<{ key: string; mime: string; blob: Blob }> {
      yield { key: 'ast-ok', mime: 'image/png" onload="x', blob: new Blob(['y']) };
    }
    const out = await writePortableBundle({
      template: template(),
      bundle: NEW,
      image: new Uint8Array([1]),
      assets: bad(),
    });
    expect(await out.blob.text()).not.toContain('onload=');
  });
});

describe('断るべきもの', () => {
  it('空の DB は書き出さない', async () => {
    await expect(
      writePortableBundle({
        template: template(),
        bundle: NEW,
        image: new Uint8Array(0),
        assets: nothing,
      }),
    ).rejects.toThrow(/空/);
  });

  it('差し込み先が無い雛形は落とす', async () => {
    await expect(
      writePortableBundle({
        template: `<html><head>${bundleTagHtml(OLD)}</head>`,
        bundle: NEW,
        image: new Uint8Array([1]),
        assets: nothing,
      }),
    ).rejects.toThrow(/<\/body>/);
  });

  it('🔴 差し込み先は**最後の** `</body>`(JS の中のものではない)', async () => {
    const out = await writePortableBundle({
      template: template(),
      bundle: NEW,
      image: new Uint8Array([1]),
      assets: nothing,
    });
    const html = await out.blob.text();
    // アプリの JS の中の `'</body>'` はそのまま残っている
    expect(html).toContain(`var e='</body>';`);
    // 差し込んだ画像は器の中(= 最後の `</body>` の前)に在る
    expect(html.indexOf('data-pkc-db-image')).toBeLessThan(html.lastIndexOf('</body>'));
    // そして器の外に出ていない
    expect(html.slice(html.lastIndexOf('</body>'))).not.toContain('data-pkc-db-image');
  });
});

/**
 * 🔴 **焼けるが開けない大きさを、焼かせない**(#996)。
 *
 * ## ⚠ この test が証明していないこと(先に書く)
 *
 * 384 MiB の中身を unit で本当に確保することはできないので、**大きさだけを偽って**
 * 門に当てている。🔑 だから証明できるのは「**門が `byteLength` / `size` を見て
 * 断っている**」までで、「**本当に 384 MiB を焼こうとすると断られる**」ではない
 * (そちらは #996 の残りとして、実際に作って確かめる)。
 * ⚠ **偽っていることを隠さない** ── 隠すと、次に読む人が「実測済み」と読む。
 */
describe('🔴 読み戻せない大きさを焼かせない(#996)', () => {
  const EDGE = Math.floor((MAX_EMBED_TEXT_CHARS * 3) / 4);

  /** 大きさだけ偽る(中身は 1 バイト)。⚠ 門より後ろへは進まない前提で使う。 */
  const fakeSize = <T extends object>(o: T, prop: 'byteLength' | 'size', n: number): T => {
    Object.defineProperty(o, prop, { value: n, configurable: true });
    // ⚠ **偽れたことを確かめる** ── 偽れていなければ門は小さい値を見るので、
    //   この test は「常に通る」空振りになる(CLAUDE.md §1)
    expect((o as unknown as Record<string, number>)[prop], '大きさを偽れていない').toBe(n);
    return o;
  };

  const oneAsset = (blob: Blob): AsyncGenerator<{ key: string; mime: string; blob: Blob }> =>
    (async function* () {
      yield { key: 'a1b2c3d4', mime: 'image/png', blob };
    })();

  it('🔴 読み戻せない大きさの中身は、焼く前に断る', async () => {
    await expect(
      writePortableBundle({
        template: template(),
        bundle: NEW,
        image: fakeSize(new Uint8Array([1]), 'byteLength', EDGE + 1),
        assets: nothing,
      }),
    ).rejects.toThrow(/取り込み直せない/);
  });

  /**
   * 🔴 **対照群 ── 門が「いつでも鳴っている」のではないこと。**
   *
   * ⚠ 大きさを偽っている(実体は 1 バイト)。画像を IMAGE_PART_BYTES ごとに割る作りになってからは、
   *   門を抜けた先で確保が落ちず、**偽の大きさのまま書き出しが終わる**(割った要素の中身は空)。
   * 🔑 だから見るのは「**断り文が出ていない**」ことと「**門の先まで進んで結果が返った**」こと
   *   (`imageBytes` が偽の大きさで返る)── 門が鳴っていれば throw で、結果は返らない。
   */
  it('⚠ 境目ちょうどでは門が鳴らない(対照群)', async () => {
    const err: unknown = await writePortableBundle({
      template: template(),
      bundle: NEW,
      image: fakeSize(new Uint8Array([1]), 'byteLength', EDGE),
      assets: nothing,
    }).catch((e: unknown) => e);
    expect(String(err), '境目ちょうどで門が鳴った').not.toContain('取り込み直せない');
    // ⚠ 空振り防止 ── 本当に門の先まで進んでいる(門が鳴っていれば throw で、結果は返らない)
    expect((err as { imageBytes?: number }).imageBytes, '門の先まで進んでいない').toBe(EDGE);
  });

  it('⚠ 普通の大きさは、これまでどおり最後まで焼ける(対照群)', async () => {
    const out = await writePortableBundle({
      template: template(),
      bundle: NEW,
      image: new Uint8Array([1, 2, 3]),
      assets: nothing,
    });
    expect(out.imageBytes).toBe(3);
    expect(out.warnings).toEqual([]);
  });

  it('🔴 巨大な添付も落とさず焼き(割ってあるので開ける)、取り込み直せない大きさだと 1 度だけ言う', async () => {
    const out = await writePortableBundle({
      template: template(),
      bundle: NEW,
      image: new Uint8Array([1, 2, 3]),
      assets: oneAsset(fakeSize(new Blob([new Uint8Array([9])]), 'size', EDGE + 1)),
    });
    expect(out.assets, '添付を落とした').toBe(1);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0], '開けることを言っていない').toContain('開けます');
    expect(out.warnings[0], '代わりの道を書いていない').toContain(archiveSuffix('full'));
    expect(await out.blob.text()).toContain('data-pkc-asset="a1b2c3d4"');
  });

  it('⚠ 普通の大きさの添付は、これまでどおり焼ける(対照群)', async () => {
    const out = await writePortableBundle({
      template: template(),
      bundle: NEW,
      image: new Uint8Array([1, 2, 3]),
      assets: oneAsset(new Blob([new Uint8Array([9, 8, 7])])),
    });
    expect(out.assets).toBe(1);
    expect(out.warnings).toEqual([]);
  });
});

/**
 * 🔴 **添付も 3MiB ごとの `<script>` に割って焼く**(#1416 §7-4d)。
 */
describe('添付を割って焼く (#1416 §7-4d)', () => {
  const bake = async (size: number, key = 'ast-big'): Promise<string> => {
    const out = await writePortableBundle({
      template: template(),
      bundle: NEW,
      image: new Uint8Array([1, 2, 3]),
      assets: (async function* () {
        yield { key, mime: 'image/png', blob: new Blob([new Uint8Array(size)]) };
      })(),
    });
    return out.blob.text();
  };
  const assetMarks = (html: string): Array<string | undefined> =>
    [...html.matchAll(/<script [^>]*data-pkc-asset="ast-big"[^>]*>/g)].map(
      (m) => /data-pkc-asset-part="([^"]*)"/.exec(m[0])?.[1],
    );

  it('🔴 3MiB を超える添付は、同じ key の要素に 番号/総数 を付けて割る', async () => {
    const html = await bake(IMAGE_PART_BYTES * 2 + 11);
    expect(assetMarks(html)).toEqual(['0/3', '1/3', '2/3']);
  });

  it('🔴 3MiB ちょうど以下は 1 要素で、割る前の版と同じ形(印なし = 古い取り込み口でも読める)', async () => {
    expect(assetMarks(await bake(IMAGE_PART_BYTES))).toEqual([undefined]);
    expect(assetMarks(await bake(IMAGE_PART_BYTES + 1))).toEqual(['0/2', '1/2']);
    expect(assetMarks(await bake(5))).toEqual([undefined]);
    // 0 バイトも 1 要素(以前と同じ)
    expect(assetMarks(await bake(0))).toEqual([undefined]);
  });

  it('🔴 ファイル全体の見積もりは、実際の長さ以上で、枠の見積もり(DB 画像の要素ごと 120 字)ぶんしかずれない', async () => {
    // 本物に近い大きさの雛形(約 12MB)── 雛形の長さを数え落とす変異が、小さい雛形では見えない
    const big = template({ body: `<div>${'x'.repeat(12 * 1024 * 1024)}</div>` });
    const image = new Uint8Array(IMAGE_PART_BYTES + 5); // 2 要素
    const out = await writePortableBundle({
      template: big,
      bundle: NEW,
      image,
      assets: (async function* () {
        yield { key: 'ast-big', mime: 'image/png', blob: new Blob([new Uint8Array(IMAGE_PART_BYTES * 2 + 1)]) };
        yield { key: 'ast-two', mime: 'image/png', blob: new Blob([new Uint8Array(7)]) };
      })(),
    });
    const actual = (await out.blob.text()).length;
    expect(out.estimatedChars, '実際より少なく見積もっている').toBeGreaterThanOrEqual(actual);
    // 画像の要素の枠(実際は約 85 字)を 120 と多めに見ているだけ。添付の枠は正確
    expect(out.estimatedChars - actual, '見積もりが実際から離れている').toBeLessThanOrEqual(2 * 40);
    expect(actual, '前提: 雛形が効いている').toBeGreaterThan(12 * 1024 * 1024);
  });

  describe('🔴 残る天井は「ファイル全体」── 超えても落とさず、警告する', () => {
    const IMG = 10 * 1024 * 1024;
    const base64Len = (b: number): number => Math.ceil(b / 3) * 4;
    const run = async (assetBytes: number) => {
      const blob = new Blob([new Uint8Array([9])]);
      Object.defineProperty(blob, 'size', { value: assetBytes, configurable: true });
      expect(blob.size, '大きさを偽れていない').toBe(assetBytes);
      return writePortableBundle({
        template: template(),
        bundle: NEW,
        image: new Uint8Array(IMG),
        assets: (async function* () {
          yield { key: 'ast-big', mime: 'image/png', blob };
        })(),
      });
    };
    const room = MAX_EMBED_TEXT_CHARS - base64Len(IMG);

    it('🔴 合計が取り込み直せる上限を超えても、添付は落とさず焼き、警告は 1 度だけ(開けることを先に言う)', async () => {
      const bytes = Math.floor(((room + 1_000_000) * 3) / 4);
      expect(bytes, '前提: 1 件だけなら通る大きさ').toBeLessThan(Math.floor((MAX_EMBED_TEXT_CHARS * 3) / 4));
      const out = await run(bytes);
      expect(out.assets, '添付を落とした').toBe(1);
      expect(out.warnings).toHaveLength(1);
      expect(out.warnings[0], '開けることを言っていない').toContain('開けます');
      expect(out.warnings[0], '取り込み直しの話をしていない').toContain('取り込み直せない');
      expect(out.warnings[0], '代わりの道を書いていない').toContain(archiveSuffix('full'));
      expect(out.warnings[0], '大きさを言っていない').toMatch(/約 \d/);
      expect(await out.blob.text(), '添付の要素が無い').toContain('data-pkc-asset="ast-big"');
    });

    it('🔴 添付が複数でも、警告は 1 度だけで、全部焼く', async () => {
      const blob = (n: number): Blob => {
        const b = new Blob([new Uint8Array([9])]);
        Object.defineProperty(b, 'size', { value: n, configurable: true });
        return b;
      };
      const half = Math.floor(((room / 2 + 1_000_000) * 3) / 4);
      const out = await writePortableBundle({
        template: template(),
        bundle: NEW,
        image: new Uint8Array(IMG),
        assets: (async function* () {
          yield { key: 'ast-a', mime: 'image/png', blob: blob(half) };
          yield { key: 'ast-b', mime: 'image/png', blob: blob(half) };
          yield { key: 'ast-c', mime: 'image/png', blob: blob(5) };
        })(),
      });
      expect(out.assets).toBe(3);
      expect(out.warnings).toHaveLength(1);
    });

    it('対照群: 余裕のある大きさは焼ける(門が いつでも鳴っている のではない)', async () => {
      const out = await run(Math.floor(((room - 1_000_000) * 3) / 4));
      expect(out.assets).toBe(1);
      expect(out.warnings).toEqual([]);
    });
  });
});
