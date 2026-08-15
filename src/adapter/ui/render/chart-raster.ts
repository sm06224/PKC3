/**
 * chart を **PNG に焼く**(#188)── 主スレッドから見た口。
 *
 * 🔑 実際に描くのは**ワーカー**(`platform/render/chart-worker.ts`)。
 * chart.js は canvas に描くので `OffscreenCanvas` で丸ごと外へ出せる ──
 * mermaid(DOM を要求する)と違い、主スレッドを 1 度も止めない。
 *
 * ⚠ 貯める所は mermaid と**同じ 1 つ**(`renderCachedPng`)── 上限も追い出しも
 * 1 か所にしか置かない。
 * ⚠ ワーカーは `WorkerLease` 越し ── 遅延起動 / バッファ / アイドルで kill
 * (2026-08-03 の不可侵指示)。
 * ⚠ 受け取るのは ArrayBuffer(transfer)で、Blob はここで作る。
 */
import { WorkerLease } from '@adapter/platform/worker-lease';
import { MAX_DATASETS, chartAltText, parseChartFence, type ChartSpec } from '@features/markdown/chart-fence';
import { renderCachedPng, type DiagramPalette, type Raster, type RasterKey } from './mermaid-raster';
import { hydrateDiagrams, type DiagramKind, type MermaidScope } from './mermaid-hydrate';

/** グラフの高さ(CSS px)。⚠ 幅から決める ── 本文に高さを書かせない。 */
export function chartHeightFor(width: number): number {
  // 16:9 に近い比。⚠ 上下限を置く(細長い / 画面を覆う、をどちらも避ける)
  return Math.max(160, Math.min(520, Math.round(width * 0.56)));
}

/**
 * 系列の色。⚠ **テーマから引く**(本文に色を書かせない = 配色を変えたら図も変わる)。
 * 🔑 mermaid が `DiagramPalette` を CSS 変数から作っているので、それを使い回す。
 */
export function seriesColors(p: DiagramPalette): string[] {
  /**
   * 🔴 **系列の数だけ見分けられる色**(#188 のレビューで判明)。
   * ⚠ 初稿は 5 色(うち 3 色は文字・線・枠の**無彩色**)を返していた ──
   *   6 系列目から一巡し、しかも PNG なので tooltip も無く、
   *   **色以外の手がかりがゼロ**になる。上限は 12 系列(`MAX_DATASETS`)。
   * 🔑 地の色相(`--accent`)から**色相環を等分**して作る ── テーマを足しても
   *   対応表を書き足さずに済む(mermaid の配色が CSS 変数から引いているのと同じ向き)。
   * ⚠ 「地は無彩色、色は情報にだけ使う」(user 指示)── 色を使うのはここ、
   *   すなわち**情報の側**である。
   */
  const base = hueOf(p.accent);
  const light = p.dark ? 62 : 42;
  return Array.from({ length: MAX_DATASETS }, (_, i) => {
    const hue = (base + (360 / MAX_DATASETS) * i) % 360;
    // ⚠ 奇数番は明度を振る(色相だけだと隣り合う 2 色が近い)
    return `hsl(${Math.round(hue)} 62% ${i % 2 === 0 ? light : light + 16}%)`;
  });
}

/** 色から色相を読む。⚠ 読めない書き方なら 210 度(青)に落ちる ── 図が消えるよりよい。 */
export function hueOf(color: string): number {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  let r: number;
  let g: number;
  let b: number;
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join('') : hex[1]!;
    r = parseInt(h.slice(0, 2), 16) / 255;
    g = parseInt(h.slice(2, 4), 16) / 255;
    b = parseInt(h.slice(4, 6), 16) / 255;
  } else {
    const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color);
    if (!m) {
      const hsl = /hsla?\(\s*([\d.]+)/i.exec(color);
      return hsl ? Number(hsl[1]) % 360 : 210;
    }
    r = Number(m[1]) / 255;
    g = Number(m[2]) / 255;
    b = Number(m[3]) / 255;
  }
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 210; // 無彩色 ── 色相が無いので既定へ
  const d = max - min;
  const h =
    max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return ((h * 60) % 360 + 360) % 360;
}

let lease: WorkerLease | null = null;
/** test / 計測が差し替える口(既定は本物のワーカー)。 */
let spawn: (() => Worker) | null = null;

export function setChartWorkerSpawn(fn: (() => Worker) | null): void {
  lease?.dispose();
  lease = null;
  spawn = fn;
}

function leaseOf(): WorkerLease {
  lease ??= new WorkerLease({
    name: 'chart',
    spawn:
      spawn ??
      (() => new Worker(new URL('../../platform/render/chart-worker.ts', import.meta.url), { type: 'module' })),
  });
  return lease;
}

/**
 * 1 枚焼く(キャッシュがあればそれ)。
 * @param source 本文に書かれた原文(鍵になる ── これが変われば焼き直す)
 */
export async function renderChartToPng(
  source: string,
  spec: ChartSpec,
  key: Omit<RasterKey, 'source'>,
): Promise<Raster> {
  const full: RasterKey = { ...key, source, kind: 'chart' };
  return renderCachedPng(full, async () => {
    const height = chartHeightFor(key.width);
    const res = await leaseOf().run<{ png: ArrayBuffer; cssWidth: number }>({
      spec,
      width: key.width,
      height,
      dpr: key.dpr,
      palette: {
        text: key.palette.fg,
        grid: key.palette.border,
        bg: key.palette.bg,
        series: seriesColors(key.palette),
      },
    });
    return { png: new Blob([res.png], { type: 'image/png' }), cssWidth: res.cssWidth };
  });
}

/**
 * chart の器を埋める種類記述子(#188)。⚠ hydrate の本体は mermaid と**同じ 1 本**。
 * ⚠ 保存(SVG)は出さない ── chart.js はベクタを吐かないので、出すと
 *   押しても何も起きない導線になる。
 */
export const CHART_KIND: DiagramKind = {
  attr: 'data-pkc-chart-src',
  name: 'chart',
  imgField: 'chart-image',
  alt: (source) => {
    const { spec } = parseChartFence(source);
    return spec ? chartAltText(spec) : 'グラフ(読めませんでした)';
  },
  render: async (key) => {
    const { spec, error } = parseChartFence(key.source);
    // ⚠ **読めない理由をそのまま投げる** ── hydrate が `…-error` 属性に載せ、
    //   原文は器に残る(黙って空の枠を出さない)
    if (!spec) throw new Error(error ?? 'グラフを読めませんでした');
    return renderChartToPng(key.source, spec, key);
  },
  savable: false,
};

export function hydrateChart(root: ParentNode | readonly ParentNode[]): MermaidScope {
  return hydrateDiagrams(root, CHART_KIND);
}
