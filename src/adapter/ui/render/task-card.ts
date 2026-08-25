/**
 * 🔴 **予定の札 1 枚**(#292 段③)。
 *
 * ⚠ **2 つの面が同じ札を出す**あいだ、組み立てはここ 1 か所にする ──
 *   板(`kanban.ts`)と予定(`schedule.ts`)が別々に組むと、片方にだけ直しが入り、
 *   **同じ物が面によって違って見える**(CLAUDE.md §7)。
 *
 * ## 札が持つもの
 *
 * | 属性 | 誰が読むか |
 * |---|---|
 * | `data-pkc-entry` | 押したら**そのノート**を選ぶ(開いているノートではない) |
 * | `data-pkc-task-line` | **原文の行番号**。印の書換と、掴んだときの荷物 |
 * | `draggable` | 🔴 **掴んで日へ落とす**(双方向。user 指示 2026-08-23) |
 */
import type { AgendaItem } from '@features/schedule/agenda';
import { formatListDate } from '@features/datetime/stored-date';
import { REPEAT_WORDS } from '@features/schedule/repeat';

/**
 * 札の器を作る(中身は `patchTaskCard` が入れる)。
 *
 * ⚠ **ノート 1 件の予定(`line === null`)には印を置かない** ── チェックする
 *   「行」が無いので、置くと**押しても何も起きない印**になる。
 *   🔑 代わりに**器の列を空けたまま**にする(札の頭が面ごとにずれない)。
 */
export function createTaskCard(data: AgendaItem): HTMLElement {
  const card = document.createElement('article');
  /**
   * 🔴 **どのノートの行かを札に焼く**。⚠ これが無いと binder は
   * 「いま開いているノート」に書き込む ── 盤面では**別のノートを書き換える**。
   */
  card.setAttribute('data-pkc-entry', data.lid);
  card.setAttribute('data-pkc-action', 'select-entry');
  /**
   * 🔴 掴めるようにする(落とし先は日の升目 / 束の見出し)。
   *
   * ⚠ **行番号は札に焼かない**(2026-08-23 に踏んだ)── 1 稿目は札にも
   *   `data-pkc-task-line` を置いたが、**印(checkbox)と同じ属性が入れ子で
   *   2 つ**になり、`[data-pkc-task-line="0"]` を押す既存の test / smoke が
   *   **札のほうに当たって印を押さなくなった**(押しても `select-entry`)。
   * 🔑 掴んだときは**中の印から引く**(`querySelector`)── 名前も出どころも 1 つ。
   */
  card.draggable = true;
  const box = document.createElement(data.line === null ? 'span' : 'input');
  if (box instanceof HTMLInputElement) {
    box.type = 'checkbox';
    box.className = 'pkc-task-checkbox';
    box.setAttribute('data-pkc-action', 'toggle-task');
    box.setAttribute('aria-label', 'チェックを切り替え');
  } else {
    // ⚠ 印の代わりの**空き**(押せない)。器の列を空けて頭を揃える
    box.setAttribute('data-pkc-field', 'no-check');
  }
  const text = document.createElement('span');
  text.setAttribute('data-pkc-field', 'text');
  /**
   * 🔴 **その行に書かれた日付**。⚠ 記法(`@2026-08-25`)は `taskCardsOf` が
   *   札の字から外しているので、ここに出さないと**どこにも出ない**。
   */
  const when = document.createElement('span');
  when.setAttribute('data-pkc-field', 'when');
  /**
   * ⚠ 日付と字は**同じ器に入れる**(格子の列を増やさない)。
   * 🔑 増やすと、日付の無い札で**空の列の隙間だけ**が残り、印の位置が
   *   札ごとに 8px ずれる(`display: none` は列を消すが、その両隣の gap は残る)。
   */
  const line = document.createElement('div');
  line.setAttribute('data-pkc-field', 'line');
  line.append(when, text);
  const note = document.createElement('span');
  note.setAttribute('data-pkc-field', 'note');
  card.append(box, line, note);
  patchTaskCard(card, data, '', null);
  return card;
}

/**
 * 札の中身を合わせる。
 *
 * @param showDate 日付を出すか。⚠ **束が日ごとのときは出さない**
 *   ── 見出しに `8/27(木)` と出ているのに、その下の札全部にも同じ日が並ぶのは
 *   ただの重複である(板は束が日ではないので出す)。
 * @param thisYear 今年(`null` なら日付を出さない)。⚠ **引数で受ける** ──
 *   内部で `new Date()` を読むと test が年を跨いだ日に落ちる。
 */
