/**
 * plotly を **PNG に焼く**(#528 ①)── 主スレッドから見た口。`chart-raster.ts` と同じ型。
 *
 * 🔑 描くのは **sandbox の箱**(`platform/render/plotly-frame-doc.ts`)の中の plotly.js ── plotly は DOM を要求する
 * ので Worker では動かず、本体の画面で動かすと本文の設定が外へ要求を出せてしまう(CSP で塞いだ箱で動かす)。
 * 箱は `WorkerLease` から見える(`frame-worker.ts`):遅延起動 / 起動待ちの依頼を保持 / アイドルで箱ごと捨てる。
 *
 * ⚠ 貯める所は mermaid / chart と**同じ 1 つ**(`renderCachedPng`)── 鍵は 原文 + 配色 + 幅 + dpr + 産出器。
 * ⚠ 受け取るのは ArrayBuffer(transfer)で、Blob はここで作る。
 */
import { PLOTLY_VERSION } from '@runtime/lib-versions';
import { WorkerLease } from '@adapter/platform/worker-lease';
import { FrameWorker } from '@adapter/platform/render/frame-worker';
import { plotlyFrameDoc } from '@adapter/platform/render/plotly-frame-doc';
import { parsePlotlyFence, plotlyAltText, type PlotlySpec } from '@features/markdown/plotly-fence';
import { DeviceRenderError, renderCachedPng, type DiagramPalette, type Raster, type RasterKey } from './mermaid-raster';
import { hydrateDiagrams, type DiagramKind, type HydrateOptions, type MermaidScope } from './mermaid-hydrate';
import { chartHeightFor, seriesColors } from './chart-raster';

/** plotly の産出器の名前(鍵の `engine`)。⚠ plotly.js の版上げ・焼き方の変更は `RASTER_BAKE_VERSION` を上げる。 */
export const PLOTLY_ENGINE = `plotly.js-${PLOTLY_VERSION}`;

/** 1 辺の上限(CSS px)。 */
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 1200;

/** 高さ:設定に `layout.height` があればそれ(上下限つき)、無ければ幅から決める(chart と同じ比)。 */
export function plotlyHeightFor(width: number, layout: Record<string, unknown>): number {
  const h = layout.height;
  if (typeof h === 'number' && Number.isFinite(h)) return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(h)));
  return chartHeightFor(width);
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 既定を下に敷き、本文に書かれた物を上に重ねる(書いた物が勝つ)。 */
export function mergeLayout(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isPlain(v) && isPlain(b) ? mergeLayout(b, v) : v;
  }
  return out;
}

/**
 * 配色から敷く既定の layout。⚠ 本文に色を書かせない(配色を変えたら図も変わる)。書けば上書きされる。
 * 🔑 地は無彩色・色は情報にだけ:系列の色は `seriesColors`(chart と同じ)。
 */
export function paletteLayout(p: DiagramPalette): Record<string, unknown> {
  const axis = { gridcolor: p.border, linecolor: p.line, zerolinecolor: p.border, tickfont: { color: p.fg } };
  return {
    paper_bgcolor: p.bg,
    plot_bgcolor: p.bg,
    font: { color: p.fg },
    colorway: seriesColors(p),
    xaxis: axis,
    yaxis: axis,
    legend: { font: { color: p.fg } },
    // 余白を詰めすぎない(既定のまま)
  };
}

let lease: WorkerLease | null = null;
/** test / 計測が差し替える口(既定は本物の箱)。 */
let spawn: (() => Worker) | null = null;

export function setPlotlyFrameSpawn(fn: (() => Worker) | null): void {
  lease?.dispose();
  lease = null;
  spawn = fn;
}

/** plotly.js の本体は**必要になるまで読まない**(初期ロードに載せない。箱を作るときに 1 度だけ届く)。 */
async function loadPlotlySource(): Promise<string> {
  try {
    return (await import('plotly.js-dist-min/plotly.min.js?raw')).default;
  } catch {
    // 読み込みに失敗(オフライン / 配り直しで古くなった chunk)── 端末の事情の失敗として出す
    throw new DeviceRenderError('グラフを描くためのライブラリを読み込めませんでした(ページを再読み込みしてください)');
  }
}

function leaseOf(): WorkerLease {
  lease ??= new WorkerLease({
    name: 'plotly',
    spawn:
      spawn ??
      (() =>
        new FrameWorker({
          srcdoc: async () => plotlyFrameDoc(await loadPlotlySource()),
        }) as unknown as Worker),
  });
  return lease;
}

/** 1 枚焼く(キャッシュがあればそれ)。 */
export async function renderPlotlyToPng(
  source: string,
  spec: PlotlySpec,
  key: Omit<RasterKey, 'source'>,
): Promise<Raster> {
  const full: RasterKey = { ...key, source, kind: 'plotly', engine: key.engine ?? PLOTLY_ENGINE };
  return renderCachedPng(full, async () => {
    const layout = mergeLayout(paletteLayout(key.palette), spec.layout);
    const height = plotlyHeightFor(key.width, spec.layout);
    // 🔑 大きさは呼び側(幅)が決める ── 本文の `layout.width` は使わない(器からはみ出す / 鍵が散る)
    const res = await leaseOf()
      .run<{ png: ArrayBuffer; cssWidth: number }>({
        fig: { data: spec.data, layout: { ...layout, autosize: false, width: key.width, height } },
        width: key.width,
        height,
        scale: key.dpr,
      })
      .catch((e: unknown) => {
        // 🔴 箱そのものの失敗(`plotly: …` の前置きが付く)は端末の事情 ── 前置きを外して日本語の理由だけ出す。
        //    英語の起動失敗(`plotly: spawn failed` 等)は `ERROR_JA` が前置きごと日本語にする
        const m = e instanceof Error ? e.message : String(e);
        if (e instanceof DeviceRenderError) throw e;
        if (/^plotly: /.test(m) && /[^\u0020-\u007e]/.test(m)) throw new DeviceRenderError(m.replace(/^plotly: /, ''));
        throw e;
      });
    return { png: new Blob([res.png], { type: 'image/png' }), cssWidth: res.cssWidth };
  });
}

/** plotly の器を埋める種類記述子。⚠ hydrate の本体は mermaid / chart と**同じ 1 本**。保存(SVG)は出さない。 */
export const PLOTLY_KIND: DiagramKind = {
  attr: 'data-pkc-plotly-src',
  name: 'plotly',
  imgField: 'plotly-image',
  alt: (source) => {
    const { spec } = parsePlotlyFence(source);
    return spec ? plotlyAltText(spec) : 'グラフ(読めませんでした)';
  },
  render: async (key) => {
    const { spec, error } = parsePlotlyFence(key.source);
    // ⚠ 読めない理由をそのまま投げる ── hydrate が `…-error` 属性に載せ、原文は器に残る
    if (!spec) throw new Error(`グラフを描けません: ${error ?? '読めませんでした'}`);
    return renderPlotlyToPng(key.source, spec, key);
  },
  note: (source) => {
    const { notes } = parsePlotlyFence(source);
    return notes.length === 0 ? null : notes.join('。');
  },
  savable: false,
};

export function hydratePlotly(
  root: ParentNode | readonly ParentNode[],
  opts?: HydrateOptions,
): MermaidScope {
  return hydrateDiagrams(root, PLOTLY_KIND, opts);
}
