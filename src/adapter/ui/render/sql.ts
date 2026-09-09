/**
 * 🔴 **SQL を打つ面**(#681 段②)。
 *
 * > user の言葉 2026-09-03:「**内蔵の sqlite を最大限活用したインスタントな
 * > csv や sqliteDB のクエリアプリ**」
 *
 * ## ⚠ **読むだけ**である
 *
 * ノートの正本は同じ sqlite の中に在るので、書き込みを通すと**取り消せない壊し方**が
 * できる。🔑 境は **engine** に置いてある(worker の `PRAGMA query_only` と
 * 進み具合の見張り)── 打つ前の字の門(`sql-guard.ts`)は「**断る理由を読める字で
 * 言う**」ためのもので、境ではない。
 *
 * ## ⚠ 打つ人が最初につまずく 3 つを、面に書いておく
 *
 * 同梱の sqlite を実測した結果(`tests/adapter/sqlite-capabilities.test.ts` が pin):
 * - **`REGEXP` は無い**(`LIKE` と `GLOB` は在る)
 * - **二重引用符は必ず列名**(`DQS=0`)── 文字列は単引用符で書く
 * - **日本語入力のままでも打てる**(全角は半角へ直してから走らせる。⚠ 文字列の
 *   中身は直さない ── 探したい字そのものだから)
 *
 * ⚠ **描画器は状態を持たない** ── 打ちかけの字は state に在るので、
 *   面を閉じて戻っても消えない。
 */
import type { AppState } from '@adapter/state/app-state';

/** 表の値を字にする。⚠ `null` と空文字を**見分けられる**ようにする。 */
const cellText = (v: string | number | null): string => (v === null ? '(なし)' : String(v));

