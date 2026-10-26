/**
 * 🔴 **2 つの文章を行で見比べ、ちがいの 1 か所ずつをどちらかへ揃える**(#1231。user 指示 2026-10-26「全部やるのです」)。
 *
 * 履歴の面の「くらべる相手」(段①)は**見るだけ**だった(🟣 Gemini 裁定 Q1 = A: 行ごとの反映 B は見送り)。
 * 今回は user 指示で、**ちがいの 1 か所を左から右へ / 右から左へ取り込む**別ウィンドウ(差分マージ)を足す。
 * 差分の計算(Myers)と左右への並べ方・字単位の強調は、履歴の面と**同じ部品**(`diffLines` / `sideRows` / `charDiff`)を使う。
 *
 * ## 決めたこと
 *
 * - **ちがいの単位は「変わった塊」**(続く削除と追加を 1 つ)。1 行ずつではなく、塊ごとに → ← を押す。
 *   行ごとの取り込みは、塊を揃えたあとに残った差を**もう一度塊として**見つけ直せば足りる、と判断した。
 * - 取り込むと、その塊は**両側とも同じ字**になる(`same` に変わる)。取り消しは呼び側が積む控え(`MergeSession`)で戻す。
 * - **字を書き換えるのは「ノート」の側だけ**。履歴の版・PC のファイルは読むだけ(版は書き換えられない・
 *   ファイルは別の書き戻しの確認を通る)── 呼び側が `editable` を決め、ここは**どちらの向きへ取り込めるか**を返さない
 *   (規則は 1 か所: 画面が `editable` で押せる向きを決める)。
 * - **行末を含めて持つ**(`splitLines`)。CRLF・末尾の改行の有無まで往復で保つ。
 *
 * 🔑 **pure module**。DOM も store も知らない。
 */
import { diffLines, splitLines } from './line-patch';
import { sideRows, type SideRow } from './diff-side';
import type { DiffRow } from './diff-view';

/** 片側の行数の上限。⚠ 超えたら比べない(画面が理由を言う)── 巨大な文章で窓が固まらないため。 */
export const MERGE_MAX_LINES = 20_000;

/** 同じ行の塊と、変わった塊。`a` = 左の行、`b` = 右の行(どちらも行末を含む)。 */
export type MergeSeg =
  | { readonly kind: 'same'; readonly lines: readonly string[] }
  | { readonly kind: 'change'; readonly a: readonly string[]; readonly b: readonly string[] };

/**
 * 左右の文章から塊の並びを作る。
 * @returns どちらかが `MERGE_MAX_LINES` を超えるなら `null`
 */
export function buildMergeSegs(left: string, right: string): MergeSeg[] | null {
  const a = splitLines(left);
  const b = splitLines(right);
  if (a.length > MERGE_MAX_LINES || b.length > MERGE_MAX_LINES) return null;
  const segs: MergeSeg[] = [];
  let i = 0;
  let del: string[] = [];
  let ins: string[] = [];
  const flush = (): void => {
    if (del.length > 0 || ins.length > 0) segs.push({ kind: 'change', a: del, b: ins });
    del = [];
    ins = [];
  };
  for (const op of diffLines(left, right).ops) {
    if (typeof op === 'number') {
      if (op > 0) {
        flush();
        segs.push({ kind: 'same', lines: a.slice(i, i + op) });
        i += op;
      } else if (op < 0) {
        del = del.concat(a.slice(i, i - op));
        i -= op;
      }
    } else {
      ins = ins.concat(op);
    }
  }
  flush();
  return normalizeSegs(segs);
}

/** 続く `same` を 1 つにし、空の `same` を捨てる。 */
function normalizeSegs(segs: readonly MergeSeg[]): MergeSeg[] {
  const out: MergeSeg[] = [];
  for (const s of segs) {
    if (s.kind === 'same') {
      if (s.lines.length === 0) continue;
      const last = out[out.length - 1];
      if (last !== undefined && last.kind === 'same') {
        out[out.length - 1] = { kind: 'same', lines: last.lines.concat(s.lines) };
        continue;
      }
    }
    out.push(s);
  }
  return out;
}

/** ちがいの塊の数。 */
export function countHunks(segs: readonly MergeSeg[]): number {
  return segs.filter((s) => s.kind === 'change').length;
}

/** 左(`'a'`)か右(`'b'`)の、いまの全文。 */
export function mergeText(segs: readonly MergeSeg[], side: 'a' | 'b'): string {
  let out = '';
  for (const s of segs) out += s.kind === 'same' ? s.lines.join('') : s[side].join('');
  return out;
}

/**
 * `hunk` 番目(0 始まり)のちがいを、`from` の側の字に揃える(`'a'` = 左の字を右へ / `'b'` = 右の字を左へ)。
 * 範囲外は `null`(何もしない)。
 */
export function resolveHunk(
  segs: readonly MergeSeg[],
  hunk: number,
  from: 'a' | 'b',
): MergeSeg[] | null {
  let n = -1;
  const out: MergeSeg[] = [];
  let done = false;
  for (const s of segs) {
    if (s.kind === 'change') {
      n += 1;
      if (n === hunk) {
        out.push({ kind: 'same', lines: s[from] });
        done = true;
        continue;
      }
    }
    out.push(s);
  }
  return done ? normalizeSegs(out) : null;
}

/** 残っているちがいを全部、`from` の側の字に揃える。 */
export function resolveAll(segs: readonly MergeSeg[], from: 'a' | 'b'): MergeSeg[] {
  return normalizeSegs(segs.map((s): MergeSeg => (s.kind === 'same' ? s : { kind: 'same', lines: s[from] })));
}

// ── 表示の行 ─────────────────────────────────────────────────────────

