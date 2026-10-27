/**
 * 🔴 **ログの日の行を器へ当てる**(#1441 案 b)。規則は `features/textlog/log-days.ts`(pure)。
 *
 * ## 何を足すか
 *
 * ログ(`textlog`)の読む面で、日が変わる所の**直前**に薄い行(`2026-10-10(金)`)を挟む。
 * 押すと、その日の追記(時刻の見出しと中身)がまとめて隠れ、もう一度押すと戻る。
 *
 * ## 🔴 本文にも見出しにも触らない
 *
 * - 行は **DOM だけ**(本文の原文は 1 バイトも変わらない。書き出し・印刷・別ウィンドウの章は
 *   この面を通らないので行が出ない)。
 * - 行は **host の直下に置く重ね物**(`OVERLAY_ATTR`)── 差分描画の `intact` が数えず、
 *   行があっても全塊を作り直さない。見出しの中へは入れない(`h2.textContent` を汚さない)。
 * - 本文の塊としては**数えない**(`bodyBlocks`)── 時刻見出しの畳み(`heading-fold.ts`)は
 *   行を無いものとして数える。でないと、前の追記を畳んだとき**次の日の行まで隠れる**。
 *
 * ## 🔑 畳みは時刻見出しの畳みと喧嘩しない
 *
 * 日の畳みは「どの塊を隠すか」の**もう 1 つの集合**として足すだけで、見出しの畳みの印
 * (`data-pkc-folded`)は 1 つも触らない。日を開けば、各追記は**畳んでいた物は畳んだまま**、
 * 開いていた物は開いたまま戻る(日を畳むと追記の畳みを全部開く形にしない)。
 *
 * ## ⚠ 状態は DOM に置く(見出しの畳みと同じ)
 *
 * 行の `data-pkc-day-folded` が事実。描き直しで行が作り直されても、**日(+何番目か)をキー**に引き継ぐ。
 */
import { OVERLAY_ATTR } from './apply-blocks';
import {
  formatLogDay,
  formatLogMonth,
  logDayOfHeading,
  logDayRuns,
  logGrouping,
} from '@features/textlog/log-days';

/** 行の印(値 = `YYYY-MM-DD`)。⚠ 行かどうかを問う口はこの属性 1 つ。 */
export const LOG_DAY_ATTR = 'data-pkc-log-day';
/** 月の行の印(値 = `YYYY-MM`。#1441 の月別)。日の行(`LOG_DAY_ATTR`)の手前に 1 本だけ挟む。 */
export const LOG_MONTH_ATTR = 'data-pkc-log-month';
/** 「すべて折りたたむ / すべて出す」の行の印(#1441)。host の先頭に 1 本。 */
export const LOG_ALL_ATTR = 'data-pkc-log-all';
/** 畳んでいる印(行に付く)。 */
const DAY_FOLDED = 'data-pkc-day-folded';
/** ログの読む面に付ける印(`detail.ts` が描くたびに付け外す)。 */
export const LOG_DAYS_HOST_ATTR = 'data-pkc-log-days';

/**
 * 🔴 **行かどうかは「自分が作った物か」で決める**(#1441 レビュー)。
 *
 * ⚠ 属性(`data-pkc-log-day`)で判定してはいけない ── user は本文に `:::format{log-day=1}` と書くと
 *   **塊そのもの**へ同じ属性を焼ける(`overlay=1` と同じ偽造 ── `apply-blocks.test.ts`)。
 *   属性で見ると、その塊が行と読まれ、**同期が user の塊を消し、差分描画も死ぬ**。
 * 🔑 作った行を `WeakSet` に入れ、それだけを行と読む(属性は見た目と `closest` のための印でしかない)。
 */
const ROWS = new WeakSet<Element>();

/** 行か。 */
export function isLogDayRow(el: Element): boolean {
  return ROWS.has(el);
}

/** 本文の塊(行を除いた host の直下)。⚠ 畳みの数え方は全部これを通す。 */
export function bodyBlocks(host: HTMLElement): Element[] {
  return [...host.children].filter((c) => !isLogDayRow(c));
}

/** 日の畳みを問う口。 */
export function isLogDayFolded(row: Element): boolean {
  return row.hasAttribute(DAY_FOLDED);
}

function paintRow(row: HTMLElement, label: string, folded: boolean): void {
  if (row.textContent !== label) row.textContent = label;
  row.setAttribute('aria-expanded', folded ? 'false' : 'true');
  const hint = folded ? `${label}の追記をすべて出します` : `${label}の追記をすべて折りたたみます`;
  row.title = hint;
  row.setAttribute('aria-label', hint);
}

