/**
 * PDF の 1 ページ目を **PNG に焼く**(#529 W6。板に置いた PDF の添付ノートの絵)。
 *
 * 🔑 解析(文書の構造・フォント・画像の復号)は **pdf.js の解析ワーカー**が受け持ち、主スレッドは
 *   できた頁を canvas に写して PNG にするだけ ── PDF 用の窓(`public/pdf/reader.js`)と同じ分担で、
 *   主スレッドで PDF を解析しない。pdf.js 本体は **PDF の窓と同じ実体**(`pdf/lib/`、build が
 *   `node_modules/pdfjs-dist` から写す)を使う ── 2 つ目を同梱しない。
 *
 * ## 計算ワーカーの規律(`worker-lease.ts` と同じ 3 つ。2026-08-03 の不可侵指示)
 *
 * `WorkerLease` は「`{id, payload}` を送り `{id, ok, result}` が返る」自前の worker 用で、pdf.js が自分の
 * `port` を握る作りとは噛み合わない。だから**同じ 3 つの規律を、この大きさで**写す:
 * ① **遅延起動** ── 最初の依頼が来るまで pdf.js も解析ワーカーも読まない
 * ② **起動待ちの依頼を溜める** ── 列に並べて 1 件ずつ(落とさない)
 * ③ **アイドルで terminate** ── 待ちも飛んでいるものも 0 のまま `idleMs` 経ったら、解析ワーカーを
 *   `destroy()` して pdf.js の参照も手放す。⚠ 飛んでいる間は殺さない。`dispose()` は待ちを必ず reject する。
 *
 * ⚠ 受け取った bytes は pdf.js へ**移す**(ゼロコピー。呼び側はこの後触らない)。
 * ⚠ 1 件ごとに文書・頁・canvas を**その場で捨てる**(生成物は寿命の終端で破棄 ── 2026-07-27 の不可侵指示)。
 */

/** pdf.js のうち使う口だけの型(実体は実行時に URL から読むので、型は自前で持つ)。 */
export interface PdfJsLib {
  GlobalWorkerOptions: { workerSrc: string };
  PDFWorker: new (opts?: { name?: string }) => { destroy(): void; destroyed: boolean };
  getDocument(src: Record<string, unknown>): {
    promise: Promise<PdfJsDoc>;
    destroy(): Promise<void>;
  };
}
interface PdfJsDoc {
  getPage(n: number): Promise<PdfJsPage>;
}
interface PdfJsPage {
  getViewport(o: { scale: number }): { width: number; height: number };
  render(o: Record<string, unknown>): { promise: Promise<void> };
  cleanup(): void;
}

/** 焼いた絵。 */
export interface PageBake {
  png: Blob;
  /** 画面に置くときの幅(CSS px)。 */
  cssWidth: number;
  /** 画面に置くときの高さ(CSS px)。 */
  cssHeight: number;
}

/** 焼いた絵の 1 辺の上限(画素)。⚠ 巨大な頁(ポスター)で canvas を作れず落ちるのを避ける。 */
export const MAX_SIDE_PX = 4096;

/** pdf.js の実体の置き場(PDF の窓と同じ `pdf/lib/`)。 */
export const PDF_LIB_DIR = 'pdf/lib/';

export interface PageBakerOptions {
  /** pdf.js の読み込み(遅延 ── 最初の依頼まで呼ばれない)。 */
  load(): Promise<{ lib: PdfJsLib; baseUrl: string }>;
  /** 暇になってから畳むまで(ms)。 */
  idleMs?: number;
  /** canvas を作って PNG にする口(test が差し替える)。 */
  makeCanvas?(w: number, h: number): BakeCanvas;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(h: unknown): void;
  /** 1 件の上限(ms)と、その timer(test が差す。⚠ アイドルの timer とは別 ── 数えるものが違う)。 */
  jobTimeoutMs?: number;
  setJobTimer?(fn: () => void, ms: number): unknown;
  clearJobTimer?(h: unknown): void;
}

/** 焼き先。 */
export interface BakeCanvas {
  context: unknown;
  toPng(): Promise<Blob>;
  /** 画素を手放す。 */
  release(): void;
}

interface Job {
  bytes: ArrayBuffer;
  width: number;
  dpr: number;
  resolve(v: PageBake): void;
  reject(e: Error): void;
}

