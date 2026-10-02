/**
 * 🔴 **入れ替わった行の中で、変わった字だけを見つける**(#1231 段①)。
 *
 * > user の物語: 行が 1 本まるごと塗られても、**どこが変わったのか**は目で探すしかない
 * > (「いまの本文」と「むかしの本文」で 1 字だけ違う行が、2 行並ぶ)。
 *
 * ⚠ **日本語には単語の境界が無い**ので、割る単位は**字**(UTF-16 の 1 単位ではなく
 *   コードポイント 1 つ ── 絵文字を半分に割らない)である。
 * 🔑 **pure module**。DOM も store も知らない。
 */

/** 字単位の比較をする行の長さの上限(**片方でも**超えたら比べない)。⚠ 超えた行は行ごと塗る。 */
export const CHAR_DIFF_MAX_CHARS = 2000;

export interface CharSeg {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/** 前後の同じ部分を除いた**中身の大きさ**の積 ── 比べるのにかかる量の見積もり(`sideRows` が予算に使う)。 */
export function charDiffCost(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const [head, tail] = commonEnds(x, y);
  return (x.length - head - tail) * (y.length - head - tail);
}

/** 先頭と末尾で同じ字の数。⚠ 重ならないように(短いほうの長さを超えない)。 */
function commonEnds(x: readonly string[], y: readonly string[]): [number, number] {
  const min = Math.min(x.length, y.length);
  let head = 0;
  while (head < min && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < min - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  return [head, tail];
}

/**
 * `a` → `b` の字ごとの差し引き。`same` + `del` をつなぐと `a`、`same` + `add` をつなぐと `b` に戻る。
 *
 * @returns 上限(`CHAR_DIFF_MAX_CHARS`)を**片方でも**超えるなら `null`(= 行ごと塗る側へ倒す。
 *   ⚠ 「全部変わった」という配列を返さない ── 呼び側が「比べていない」と「全部違う」を区別できなくなる)
 */
export function charDiff(a: string, b: string): CharSeg[] | null {
  const x = [...a];
  const y = [...b];
  if (x.length > CHAR_DIFF_MAX_CHARS || y.length > CHAR_DIFF_MAX_CHARS) return null;
  const [head, tail] = commonEnds(x, y);
  const mx = x.slice(head, x.length - tail);
  const my = y.slice(head, y.length - tail);
  const out: CharSeg[] = [];
  const push = (kind: CharSeg['kind'], text: string): void => {
    if (text === '') return;
    const last = out[out.length - 1];
    if (last !== undefined && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  push('same', x.slice(0, head).join(''));
  // LCS の長さ表(後ろから)。⚠ 上限が 2000 なので Uint16 に収まる
  const n = mx.length;
  const m = my.length;
  const w = m + 1;
  const t = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] =
        mx[i] === my[j]
          ? t[(i + 1) * w + j + 1]! + 1
          : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (mx[i] === my[j]) {
      push('same', mx[i]!);
      i++;
      j++;
    } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) {
      push('del', mx[i]!);
      i++;
    } else {
      push('add', my[j]!);
      j++;
    }
  }
  while (i < n) push('del', mx[i++]!);
  while (j < m) push('add', my[j++]!);
  push('same', x.slice(x.length - tail).join(''));
  return out;
}
