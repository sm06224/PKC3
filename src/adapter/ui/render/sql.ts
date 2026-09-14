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
import { sqlSourcesOf } from '@features/query/sqlite-attachment';
import { SQL_GUEST_EXTS } from '@features/query/sql-guest-source';
// 🔴 添付の .csv / .tsv / .xlsx も同じ選び所へ並べる(#854 段① / 段③)
import { csvAttachmentSourcesOf } from '@features/query/csv-attachment';
import { xlsxAttachmentSourcesOf } from '@features/query/xlsx-attachment';
// 🔴 手持ちのファイルを開く(#854 段②)
import { isSqlLocalFileLid, SQL_PICK_LOCAL_FILE_VALUE } from '@features/query/sql-local-file';
import { humanBytes } from '@features/human-bytes';
import { SQL_RULES, sqlExampleText, sqlPlaceholder, sqlTipText } from '@features/query/sql-tip';

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
  /** 「ノートへ」の口(答えが無いうちは押させない)。 */
  private save: HTMLButtonElement | null = null;
  /** 調べる相手の選び所(#681 段③ の 2 つ目)。 */
  private source: HTMLSelectElement | null = null;
  /** 案内の 1 段落(#681 F2 ── 相手に合わせて書き換える)。 */
  private tip: HTMLElement | null = null;
  /**
   * 直前に組んだ選択肢の指紋(添付が増減したときだけ組み直す)。
   * 🔴 **初期値は `null`**(#681 の着地前レビュー F5)── `''` にすると
   *   「相手が 1 つも無い」の指紋と**同じ**になり、**1 枚目の描画で枝ごと素通り**する。
   *   結果、`.sqlite` を 1 つも取り込んでいない人に**中身が空の選び所**が出ていた
   *   (「押しても何も無い口を作らない」と書いた当の行が、初回だけ走っていなかった)。
   */
  private sourceKey: string | null = null;
  /** 打ち始めても消えない手本(#837 K1)。⚠ 器は 1 度しか組まないので控えを持つ。 */
  private example: HTMLElement | null = null;

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
    box.placeholder = sqlPlaceholder(null);
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
    /**
     * 🔴 **答えをノートへ書き出す**(#681 段③ の 3 つ目)。
     * ⚠ 窓を閉じれば答えは消えるので、**残す道が要る** ── 無いと
     *   「調べられるが、持ち帰れない」で終わる。
     * ⚠ 答えが無いうちは**押せない**(押せるのに何も起きない口を作らない)。
     */
    const save = document.createElement('button');
    save.type = 'button';
    save.setAttribute('data-pkc-action', 'sql-to-note');
    save.setAttribute('data-pkc-field', 'sql-to-note');
    save.textContent = 'ノートへ';
    save.title = 'いま出ている答えを、新しいノートに書き出します';
    /**
     * 🔴 **調べる相手**(#681 段③ の 2 つ目)。既定は「この PKC のノート」。
     * ⚠ **どちらを調べているかが読めない**と、user は「ノートを数えたつもりで
     *   よその DB を数えていた」に気づけない ── だから常に画面に出す。
     */
    const source = document.createElement('select');
    source.setAttribute('data-pkc-action', 'set-sql-source');
    source.setAttribute('data-pkc-field', 'sql-source');
    source.setAttribute('aria-label', '調べる相手');
    /**
     * 🔴 **「手持ちのファイルを開く…」が押した先**(#854 段②)。
     * ⚠ **隠したまま置く** ── 選び所の一項目を選ぶと `binder.ts` がここを
     *   `click()` する(`office-pack-input` / `settings-file-input` と同じ作法)。
     * ⚠ **憶えない**(user 裁定 2026-09-12)── ここは選ぶたびに使い捨てる口で、
     *   選んだ file を溜める仕組みはどこにも持たない。
     */
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = SQL_GUEST_EXTS.join(',');
    fileInput.hidden = true;
    fileInput.setAttribute('data-pkc-field', 'sql-file-input');
    fileInput.setAttribute('aria-label', '手持ちのファイルを選ぶ');
    /**
     * 🔴 **構造をノートへ**(#918 段①。user 要望 2026-09-14「ai向けに構造吐き出したり」)。
     * ⚠ **答えが無くても押せる**(「ノートへ」との違い)── 構造は**打つ前**に要る物だから。
     * 🔑 字で「構造」と言い切る ── 「ノートへ」が 2 つ並ぶと、どちらが何か読めない。
     */
    const schema = document.createElement('button');
    schema.type = 'button';
    schema.setAttribute('data-pkc-action', 'sql-schema-to-note');
    schema.setAttribute('data-pkc-field', 'sql-schema-to-note');
    schema.textContent = '構造をノートへ';
    schema.title =
      'いま調べている相手の表・列・型・鍵・繋がり・行数を、ノート 1 枚にします(中身は入りません)。AI に貼るのに使えます。';
    bar.append(run, save, schema, source, fileInput);
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
    // 🔴 中身は `render` が揃える(#681 F2)── 相手が変われば案内も手本も変わる
    tip.textContent = sqlTipText(null);
    /**
     * 🔴 **打ち方の約束は 2 行目へ**(#837 K1、2026-09-09)。
     * ⚠ 直す前は 6 文が 1 段落に続いていて、**読み飛ばされる長さ**だった。
     */
    const rules = document.createElement('p');
    rules.setAttribute('data-pkc-field', 'sql-rules');
    rules.textContent = SQL_RULES;
    /**
     * 🔴 **打ち始めても消えない手本**(#837 K1)。
     * ⚠ 薄字(`placeholder`)は **1 文字打った瞬間に消える**ので、
     *   「打つために開く面」なのに**打つ物の見本が画面から無くなって**いた。
     */
    const example = document.createElement('p');
    example.setAttribute('data-pkc-field', 'sql-example');
    example.textContent = sqlExampleText(null);
    const note = document.createElement('p');
    note.setAttribute('data-pkc-field', 'sql-note');
    const body = document.createElement('div');
    body.setAttribute('data-pkc-field', 'sql-body');
    head.append(title, box, bar, tip, rules, example);
    this.host.append(head, note, body);
    this.box = box;
    this.run = run;
    this.save = save;
    this.source = source;
    this.example = example;
    this.tip = tip;
    this.note = note;
    this.body = body;
    return body;
  }

  /**
   * 🔴 **調べる相手の選び所を揃える**(#681 段③ の 2 つ目、#854 段①②)。
   *
   * ⚠ **選択肢は添付が増減したときだけ組み直す** ── 毎回作り直すと、
   *   開いたまま増えた添付に気づける代わりに、**選んでいる最中に選択肢が
   *   差し替わる**(押している指の下で並びが動く)。
   * ⚠ **いま選ばれている物は state から書き戻す** ── 開けなかった回は
   *   `guest` が `null` に戻るので、選び所も「この PKC」へ戻る
   *   (画面と実体が食い違わない)。
   * 🔑 **`.sqlite` の下に `.csv` / `.tsv`、その下に `.xlsx`**(#854 段① / 段③)──
   *   開く仕組みは `sqlGuestSourceOf` が `name` の拡張子だけで見分けるので、
   *   ここは一覧を**連結するだけ**でよい(判定を 2 か所に置かない)。
   * ⚠ **並べたものは必ず開けなければならない** ── 選び所に出したのに
   *   `sqlGuestSourceOf` が知らない拡張子だと、押した瞬間に断られる
   *   (無言の dead click に近い)。両者が同じ 1 つの判定を見ていることは
   *   `tests/adapter/sql-source-parity.test.ts` が見る。
   */
  private paintSource(state: AppState): void {
    const sel = this.source;
    if (sel === null) return;
    const sources = [
      ...sqlSourcesOf(state.entryMetas.values()),
      ...csvAttachmentSourcesOf(state.entryMetas.values()),
      ...xlsxAttachmentSourcesOf(state.entryMetas.values()),
    ];
    /**
     * 🔴 **いま開いている手持ちのファイルも一覧へ足す**(#854 段②)。
     * ⚠ 足さないと、開いた file を表す `<option>` が一覧に無いまま `want` だけ
     *   それを指し、すぐ下の「いま選ばれている物は state から書き戻す」が
     *   選び所を「この PKC」へ戻してしまう(画面と実体が食い違う ── この file
     *   自身のいちばん上のコメントが戒めている形)。
     * ⚠ **entryMetas には出てこない** ── ノートでも添付でもないので、
     *   開いている間だけこの場で足す(閉じれば消える。「憶えない」の裁定どおり)。
     */
    const guest = state.sqlPage.guest;
    if (guest !== null && isSqlLocalFileLid(guest.lid)) sources.push(guest);
    const key = sources.map((s) => `${s.lid}:${s.name}`).join('|');
    if (key !== this.sourceKey) {
      this.sourceKey = key;
      sel.textContent = '';
      const here = document.createElement('option');
      here.value = '';
      here.textContent = 'この PKC のノート';
      sel.append(here);
      for (const s of sources) {
        const opt = document.createElement('option');
        opt.value = s.lid;
        opt.textContent = s.name;
        sel.append(opt);
      }
      /**
       * 🔴 **「手持ちのファイルを開く…」は常に置く**(#854 段②)。
       * ⚠ 添付が 1 つも無くても**この項目だけは押せる**ので、上の
       *   「選べる相手が 1 つも無いときは出さない」は成り立たなくなった ──
       *   選び所そのものは**もう隠さない**(実体の無い口ではなく、押せば file
       *   選択画面が開く実在する操作である)。
       */
      const pick = document.createElement('option');
      pick.value = SQL_PICK_LOCAL_FILE_VALUE;
      pick.textContent = '手持ちのファイルを開く…';
      sel.append(pick);
      sel.hidden = false;
    }
    const want = state.sqlPage.guest?.lid ?? '';
    if (sel.value !== want) sel.value = want;
  }

  render(state: AppState): void {
    const body = this.ensureFrame();
    const p = state.sqlPage;
    // ⚠ 打ちかけの字は**上書きしない**(state が直した字を返したときだけ揃える)
    if (this.box !== null && this.box.value !== p.sql) this.box.value = p.sql;
    if (this.run !== null) this.run.disabled = p.running;
    /**
     * ⚠ **押せるのに何も起きない口を作らない** ── まだ走らせていない回と、
     *   走っている最中は押させない(押した後に「何も起きなかった」を作らない)。
     */
    if (this.save !== null) this.save.disabled = p.running || p.ranSql === '' || p.columns.length === 0;
    this.paintSource(state);
    /**
     * 🔴 **案内も手本も、いま調べている相手へ揃える**(#681 の着地前レビュー F2)。
     * ⚠ 直す前は静的な字だったので、取り込んだ `.sqlite` を選んでも
     *   「調べられるのは entries …」のままで、**そのとおり打つと英語で断られた**。
     */
    const target = p.guest === null ? null : { name: p.guest.name, tables: p.guest.tables };
    const tipText = sqlTipText(target);
    if (this.tip !== null && this.tip.textContent !== tipText) this.tip.textContent = tipText;
    const hint = sqlPlaceholder(target);
    if (this.box !== null && this.box.placeholder !== hint) this.box.placeholder = hint;
    // 🔴 **消えない手本も相手へ揃える**(#837 K1)── 薄字と同じ 1 本から採る
    const example = sqlExampleText(target);
    if (this.example !== null && this.example.textContent !== example) {
      this.example.textContent = example;
    }
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
      // ⚠ 書き出しの知らせも指紋に入れる ── 入れないと、答えが同じ回に**行が更新されない**
      p.saved,
      // ⚠ 調べる相手が変わったら、上の行を必ず言い直す(#681 段③ の 2 つ目)
      p.guest?.lid ?? '',
      p.guestError,
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
  /**
   * 🔴 **どちらを調べているかは、どの行にも添える**(#681 の着地前レビュー F2)。
   * ⚠ 直す前は「まだ走らせていない」と「答えが出た」の 2 つにしか出ておらず、
   *   **断りが出た回と書き出した回で名札が消えていた** ── いちばん取り違えやすい
   *   のは断りの直後である。
   */
  /**
   * 🔴 **打ち切ったことは、選んでいる間ずっと言う**(#854 段①)。
   * ⚠ 黙って一部だけ返すと user は「これで全部」と読む ── いちばん気づけない
   *   外し方(CLAUDE.md §4)。だから**この相手を選んでいる限り毎行に添える**
   *   (答えが出た後・断られた後でも消えない)。
   */
  const truncNote =
    p.guest !== null && p.guest.truncated ? '(行が多いので、先頭だけを表にしています)' : '';
  const where = p.guest === null ? '' : ` ── ${p.guest.name} を調べています${truncNote}`;
  /**
   * 🔴 **開けなかったことを、いちばん上で言う**(#681 段③ の 2 つ目)。
   * ⚠ 黙って「この PKC」へ戻ると、選んだ人には**選べなかった**ようにしか見えない。
   * ⚠ **`.sqlite` に決め打たない**(#854 段①)── `.csv` / `.tsv` も同じ相手選びから
   *   開くので、字を見て相手を勘違いさせない。
   */
  if (p.guestError !== '') return `選んだ file を開けませんでした ── ${p.guestError}`;
  if (p.running) return `走らせています…${where}`;
  if (p.error !== '') return `${p.error}${where}`;
  /**
   * 🔴 **書き出したことを、いちばん上で言う**(#681 段③ の 3 つ目)。
   * ⚠ この面は**別の窓**なので、ノートを作っても窓の中は何も変わらない ──
   *   言わないと「押せなかった」に見える。
   */
  if (p.saved !== '')
    return `「${p.saved}」というノートに書き出しました(左の一覧に出ています)${where}`;
  /**
   * 🔴 **どちらを調べているかを、打つ前から言う**(#681 段③ の 2 つ目)。
   * ⚠ 言わないと「ノートを数えたつもりで、よその DB を数えていた」に気づけない。
   */
  if (p.ranSql === '')
    return p.guest === null
      ? ''
      : `${p.guest.name} を調べています(表 ${String(p.guest.tables.length)} 個 / ${humanBytes(p.guest.bytes)})${truncNote}`;

  const took = `(${String(p.ms)} ミリ秒)`;
  if (p.truncated)
    return `${String(p.rows.length)} 行${took} ── 多すぎるので途中まで出しています(LIMIT や条件で絞ると全部見えます)${where}`;
  if (p.rows.length === 0)
    return `0 行${took} ── 条件に当たるものがありませんでした${zeroHint(p.ranSql)}${where}`;
  return `${String(p.rows.length)} 行${took}${where}`;
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
