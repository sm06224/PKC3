/**
 * 板に置いた PDF の添付ノートの **1 ページ目を PNG に焼く**(#529 W6)── 主スレッドから見た口。
 *
 * 型は chart / mermaid と同じ(`chart-raster.ts`): 鍵 = 原文 + テーマ + 幅 + dpr(+ 産出器)、bytes は IDB の Blob
 * (`renderCachedPng`)、画面は `<img>` 1 枚、ObjectURL は表示終端で revoke(`hydrateDiagrams`)。
 * 「原文」の席には**添付の鍵**を入れる(添付は差し替えると鍵が変わるので、内容が変われば焼き直す)。
 *
 * 🔑 焼く本体は `platform/pdf/page-baker.ts`(解析は pdf.js のワーカー・遅延起動・アイドルで terminate)。
 * ⚠ PDF の bytes は**キャッシュが外れたときだけ**借りる(`produce` の中)── 当たれば添付を読まない。
 * ⚠ pdf.js の実体は PDF の窓と同じ `pdf/lib/`(単一 HTML の持ち運び版など、無い環境では読めない →
 *   端末の事情の失敗として出し、枠は従来どおり「PDF は元のノートで」のまま残る)。
 */
import { PdfPageBaker, PDF_LIB_DIR, type PdfJsLib } from '@adapter/platform/pdf/page-baker';
import { DeviceRenderError, renderCachedPng, type Raster, type RasterKey } from './mermaid-raster';
import type { AssetLender } from './detail';
import type { DiagramKind } from './mermaid-hydrate';

/** 鍵の `kind` / `engine`。⚠ pdf.js の版上げ・描き方の変更は `RASTER_BAKE_VERSION` を上げる。 */
export const PDF_PAGE_KIND_NAME = 'pdf-page';
export const PDF_ENGINE = 'pdf.js';

/** 器の属性(値 = 添付の鍵)。 */
export const PDF_PAGE_ATTR = 'data-pkc-pdf-src';
export const PDF_PAGE_IMG_FIELD = 'place-attachment-pdf-image';

let baker: PdfPageBaker | null = null;
/** test / 計測が差し替える口。 */
let makeBaker: (() => PdfPageBaker) | null = null;

export function setPdfBakerFactory(fn: (() => PdfPageBaker) | null): void {
  baker?.dispose();
  baker = null;
  makeBaker = fn;
}

function bakerOf(): PdfPageBaker {
  baker ??=
    makeBaker?.() ??
    new PdfPageBaker({
      load: async () => {
        const baseUrl = new URL(PDF_LIB_DIR, document.baseURI).href;
        try {
          const lib = (await import(/* @vite-ignore */ new URL('pdf.min.mjs', baseUrl).href)) as PdfJsLib;
          return { lib, baseUrl };
        } catch {
          throw new DeviceRenderError('PDF を描くためのライブラリを読み込めませんでした');
        }
      },
    });
  return baker;
}

/** 1 枚焼く(キャッシュがあればそれ)。 */
export async function renderPdfPageToPng(
  assetKey: string,
  lender: AssetLender,
  key: Omit<RasterKey, 'source'>,
): Promise<Raster> {
  const full: RasterKey = { ...key, source: assetKey, kind: PDF_PAGE_KIND_NAME, engine: key.engine ?? PDF_ENGINE };
  return renderCachedPng(full, async () => {
    const blob = await lender.getBlob(assetKey);
    if (blob === null) throw new DeviceRenderError('PDF の添付を読めませんでした');
    // ⚠ ここで得た bytes は pdf.js へ移る(以後触らない)
    const bytes = await blob.arrayBuffer();
    const r = await bakerOf().bake(bytes, key.width, key.dpr);
    return { png: r.png, cssWidth: r.cssWidth };
  });
}

/** 板の PDF の器を埋める種類記述子。⚠ 貸出口(`lender`)に結びつく ── 板ごとに 1 つ作る。 */
export function pdfPageKind(lender: AssetLender, title: (assetKey: string) => string): DiagramKind {
  return {
    attr: PDF_PAGE_ATTR,
    name: 'pdf',
    imgField: PDF_PAGE_IMG_FIELD,
    alt: (source) => title(source),
    render: (key) => renderPdfPageToPng(key.source, lender, key),
    savable: false,
    // 🔑 押すと元のノートへ(従来どおり)── 別窓の拡大には繋がない
    viewBig: false,
  };
}
