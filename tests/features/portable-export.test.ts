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
import { parseBundleTag, type PortableBundle } from '../../src/features/portable/bundle';

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
    const b64 = html.match(/data-pkc-db-image>([^<]*)</)![1]!;
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
    const b64 = html.match(/data-pkc-db-image>([^<]*)</)![1]!;
    const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(back.byteLength).toBe(n);
    // 全部比べる(末尾だけ見ると、境目の狂いを見逃す)
    expect(back).toEqual(image);
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