function createRow(host: HTMLElement, attr: string, value: string): HTMLButtonElement {
  const btn = host.ownerDocument.createElement('button');
  btn.type = 'button';
  btn.setAttribute(attr, value);
  btn.setAttribute('data-pkc-field', attr === LOG_MONTH_ATTR ? 'log-month' : 'log-day');
  // 🔑 押しの振り分けは既存の作法(`data-pkc-action`)に乗せる ── 独自の listener を足さない
  btn.setAttribute('data-pkc-action', 'toggle-log-day');
  btn.setAttribute(OVERLAY_ATTR, '');
  ROWS.add(btn);
  return btn;
}

/** 日の行か(月の行・すべての行ではない)。 */
function isDayRow(el: Element): boolean {
  return isLogDayRow(el) && el.hasAttribute(LOG_DAY_ATTR);
}

/** 月の行か。 */
export function isLogMonthRow(el: Element): boolean {
  return isLogDayRow(el) && el.hasAttribute(LOG_MONTH_ATTR);
}

/** 「すべて」の行か。 */
export function isLogAllRow(el: Element): boolean {
  return isLogDayRow(el) && el.hasAttribute(LOG_ALL_ATTR);
}

/** 畳める行(日・月)。 */
function foldableRows(host: HTMLElement): HTMLElement[] {
  return [...host.children].filter(
    (c): c is HTMLElement => c instanceof HTMLElement && (isDayRow(c) || isLogMonthRow(c)),
  );
}

/** 時刻見出しの日を塊ごとに読む。 */
function daysOf(blocks: readonly Element[], levels: readonly number[]): (string | null)[] {
  return blocks.map((b, i) => (levels[i] === 2 ? logDayOfHeading(b.textContent ?? '') : null));
}

/**
 * 行を過不足なく置き、**日・月の畳みで隠す塊の添字**を返す。⚠ 描画のたびに呼ぶ(冪等)。
 *
 * - 日の行: 日が変わる所の手前(#1441 案 b)。
 * - 🔴 **月の行**: 日が 2 つ以上の月にまたがるとき、月の最初の日の行の**さらに手前**に 1 本(月別)。
 *   押すとその月の全部の追記が隠れる。月の中の日の行も隠す(`rows[].inFoldedMonth`)。
 * - 🔴 **「すべて」の行**: 日が 3 つ以上あるとき host の先頭に 1 本。いまの状態で裏返る
 *   (1 つでも開いていれば「すべて折りたたむ」/ 全部畳んでいれば「すべて出す」)。
 *
 * @param blocks `bodyBlocks(host)`(行を除く)
 * @param levels 塊ごとの見出しの段
 * @returns 隠す塊 / 日・月の畳みが触りうる塊(`managed`)
 */
