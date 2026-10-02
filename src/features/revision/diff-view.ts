/**
 * 🔴 **版のちがいを、行で見せる**(#398 段②)。
 *
 * > user の物語: 3 日前の版に戻したい。履歴を開くと**題名が 3 つとも同じ**で、
 * > 日時しか手がかりが無い ── どれが目当てか、押すまで分からない。
 *
 * ⚠ 「押せば戻せる」では足りない。復元は前進変異なので**データは失われない**が、
 *   試すたびに履歴へ 1 件積まれ、⚠ **次に探すときの手がかりをさらに埋める**
 *   ── これは「消える」問題ではなく「**探せなくなっていく**」問題である。
 *
 * 🔑 **新しい保存形は要らない** ── 差分は `diffLines`(既にある)で組む。
 * 🔑 **pure module**。DOM も store も知らない。
 */
import { diffLines, splitLines } from './line-patch';

/** 見せる行 1 つ。⚠ `text` は**行末を含まない**(器が改行を持つ)。 */
export interface DiffRow {
  kind: 'same' | 'add' | 'del' | 'gap';
  text: string;
  /** `gap` のときだけ ── 畳んだ行数(「⋯ N 行」と出す材料)。 */
  skipped?: number;
}

/**
 * 🔴 **PC のファイルとのちがいを出せないときの字**(#1231 着地後レビュー)。⚠ 画面に出る字なので 1 か所に置く。
 * 「違いはありません」とは**言わない**(読めなかったのに「同じ」と言うのは嘘)── 理由を言う。
 * - `DIFF_FILE_UNAVAILABLE_NOTE` … 書き戻しの確認(大きいのか読めないのかを分けずに言う)
 * - `DIFF_FILE_TOO_LARGE_NOTE` … 履歴の面(大きすぎると分かっているとき)
 */
export const DIFF_FILE_UNAVAILABLE_NOTE = 'ファイルが大きい(または読めない)ため、ちがいは出せません';
export const DIFF_FILE_TOO_LARGE_NOTE = 'ファイルが大きいため、ちがいは出せません';

/** 行末を落とす(表示用)。⚠ 原文の `\r` も落とす(画面に出さない)。 */
const bare = (line: string): string => line.replace(/\r?\n$/, '');

/**
 * `from` → `to` のちがいを行で返す。
 *
 * @param context 変わった行の前後に残す行数。⚠ **0 にしない** ── 前後が無いと
 *   「どこの `- 牛乳` か」が分からない(同じ字の行は本文に何度でも出る)。
 *
 * ⚠ **変わっていない所は畳む**(`gap`)── 5000 行のログで全行出すと、
 *   ちがいが**画面から消える**(探せない、という当の問題を作り直すことになる)。
 * ⚠ 畳むのは **`context * 2` 行より長い**塊だけ ── 2 行のために「⋯ 2 行」と
 *   出すと、かえって読みにくい。
 */
export function diffRows(from: string, to: string, context = 2): DiffRow[] {
  const src = splitLines(from);
  const rows: DiffRow[] = [];
  let i = 0;
  for (const op of diffLines(from, to).ops) {
    if (typeof op === 'number') {
      if (op > 0) {
        for (let n = 0; n < op; n++) rows.push({ kind: 'same', text: bare(src[i++]!) });
      } else if (op < 0) {
        for (let n = 0; n < -op; n++) rows.push({ kind: 'del', text: bare(src[i++]!) });
      }
    } else {
      for (const line of op) rows.push({ kind: 'add', text: bare(line) });
    }
  }
  return collapse(rows, context);
}

/** 変わっていない長い塊を `gap` へ畳む。 */
function collapse(rows: readonly DiffRow[], context: number): DiffRow[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.kind === 'same') continue;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) {
      keep[j] = true;
    }
  }
  const out: DiffRow[] = [];
  let run = 0;
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) {
      if (run > 0) {
        out.push({ kind: 'gap', text: '', skipped: run });
        run = 0;
      }
      out.push(rows[i]!);
    } else {
      run++;
    }
  }
  if (run > 0) out.push({ kind: 'gap', text: '', skipped: run });
  return out;
}

/**
 * ちがいの総量。⚠ **`diffRows` から数えない** ── あちらは畳むので、
 *   畳んだぶんを数え落とす。ここは畳む前の ops から数える。
 */
export function diffCounts(from: string, to: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of diffLines(from, to).ops) {
    if (typeof op === 'number') {
      if (op < 0) removed += -op;
    } else added += op.length;
  }
  return { added, removed };
}

/**
 * 履歴の日時を `YYYY-MM-DD HH:MM` に縮める(#1231 段①。版を名指しする字に使う)。
 * ⚠ 読めない形はそのまま返す(縮めようとして字を落とさない)。`null` はそのまま `null`。
 */
export function shortStamp(createdAt: string | null): string | null {
  if (createdAt === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(createdAt);
  return m === null ? createdAt : `${m[1]} ${m[2]}`;
}
