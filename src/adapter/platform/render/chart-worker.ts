/// <reference lib="webworker" />
/**
 * chart を **PNG に焼く**ワーカー(#188)。
 *
 * > user 指示 2026-08-03(不可侵)「基本的に重い処理はワーカーにしてください」
 * > user 指示 2026-08-03(不可侵)「PNG ラスタをキャッシュして、GPU レンダリングで表示」
 *
 * 🔑 chart.js は **canvas に描く**(mermaid のように SVG を吐かない)ので、
 * `OffscreenCanvas` を使えば**丸ごとワーカーへ逃がせる** ── mermaid が
 * 「DOM を要求するから逃がせない」のと違い、こちらは主スレッドを 1 度も止めない。
 *
 * ⚠ **chart.js は遅延 import**(要るまで読まない)。ワーカー自体も
 *   `WorkerLease` が要るまで作らず、暇になれば殺す。
 * ⚠ 返すのは **PNG の bytes(ArrayBuffer)を transfer** ── ゼロコピー
 *   (2026-07-27 の不可侵指示)。Blob を作るのは受け取った側の仕事。
 */
import type { ChartSpec } from '@features/markdown/chart-fence';

export interface ChartJobRequest {
  id: number;
  spec: ChartSpec;
  /** CSS px の幅。 */
  width: number;
  /** CSS px の高さ。 */
  height: number;
  /** devicePixelRatio(焼くのはこの倍率)。 */
  dpr: number;
  /** テーマ由来の色(本文に色を書かせないので、こちらが渡す)。 */
  palette: { text: string; grid: string; series: readonly string[]; bg: string };
}

interface ChartJobResponse {
  id: number;
  ok: boolean;
  result?: { png: ArrayBuffer; cssWidth: number };
  error?: string;
}

/**
 * chart.js の設定を**ここで組む**。⚠ 本文から来るのは `ChartSpec`(検め済み)
 * だけで、**chart.js の option をそのまま受けない**(関数の入る余地を作らない)。
 */
function buildConfig(req: ChartJobRequest): Record<string, unknown> {
  const { spec, palette } = req;
  const color = (i: number, given?: string): string =>
    given ?? palette.series[i % palette.series.length] ?? palette.text;
  const datasets = spec.datasets.map((d, i) => ({
    label: d.label,
    data: [...d.data],
    borderColor: color(i, d.color),
    backgroundColor: color(i, d.color),
    // ⚠ 欠測は線を切る(0 に落として谷を作らない)
    spanGaps: false,
    borderWidth: 2,
    pointRadius: spec.type === 'line' ? 2 : 0,
  }));
  const axisType = spec.type === 'pie' || spec.type === 'doughnut' || spec.type === 'radar';
  return {
    type: spec.type,
    data: { labels: [...spec.labels], datasets },
    options: {
      responsive: false,
      animation: false,
      devicePixelRatio: 1, // ⚠ 倍率は canvas の実寸で持つ(二重に掛けない)
      plugins: {
        legend: {
          display: spec.legend ?? spec.datasets.length > 1,
          labels: { color: palette.text },
        },
        title: spec.title
          ? { display: true, text: spec.title, color: palette.text }
          : { display: false },
      },
      ...(axisType
        ? {}
        : {
            scales: {
              x: {
                stacked: spec.stacked === true,
                ticks: { color: palette.text },
                grid: { color: palette.grid },
              },
              y: {
                stacked: spec.stacked === true,
                ticks: { color: palette.text },
                grid: { color: palette.grid },
              },
            },
          }),
    },
  };
}

/** chart.js を 1 度だけ読む(遅延 import + 使い回し)。 */
let chartMod: Promise<typeof import('chart.js/auto')> | null = null;
function loadChart(): Promise<typeof import('chart.js/auto')> {
  chartMod ??= import('chart.js/auto');
  return chartMod;
}

export async function renderChartPng(
  req: ChartJobRequest,
): Promise<{ png: ArrayBuffer; cssWidth: number }> {
  const { default: Chart } = await loadChart();
  const w = Math.max(1, Math.round(req.width * req.dpr));
  const h = Math.max(1, Math.round(req.height * req.dpr));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context を取れませんでした');
  // ⚠ 背景を塗る ── 透過のまま PNG にすると、ダークな配色で黒地に黒線になる
  ctx.fillStyle = req.palette.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.scale(req.dpr, req.dpr);
  const chart = new Chart(ctx as unknown as CanvasRenderingContext2D, buildConfig(req) as never);
  try {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { png: await blob.arrayBuffer(), cssWidth: req.width };
  } finally {
    // ⚠ **生成物はその場で捨てる**(不可侵指示: ライフサイクル終端で即破棄)。
    //    chart は canvas と listener を握るので、destroy しないと積もる
    chart.destroy();
  }
}

// ── worker の口 ────────────────────────────────────────────────
// ⚠ `self.onmessage` に**代入**する(`addEventListener` にしない)── この repo の
//   worker の test はこの形を前提に実物を dynamic import している。
const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage: (msg: ChartJobResponse, transfer?: Transferable[]) => void;
};

ctx.onmessage = (ev: MessageEvent): void => {
  /**
   * 🔴 **封筒を開ける**(2026-08-29 に判明。それまで grafu は 1 度も描けていなかった)。
   *
   * ⚠ `WorkerLease` は依頼を **`{ id, payload }` に包んで**投げる
   *   (`worker-lease.ts:135` / `:184`)。ここは 1 稿目それを開けずに
   *   `ev.data` を丸ごと依頼として読んでいたので、`req.width` は **undefined** ──
   *   `undefined * dpr` = **NaN** → `new OffscreenCanvas(NaN, …)` が投げ、
   *   器は `data-pkc-chart-state="failed"` のまま**画面に何も出なかった**。
   * 🔴 **`id` だけは偶然通っていた**(封筒の最上位に在るので)── だから
   *   「返事は返るのに中身が無い」という、いちばん見分けにくい形になっていた。
   * 🔑 同じ lease を使う `markdown-worker.ts:45` は `const { id, payload } = ev.data;`
   *   と正しく開けている ── **綴りを合わせる**。
   * ⚠ 両端の unit がそれぞれ「相手を模した stub」と話していたので、
   *   **どちらも緑のまま**この食い違いが残った(CLAUDE.md §7)。
   */
  const { id, payload } = ev.data as { id: number; payload: ChartJobRequest };
  renderChartPng(payload)
    .then((result) => {
      ctx.postMessage({ id, ok: true, result }, [result.png]);
    })
    .catch((e: unknown) => {
      ctx.postMessage({ id, ok: false, error: String(e).slice(0, 200) });
    });
};
