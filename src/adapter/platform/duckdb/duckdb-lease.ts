/**
 * 🔴 **DuckDB を「使うときだけ」載せる貸し出し**(#682 段①b。user 裁定 2026-09-15)。
 *
 * ## なぜ要るか
 *
 * user 裁定(解釈):**DuckDB を常駐させない。使う瞬間だけ載り、使い終わったら返すこと。**
 * ⚠ 実測(2026-09-14)では、起こして問い合わせると**プロセス木の常駐が +182.5MB** 増える。
 * 置きっぱなしにできる量ではない。
 *
 * ## なぜ `WorkerLease` を使わないか
 *
 * ⚠ `worker-lease.ts` は「**こちらが組んだ封筒を `postMessage` で投げ、返事を待つ**」形の
 * ワーカー用である。DuckDB のワーカーは**上流が持つ独自の口**(`AsyncDuckDB`)で話すので、
 * 封筒の層が噛み合わない。
 * 🔑 だから**方針だけ写して、実体は分ける**(遅延起動 / 起動待ちを溜める / アイドルで畳む /
 * 飛んでいる間は畳まない / 畳むときは待ち手を必ず断る)。
 * ⚠ 既定の `idleMs` は `WorkerLease` と**同じ 30 秒**にしてある ── 揃えないと、
 * 「どちらの規律に従うのか」が読む人に分からなくなる。
 *
 * 🔴 **storage worker(sqlite)には相乗りさせない** ── あちらは DB の錠を握るので
 * 常駐が要る側で、相乗りさせるとこの規律の外に出る。
 */

/** 起こした DuckDB の取っ手。⚠ 実体は adapter が差す(この層は上流を import しない)。 */
export interface DuckDbHandle {
  query(sql: string): Promise<unknown>;
  /** 畳む。⚠ 例外を投げても貸し出しは「畳んだ」ものとして進む(下の理由)。 */
  terminate(): Promise<void>;
}

export interface DuckDbLeaseOptions {
  /** 起こす。⚠ **呼ばれるまで走らない**(これが遅延起動の実体)。 */
  open(): Promise<DuckDbHandle>;
  /**
   * 何もしていない状態がこれだけ続いたら畳む(ms)。既定 30 秒。
   * ⚠ 短すぎると連続して打つたびに起こし直して**かえって重くなる**
   * (起こすのに実測 1.28 秒かかる)。
   */
  idleMs?: number;
  /** タイマー(test が差し替える ── 実時間を待たないため)。 */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

const DEFAULT_IDLE_MS = 30_000;

export class DuckDbLease {
  private handle: DuckDbHandle | null = null;
  private opening: Promise<DuckDbHandle> | null = null;
  private flying = 0;
  private timer: unknown = null;
  private readonly idleMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  constructor(private readonly opts: DuckDbLeaseOptions) {
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** いま起きているか。⚠ **test と計測のための観測点**(製品の分岐には使わない)。 */
  get awake(): boolean {
    return this.handle !== null;
  }

  /**
   * 1 件打つ。起きていなければ起こし、**起こしている間に来た分は溜まる**
   * (`opening` を共有するので、`open` は 1 度しか走らない)。
   */
  async run(sql: string): Promise<unknown> {
    this.cancelIdle();
    this.flying += 1;
    try {
      const h = await this.ensure();
      return await h.query(sql);
    } finally {
      this.flying -= 1;
      // ⚠ **飛んでいる間は畳まない** ── 0 になった回だけ時計を張り直す
      if (this.flying === 0) this.armIdle();
    }
  }

  /**
   * いま畳む。⚠ **飛んでいる問い合わせがある間は畳まない**(黙って何もしない)。
   * 🔑 畳んだ後にまた `run` を呼べば**起こし直す** ── 片道にしない。
   */
  async release(): Promise<void> {
    this.cancelIdle();
    if (this.flying > 0) return;
    const h = this.handle;
    this.handle = null;
    this.opening = null;
    if (h === null) return;
    /**
     * ⚠ 畳む側の例外は**飲む** ── ここで投げると、呼び側は「畳めなかった」と
     * 受け取るが、実際には**もう参照を捨てている**ので起こし直すしかない。
     * 🔑 状態と例外を食い違わせない(§「片道の操作を作らない」の裏面)。
     */
    await h.terminate().catch(() => undefined);
  }

  private ensure(): Promise<DuckDbHandle> {
    if (this.handle !== null) return Promise.resolve(this.handle);
    if (this.opening !== null) return this.opening;
    const p = this.opts
      .open()
      .then((h) => {
        this.handle = h;
        this.opening = null;
        return h;
      })
      .catch((e: unknown) => {
        /**
         * 🔴 **失敗を貼り付けない** ── `opening` を残すと、以後の `run` が
         * **永久に同じ失敗を返す**(電波が戻っても直らない)。捨てて、次で試し直させる。
         */
        this.opening = null;
        throw e;
      });
    this.opening = p;
    return p;
  }

  private armIdle(): void {
    this.cancelIdle();
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.release();
    }, this.idleMs);
  }

  private cancelIdle(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