export class SqlRenderer {
  private readonly host: HTMLElement;
  /** 打つ欄。⚠ 1 度だけ組む ── 表の描き直しで作り直さない(打ちかけを失わせない)。 */
  private box: HTMLTextAreaElement | null = null;
  private run: HTMLButtonElement | null = null;
  private note: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  /** 直前に描いた指紋。⚠ 同じなら触らない。 */
  private last = ' ';
  /**
   * 🔴 **開いた最初の 1 回だけ欄へ焦点**(2026-09-09 の動線レビュー)。
   * ⚠ 打つためだけに開く窓なので、まず欄を 1 回押させるのは手数が 1 つ多い。
   *   探す面(`search.ts`)が同じ作法を採っている ── そちらへ揃える。
   * ⚠ **1 回だけ** ── 答えが届くたびに奪い直すと、読んでいる最中に飛ぶ。
   */
  private focused = false;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  private ensureFrame(): HTMLElement {
    if (this.body !== null) return this.body;
    const head = document.createElement('div');
    head.setAttribute('data-pkc-field', 'sql-head');
    const title = document.createElement('h2');
    title.setAttribute('data-pkc-field', 'pane-title');
    title.textContent = 'SQL で調べる';
    const box = document.createElement('textarea');
    box.setAttribute('data-pkc-action', 'set-sql-text');
    box.setAttribute('data-pkc-field', 'sql-input');
    box.setAttribute('aria-label', '打つ SQL');
    box.placeholder = 'SELECT title, updated_at FROM entries ORDER BY updated_at DESC LIMIT 20';
    box.rows = 4;
    box.spellcheck = false;
    const bar = document.createElement('div');
    bar.setAttribute('data-pkc-field', 'sql-bar');
    const run = document.createElement('button');
    run.type = 'button';
    run.setAttribute('data-pkc-action', 'run-sql');
    run.setAttribute('data-pkc-field', 'sql-run');
    run.textContent = '走らせる';
    // 🔑 近道も出す(打ち終わって手を動かさずに走らせられる)
    run.title = 'Ctrl+Enter でも走ります';
    bar.append(run);
    const tip = document.createElement('p');
    tip.setAttribute('data-pkc-field', 'sql-tip');
    /**
     * ⚠ **実測したことだけ書く**(`sqlite-capabilities.test.ts` が pin している)。
     * ⚠ 記法は書かない(`textContent` なので記号がそのまま出る)。
     */
    /**
     * 🔴 **1 行目は「何が調べられるか」**(2026-09-09 の動線レビュー)。
     * ⚠ 初稿は落とし穴だけを並べていたので、**表の名前が 1 つも出ていなかった** ──
     *   唯一の手掛かりは薄字の例文で、それは **1 文字打った瞬間に消える**。
     */
    tip.textContent =
      '調べられるのは entries(ノート)/ relations(つながり)/ revisions(履歴)/ ' +
      'assets(添付)です。読むだけで、書き換えはできません。' +
      '文字列は単引用符で囲みます(二重引用符は列の名前です)。' +
      'REGEXP は使えません(LIKE と GLOB は使えます)。' +
      '日本語入力のままでも打てます(ただし LIKE の ％ と ＿ は半角で打ってください)。';
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'sql-note');
    const body = document.createElement('div');
    body.setAttribute('data-pkc-field', 'sql-body');
    head.append(title, box, bar, tip);
    this.host.append(head, note, body);
    this.box = box;
    this.run = run;
    this.note = note;
    this.body = body;
    return body;
  }

  render(state: AppState): void {
    const body = this.ensureFrame();
    const p = state.sqlPage;
    // ⚠ 打ちかけの字は**上書きしない**(state が直した字を返したときだけ揃える)
    if (this.box !== null && this.box.value !== p.sql) this.box.value = p.sql;
    if (this.run !== null) this.run.disabled = p.running;
    if (!this.focused && !this.host.hidden) {
      this.focused = true;
      this.box?.focus();
    }
    /**
     * 🔴 **「答えの回」を数える必要は無い**(2026-09-09、変異試験 M27/M28 が SURVIVED で教えた)。
     *
     * ⚠ 初稿は「同じ字・同じ件数・同じ時間の 2 回目が素通りして、前の表が残る」と読み、
     *   state に連番(`runSeq`)を足した ── **外して壊れることを見ずに書いた**。
     * 🔑 実測すると壊れない:走らせると必ず `running: true` を通り、その版が**先に描かれる**
     *   ので、次に来る答えの指紋は**直前の指紋(走っています…)と必ず違う**。
     *   ⚠ だから連番は 1 度も効かない(**no-op**)。CLAUDE.md
     *   「『これが無いと壊れる』と書く前に、外して壊れるのを見る」。
     * ⚠ 振る舞いのほうは test が守っている(「同じ字をもう一度走らせると表が入れ替わる」)
     *   ── ここを直すときは、その test が落ちるかで確かめる。
     */
    const fingerprint = [
      p.ranSql,
      p.error,
      String(p.running),
      String(p.truncated),
      String(p.ms),
      String(p.rows.length),
    ].join(' ');
    if (fingerprint === this.last) return;
    this.last = fingerprint;

    if (this.note !== null) {
      this.note.textContent = noteLine(p);
      // 🔑 断りの行だと分かる印(色は CSS 側が持つ)
      this.note.setAttribute('data-pkc-sql-error', p.error === '' ? 'no' : 'yes');
    }

    body.textContent = '';
    if (p.columns.length === 0) return;
    const table = document.createElement('table');
    table.setAttribute('data-pkc-field', 'sql-table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const c of p.columns) {
      const th = document.createElement('th');
      th.textContent = c;
      hr.append(th);
    }
    thead.append(hr);
    const tbody = document.createElement('tbody');
    for (const row of p.rows) {
      const tr = document.createElement('tr');
      for (const v of row) {
        const td = document.createElement('td');
        // ⚠ **字として入れる**(worker から来た値を HTML として注入しない)
        td.textContent = cellText(v);
        if (v === null) td.setAttribute('data-pkc-sql-null', 'yes');
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(thead, tbody);
    body.append(table);
  }
}

/**
 * 表の上に出す 1 行。⚠ **どの状態でも 1 行言う**(黙って終わらない)。
 *
 * 🔴 **数だけで終えない ── 次の一手まで言う**(2026-09-09 の動線レビュー)。
 * ⚠ 「500 行」「0 行」で止めると、マニュアルを開いていない人はそこで手が止まる。
 */
function noteLine(p: AppState['sqlPage']): string {
  if (p.running) return '走らせています…';
  if (p.error !== '') return p.error;
  if (p.ranSql === '') return '';
  const took = `(${String(p.ms)} ミリ秒)`;
  if (p.truncated)
    return `${String(p.rows.length)} 行${took} ── 多すぎるので途中まで出しています(LIMIT や条件で絞ると全部見えます)`;
  if (p.rows.length === 0) return `0 行${took} ── 条件に当たるものがありませんでした${zeroHint(p.ranSql)}`;
  return `${String(p.rows.length)} 行${took}`;
}

/**
 * 🔴 **0 行のとき、いちばん多い外し方を名指しする**(2026-09-09 の動線レビュー、実測)。
 *
 * ⚠ 日本語入力のまま `LIKE '％請求％'` と打つと、門は通り(引用符の中は直さないのが
 *   正しい ── 探したい字そのものだから)、走り、**0 行**で返る。
 *   実測:同じ 1 件に対して半角 `'%請求%'` は **1 行**、全角 `'％請求％'` は **0 行**。
 * 🔑 失敗ではなく **0 行**として返るので、user は「そのノートは無い」と読む ──
 *   いちばん気づけない外し方である。だから**画面が名前で言う**。
 */
function zeroHint(sql: string): string {
  return /[％＿]/.test(sql)
    ? '(打った字に全角の ％ か ＿ が入っています ── LIKE の記号は半角の % と _ です)'
    : '';
}
