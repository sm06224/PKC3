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
  /**
   * file を器へ差し込む。⚠ 同じ名前は入れ替える。
   * 🔑 **bytes を渡すのはここだけ** ── 打つ字(`query`)に中身を混ぜない
   *   (混ぜると、大きい csv が SQL の字として組み立てられる)。
   */
  put(name: string, bytes: Uint8Array): Promise<void>;
  query(sql: string): Promise<DuckDbRaw>;
  /** 畳む。⚠ 例外を投げても貸し出しは「畳んだ」ものとして進む(下の理由)。 */
  terminate(): Promise<void>;
}

import type { DuckDbRaw } from '@features/query/duckdb-rows';

/**
 * 🔴 **時間の門に掛かったときの断り**(#682 段②)。
 * ⚠ **字を 1 か所で持つ** ── 呼び側が「時間切れか」を字で見分けるので、
 *   2 か所に書くと、片方を直した日に見分けが静かに壊れる(§7)。
 */
export const DUCKDB_TOO_LONG = '時間がかかりすぎたので止めました(条件を絞ってください)';

/** 1 件の依頼。 */
export interface DuckDbJob {
  readonly sql: string;
  /**
   * 🔴 **時間の門(ms)**。⚠ 超えたら**ワーカーごと畳んで**止める ──
   *   sqlite と違い、上流には**問い合わせを中断する口が無い**。
   * ⚠ だから同時に飛んでいる別の問い合わせも道連れになる(面は 1 度に 1 本しか
   *   走らせないので、いまは起きない)。省くと**永久に待つ**形が作れてしまう。
   */
  readonly maxMs?: number;
  /**
   * 打つ前に差し込む相手。⚠ **`key` が同じ間は差し直さない** ── 同じ csv を
   *   打鍵のたびに読み直すと、大きい file で毎回待たされる。
   * 🔑 畳んだら控えも捨てる(起こし直した器には何も入っていない)。
   */
  readonly data?: { readonly key: string; readonly load: (h: DuckDbHandle) => Promise<void> };
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
  /** いま差し込んである相手(`null` = 何も入っていない)。 */
  private loadedKey: string | null = null;
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
  async run(job: DuckDbJob): Promise<DuckDbRaw> {
    this.cancelIdle();
    this.flying += 1;
    try {
      /**
       * 🔴 **相手が変わったら器ごと作り直す**(#682 段②)。
       *
       * ⚠ 差し込んだ後に**外への口を engine ごと塞ぐ**設計なので(`duckdb-runner.ts`)、
       *   同じ器へ 2 件目を差し込むことは**できない**(塞いだ後は file を読めない)。
       * 🔑 実測(2026-09-15):一度塞ぐと同じ DB では二度と開けられない ──
       *   「Cannot enable external access while database is running」。
       *   つまり**作り直すのが唯一の道**である。
       * ⚠ ここは既に `flying` を 1 つ数えた後なので `release()` は早期 return する ──
       *   だから控えを直に捨てる `forget` を使う。
       */
      const stale = this.handle;
      if (job.data !== undefined && stale !== null && this.loadedKey !== null && this.loadedKey !== job.data.key) {
        this.forget(stale);
      }
      const h = await this.ensure();
      /**
       * ⚠ **差し込みも時間の門の内側に置かない** ── 相手を読むのは呼び側の仕事で、
       *   ここでやるのは器へ入れることだけ。入れる所で止まる形は作らない。
       */
      if (job.data !== undefined && this.loadedKey !== job.data.key) {
        await job.data.load(h);
        // ⚠ **入れ終わってから控える** ── 先に控えると、落ちた回に「入っている」と嘘をつく
        this.loadedKey = job.data.key;
      }
      return job.maxMs === undefined ? await h.query(job.sql) : await this.raceQuery(h, job.sql, job.maxMs);
    } finally {
      this.flying -= 1;
      // ⚠ **飛んでいる間は畳まない** ── 0 になった回だけ時計を張り直す
      if (this.flying === 0) this.armIdle();
    }
  }

  /**
   * 🔴 **時間で切る** ── 上流に中断の口が無いので、**畳むのが唯一の手**である。
   * ⚠ 畳んだ取っ手を**控えから外す**(外さないと、死んだ器へ次の問い合わせが飛ぶ)。
   */
  private raceQuery(h: DuckDbHandle, sql: string, maxMs: number): Promise<DuckDbRaw> {
    return new Promise<DuckDbRaw>((resolve, reject) => {
      let settled = false;
      const timer = this.setTimer(() => {
        if (settled) return;
        settled = true;
        this.forget(h);
        reject(new Error(DUCKDB_TOO_LONG));
      }, maxMs);
      h.query(sql).then(
        (v) => {
          if (settled) return;
          settled = true;
          this.clearTimer(timer);
          resolve(v);
        },
        (e: unknown) => {
          if (settled) return;
          settled = true;
          this.clearTimer(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  /**
   * その取っ手を捨てる。⚠ **いま持っている物と同じときだけ**控えを消す ──
   *   既に起こし直した後なら、新しいほうを巻き添えにしない。
   */
  private forget(h: DuckDbHandle): void {
    if (this.handle === h) {
      this.handle = null;
      this.opening = null;
      this.loadedKey = null;
    }
    void h.terminate().catch(() => undefined);
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
    // ⚠ 畳んだら**差し込んだ物も消える** ── 起こし直した器は空である
    this.loadedKey = null;
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
