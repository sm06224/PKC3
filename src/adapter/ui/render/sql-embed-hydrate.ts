/**
 * 🔴 **本文に埋め込んだ SQL(` ```sql embed `)の答えを、見えたときに引いて表にする**(#1223)。
 *
 * `renderMarkdown` は**コード枠 + 空の器**(`sqlEmbedHostHtml`)しか出さない(features 層は
 * 引かない)。ここがその器を見つけて、引いて、表を入れる ── mermaid / chart / 数式と同じ骨組み
 * である(`mermaid-hydrate.ts` / `math-hydrate.ts`)。
 *
 * ## 決まっていること(Gemini 裁定 2026-10-01、issue #1223)
 *
 * - **鮮度 = 本文を開いたとき 1 回引き、同じ本文のうちは同じ答え。編集して保存すると引き直す**
 *   (Q2 = B)。⚠ だから**答えの鮮度を決める鍵は「本文」**(`sync` の `epoch`)で、
 *   同じ本文の中で何度描き直しても(別のブロックを編集しても)再び引かない。
 * - **相手はこの PKC のノート(sqlite)だけ・読むだけ**。字の門(`checkReadOnlySql`)と
 *   `PRAGMA query_only`(worker)の両方を通る ── SQL を打つ面と**同じ口**。
 * - **閲覧用の上限は別建てで小さく**(`SQL_EMBED_*`)。
 *
 * ## ⚠ 保存を待たせない
 *
 * `runReadOnlySql` は**保存と同じ worker・同じ接続**で走る。①**直列**(同時に走るのは全体で
 * 1 件 ── 本文が何枚あっても、枠が何個並んでいても)②**見えたときだけ**引く ③**時間と歩数は
 * 小さく**(2 秒 / 2 万歩)④**走らせる前に、書込の後ろへ並ぶ**(`main.ts` が `settled()` を
 * 挟む。保存した直後に引いて古い表を出さないため)。
 *
 * ## ⚠ 寿命
 *
 * 答えは**本文を描いている間だけ**持つ(不可侵指示 2026-07-27「ライフサイクル終端での即破棄」)。
 * `release()` で観測器・答えの控え・待ちを全部手放す(別のノートへ移る / 編集を抜けるとき)。
 */
import { checkReadOnlySql, sqlRunFailureText } from '@features/query/sql-guard';
import {
  SQL_EMBED_ATTR,
  SQL_EMBED_FETCH_ROWS,
  SQL_EMBED_MAX_MS,
  SQL_EMBED_MAX_STEPS,
  SQL_EMBED_MORE_FIELD,
  SQL_EMBED_PAGE_ROWS,
  SQL_EMBED_SAVED_FIELD,
  SQL_EMBED_SAVED_TEXT,
  SQL_EMBED_SRC_ATTR,
  sqlEmbedAnswerHtml,
  sqlEmbedFailureHtml,
  sqlEmbedPendingHtml,
  type SqlEmbedAnswer,
} from '@features/markdown/sql-embed';
import { copyButtonHtml } from '@features/markdown/markdown-render';
import { watchVisible, type VisibleWatch } from './visible-watch';

/** 引く口(`runReadOnlySql` と同じ形)。⚠ `guest` は無い ── 相手はこの PKC だけ。 */
export type SqlEmbedRunner = (
  sql: string,
  limits: { maxRows: number; maxSteps: number; maxMs: number },
) => Promise<{
  columns: string[];
  rows: Array<Array<string | number | null>>;
  truncated: boolean;
  ms: number;
}>;

let runner: SqlEmbedRunner | null = null;

/**
 * 引く口を差す(`main.ts` が 1 度、test が自分の物を)。
 * ⚠ 差さなければ「この版では引けません」の 1 行が出る(黙って空にしない)。
 */
export function setSqlEmbedRunner(fn: SqlEmbedRunner | null): void {
  runner = fn;
}

/** 走る前に止められた(別のノートへ移った等)。⚠ 画面には出さない。 */
export class SqlEmbedCancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

/**
 * 🔴 **直列の列**。⚠ 全体で 1 本 ── 前の 1 件が終わってから次を走らせる。
 * 列は**落ちない**(失敗は呼び側へ返し、列そのものは次へ進む)。
 */
let chain: Promise<unknown> = Promise.resolve();

/**
 * 答えを 1 件引く。⚠ **ここが閲覧用の唯一の入口**(画面の埋め込みも、書き出しの焼き込みも)。
 *
 * @param alive 走らせる**直前**に問う。`false` なら引かずに {@link SqlEmbedCancelled}
 * @throws Error 画面に出せる字(字の門の断り / engine の失敗)
 */