/** 画面に並べる行。`change` は 1 つの塊の中の対(左右)をまとめて持つ。 */
export type MergeRow =
  | { kind: 'same'; text: string }
  | { kind: 'gap'; skipped: number }
  | { kind: 'change'; hunk: number; pairs: Extract<SideRow, { kind: 'pair' }>[] };

const bare = (line: string): string => line.replace(/\r?\n$/, '');

/** 同じ行の長い塊をこの行数より多く並べない(前後の `CONTEXT` 行だけ残して畳む)。 */
export const MERGE_CONTEXT = 2;

/**
 * 画面の行を作る。
 * @param showAll `true` = 同じ行も全部出す
 */
export function mergeRows(segs: readonly MergeSeg[], showAll = false): MergeRow[] {
  // 1. 塊ごとに DiffRow 化 → sideRows で字単位の強調つきの対にする(予算は全体で 1 回分)
  const flat: DiffRow[] = [];
  const spans: { hunk: number; pairs: number }[] = [];
  let h = -1;
  for (const s of segs) {
    if (s.kind === 'same') {
      for (const l of s.lines) flat.push({ kind: 'same', text: bare(l) });
    } else {
      h += 1;
      for (const l of s.a) flat.push({ kind: 'del', text: bare(l) });
      for (const l of s.b) flat.push({ kind: 'add', text: bare(l) });
      spans.push({ hunk: h, pairs: Math.max(s.a.length, s.b.length) });
    }
  }
  const sided = sideRows(flat);
  // 2. 出てきた対の列を、塊の単位に束ね直す
  const rows: MergeRow[] = [];
  let k = 0;
  let span = 0;
  for (const s of segs) {
    if (s.kind === 'same') {
      for (let n = 0; n < s.lines.length; n++) {
        const r = sided[k++]!;
        rows.push({ kind: 'same', text: r.kind === 'pair' && r.left !== null ? r.left.text : '' });
      }
    } else {
      const sp = spans[span++]!;
      const pairs: Extract<SideRow, { kind: 'pair' }>[] = [];
      for (let n = 0; n < sp.pairs; n++) pairs.push(sided[k++] as Extract<SideRow, { kind: 'pair' }>);
      rows.push({ kind: 'change', hunk: sp.hunk, pairs });
    }
  }
  return showAll ? rows : foldSame(rows);
}

/** 変わった塊の前後 `MERGE_CONTEXT` 行だけ残して、同じ行の長い並びを畳む。 */
function foldSame(rows: readonly MergeRow[]): MergeRow[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.kind !== 'change') return;
    keep[i] = true;
    for (let j = 1; j <= MERGE_CONTEXT; j++) {
      if (i - j >= 0) keep[i - j] = true;
      if (i + j < rows.length) keep[i + j] = true;
    }
  });
  const out: MergeRow[] = [];
  let run = 0;
  rows.forEach((r, i) => {
    if (r.kind === 'change' || keep[i]) {
      if (run > 0) {
        out.push({ kind: 'gap', skipped: run });
        run = 0;
      }
      out.push(r);
    } else {
      run += 1;
    }
  });
  // 変わった塊が 1 つも無いとき(全部同じ)は、畳まずにそのまま全部出す
  if (!rows.some((r) => r.kind === 'change')) return [...rows];
  if (run > 0) out.push({ kind: 'gap', skipped: run });
  return out;
}

/** 左右が同じになったか(ちがいの塊が 0)。 */
export function isMerged(segs: readonly MergeSeg[]): boolean {
  return countHunks(segs) === 0;
}

// ── 取り消しの控え ───────────────────────────────────────────────────

/**
 * 取り込みの控え。⚠ `segs` は不変の配列なので、積むのは参照だけ(字を複製しない)。
 * 上限を超えたら古い物から捨てる ── 控えが窓の常駐を押し上げない。
 */
export const MERGE_UNDO_MAX = 100;

export class MergeSession {
  private current: MergeSeg[];
  private readonly undo: MergeSeg[][] = [];
  private readonly redo: MergeSeg[][] = [];
  private readonly first: MergeSeg[];

  constructor(segs: MergeSeg[]) {
    this.current = segs;
    this.first = segs;
  }

  get segs(): readonly MergeSeg[] {
    return this.current;
  }
  get canUndo(): boolean {
    return this.undo.length > 0;
  }
  get canRedo(): boolean {
    return this.redo.length > 0;
  }

  /** 取り込めたら `true`。範囲外は何もしない。 */
  take(hunk: number, from: 'a' | 'b'): boolean {
    const next = resolveHunk(this.current, hunk, from);
    if (next === null) return false;
    this.push(next);
    return true;
  }

  /** 残りを全部、`from` の側へ揃える。ちがいが無ければ何もしない(`false`)。 */
  takeAll(from: 'a' | 'b'): boolean {
    if (countHunks(this.current) === 0) return false;
    this.push(resolveAll(this.current, from));
    return true;
  }

  private push(next: MergeSeg[]): void {
    this.undo.push(this.current);
    if (this.undo.length > MERGE_UNDO_MAX) this.undo.shift();
    this.redo.length = 0;
    this.current = next;
  }

  undoOne(): boolean {
    const prev = this.undo.pop();
    if (prev === undefined) return false;
    this.redo.push(this.current);
    this.current = prev;
    return true;
  }

  redoOne(): boolean {
    const next = this.redo.pop();
    if (next === undefined) return false;
    this.undo.push(this.current);
    this.current = next;
    return true;
  }

  /** 最初の状態(読み込んだ直後)へ戻す。取り消しの控えも消す。 */
  reset(): void {
    this.undo.length = 0;
    this.redo.length = 0;
    this.current = this.first;
  }
}
