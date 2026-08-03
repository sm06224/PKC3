/**
 * 計算ワーカーの**貸し出し**(P8 段⑨)。
 *
 * > user 指示 2026-08-03(不可侵)「**基本的に重い処理はワーカーにしてください /
 * > ワーカーはしばらくつかわれないなら、キルと解放し、ワーカーへのジョブ発行を
 * > バッファして、ワーカーにディスパッチします**」
 *
 * 3 つの規律が**同時に**要る:
 *
 * 1. **遅延起動** ── 要るまで作らない(初回起動が遅いのは許容だが、
 *    「使わない人にも常駐する」は許容されない)
 * 2. **ジョブのバッファ** ── 起動待ちの間に来た依頼を落とさない。起動してから
 *    まとめてディスパッチする
 * 3. **アイドルで kill と解放** ── 使われなくなったら `terminate()` して
 *    常駐メモリを返す。次に来たら黙って作り直す
 *
 * 🔴 **飛んでいるジョブがある間は kill しない**。アイドル判定は
 * 「**待ちも飛んでいるものも 0**」であって「最後の投函から N ms」ではない
 * ── 後者だけだと、N ms より長い 1 件を殺す。
 * 🔴 **terminate 時は待っている依頼を必ず reject する**。捨てるだけだと
 * `await` が永久に返らず、user から見ると「押したのに何も起きない」になる。
 * ⚠ 受け渡しは **transfer**(ゼロコピー ── 2026-07-27 の不可侵指示と同じ向き)。
 *
 * 🔑 **storage worker(sqlite)はこの機構の対象外**。あちらは DB の lease を
 * 握るので常駐が必要で、殺すと書き込み権を落とす。ここが面倒を見るのは
 * **計算のワーカー**(描画・圧縮・符号化)である。
 */

/** worker から返る 1 件の応答。⚠ 形は利用側が決める(この層は id だけ見る)。 */
export interface LeaseResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface WorkerLeaseOptions {
  /** worker を作る(遅延起動。**呼ばれるまで作らない**)。 */
  spawn(): Worker;
  /**
   * 何もしていない状態がこれだけ続いたら kill する(ms)。
   * ⚠ 短すぎると連続操作のたびに作り直して**かえって重くなる**。既定 30 秒。
   */
  idleMs?: number;
  /** タイマー(test が差し替える ── 実時間を待たないため)。 */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  /** 名前(エラー文に出る ── どのワーカーが落ちたか分からないと直せない)。 */
  name?: string;
}

interface Waiter {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** 起動待ちの間に溜めた 1 件。 */
interface Buffered {
  id: number;
  payload: unknown;
  transfer: Transferable[];
}

export class WorkerLease {
  private readonly opts: Required<Omit<WorkerLeaseOptions, 'name'>> & { name: string };
  private worker: Worker | null = null;
  /** 起動の途中(spawn 済みだが最初の postMessage をまだ流していない)。 */
  private starting = false;
  private nextId = 1;
  private readonly pending = new Map<number, Waiter>();
  /** 🔑 起動待ちに来た依頼(**落とさない**)。 */
  private readonly buffer: Buffered[] = [];
  private idleTimer: unknown = null;
  private disposed = false;

  constructor(options: WorkerLeaseOptions) {
    this.opts = {
      spawn: options.spawn,
      idleMs: options.idleMs ?? 30_000,
      setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
      name: options.name ?? 'worker',
    };
  }

  /** いま worker が生きているか(test と計測の観測点)。 */
  get alive(): boolean {
    return this.worker !== null;
  }

  /** 待ち + 飛んでいるものの件数(0 = アイドル)。 */
  get busy(): number {
    return this.pending.size + this.buffer.length;
  }

