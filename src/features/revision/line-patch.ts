/**
 * 行ベースの lossless パッチ(P5c-1)。revision の逆向き差分チェーンが使う。
 *
 * 規律:
 * - **行末を含めて分割**── CRLF / 末尾改行の有無まで byte 一致で復元する
 *   (frontmatter splice と同じ規約)。行の連結は素の join('')
 * - 適用は**全消費を要求**する(source を使い切らないパッチはエラー)── 壊れた
 *   パッチから「それらしい本文」を作らない
 * - diff は Myers(O(ND))。前後の共通部分を削ってから走らせ、編集距離が予算を
 *   超えたら**中間まるごと置換**にフォールバックする(最小ではないが正しい)。
 *   最小性より**上限のある時間・メモリ**を優先する ── 巨大な全面書換で worker が
 *   固まる方が実害が大きい
 */

/** ops: 正数 = source から n 行 copy / 負数 = source の n 行を捨てる / 配列 = 挿入。 */
export interface LinePatch {
  v: 1;
  ops: Array<number | string[]>;
}

/** 編集距離の予算(超えたら置換フォールバック)。典型的な編集は 1 桁で収まる。 */
const MAX_EDIT_DISTANCE = 400;

/**
 * 行末を保持したまま分割(空文字は 0 行)。
 *
 * ⚠ 正規表現 `/(?<=\n)/` の split を使わない(R0-1、rust-wasm-strategy §3.4 / §4.1):
 * lookbehind split が `diffLines` 全体の **88%** を占めていた。**出力は完全に
 * 同一のまま**、実測で 47〜64% 短縮(分母 = 正規表現版。ascii/ja 20k 行・
 * 200KB 相当・単一巨大行・改行少で計測)。改行を含まない巨大行では 99% 短縮
 * (`indexOf` の native 走査が 1 回で終わるため ── charCodeAt ループ版はここで
 * 逆に 16% 悪化したので採らなかった)。
 *
 * Rust/wasm 化の勝敗を測る前にこれを回収するのが要点 ── 「言語のせいではない
 * 遅さ」を対照群に残したまま比較すると、間違った勝利宣言をする。
 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const out: string[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) break;
    out.push(text.slice(start, nl + 1));
    start = nl + 1;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

type Step = { k: 'copy' } | { k: 'del' } | { k: 'ins'; line: string };

/** Myers O(ND)。予算超過は null(caller が置換へフォールバック)。 */
function myers(a: readonly string[], b: readonly string[]): Step[] | null {
  const n = a.length;
  const m = b.length;
  const maxD = Math.min(MAX_EDIT_DISTANCE, n + m);
  const size = 2 * maxD + 1;
  const offset = maxD;
  let v = new Int32Array(size);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, offset);
    }
    v = v.slice();
  }
  return null; // 予算超過
}

function backtrack(
  trace: readonly Int32Array[],
  a: readonly string[],
  b: readonly string[],
  offset: number,
): Step[] {
  const steps: Step[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      steps.push({ k: 'copy' });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) steps.push({ k: 'ins', line: b[prevY]! });
      else steps.push({ k: 'del' });
      x = prevX;
      y = prevY;
    }
  }
  steps.reverse();
  return steps;
}

function stepsToOps(steps: readonly Step[]): Array<number | string[]> {
  const ops: Array<number | string[]> = [];
  let copy = 0;
  let del = 0;
  let ins: string[] = [];
  const flushCopy = (): void => {
    if (copy > 0) ops.push(copy);
    copy = 0;
  };
  const flushDel = (): void => {
    if (del > 0) ops.push(-del);
    del = 0;
  };
  const flushIns = (): void => {
    if (ins.length > 0) ops.push(ins);
    ins = [];
  };
  for (const s of steps) {
    if (s.k === 'copy') {
      flushDel();
      flushIns();
      copy++;
    } else if (s.k === 'del') {
      flushCopy();
      flushIns();
      del++;
    } else {
      flushCopy();
      flushDel();
      ins.push(s.line);
    }
  }
  flushCopy();
  flushDel();
  flushIns();
  return ops;
}

/**
 * 直前の diffLines が編集距離の予算を超えて「中間まるごと置換」に落ちたか。
 * 最小性を諦めた事実を観測可能にするためだけの印(挙動には影響しない)。
 */
let lastDiffFellBack = false;
export function didLastDiffFallBack(): boolean {
  return lastDiffFellBack;
}

/** `from` を `to` へ変換するパッチ。 */
export function diffLines(from: string, to: string): LinePatch {
  lastDiffFellBack = false;
  const a = splitLines(from);
  const b = splitLines(to);

  // 共通の前後を削る(典型的な編集はここでほぼ潰れる)
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const steps = myers(midA, midB);
  const ops: Array<number | string[]> = [];
  if (head > 0) ops.push(head);
  if (steps) {
    ops.push(...stepsToOps(steps));
  } else {
    // 予算超過 ── 中間をまるごと置換(最小ではないが**正しい**)。
    // ⚠ 暗黙に劣化する経路なので、起きたことが分かるようにしておく(R0-④):
    // パッチが膨らむと encodeReverse が全文保存を選び、容量が跳ねる。
    // 「なぜか履歴が重い」の調査で最初に疑う場所
    lastDiffFellBack = true;
    if (midA.length > 0) ops.push(-midA.length);
    if (midB.length > 0) ops.push(midB);
  }
  if (tail > 0) ops.push(tail);
  return { v: 1, ops };
}

/** パッチ適用。source を使い切らない / はみ出すパッチは throw(整合性の砦)。 */
export function applyLinePatch(from: string, patch: LinePatch): string {
  if (patch.v !== 1) throw new Error(`unsupported patch version: ${String(patch.v)}`);
  const src = splitLines(from);
  const out: string[] = [];
  let i = 0;
  for (const op of patch.ops) {
    if (typeof op === 'number') {
      if (op > 0) {
        if (i + op > src.length) throw new Error('patch: copy overruns source');
        for (let n = 0; n < op; n++) out.push(src[i++]!);
      } else if (op < 0) {
        i += -op;
        if (i > src.length) throw new Error('patch: delete overruns source');
      }
    } else {
      for (const line of op) out.push(line);
    }
  }
  if (i !== src.length) throw new Error('patch: source not fully consumed');
  return out.join('');
}

export function serializeLinePatch(patch: LinePatch): string {
  return JSON.stringify(patch);
}

/** 不正 JSON / 形違いは throw(黙って空パッチにしない)。 */
export function parseLinePatch(text: string): LinePatch {
  const raw = JSON.parse(text) as unknown;
  if (
    typeof raw !== 'object' ||
    raw === null ||
    (raw as LinePatch).v !== 1 ||
    !Array.isArray((raw as LinePatch).ops)
  ) {
    throw new Error('patch: malformed');
  }
  return raw as LinePatch;
}
