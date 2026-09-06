/**
 * 🔴 **表の升の入力欄を、塊の差し替えを跨いで生かす**(#745)。
 *
 * ## 何が起きていたか(実測 2026-09-06)
 *
 * > 5 列 3 行の表を上から埋める。A1 を押して打ち `Enter`、続けて A2 を押すと
 * > 欄が開く ── ところが数十ミリ秒後、その欄が**黙って消えて表に戻る**
 * > (打ちかけの字ごと)。焦点は本文の外へ落ちるので、打った字はどこにも入らない。
 *
 * 実測(同じ tick で「確定 → 隣を押す」を撃った):
 *
 * | 経過 | 欄 | 打ちかけの字 |
 * |---|---|---|
 * | +50ms | 生きている | 残っている |
 * | **+150ms** | **消えた** | **消えた** |
 *
 * 経路は 1 本:確定 → `SET_CSV_CELL` → `REQUEST_BODY_REWRITE` → worker を往復 →
 * `BODY_REWRITTEN` → 本文が変わるので `applyBlocks` が**その表の塊を差し替える** ──
 * 開いている `<input>` はその塊の中に居るので、一緒に捨てられる。
 *
 * ## 🔑 直し方 ── 開き直す(留めるのではなく)
 *
 * ⚠ **塊を留める(`pin`)道は採らない。** 留めると、さっき確定した升の新しい字が
 *   **欄を閉じるまで画面に出ない**(打ったのに古い字のまま見える)── いちばん
 *   気づけない嘘になる。
 * 🔑 だから**新しい塊を当ててから、同じ升の欄を開き直す** ── 画面は最新で、
 *   打ちかけの字と caret はそのまま戻る。
 *
 * ⚠ **開く仕掛けを 2 本にしない**(§7)── ここは `element.click()` を撃つだけで、
 *   欄を組むのは `binder.ts` の `edit-cell` **1 か所のまま**である。
 *   ⚠ 開き方を別に書くと、「押して開いた欄」と「開き直した欄」で
 *   確定の作法がずれる(= どちらかだけ本文に届かない形が生まれる)。
 */

/** 開いている升の欄の居場所と、打ちかけの中身。 */
export interface OpenCell {
  /** 原文の行番号(`data-pkc-cell-line`)。 */
  readonly line: string;
  /** 列番号(`data-pkc-cell-col`)。 */
  readonly col: string;
  /** 打ちかけの字(**確定前**)。 */
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

const INPUT = '[data-pkc-field="cell-input"]';

/** その升を名指しする選択子(⚠ 値は属性なので、引用符を含む字は来ない)。 */
function cellSelector(line: string, col: string): string {
  return `[data-pkc-action="edit-cell"][data-pkc-cell-line="${line}"][data-pkc-cell-col="${col}"]`;
}

/**
 * いま開いている升の欄を控える。開いていなければ `null`。
 * ⚠ **`host` の中だけ**を見る ── 別の面(添付の説明・小窓)の欄を掴まない。
 */
export function captureCellInput(host: HTMLElement): OpenCell | null {
  const input = host.querySelector<HTMLInputElement>(INPUT);
  if (input === null) return null;
  const cell = input.closest<HTMLElement>('[data-pkc-action="edit-cell"]');
  if (cell === null) return null;
  const line = cell.getAttribute('data-pkc-cell-line');
  const col = cell.getAttribute('data-pkc-cell-col');
  if (line === null || col === null) return null;
  return {
    line,
    col,
    value: input.value,
    start: input.selectionStart ?? input.value.length,
    end: input.selectionEnd ?? input.value.length,
  };
}

/**
 * 控えた升の欄を開き直す。
 *
 * ⚠ **同じ升が新しい塊に無ければ、何もしない** ── 行が消えた / 列が減った本文が
 *   届いたときに、**別の升へ打ちかけの字を移さない**(それはデータの取り違えである)。
 * ⚠ 既に欄が開いているなら何もしない(塊が差し替わらなかった回)。
 */
export function reopenCellInput(host: HTMLElement, keep: OpenCell): void {
  if (host.querySelector(INPUT) !== null) return;
  const cell = host.querySelector<HTMLElement>(cellSelector(keep.line, keep.col));
  if (cell === null) return;
  // 🔑 開くのは `binder.ts` の `edit-cell` ── ここは押すだけ(§7)
  cell.click();
  const input = host.querySelector<HTMLInputElement>(INPUT);
  if (input === null) return;
  /**
   * ⚠ **この 2 行は、smoke では殺せない**(実測 2026-09-06)。
   *
   * 欄が壊されるとき `blur` が撃たれて打ちかけの字は確定するので、
   * 本文を往復して**同じ字が戻ってくる** ── だから最後の姿は同じになる。
   * 🔑 それでも書くのは、**往復の間に打った字を取りこぼさないため**である
   *   (戻さないと、その窓では古い字が全選択されていて、次の 1 打で消える)。
   * ⚠ **鳴る検査は持っていない**と自覚して置く(守っていると書かない)。
   */
  input.value = keep.value;
  input.setSelectionRange(keep.start, keep.end);
  /** ⚠ `focus` は `binder.ts` が既に撃っている ── ここは念のためで、no-op である。 */
  input.focus();
}