export function syncLogDays(
  host: HTMLElement,
  blocks: readonly Element[],
  levels: readonly number[],
): {
  hidden: Set<number>;
  managed: Set<number>;
  rows: { row: HTMLElement; start: number; inFoldedMonth: boolean }[];
} {
  const hidden = new Set<number>();
  const managed = new Set<number>();
  const placed: { row: HTMLElement; start: number; inFoldedMonth: boolean }[] = [];
  const existing = [...host.children].filter(isLogDayRow) as HTMLElement[];

  const enabled = host.hasAttribute(LOG_DAYS_HOST_ATTR);
  const runs = enabled ? logDayRuns(levels, daysOf(blocks, levels)) : [];
  // 🔴 月・すべての行を出すかは `logGrouping` 1 本(畳む物が増えるときだけ足す)
  const { months, all: grouped } = logGrouping(runs);

  /**
   * 行は「日 + その日の何番目の連なりか」(`day#n`)で引く ── 畳みの引き継ぎも、行の使い回しも同じ鍵。
   * ⚠ 同じ日が離れて 2 度出る形では、**連なりの数・順が変わると**畳みを別の連なりへ引き継ぐ(または忘れる)
   *   ことがある(例: 間の節が消えて 2 つが 1 つになる)。鍵を安定させる材料が本文に無いので、その範囲で許す。
   * 🔑 月の行も同じ作り(`YYYY-MM#n`)。
   */
  const byKey = new Map<string, HTMLElement>();
  const monthByKey = new Map<string, HTMLElement>();
  let allRow: HTMLElement | undefined;
  const seenOld = new Map<string, number>();
  const seenOldMonth = new Map<string, number>();
  for (const row of existing) {
    if (isLogAllRow(row)) {
      allRow = row;
    } else if (isLogMonthRow(row)) {
      const m = row.getAttribute(LOG_MONTH_ATTR)!;
      const n = seenOldMonth.get(m) ?? 0;
      seenOldMonth.set(m, n + 1);
      monthByKey.set(`${m}#${n}`, row);
    } else {
      const day = row.getAttribute(LOG_DAY_ATTR)!;
      const n = seenOld.get(day) ?? 0;
      seenOld.set(day, n + 1);
      byKey.set(`${day}#${n}`, row);
    }
  }

  const keep = new Set<Element>();
  const seenNew = new Map<string, number>();
  const dayRowAt = new Map<number, HTMLElement>();
  for (const run of runs) {
    const n = seenNew.get(run.day) ?? 0;
    seenNew.set(run.day, n + 1);
    const key = `${run.day}#${n}`;
    const first = blocks[run.start]!;
    /**
     * 🔑 **隣に居なくても使い回す**。⚠ 境目の追記を直すと、差分描画は作り直した塊を「次の日の行と見出し
     *   の間」へ挿すので、次の日の行は見出しの隣から外れる。隣だけ見ると**新しい行を作って焦点も失う**
     *   (押した行が消える)。同じ鍵の行が在れば、それを見出しの手前へ**必要なときだけ**動かす。
     */
    let row = byKey.get(key);
    if (row === undefined) {
      row = createRow(host, LOG_DAY_ATTR, run.day);
      first.before(row);
    } else if (first.previousElementSibling !== row) {
      // ⚠ 動かすと(いったん外して挿すので)焦点が外れる ── 持っていたなら返す
      const focused = row.ownerDocument.activeElement === row;
      first.before(row);
      if (focused) row.focus({ preventScroll: true });
    }
    keep.add(row);
    dayRowAt.set(run.start, row);
  }

  // 月の行を、その月の最初の日の行の手前へ
  const seenMonth = new Map<string, number>();
  const monthFolded = new Set<number>();
  const insideFoldedMonth = new Set<number>();
  for (const mr of months) {
    const n = seenMonth.get(mr.month) ?? 0;
    seenMonth.set(mr.month, n + 1);
    const key = `${mr.month}#${n}`;
    const anchor = dayRowAt.get(mr.start)!;
    let row = monthByKey.get(key);
    if (row === undefined) {
      row = createRow(host, LOG_MONTH_ATTR, mr.month);
      anchor.before(row);
    } else if (anchor.previousElementSibling !== row) {
      const focused = row.ownerDocument.activeElement === row;
      anchor.before(row);
      if (focused) row.focus({ preventScroll: true });
    }
    keep.add(row);
    const folded = row.hasAttribute(DAY_FOLDED);
    paintRow(row, formatLogMonth(mr.month), folded);
    placed.push({ row, start: mr.start, inFoldedMonth: false });
    for (let i = mr.start; i < mr.end; i += 1) {
      managed.add(i);
      if (folded) {
        hidden.add(i);
        monthFolded.add(i);
      }
    }
    if (folded) for (let i = mr.start; i < mr.end; i += 1) insideFoldedMonth.add(i);
  }

  for (const run of runs) {
    const row = dayRowAt.get(run.start)!;
    const isFolded = row.hasAttribute(DAY_FOLDED);
    paintRow(row, formatLogDay(run.day), isFolded);
    // 月の畳みの中の日の行は、塊と一緒に隠す(押し所だけが宙に残らない)
    placed.push({ row, start: run.start, inFoldedMonth: insideFoldedMonth.has(run.start) });
    for (let i = run.start; i < run.end; i += 1) {
      managed.add(i);
      if (isFolded) hidden.add(i);
    }
  }

  // 「すべて」の行(host の先頭)
  if (grouped) {
    if (allRow === undefined) {
      allRow = createRow(host, LOG_ALL_ATTR, '');
      allRow.setAttribute('data-pkc-field', 'log-all');
      allRow.setAttribute('data-pkc-action', 'toggle-log-day-all');
    }
    if (host.firstElementChild !== allRow) {
      const focused = allRow.ownerDocument.activeElement === allRow;
      host.prepend(allRow);
      if (focused) allRow.focus({ preventScroll: true });
    }
    keep.add(allRow);
    // 字は `paintAllRow`(行の表示が決まった後に、見えている物から決める)── 作った直後はひとまず「折りたたむ」
    if (allRow.textContent === '') paintAllRowWith(allRow, true);
  }
  for (const row of existing) if (!keep.has(row)) row.remove();
  return { hidden, managed, rows: placed };
}