/** 既定の canvas。⚠ 主スレッドの canvas(解析は pdf.js のワーカー側)。 */
function defaultCanvas(w: number, h: number): BakeCanvas {
  if (typeof OffscreenCanvas === 'function') {
    const c = new OffscreenCanvas(w, h);
    const context = c.getContext('2d');
    if (!context) throw new Error('この端末では PDF の絵を作れませんでした');
    return {
      context,
      toPng: () => c.convertToBlob({ type: 'image/png' }),
      release: () => {
        c.width = c.height = 0;
      },
    };
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const context = c.getContext('2d');
  if (!context) throw new Error('この端末では PDF の絵を作れませんでした');
  return {
    context,
    toPng: () =>
      new Promise<Blob>((resolve, reject) => {
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG にできませんでした'))), 'image/png');
      }),
    release: () => {
      c.width = c.height = 0;
    },
  };
}

export class PdfPageBaker {
  private readonly opts: PageBakerOptions;
  private readonly idleMs: number;
  private readonly queue: Job[] = [];
  private running = false;
  private disposed = false;
  private engine: { lib: PdfJsLib; baseUrl: string; worker: { destroy(): void } } | null = null;
  private loading: Promise<NonNullable<PdfPageBaker['engine']>> | null = null;
  private idleTimer: unknown = null;
  /** いま走っている文書の読み込み(`dispose` が止める)。 */
  private current: { destroy(): Promise<void> } | null = null;

  constructor(opts: PageBakerOptions) {
    this.opts = opts;
    this.idleMs = opts.idleMs ?? 30_000;
  }

  /** 解析ワーカーが生きているか(test と計測の観測点)。 */
  get alive(): boolean {
    return this.engine !== null;
  }

  /** 待ち + 飛んでいるものの件数(0 = アイドル)。 */
  get busy(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  bake(bytes: ArrayBuffer, width: number, dpr: number): Promise<PageBake> {
    if (this.disposed) return Promise.reject(new Error('pdf: disposed'));
    this.cancelIdle();
    return new Promise<PageBake>((resolve, reject) => {
      this.queue.push({ bytes, width, dpr, resolve, reject });
      void this.pump();
    });
  }

  /** 畳む。待っている依頼は reject する(`await` を永久に待たせない)。 */
  dispose(): void {
    this.disposed = true;
    for (const j of this.queue.splice(0)) j.reject(new Error('pdf: disposed'));
    void this.current?.destroy().catch(() => undefined);
    this.dropEngine();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.queue.shift(); job !== undefined; job = this.queue.shift()) {
        try {
          job.resolve(await this.bakeOne(job));
        } catch (e) {
          job.reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
    } finally {
      this.running = false;
      this.armIdle();
    }
  }

  private async ensureEngine(): Promise<NonNullable<PdfPageBaker['engine']>> {
    if (this.engine !== null) return this.engine;
    this.loading ??= this.opts
      .load()
      .then(({ lib, baseUrl }) => {
        lib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', baseUrl).href;
        const worker = new lib.PDFWorker({ name: 'pkc3-pdf-page' });
        const eng = { lib, baseUrl, worker };
        if (this.disposed) {
          worker.destroy();
          throw new Error('pdf: disposed');
        }
        this.engine = eng;
        return eng;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  private async bakeOne(job: Job): Promise<PageBake> {
    // 🔴 dispose と起動の競合(`dispose` の後に列から取り出した 1 件が、新しい解析ワーカーを作ってしまう)を止める
    if (this.disposed) throw new Error('pdf: disposed');
    const { lib, baseUrl, worker } = await this.ensureEngine();
    if (this.disposed) throw new Error('pdf: disposed');
    const task = lib.getDocument({
      data: new Uint8Array(job.bytes),
      worker,
      cMapUrl: new URL('cmaps/', baseUrl).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('standard_fonts/', baseUrl).href,
      wasmUrl: new URL('wasm/', baseUrl).href,
      // PDF の中の JavaScript は動かさない(窓と同じ)
      isEvalSupported: false,
      enableScripting: false,
    });
    this.current = task;
    // 🔴 1 件ごとの時間切れ。壊れた PDF で pdf.js が返らないと、列の後ろの依頼が全部止まる。
    //    切れたら文書の読み込みを destroy して(解析側も止まる)この 1 件だけ reject し、列は次へ進む
    const set = this.opts.setJobTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clear = this.opts.clearJobTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    let timer: unknown = null;
    const expired = new Promise<never>((_, reject) => {
      timer = set(() => {
        void task.destroy().catch(() => undefined);
        reject(new Error('PDF の 1 ページ目を描き終わりませんでした'));
      }, this.opts.jobTimeoutMs ?? 60_000);
    });
    const work = this.render(task, job);
    // ⚠ 時間切れの後に work が落ちても未処理の reject にしない
    work.catch(() => undefined);
    try {
      return await Promise.race([work, expired]);
    } finally {
      clear(timer);
    }
  }

  private async render(task: ReturnType<PdfJsLib['getDocument']>, job: Job): Promise<PageBake> {
    let canvas: BakeCanvas | null = null;
    try {
      const doc = await task.promise;
      const page = await doc.getPage(1);
      try {
        const base = page.getViewport({ scale: 1 });
        const want = Math.max(1, job.width) * Math.max(1, job.dpr);
        // 幅に合わせ、1 辺の上限で頭打ち(縦に長い頁でも落ちない)
        const scale = Math.min(want / base.width, MAX_SIDE_PX / base.width, MAX_SIDE_PX / base.height);
        const vp = page.getViewport({ scale });
        const w = Math.max(1, Math.round(vp.width));
        const h = Math.max(1, Math.round(vp.height));
        canvas = (this.opts.makeCanvas ?? defaultCanvas)(w, h);
        await page.render({ canvasContext: canvas.context, viewport: vp, background: '#ffffff' }).promise;
        const png = await canvas.toPng();
        const ratio = w / Math.max(1, job.dpr);
        return { png, cssWidth: Math.round(ratio), cssHeight: Math.round(h / Math.max(1, job.dpr)) };
      } finally {
        page.cleanup();
      }
    } finally {
      // ⚠ 文書・頁・canvas はその場で捨てる(積まない)。解析ワーカーは共有なので task.destroy() では畳まれない
      canvas?.release();
      if (this.current === task) this.current = null;
      await task.destroy().catch(() => undefined);
    }
  }

  private armIdle(): void {
    this.cancelIdle();
    if (this.disposed || this.busy > 0 || this.engine === null) return;
    this.idleTimer = (this.opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => {
      this.idleTimer = null;
      this.dropEngine();
    }, this.idleMs);
  }

  private cancelIdle(): void {
    if (this.idleTimer === null) return;
    (this.opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.idleTimer);
    this.idleTimer = null;
  }

  /** 解析ワーカーを畳み、pdf.js の参照も手放す(次の依頼で作り直す)。 */
  private dropEngine(): void {
    this.cancelIdle();
    const eng = this.engine;
    this.engine = null;
    eng?.worker.destroy();
  }
}