  /**
   * 1 件流す。⚠ worker が居なければ**ここで作る**(遅延起動)。
   * @param transfer ゼロコピーで渡すもの(ArrayBuffer 等)。⚠ 渡した側では
   *   使えなくなる ── 呼ぶ側が「もう触らない」ことを保証すること。
   */
  run<T>(payload: unknown, transfer: Transferable[] = []): Promise<T> {
    if (this.disposed) return Promise.reject(new Error(`${this.opts.name}: disposed`));
    const id = this.nextId++;
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
    // アイドル kill の予約は**投函した時点で**畳む(飛んでいる間は殺さない)
    this.cancelIdle();
    if (this.worker && !this.starting) {
      this.worker.postMessage({ id, payload }, transfer);
    } else {
      // 🔑 起動待ち ── **捨てずに溜める**。起動が済んだらまとめて流す
      this.buffer.push({ id, payload, transfer });
      this.start();
    }
    return p;
  }

  /** 明示的に畳む(アプリ終了 / 面の破棄)。待っている依頼は reject する。 */
  dispose(): void {
    this.disposed = true;
    this.kill(new Error(`${this.opts.name}: disposed`));
  }

  private start(): void {
    if (this.worker || this.starting) return;
    this.starting = true;
    let w: Worker;
    try {
      w = this.opts.spawn();
    } catch (e) {
      this.starting = false;
      // 起動そのものが失敗 ── 溜めた分を**必ず**落とす(永久 hang にしない)
      this.failAll(new Error(`${this.opts.name}: spawn failed: ${String(e)}`));
      return;
    }
    this.worker = w;
    w.onmessage = (ev: MessageEvent<LeaseResponse>) => this.onMessage(ev.data);
    w.onerror = (ev: ErrorEvent) => {
      // ⚠ 落ちた worker は**捨てて作り直す** ── 使い回すと以後の依頼が全部死ぬ
      this.dropWorker();
      this.failAll(new Error(`${this.opts.name}: ${ev.message || 'load failed'}`));
    };
    w.onmessageerror = () => {
      this.dropWorker();
      this.failAll(new Error(`${this.opts.name}: message deserialization failed`));
    };
    this.starting = false;
    this.flush();
  }

  /** 溜めた分をまとめて流す。 */
  private flush(): void {
    const w = this.worker;
    if (!w) return;
    for (const job of this.buffer.splice(0)) {
      w.postMessage({ id: job.id, payload: job.payload }, job.transfer);
    }
  }

  private onMessage(res: LeaseResponse): void {
    const waiter = this.pending.get(res.id);
    if (waiter) {
      this.pending.delete(res.id);
      if (res.ok) waiter.resolve(res.result);
      else waiter.reject(new Error(res.error ?? `${this.opts.name}: failed`));
    }
    this.armIdle();
  }

  /**
   * 🔴 アイドルの予約。**待ちも飛んでいるものも 0 のときだけ**張る ──
   * 「最後の投函から N ms」で殺すと、N ms より長い 1 件を殺してしまう。
   *
   * ⚠ **不変条件はこの 2 行で閉じている**:
   *  ① 張るのは `busy === 0` のときだけ(ここ)
   *  ② `run()` は必ず `cancelIdle()` する(= 張ったあとに busy が増えることは無い)
   *
   * かつて発火時にも `busy` を見直していたが、**2 つの規則が互いを救い合って
   * どちらを消しても test が緑**だった(変異試験で判明)── 規則は 1 つに寄せ、
   * 前提のほうを書く。②
   */
  private armIdle(): void {
    this.cancelIdle();
    if (this.disposed || this.busy > 0 || !this.worker) return;
    this.idleTimer = this.opts.setTimer(() => {
      this.idleTimer = null;
      this.dropWorker();
    }, this.opts.idleMs);
  }

  private cancelIdle(): void {
    if (this.idleTimer !== null) {
      this.opts.clearTimer(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** worker だけを畳む(依頼は触らない ── 次の `run` で作り直される)。 */
  private dropWorker(): void {
    const w = this.worker;
    this.worker = null;
    this.starting = false;
    this.cancelIdle();
    if (!w) return;
    w.onmessage = null;
    w.onerror = null;
    w.onmessageerror = null;
    w.terminate();
  }

  private kill(err: Error): void {
    this.dropWorker();
    this.failAll(err);
  }

  /** 待っている依頼を全部落とす(捨てるだけにしない ── 永久 hang の防止)。 */
  private failAll(err: Error): void {
    for (const job of this.buffer.splice(0)) {
      this.pending.get(job.id)?.reject(err);
      this.pending.delete(job.id);
    }
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}