/**
 * 目的の塊を覆っている**日・月の畳み**を開く(目次から飛ぶ前 ── `revealBlock` が呼ぶ)。
 * @returns 開いたか
 */
export function openLogDayCovering(
  host: HTMLElement,
  blocks: readonly Element[],
  levels: readonly number[],
  idx: number,
): boolean {
  if (!host.hasAttribute(LOG_DAYS_HOST_ATTR)) return false;
  const runs = logDayRuns(levels, daysOf(blocks, levels));
  let opened = false;
  for (const run of runs) {
    if (idx < run.start || idx >= run.end) continue;
    const row = blocks[run.start]!.previousElementSibling;
    if (row !== null && isDayRow(row) && isLogDayFolded(row)) {
      row.removeAttribute(DAY_FOLDED);
      opened = true;
    }
  }
  const grouping = logGrouping(runs);
  if (grouping.months.length > 0) {
    for (const mr of grouping.months) {
      if (idx < mr.start || idx >= mr.end) continue;
      const dayRow = blocks[mr.start]!.previousElementSibling;
      const row = dayRow?.previousElementSibling ?? null;
      if (row !== null && isLogMonthRow(row) && isLogDayFolded(row)) {
        row.removeAttribute(DAY_FOLDED);
        opened = true;
      }
    }
  }
  return opened;
}

/** 行の畳みを反転する印だけ(見え方は `applyHeadingFold` が計算し直す)。 */
export function flipLogDay(row: Element): void {
  if (!isLogDayRow(row)) return; // 偽造の印を持つ本文の塊は行ではない
  if (isLogAllRow(row)) return; // 「すべて」の行は `foldAllLogDays` の仕事
  if (row.hasAttribute(DAY_FOLDED)) row.removeAttribute(DAY_FOLDED);
  else row.setAttribute(DAY_FOLDED, '');
}

/** 見えている(隠れていない)畳める行。⚠ 月の畳みの中の日の行・章の畳みで隠れた行は数えない。 */
function visibleFoldableRows(host: HTMLElement): HTMLElement[] {
  return foldableRows(host).filter((r) => !r.hidden);
}

/**
 * 🔴 **いま見えている行が、全部畳まれているか**(#1441 レビュー)。「すべて」の字と、押したときの向きは
 * **この 1 つの答え**から決める ── 月の行だけ畳んだ状態(日の行は月の中に隠れている)で、字が「折りたたむ」のまま
 * 押すと「出す」側へ動く、という食い違いを作らない。
 */
export function logRowsAllFolded(host: HTMLElement): boolean {
  const v = visibleFoldableRows(host);
  return v.length > 0 && v.every((r) => r.hasAttribute(DAY_FOLDED));
}

function paintAllRowWith(allRow: HTMLElement, open: boolean): void {
  const label = open ? 'すべて折りたたむ' : 'すべて出す';
  if (allRow.textContent !== label) allRow.textContent = label;
  allRow.setAttribute('aria-expanded', open ? 'true' : 'false');
  const hint = open ? 'ログの日と月を、すべて折りたたみます' : 'ログの日と月を、すべて出します';
  allRow.title = hint;
  allRow.setAttribute('aria-label', hint);
}

/** 「すべて」の行の字を、いま見えている行から決め直す(`applyHeadingFold` が行の表示を決めた後に呼ぶ)。 */
export function paintAllRow(host: HTMLElement): void {
  const allRow = [...host.children].find((c): c is HTMLElement => c instanceof HTMLElement && isLogAllRow(c));
  if (allRow !== undefined) paintAllRowWith(allRow, !logRowsAllFolded(host));
}

/**
 * 🔴 **日・月の行を、まとめて畳む / 出す**(#1441 の「全部畳む / 全部開く」)。
 * 見えている行に 1 つでも開いている物があれば全部畳み、見えている行が全部畳んであれば全部出す(押し所は 1 つで、いつも何かが起きる)。
 * 🔑 印を付け外すだけ ── 見え方は `applyHeadingFold` が計算し直す。時刻見出しの畳みは触らない。
 * @returns 畳んだ(true)/ 出した(false)
 */
export function foldAllLogDays(host: HTMLElement): boolean {
  // 向きは「いま見えている物」から決める(字と同じ答え ── `logRowsAllFolded`)。印は隠れた行にも付け外す
  const rows = foldableRows(host);
  const fold = !logRowsAllFolded(host);
  for (const r of rows) {
    if (fold) r.setAttribute(DAY_FOLDED, '');
    else r.removeAttribute(DAY_FOLDED);
  }
  return fold;
}
