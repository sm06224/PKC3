/**
 * 🔴 **塊を跨ぐ取り消し**(2026-08-05。ライブエディタ S8。設計 doc §6 / §9 論点 C)。
 *
 * ライブエディタは行ごとに `<textarea>` を出し入れするので、**ブラウザ自前の取り消しは
 * その行の中だけ**しか戻せない。行を閉じた時点でその履歴は消えるため、
 * 「1 つ前の編集を取り消す」が効かない ── これが**既定 ON にしない理由**だった
 * (user 裁定 §9 論点 C)。ここが確定 1 件ずつの履歴を持つ。
 *
 * ## 粒度の規約(user に説明できる形にする)
 * - **行の中では OS の取り消し**(打鍵 1 つずつ)── 入力欄が焦点を持っている間
 * - **行の外ではこの履歴**(確定 1 件ずつ)── 入力欄を閉じた後
 * 境目が「入力欄に居るかどうか」なので、判定が 1 つで済む。
 *
 * ## 🔑 pure module
 * DOM も state も知らない。⚠ **戻せるかを必ず照合する**
 * ── 記録した「入った行」がいま本文に**実在するか**を確かめてから当てる。
 * 外から本文が差し替わった(取り込み / 別タブの保存)後に盲目的に当てると、
 * **無関係な行を潰す**(= 静かなデータ破壊)。照合の材料は持っているので捨てない。
 */

/** 確定 1 件。⚠ 行の配列で持つ(本文全体を 2 部持たない)。 */
export interface EditStep {
  /** 置き換えた原文の開始行(0 始まり)。 */
  readonly start: number;
  /** 置き換える前に在った行。空 = 挿入だけだった(末尾への書き足し)。 */
  readonly removed: readonly string[];
  /** 置き換えた後に入った行。 */
  readonly inserted: readonly string[];
}

export interface Journal {
  readonly past: readonly EditStep[];
  readonly future: readonly EditStep[];
}

export const EMPTY_JOURNAL: Journal = { past: [], future: [] };

/**
 * 履歴の上限。⚠ **無限に持たない**(常駐メモリが編集回数で増える ──
 * user 指示 2026-08-03「効くのは定常」)。行の配列なので 1 件は小さい。
 */
export const JOURNAL_LIMIT = 200;

/**
 * 🔑 **本文への当て方はここ 1 か所**(`commit` の継ぎ足しもこれを使う)。
 * `[start, endIncl]`(両端含む)を `replacement` の行で置き換える。
 * ⚠ `start === 行数` かつ `endIncl === 行数 − 1` は**末尾への挿入**になる
 * (空区間 ── 規則を分岐させずに書き足しが表せる)。
 */
export function spliceLines(
  text: string,
  start: number,
  endIncl: number,
  replacement: string,
): string {
  const lines = text.split('\n');
  return [...lines.slice(0, start), ...replacement.split('\n'), ...lines.slice(endIncl + 1)].join(
    '\n',
  );
}

/** 確定 1 件を履歴の材料にする(`text` は**置き換える前**の本文)。 */
export function stepFor(
  text: string,
  start: number,
  endIncl: number,
  replacement: string,
): EditStep {
  const lines = text.split('\n');
  return {
    start,
    removed: lines.slice(start, endIncl + 1),
    inserted: replacement.split('\n'),
  };
}

/**
 * 1 件記録する。
 * ⚠ **やり直しの先は捨てる** ── 分岐した歴史を持つと「どちらへ戻るのか」が
 * user に説明できなくなる(どの編集器もそうしている)。
 */
export function record(j: Journal, step: EditStep, limit = JOURNAL_LIMIT): Journal {
  const past = [...j.past, step];
  return { past: past.slice(Math.max(0, past.length - limit)), future: [] };
}

/** 差し替えを当てる(`from` が在る所を `to` にする)。照合は呼び側。 */
function swap(text: string, start: number, from: readonly string[], to: readonly string[]): string {
  const lines = text.split('\n');
  return [...lines.slice(0, start), ...to, ...lines.slice(start + from.length)].join('\n');
}

/**
 * 🔴 **その行がいま本文に実在するか**を照合する。
 *
 * ⚠ ここが無いと、外から本文が差し替わった後の取り消しが**別の行を潰す**。
 * 記録した内容そのものが照合材料なので、**捨てずに使う**。
 */
function matches(text: string, start: number, expect: readonly string[]): boolean {
  const lines = text.split('\n');
  if (start < 0 || start > lines.length) return false;
  if (start + expect.length > lines.length) return false;
  for (let i = 0; i < expect.length; i += 1) {
    if (lines[start + i] !== expect[i]) return false;
  }
  return true;
}

export interface JournalMove {
  text: string;
  journal: Journal;
  /** 動かした 1 件(呼び側が「どこが変わったか」を知る材料)。 */
  step: EditStep;
}

/**
 * 1 歩戻す。戻せない(履歴が空 / 本文が食い違う)なら `null`。
 * ⚠ 食い違ったときは**その 1 件を捨てる**のではなく `null` を返す
 * ── 黙って飛ばすと、次の Ctrl+Z が想定外の場所へ当たる。
 */
export function undo(j: Journal, text: string): JournalMove | null {
  const step = j.past[j.past.length - 1];
  if (step === undefined) return null;
  if (!matches(text, step.start, step.inserted)) return null;
  return {
    text: swap(text, step.start, step.inserted, step.removed),
    journal: { past: j.past.slice(0, -1), future: [step, ...j.future] },
    step,
  };
}

/** 1 歩やり直す。やり直せないなら `null`。 */
export function redo(j: Journal, text: string): JournalMove | null {
  const step = j.future[0];
  if (step === undefined) return null;
  if (!matches(text, step.start, step.removed)) return null;
  return {
    text: swap(text, step.start, step.removed, step.inserted),
    journal: { past: [...j.past, step], future: j.future.slice(1) },
    step,
  };
}