export function askSqlEmbed(src: string, alive: () => boolean = () => true): Promise<SqlEmbedAnswer> {
  const job = async (): Promise<SqlEmbedAnswer> => {
    if (!alive()) throw new SqlEmbedCancelled();
    // ⚠ 断り文は SQL を打つ面と同じ(`checkReadOnlySql` の `why`)
    const check = checkReadOnlySql(src);
    if (!check.ok) throw new Error(check.why);
    const run = runner;
    if (run === null) throw new Error('このタブの PKC3 が古いままのため、SQL を実行できません。再読み込みしてください');
    try {
      // ⚠ 打つのは**全角を直した後の字**(`check.sql`)── 元の字を渡さない
      const r = await run(check.sql, {
        maxRows: SQL_EMBED_FETCH_ROWS,
        maxSteps: SQL_EMBED_MAX_STEPS,
        maxMs: SQL_EMBED_MAX_MS,
      });
      return { columns: r.columns, rows: r.rows, truncated: r.truncated };
    } catch (e) {
      throw new Error(sqlRunFailureText(e instanceof Error ? e.message : String(e)), { cause: e });
    }
  };
  const p = chain.then(job);
  chain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

/**
 * 1 つの面(本文の器)が持つ、埋め込みの面倒を見る係。
 *
 * ⚠ **面ごとに 1 つ**(`DetailRenderer` が 1 つ持つ)。観測器もその中で 1 つ ──
 * `sync` のたびに作らない(`mermaid-hydrate.ts` が 121 個作った失敗の再演を避ける)。
 */
export class SqlEmbedHydrator {
  /** いまの鍵(本文)。⚠ `null` = まだ何も描いていない / 手放した後。 */
  private epoch: string | null = null;
  /** 鍵が変わる / 手放すたびに進む。⚠ 古い世代の答えは画面に当てない。 */
  private gen = 0;
  /** SQL の字 → 答え。⚠ **鍵が変わったら捨てる**(同じ本文のうちだけ再利用する)。 */
  private readonly cache = new Map<string, Promise<SqlEmbedAnswer>>();
  private watch: VisibleWatch | null = null;
  private readonly watching = new Set<HTMLElement>();
  /** 器 → どの鍵で予約したか。⚠ 同じ鍵で予約済みの器は触らない。 */
  private readonly scheduled = new WeakMap<HTMLElement, string>();
  private readonly answers = new WeakMap<HTMLElement, SqlEmbedAnswer>();
  private readonly shown = new WeakMap<HTMLElement, number>();
  private readonly bound = new WeakSet<HTMLElement>();
  /** 🔴 答えに「保存したときの答え」を添える器(2 列の下見。#1254 §1)。⚠ `sync` のたびに根ごと決まる。 */
  private readonly savedNote = new WeakSet<HTMLElement>();
  /** 器 → 「引いています」の 1 行を書いた世代。⚠ 手放した後も居座らせないための印。 */
  private readonly pendingLine = new WeakMap<HTMLElement, number>();

  /**
   * `root` の中の器を面倒みる。**描くたびに呼んでよい**(冪等)。
   *
   * @param epoch 答えの鮮度を決める鍵。⚠ **本文そのもの**を渡す(同じ本文のうちは同じ答え、
   *   変われば引き直す)。別の本文と衝突させない。
   * @param savedNote 🔴 答えに「保存したときの答え」を添える(2 列の下見だけが立てる。#1254 §1)。
   *   ⚠ 下見の鍵は**編集に入った時点の保存済みの本文**なので、打っている最中の SQL の答えではない。
   */
  sync(root: Element, epoch: string, savedNote = false): void {
    if (epoch !== this.epoch) {
      this.epoch = epoch;
      this.gen += 1;
      this.cache.clear();
    }
    // ⚠ 差し替えで根の外へ出た器の観測は外す(観測器に死んだ節点を持たせ続けない)
    for (const h of [...this.watching]) {
      if (root.contains(h)) continue;
      this.watch?.unobserve(h);
      this.watching.delete(h);
    }
    for (const host of root.querySelectorAll<HTMLElement>(`[${SQL_EMBED_ATTR}]`)) {
      // ⚠ 予約済みでも毎回決める(器はどちらか 1 つの根にしか居ない ── 面ごとに答えが変わる)
      if (savedNote) this.savedNote.add(host);
      else this.savedNote.delete(host);
      if (this.scheduled.get(host) === epoch) continue;
      this.scheduled.set(host, epoch);
      this.observe(host);
    }
  }

  /** 全部手放す(観測・答え・待ち)。⚠ 手放した後も `sync` で再び使える。 */
  release(): void {
    this.watch?.disconnect();
    this.watch = null;
    this.watching.clear();
    this.cache.clear();
    this.epoch = null;
    this.gen += 1;
  }

  private observe(host: HTMLElement): void {
    // ⚠ 観測器の無い環境(古い端末)では**見えるのを待たず**引く(出ないよりよい)
    if (typeof IntersectionObserver !== 'function') {
      this.go(host);
      return;
    }
    this.watch ??= watchVisible((h) => {
      this.watching.delete(h);
      this.go(h);
    });
    this.watching.add(host);
    this.watch.observe(host);
  }

  private go(host: HTMLElement): void {
    if (this.epoch === null) return;
    const at = this.gen;
    const stale = (): boolean => at !== this.gen;
    const sql = host.getAttribute(SQL_EMBED_SRC_ATTR) ?? '';
    let answer = this.cache.get(sql);
    if (answer === undefined) {
      answer = askSqlEmbed(sql, () => !stale());
      this.cache.set(sql, answer);
    }
    host.setAttribute('data-pkc-sql-embed-state', 'pending');
    /**
     * 🔴 **引いている間は 1 行出す**(#1254 §1)。⚠ **器が空のときだけ** ── 前の答えの表が
     * 残っている器(同じ器を引き直すとき)は、新しい答えが来るまでその表を見せたままにする
     * (一瞬 1 行に縮めると、下の本文が上下に揺れる)。
     */
    if (this.pendingLine.has(host) || !host.hasChildNodes()) {
      host.innerHTML = sqlEmbedPendingHtml();
      this.pendingLine.set(host, at);
    }
    /** 手放した / 世代が変わったとき、**自分が書いた**「引いています」だけを消す(嘘にしない)。 */
    const dropPending = (): void => {
      if (this.pendingLine.get(host) !== at) return;
      this.pendingLine.delete(host);
      host.textContent = '';
    };
    answer.then(
      (a) => {
        if (stale()) {
          dropPending();
          return;
        }
        this.answers.set(host, a);
        this.shown.set(host, SQL_EMBED_PAGE_ROWS);
        this.bind(host);
        this.draw(host);
      },
      (e: unknown) => {
        if (stale() || e instanceof SqlEmbedCancelled) {
          dropPending();
          return;
        }
        this.pendingLine.delete(host);
        host.innerHTML = sqlEmbedFailureHtml(e instanceof Error ? e.message : String(e));
        host.setAttribute('data-pkc-sql-embed-state', 'failed');
      },
    );
  }

  private draw(host: HTMLElement): void {
    const a = this.answers.get(host);
    if (a === undefined) return;
    this.pendingLine.delete(host);
    host.innerHTML = sqlEmbedAnswerHtml(a, this.shown.get(host) ?? SQL_EMBED_PAGE_ROWS, true);
    if (this.savedNote.has(host)) {
      const note = host.ownerDocument.createElement('p');
      note.setAttribute('data-pkc-field', SQL_EMBED_SAVED_FIELD);
      note.textContent = SQL_EMBED_SAVED_TEXT;
      host.append(note);
    }
    host.setAttribute('data-pkc-sql-embed-state', 'ready');
    /**
     * ⚠ **列の並べ替えは付けない** ── `applyTableSort` は描くたびに本文の表へ付けるが、
     *   ここは「さらに N 行」で行を足すので、並べ替えると**足した行の位置が食い違う**。
     *   付与済みの印を先に置いておけば、あちらは触らない(冪等の門が読む印)。
     */
    const table = host.querySelector('table');
    table?.setAttribute('data-pkc-table-sort-ready', 'true');
    /**
     * 🔴 **答えの表にも、本文の表と同じ ⧉(コピー)を付ける**(#1254 §3 改善 E。Gemini 裁定 = a)。
     *
     * > user の物語:本文の表は右上の ⧉ で表計算に貼れる。**SQL の答えの表だけ**は ⧉ が無く、
     * > 選択して貼るしかなかった。
     *
     * ⚠ **別の実装を作らない** ── 器は本文の表と同じ(`.pkc-md-block` + `kind="table"` + 同じ
     *   `copyButtonHtml`)で、押した結果は `copy-md-block` の 1 本(読むのは `readTableRows`、
     *   並べ替えの矢印を字に混ぜない #1150 の直しもそこに在る)。
     * ⚠ **コピーされるのは、いま画面に出ている行**(`shown` ぶんだけ描いた表をそのまま読む。
     *   「さらに N 行」を押す前は 200 行まで)。**表だけを包む** ── 「さらに N 行」・注記・
     *   「保存したときの答え」・「答えを引いています…」は器の外なので、コピーに混ざらない。
     * ⚠ **▾(形を選ぶ口)は付けない** ── あれは本文の表を書き換える口を含み、答えの表には
     *   書き換える本文が無い。⚠ 並べ替えも付けない(上の註記)。
     * ⚠ 書き出し(`bakeSqlEmbeds`)は ⧉ を持たない(閲覧側に受け手が居ない)── 画面の器だけ。
     */
    if (table !== null) {
      const block = host.ownerDocument.createElement('div');
      block.className = 'pkc-md-block';
      block.setAttribute('data-pkc-md-block-kind', 'table');
      block.insertAdjacentHTML('beforeend', copyButtonHtml('table'));
      table.replaceWith(block);
      block.append(table);
    }
  }

  /** 「さらに N 行」を受ける(器ごとに 1 回だけ付ける ── 描き直しても積まない)。 */
  private bind(host: HTMLElement): void {
    if (this.bound.has(host)) return;
    this.bound.add(host);
    host.addEventListener('click', (ev) => {
      const t = ev.target;
      if (!(t instanceof Element) || t.closest(`[data-pkc-field="${SQL_EMBED_MORE_FIELD}"]`) === null) {
        return;
      }
      this.shown.set(host, (this.shown.get(host) ?? SQL_EMBED_PAGE_ROWS) + SQL_EMBED_PAGE_ROWS);
      this.draw(host);
    });
  }
}
