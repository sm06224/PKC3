/** @vitest-environment happy-dom */
/**
 * 板の PDF の 1 ページ目を PNG にして器へ出す(#529 W6)── chart / mermaid と同じ型に乗っているか。
 *
 * 守る主張:
 * 1. 鍵: 種類 `pdf-page` + 産出器 + 添付の鍵(原文の席)+ 幅 + dpr + 配色(他の絵と取り違えない / 版が違えば別鍵)
 * 2. 添付の bytes は**キャッシュが外れたときだけ**借りる(当たれば読まない)
 * 3. 器は `<img>` 1 枚で埋まる(canvas / SVG を画面に置かない)/ 押し所は器のまま(別窓の拡大に繋がない)
 * 4. ObjectURL は表示終端(`dispose`)で revoke する
 * 5. 焼けない(借りられない / 焼き手が落ちる)と器は字のまま(`failed`)で、押すと元のノートへ行く道は残る
 *
 * 貯める所(IDB)は差す ── ここで見たいのは**鍵と順序**であって IDB ではない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RasterKey } from '../../src/adapter/ui/render/mermaid-raster';

const seenKeys: RasterKey[] = [];
let cacheHit = false;

vi.mock('../../src/adapter/ui/render/mermaid-raster', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/adapter/ui/render/mermaid-raster')>();
  return {
    ...real,
    readPalette: () => ({ bg: '#fff', alt: '#eee', fg: '#000', line: '#666', border: '#ccc', accent: '#080', dark: false }),
    renderCachedPng: vi.fn(async (key: RasterKey, produce: () => Promise<{ png: Blob; cssWidth: number }>) => {
      seenKeys.push(key);
      if (cacheHit) return { png: new Blob(['cached'], { type: 'image/png' }), cssWidth: key.width };
      return produce();
    }),
  };
});

import { cacheKey } from '../../src/adapter/ui/render/mermaid-raster';
import { hydrateDiagrams } from '../../src/adapter/ui/render/mermaid-hydrate';
import {
  PDF_ENGINE,
  PDF_PAGE_ATTR,
  PDF_PAGE_KIND_NAME,
  pdfPageKind,
  renderPdfPageToPng,
  setPdfBakerFactory,
} from '../../src/adapter/ui/render/pdf-raster';
import type { PdfPageBaker } from '../../src/adapter/platform/pdf/page-baker';
import type { AssetLender } from '../../src/adapter/ui/render/detail';

const urls: string[] = [];
const revoked: string[] = [];

function lender(blob: Blob | null): { l: AssetLender; got: string[] } {
  const got: string[] = [];
  return {
    got,
    l: {
      lend: () => Promise.resolve(null),
      getBlob: (k) => {
        got.push(k);
        return Promise.resolve(blob);
      },
    },
  };
}

function fakeBaker(): { baker: PdfPageBaker; calls: Array<{ bytes: ArrayBuffer; width: number; dpr: number }>; disposed: () => boolean } {
  const calls: Array<{ bytes: ArrayBuffer; width: number; dpr: number }> = [];
  let disposed = false;
  const baker = {
    bake: (bytes: ArrayBuffer, width: number, dpr: number) => {
      calls.push({ bytes, width, dpr });
      return Promise.resolve({ png: new Blob(['png'], { type: 'image/png' }), cssWidth: width, cssHeight: 10 });
    },
    dispose: () => {
      disposed = true;
    },
  } as unknown as PdfPageBaker;
  return { baker, calls, disposed: () => disposed };
}

const key = (over: Partial<Omit<RasterKey, 'source'>> = {}): Omit<RasterKey, 'source'> => ({
  theme: 'light',
  palette: { bg: '#fff', alt: '#eee', fg: '#000', line: '#666', border: '#ccc', accent: '#080', dark: false },
  width: 320,
  dpr: 2,
  ...over,
});

beforeEach(() => {
  seenKeys.length = 0;
  urls.length = 0;
  revoked.length = 0;
  cacheHit = false;
  document.body.innerHTML = '';
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const u = `blob:pdf-${String(urls.length)}`;
    urls.push(u);
    return u;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => void revoked.push(u));
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private readonly cb: (e: unknown[]) => void) {}
      observe(el: Element): void {
        this.cb([{ isIntersecting: true, target: el }]);
      }
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});
afterEach(() => {
  setPdfBakerFactory(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PDF の絵の鍵と順序', () => {
  it('🔴 鍵: 種類・産出器・添付の鍵・幅・dpr が入り、どれが変わっても別鍵(版が違えば別の絵)', async () => {
    const fb = fakeBaker();
    setPdfBakerFactory(() => fb.baker);
    const { l } = lender(new Blob(['%PDF']));
    await renderPdfPageToPng('asset-1', l, key());
    const k = seenKeys[0]!;
    expect(k).toMatchObject({ kind: PDF_PAGE_KIND_NAME, engine: PDF_ENGINE, source: 'asset-1', width: 320, dpr: 2 });
    const base = cacheKey(k);
    expect(cacheKey({ ...k, source: 'asset-2' }), '添付が替わっても同じ絵').not.toBe(base);
    expect(cacheKey({ ...k, width: 640 }), '幅が鍵に無い').not.toBe(base);
    expect(cacheKey({ ...k, dpr: 1 }), 'dpr が鍵に無い').not.toBe(base);
    expect(cacheKey({ ...k, engine: 'pdf.js-next' }), '産出器の版が鍵に無い').not.toBe(base);
    expect(cacheKey({ ...k, kind: 'chart' }), '他の絵と取り違える').not.toBe(base);
    expect(cacheKey({ ...k, palette: { ...k.palette, bg: '#000' } }), '配色が鍵に無い').not.toBe(base);
  });

  it('🔴 添付の bytes はキャッシュが外れたときだけ借りる(当たれば借りない / 焼かない)', async () => {
    const fb = fakeBaker();
    setPdfBakerFactory(() => fb.baker);
    const miss = lender(new Blob(['%PDF-1.7']));
    await renderPdfPageToPng('a', miss.l, key({ width: 320, dpr: 2 }));
    expect(miss.got).toEqual(['a']);
    expect(fb.calls).toHaveLength(1);
    expect(fb.calls[0]).toMatchObject({ width: 320, dpr: 2 });
    expect(fb.calls[0]!.bytes.byteLength, 'bytes が焼き手に届いていない').toBe(8);
    cacheHit = true;
    const hit = lender(new Blob(['%PDF-1.7']));
    const r = await renderPdfPageToPng('a', hit.l, key());
    expect(hit.got, 'キャッシュに当たったのに添付を読んでいる').toEqual([]);
    expect(fb.calls, 'キャッシュに当たったのに焼いている').toHaveLength(1);
    expect(r.png.size).toBeGreaterThan(0);
  });

  it('🔴 借りられない添付は端末の事情の失敗として reject する(焼き手を呼ばない)', async () => {
    const fb = fakeBaker();
    setPdfBakerFactory(() => fb.baker);
    await expect(renderPdfPageToPng('gone', lender(null).l, key())).rejects.toThrow();
    expect(fb.calls).toHaveLength(0);
  });

  it('焼き手は差し替えのたびに畳む(古い焼き手を残さない)', async () => {
    const fb = fakeBaker();
    setPdfBakerFactory(() => fb.baker);
    await renderPdfPageToPng('a', lender(new Blob(['x'])).l, key());
    setPdfBakerFactory(null);
    expect(fb.disposed()).toBe(true);
  });
});

describe('PDF の器を埋める(hydrate)', () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
  };

  function mount(): HTMLElement {
    const host = document.createElement('button');
    host.setAttribute('data-pkc-field', 'place-body-skip');
    host.setAttribute('data-pkc-action', 'select-entry');
    host.setAttribute('data-pkc-entry', 'ap');
    host.setAttribute(PDF_PAGE_ATTR, 'pdf1');
    host.textContent = 'PDF は元のノートで';
    const wrap = document.createElement('div');
    wrap.append(host);
    document.body.append(wrap);
    return host;
  }

  it('🔴 img 1 枚で埋まり、押し所は器のまま(別窓の拡大に繋がない)/ dispose で URL を返す', async () => {
    const fb = fakeBaker();
    setPdfBakerFactory(() => fb.baker);
    const host = mount();
    const scope = hydrateDiagrams([host], pdfPageKind(lender(new Blob(['%PDF'])).l, () => '見積書'));
    await settle();
    const img = host.querySelector('img')!;
    expect(img, '絵が入っていない').not.toBeNull();
    expect(img.getAttribute('data-pkc-field')).toBe('place-attachment-pdf-image');
    expect(img.alt, '絵しか無い面の読み上げが無い').toBe('見積書');
    expect(host.querySelector('canvas, svg'), 'canvas / SVG を画面に置いている').toBeNull();
    expect(img.getAttribute('data-pkc-action'), '絵が押し所を奪っている(器の元のノートへ行く道が塞がる)').toBeNull();
    expect(host.getAttribute('data-pkc-action')).toBe('select-entry');
    expect(host.querySelector('[data-pkc-field="diagram-save"]'), '保存の導線を出している').toBeNull();
    expect(host.getAttribute('data-pkc-pdf-state')).toBe('ready');
    expect(urls).toHaveLength(1);
    expect(revoked, '表示中に返している').toHaveLength(0);
    scope.dispose();
    expect(revoked, '表示終端で URL を返していない').toEqual(urls);
  });

  it('🔴 焼けなかったら字のまま(failed)で、元のノートへ行く器は残る', async () => {
    setPdfBakerFactory(() => fakeBaker().baker);
    const host = mount();
    const scope = hydrateDiagrams([host], pdfPageKind(lender(null).l, () => 't'));
    await settle();
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toBe('PDF は元のノートで');
    expect(host.getAttribute('data-pkc-pdf-state')).toBe('failed');
    expect(host.getAttribute('data-pkc-action')).toBe('select-entry');
    expect(urls).toHaveLength(0);
    scope.dispose();
  });
});
