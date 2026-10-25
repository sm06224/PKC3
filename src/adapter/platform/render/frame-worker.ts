/**
 * **sandbox の箱(iframe)を、`WorkerLease` から見える「ワーカー」にする**(#528 ①)。
 *
 * plotly.js は `document` を要求する(SVG を組んで canvas に写す)ので、`Worker` では動かない。
 * かといって本体の画面で動かすと、本文に書かれた設定(地図のタイル・外部画像・CDN の地形データ)が
 * **外へ要求を出せてしまう**。だから**CSP で外へ出られない sandbox の箱**の中で動かす。
 *
 * 🔑 箱は `postMessage` / `onmessage` / `terminate` で話す点が Worker と同じなので、
 *   **`WorkerLease` をそのまま使う**(遅延起動・起動待ちの依頼の保持・アイドルで terminate・
 *   terminate 時に待ちを reject ── CLAUDE.md §2-5 の機構を 2 つ目に書かない)。
 *   `terminate()` = 箱を DOM から外す = plotly.js のメモリごと手放す。
 *
 * ## 約束(箱の中の台本は呼び側が渡す。ここは箱の持ち方だけ)
 * - 箱 → 親: 準備ができたら `{ ready: true }`。依頼への返事は `{ id, ok, result | error }`(`WorkerLease` の封筒)
 * - 親 → 箱: `{ id, payload }`(`WorkerLease` の封筒)
 *
 * ⚠ **送り主は `event.source === iframe.contentWindow` だけで決める**(`event.origin` は sandbox の箱では
 *   `"null"` で、どの箱も同じ値になる ── `html-sandbox.ts` の同じ規律)。
 * ⚠ **返事が来ない依頼は箱ごと捨てる**(`jobTimeoutMs`)── 箱の中が詰まっても `await` を永久に待たせない。
 */

export interface FrameWorkerOptions {
  /** 箱の中身(HTML 全文)。⚠ 非同期でよい(plotly.js の本体は遅延 import で届く)。 */
  readonly srcdoc: () => Promise<string>;
  /** 箱を置く document。 */
  readonly doc?: Document;
  /** 依頼 1 件の返事を待つ上限(ms)。 */
  readonly jobTimeoutMs?: number;
  /** test が差す timer。 */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (h: unknown) => void;
}

/** `WorkerLease` が触る Worker の面だけを満たす。 */
export class FrameWorker {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;

  private iframe: HTMLIFrameElement | null = null;
  private ready = false;
  private dead = false;
  private readonly queue: Array<{ msg: unknown; transfer: Transferable[] }> = [];
  private readonly watch = new Map<number, unknown>();
  private readonly onWindowMessage: (ev: MessageEvent) => void;
  private readonly opts: FrameWorkerOptions;
  private readonly doc: Document;

  constructor(opts: FrameWorkerOptions) {
    this.opts = opts;
    this.doc = opts.doc ?? document;
    this.onWindowMessage = (ev) => this.receive(ev);
    this.doc.defaultView?.addEventListener('message', this.onWindowMessage);
    opts
      .srcdoc()
      .then((html) => this.mount(html))
      .catch((e: unknown) => this.fail(e instanceof Error ? e.message : String(e)));
  }

  get alive(): boolean {
    return !this.dead;
  }

  postMessage(msg: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void {
    if (this.dead) return;
    const list = Array.isArray(transfer) ? transfer : [];
    if (!this.ready) {
      this.queue.push({ msg, transfer: list });
      return;
    }
    this.send(msg, list);
  }

  terminate(): void {
    this.dead = true;
    this.doc.defaultView?.removeEventListener('message', this.onWindowMessage);
    const timers = this.opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    for (const h of this.watch.values()) timers(h);
    this.watch.clear();
    this.queue.length = 0;
    // 🔑 箱を外す = 箱の中の plotly.js とその heap を手放す
    this.iframe?.remove();
    this.iframe = null;
  }

  private mount(html: string): void {
    if (this.dead) return;
    const f = this.doc.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.setAttribute('aria-hidden', 'true');
    f.tabIndex = -1;
    f.setAttribute('data-pkc-frame-worker', '');
    // 画面に出さない(寸法は箱の中の台本が依頼ごとに決める)
    f.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:900px;border:0;visibility:hidden;pointer-events:none';
    f.srcdoc = html;
    (this.doc.body ?? this.doc.documentElement).append(f);
    this.iframe = f;
  }

  private send(msg: unknown, transfer: Transferable[]): void {
    const w = this.iframe?.contentWindow;
    if (!w) return;
    const id = (msg as { id?: unknown } | null)?.id;
    if (typeof id === 'number') {
      const ms = this.opts.jobTimeoutMs ?? 45_000;
      const set = this.opts.setTimer ?? ((fn, t) => setTimeout(fn, t));
      this.watch.set(
        id,
        set(() => {
          this.watch.delete(id);
          this.fail('描画用の枠の中で描き終わりませんでした');
        }, ms),
      );
    }
    try {
      w.postMessage(msg, '*', transfer);
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  private receive(ev: MessageEvent): void {
    if (this.dead || this.iframe === null || ev.source !== this.iframe.contentWindow) return;
    const d = ev.data as { ready?: unknown; id?: unknown } | null;
    if (d === null || typeof d !== 'object') return;
    if (d.ready === true) {
      if (this.ready) return;
      this.ready = true;
      for (const q of this.queue.splice(0)) this.send(q.msg, q.transfer);
      return;
    }
    if (typeof d.id === 'number') {
      const h = this.watch.get(d.id);
      if (h !== undefined) {
        (this.opts.clearTimer ?? ((x) => clearTimeout(x as ReturnType<typeof setTimeout>)))(h);
        this.watch.delete(d.id);
      }
      this.onmessage?.({ data: d } as MessageEvent);
    }
  }

  /** 箱が使えなくなった。`WorkerLease` は onerror を受けて箱を捨て、待ちを全部 reject する。 */
  private fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}
