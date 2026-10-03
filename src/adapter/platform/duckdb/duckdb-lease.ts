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
  /**
   * 🔴 **差し込んだ file を外す**(#682 段④d)。⚠ **表へ写し終えた file は残さない** ──
   *   `.sqlite` の NDJSON は表と**同じ中身**なので、残すと**同じ物を 2 回持つ**(常駐メモリ)。
   * ⚠ 無い名前を渡しても落ちない。
   */
  drop(name: string): Promise<void>;
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

/**
 * 🔴 **器へ写す所が時間の門に掛かったときの断り**(#682 段④d の着地後レビュー R5)。
 * ⚠ 字を 1 か所で持つ(`DUCKDB_TOO_LONG` と同じ理由)。
 */
export const DUCKDB_LOAD_TOO_LONG =
  '表を DuckDB へ写すのに時間がかかりすぎたので止めました(もう一度押すと、最初から写し直します)';

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
   * 🔴 **器へ写す所(`data.load`)の時間の門(ms)**(#682 段④d の着地後レビュー R5)。
   *
   * ⚠ 直す前は**写す所に時計が無かった**。呼び側が仕事を**直列の列**で通す(`DuckDbRunner.serial`)ので、
   *   写しの途中で止まると**後ろの仕事が全部永久に待つ**(下の `forget(stale)` は、次の仕事が走り出して初めて効く)。
   * ⚠ 超えたら**ワーカーごと畳んで**止める(`maxMs` と同じ ── 上流に中断の口が無い)。畳んだ器は控えから外すので、
   *   次の仕事は**最初から写し直す**。省くと**永久に待つ**形が作れてしまう。
   */
  readonly loadMaxMs?: number;
  /**
   * 打つ前に差し込む相手。⚠ **`key` が同じ間は差し直さない** ── 同じ csv を
   *   打鍵のたびに読み直すと、大きい file で毎回待たされる。
   * 🔑 畳んだら控えも捨てる(起こし直した器には何も入っていない)。
   */
  readonly data?: { readonly key: string; readonly load: (h: DuckDbHandle) => Promise<void> };
  /**
   * 🔴 **この打ち込みが通ったら、器を畳まずに持ち続ける**(#918 段⑧)。
   *
   * ⚠ 書き込み(`CREATE TABLE` / `INSERT` …)で**作った表は器の中にしか無い** ──
   *   しばらく使わないからと畳むと、**user が作った表が黙って消える**
   *   (画面は「ウィンドウを閉じると消えます」と言っているのに、30 秒で消える)。
   * 🔑 だから `hold` が立った回が通った後は**アイドルで畳まない**。畳まれるのは
   *   ①ウィンドウを閉じたとき(プロセスごと)②相手を替えたとき(器を作り直す)
   *   ③時間の門に掛かったとき ④明示の `release()` のどれかだけである。
   * ⚠ 読むだけの回は今までどおり 30 秒で畳む(常駐メモリを返す規律は変えない)。
   */
  readonly hold?: boolean;
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
  /** 🔴 書き込みが通った後は `true`(アイドルで畳まない。⚠ 畳んだら必ず `false` へ戻す)。 */
  private held = false;
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
       * ⚠ **差し込みは打つ字の門(`maxMs`)の内側に置かない** ── 相手を読むのは呼び側の仕事で、
       *   重い写し(100k 行の表を NDJSON にして入れる)を 30 秒の門で切ると**正しく動いている写しを殺す**。
       * 🔴 ただし**時計はもう 1 つ**(`loadMaxMs`。#682 段④d の着地後レビュー)── 呼び側が仕事を**直列の列**で
       *   通すので、写す所に時計が無いと、止まった写しが**後ろの仕事を全部永久に塞ぐ**。
       */
      if (job.data !== undefined && this.loadedKey !== job.data.key) {
        const loading = job.data.load(h);
        // 🔴 写す所にも時計を置く(`loadMaxMs`)── 置かないと、止まった写しが呼び側の列を永久に塞ぐ
        if (job.loadMaxMs === undefined) await loading;
        else await this.race(h, loading, job.loadMaxMs, DUCKDB_LOAD_TOO_LONG);
        // ⚠ **入れ終わってから控える** ── 先に控えると、落ちた回に「入っている」と嘘をつく
        this.loadedKey = job.data.key;
      }
      const answer =
        job.maxMs === undefined ? await h.query(job.sql) : await this.raceQuery(h, job.sql, job.maxMs);
      /**
       * ⚠ **通ってから立てる**(落ちた回は何も作っていない)。
       * ⚠ **取っ手が同じときだけ** ── 時間の門で畳まれた器は `forget` が `held` を下ろしている。
       */
      if (job.hold === true && this.handle === h) this.held = true;
      return answer;
    } finally {
      this.flying -= 1;
      /**
       * ⚠ **飛んでいる間は畳まない** ── 0 になった回だけ時計を張り直す。
       * 🔴 **書き込みで作った物を持っている間は、時計そのものを張らない**(`hold`)。
       */
      if (this.flying === 0 && !this.held) this.armIdle();
    }
  }

  /**
   * 🔴 **時間で切る** ── 上流に中断の口が無いので、**畳むのが唯一の手**である。
   * ⚠ 畳んだ取っ手を**控えから外す**(外さないと、死んだ器へ次の問い合わせが飛ぶ)。
   */
  private raceQuery(h: DuckDbHandle, sql: string, maxMs: number): Promise<DuckDbRaw> {
    return this.race(h, h.query(sql), maxMs, DUCKDB_TOO_LONG);
  }

  /**
   * 🔴 **どんな仕事でも、時計と競わせる**(問い合わせも、器へ写す所も同じ 1 本 ── §7)。
   * ⚠ 時計が先に鳴ったら**器を畳み**(`forget`)、遅れて届いた答えは**捨てる**(`settled`)。
   */
  private race<T>(h: DuckDbHandle, work: Promise<T>, maxMs: number, tooLong: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = this.setTimer(() => {
        if (settled) return;
        settled = true;
        this.forget(h);
        reject(new Error(tooLong));
      }, maxMs);
      work.then(
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
      this.held = false;
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
    this.held = false;
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