export function patchTaskCard(
  card: HTMLElement,
  data: AgendaItem,
  title: string,
  thisYear: number | null,
  showDate = true,
): void {
  const box = card.querySelector<HTMLInputElement>('[data-pkc-action="toggle-task"]');
  if (box && data.line !== null) {
    // 🔴 **指すのは原文の行番号**(索引ではない ── 別の行を書き換えないため)
    box.setAttribute('data-pkc-task-line', String(data.line));
    box.checked = data.done;
  }
  /**
   * 🔴 **ノート 1 件の予定であることを、札に出す**(段④)。
   * ⚠ 出さないと、行の予定と見分けが付かない ── 掴んで落としたときに
   *   書き換わる場所が違う(行の `@…` か、frontmatter の `date:` か)のに、
   *   画面が同じでは user が予測できない。
   */
  if (data.line === null) card.setAttribute('data-pkc-whole-note', '');
  else card.removeAttribute('data-pkc-whole-note');
  if (data.done) card.setAttribute('data-pkc-task-done', '');
  else card.removeAttribute('data-pkc-task-done');
  const when = card.querySelector<HTMLElement>('[data-pkc-field="when"]');
  if (when) {
    /**
     * 🔑 日付の見せ方は `formatListDate` 1 本(左の一覧と同じ規則)──
     * 面ごとに書くと、同じ日が場所によって違う字で出る(CLAUDE.md §7)。
     */
    const day =
      showDate && data.date !== null && thisYear !== null
        ? formatListDate(data.date, thisYear)
        : '';
    /**
     * 🔴 **期間の終わりは、日付を出さない面でも出す**(#344 段①)。
     *
     * ⚠ `showDate` を切っているのは「**束の見出しと同じ日が札にも並ぶのは重複**」
     *   だからである ── ところが**終わりの日は見出しに出ていない**。
     *   出さないと、user は「この札はいつまでの予定か」を**本文を開くまで知れない**
     *   (期間の札は複数の日に出るので、なおさら分からない)。
     * 🔑 だから重複の理屈はここには当たらない ── **`showDate` とは別に**出す。
     */
    const till =
      data.until !== null && thisYear !== null ? `〜${formatListDate(data.until, thisYear)}` : '';
    const head =
      till !== ''
        ? `${day}${till}`
        : data.time === null
          ? day
          : day === ''
            ? data.time
            : `${day} ${data.time}`;
    /**
     * 🔴 **刻みは、日付を出さない面でも出す**(#344 段②)── 期間の終わりと同じ理由。
     * ⚠ 束の見出しに出ているのは**その日**であって、「これが毎週の回だ」ではない。
     *   出さないと、user は**押したら何が起きるか**を予測できない
     *   (押すと規則の行ではなく、その日ぶんの行が増える)。
     */
    const every = data.repeat === null ? '' : REPEAT_WORDS[data.repeat];
    const label = every === '' ? head : head === '' ? every : `${head} ${every}`;
    if (when.textContent !== label) when.textContent = label;
    when.hidden = label === '';
  }
  /**
   * 🔑 **期間であることを札の属性に出す**(#344 段①)── 見た目のためではなく、
   * **外から見える継ぎ目**を作るため(smoke と CSS が「期間の札」を名指しできる)。
   */
  if (data.until !== null) card.setAttribute('data-pkc-task-range', data.until);
  else card.removeAttribute('data-pkc-task-range');
  /**
   * 🔴 **繰り返しの回であることと、「どの回か」を札に焼く**(#344 段②)。
   *
   * ⚠ **行番号は焼かない**(2026-08-23 の罠)── 代わりに**日**を焼く。
   *   押したとき(実体の行を作る)と掴んだとき(断る)に、
   *   `lid` と行番号だけでは**どの回か決まらない**からである
   *   (1 本の規則の行が、複数の日に札を出す)。
   * ⚠ 名前は新しくする ── 既存の `[data-pkc-task-line]` を押す経路に当てない。
   */
  if (data.repeat !== null) {
    card.setAttribute('data-pkc-task-repeat', data.repeat);
    if (data.date !== null) card.setAttribute('data-pkc-task-date', data.date);
    else card.removeAttribute('data-pkc-task-date');
  } else {
    card.removeAttribute('data-pkc-task-repeat');
    card.removeAttribute('data-pkc-task-date');
  }
  const text = card.querySelector('[data-pkc-field="text"]');
  // ⚠ 中身が空の項目もある(`- [ ]` だけの行)── 札は出すが、字は出ない
  if (text && text.textContent !== data.text) text.textContent = data.text;
  const note = card.querySelector('[data-pkc-field="note"]');
  if (note && note.textContent !== title) note.textContent = title;
  // 🔑 題名は指紋にも使う(ノートを改名したら札の字も直る)
  card.setAttribute('data-pkc-note', title);
}
