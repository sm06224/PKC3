/** @vitest-environment happy-dom */
/**
 * 🔴 **書き出しと起動を、本物どうしで繋ぐ**(#400 段④)。
 *
 * ⚠ 片端だけの test では**綴りの食い違いが両方緑のまま通る**
 * (CLAUDE.md §7 ── #195 で `nonce` を添え忘れ、実ブラウザの smoke が拾うまで
 * 誰も気づけなかった型)。だからここは**実物の writer が出したものを、
 * 実物の reader に読ませる**。
 *
 * 🔑 間に立つのは `DOMParser` だけ ── **封筒を 1 バイトも作らせない**。
 */
import { describe, expect, it } from 'vitest';
import { writePortableBundle, bundleTagHtml } from '../../src/features/export/portable-bundle';
import { readBundle, takeEmbeddedImage } from '../../src/adapter/platform/portable-boot';
import {
  ASSET_SELECTOR,
  restoreEmbeddedAssets,
} from '../../src/adapter/platform/portable-assets';
import type { PortableBundle } from '../../src/features/portable/bundle';

const OLD: PortableBundle = { id: 'pkcb-template', exportedAt: 0 };
const NEW: PortableBundle = { id: 'pkcb-0011223344556677', exportedAt: 1_700_000_000_000 };
const CID = 'c-1';

const template = (): string =>
  `<!doctype html><html lang="ja"><head>${bundleTagHtml(OLD)}<title>PKC3</title>` +
  `<script type="module">var s='data-pkc-bundle';</script></head>` +
  `<body><div data-pkc-slot="root"></div></body></html>`;

/** 器の代役。⚠ **本物と同じ意味論**(key ごとに 1 件、上書きできる)。 */
function sink() {
  const map = new Map<string, { blob: Blob }>();
  return {
    map,
    listKeys: async (cid: string) =>
      [...map.keys()].filter((k) => k.startsWith(`${cid}:`)).map((k) => k.slice(cid.length + 1)),
    put: async (cid: string, key: string, blob: Blob) => {
      map.set(`${cid}:${key}`, { blob });
    },
  };
}

async function build(image: Uint8Array, assets: Array<{ key: string; mime: string; bytes: number[] }>) {
  async function* gen(): AsyncGenerator<{ key: string; mime: string; blob: Blob }> {
    for (const a of assets)
      yield { key: a.key, mime: a.mime, blob: new Blob([new Uint8Array(a.bytes)]) };
  }
  const out = await writePortableBundle({
    template: template(),
    bundle: NEW,
    image,
    assets: gen(),
  });
  return new DOMParser().parseFromString(await out.blob.text(), 'text/html');
}

describe('#400 段④ ── 書き出したものが、そのまま起動で読める', () => {
  it('🔴 印・DB 画像・添付が、書いた通りに読み戻せる', async () => {
    const image = new Uint8Array([0, 1, 250, 255, 7, 7, 7]);
    const doc = await build(image, [
      { key: 'ast-aaa', mime: 'image/png', bytes: [1, 2, 3] },
      { key: 'ast-bbb', mime: 'application/pdf', bytes: [9] },
    ]);

    // ① 印
    expect(readBundle(doc)).toEqual(NEW);

    // ② DB 画像(⚠ 取り出したら DOM から外れる)
    expect(Array.from(takeEmbeddedImage(doc)!)).toEqual(Array.from(image));
    expect(doc.querySelector('script[data-pkc-db-image]')).toBeNull();

    // ③ 添付
    const s = sink();
    expect(doc.querySelectorAll(ASSET_SELECTOR)).toHaveLength(2); // 空振り防止
    const r = await restoreEmbeddedAssets(doc, CID, s);
    expect(r).toEqual({ restored: 2, skipped: 0, failed: 0 });
    expect(doc.querySelectorAll(ASSET_SELECTOR)).toHaveLength(0);

    const a = s.map.get(`${CID}:ast-aaa`)!;
    expect(a.blob.type).toBe('image/png');
    expect(Array.from(new Uint8Array(await a.blob.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(s.map.get(`${CID}:ast-bbb`)!.blob.type).toBe('application/pdf');
  });

  it('🔴 2 回目の起動では書き直さない(器に在るものは飛ばす)', async () => {
    const doc = await build(new Uint8Array([1]), [
      { key: 'ast-aaa', mime: 'image/png', bytes: [1, 2, 3] },
    ]);
    const s = sink();
    await s.put(CID, 'ast-aaa', new Blob(['already']));
    const r = await restoreEmbeddedAssets(doc, CID, s);
    expect(r).toEqual({ restored: 0, skipped: 1, failed: 0 });
    // 🔑 **上書きしていない**(器のほうが正しい ── 起動のたびに書き戻さない)
    expect(await s.map.get(`${CID}:ast-aaa`)!.blob.text()).toBe('already');
  });

  it('⚠ 別の器の key は数に入れない(接頭辞で切る)', async () => {
    const doc = await build(new Uint8Array([1]), [
      { key: 'ast-aaa', mime: 'image/png', bytes: [4] },
    ]);
    const s = sink();
    await s.put('c-other', 'ast-aaa', new Blob(['よその']));
    const r = await restoreEmbeddedAssets(doc, CID, s);
    expect(r.restored, 'よその器の key を「在る」と数えている').toBe(1);
  });

  it('🔴 読めなかった添付は数える(黙って 0 に畳まない)', async () => {
    const doc = await build(new Uint8Array([1]), [
      { key: 'ast-aaa', mime: 'image/png', bytes: [4] },
    ]);
    const el = doc.querySelector(ASSET_SELECTOR)!;
    el.textContent = '@@@ 読めない @@@';
    const r = await restoreEmbeddedAssets(doc, CID, sink());
    expect(r).toEqual({ restored: 0, skipped: 0, failed: 1 });
    // ⚠ 読めなくても DOM からは外す(base64 を抱え続けない)
    expect(doc.querySelectorAll(ASSET_SELECTOR)).toHaveLength(0);
  });

  it('添付が 0 件の書き出しでも起動する', async () => {
    const doc = await build(new Uint8Array([1, 2]), []);
    expect(await restoreEmbeddedAssets(doc, CID, sink())).toEqual({
      restored: 0,
      skipped: 0,
      failed: 0,
    });
    expect(Array.from(takeEmbeddedImage(doc)!)).toEqual([1, 2]);
  });
});
