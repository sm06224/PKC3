/**
 * 🔴 **本文のバッククォートで囲んだ色コード(`` `#3b82f6` ``)の読み方**(#1224)。
 *
 * > user の物語:デザインの覚え書きに `` `#3b82f6` `` と書いた。どんな色だったかを、
 * > コードを読んで思い浮かべるのではなく**隣の小さな四角で見たい**。違う色にしたくなったら、
 * > その四角を押して選び直せば本文のコードが書き換わる。
 *
 * ## 規則(Gemini 裁定 2026-10-01、#1224 のコメント)
 * - **見本を出すのは「バッククォートで囲んだ色コード」だけ**(地の文の `#3b82f6` には出さない)。
 *   中身が `#` + 16 進の **3 / 6 / 8 桁ちょうど**のときだけ(7 桁・`#ggg` は出さない)。
 * - **押して直せるのは 6 桁小文字 `#rrggbb` だけ**。3 桁・大文字・8 桁(透明度つき)は見本だけ
 *   出して、**書いた物の綴りを勝手に変えない**。
 *
 * ## このファイルが「規則の 1 か所」である(§7)
 * 見本を**描く側**(`markdown-render.ts`)と、押された所を**原文の中から探して書き換える側**
 * (`body-rewrite.ts` の `kind: 'color'`)は、**同じ走査(`colorSpansOfLine`)**で
 * 「その行の何番目の色コードか」を数える。2 本目の数え方を書かない。
 * ⚠ 描く側は markdown-it の `code_inline` を数え、こちらは原文の行を走る ── 別の観測なので、
 *   描く側は**焼く前にこの走査と食い違わないか**を確かめて、食い違うなら押せる形にしない
 *   (`confirmColorSpan`)。⚠ 食い違う形(複数行にまたがるコード等)で別の字を書き換えない。
 *
 * ⚠ **pure module**。browser API を使わない。
 */

/** 見本を出す形(3 / 6 / 8 桁の 16 進、大文字小文字は問わない)。 */
const COLOR_CODE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** 押して直せる形(6 桁・小文字だけ)。⚠ 書いた物の綴りを変えないための狭さ。 */
const EDITABLE_COLOR = /^#[0-9a-f]{6}$/;

/** インラインコードの中身が、見本を出す色コードか。 */
export function isColorCode(content: string): boolean {
  return COLOR_CODE.test(content);
}

/** 押して直せる色コードか(`<input type=color>` が返す形 = 6 桁小文字)。 */
export function isEditableColor(content: string): boolean {
  return EDITABLE_COLOR.test(content);
}

/** 1 行の中のインラインコード 1 つ。`start`〜`end` は**中身**の範囲(囲みのバッククォートを含まない)。 */
export interface CodeSpan {
  readonly start: number;
  readonly end: number;
  readonly content: string;
}

/**
 * 1 行の中のインラインコードを、左から全部返す(CommonMark の規則を 1 行に限って写す)。
 *
 * - 長さ n のバッククォートの並びは、**同じ長さちょうど**の並びで閉じる(閉じが無ければ字のまま)。
 * - `\` の直後のバッククォートは**囲みではない**(コードの外でだけ)。
 * - 中身の**前後が空白 1 つずつ**(かつ全部が空白でない)なら、その 1 つずつを中身に含めない
 *   (markdown-it の `code_inline` と同じ ── `` ` #fff ` `` の中身は `#fff`)。
 * ⚠ 複数行にまたがるコードは**この関数では閉じない**(1 行だけを見る)── 描く側が
 *   {@link confirmColorSpan} で食い違いを見つけて押せる形にしない。
 */
export function inlineCodeSpans(line: string): CodeSpan[] {
  const out: CodeSpan[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch !== '`') {
      i += 1;
      continue;
    }
    let n = 0;
    while (line[i + n] === '`') n += 1;
    // 閉じ: 同じ長さちょうどの並びを、この先から探す
    let j = i + n;
    let close = -1;
    while (j < line.length) {
      if (line[j] !== '`') {
        j += 1;
        continue;
      }
      let m = 0;
      while (line[j + m] === '`') m += 1;
      if (m === n) {
        close = j;
        break;
      }
      j += m;
    }
    if (close === -1) {
      i += n; // 閉じが無い並びは字のまま
      continue;
    }
    let start = i + n;
    let end = close;
    const raw = line.slice(start, end);
    if (raw.length >= 2 && raw[0] === ' ' && raw[raw.length - 1] === ' ' && raw.trim() !== '') {
      start += 1;
      end -= 1;
    }
    out.push({ start, end, content: line.slice(start, end) });
    i = close + n;
  }
  return out;
}

/** 1 行の中の**色コードだけ**を左から返す(数える単位は「何番目の色コードか」)。 */
export function colorSpansOfLine(line: string): CodeSpan[] {
  return inlineCodeSpans(line).filter((s) => isColorCode(s.content));
}

/**
 * 描く側の確認:この行の `nth` 番目の色コードが、描く側が見た `content` と**同じ**か。
 * ⚠ 同じでなければ押せる形にしない(数え方が食い違う形 ── 別の字を書き換えない)。
 */
export function confirmColorSpan(line: string | undefined, nth: number, content: string): boolean {
  if (line === undefined) return false;
  return colorSpansOfLine(line)[nth]?.content === content;
}

/**
 * 1 行の `nth` 番目の色コードを `to` に差し替える。⚠ **その色コードの範囲だけ**を入れ替える
 * (前後の字・同じ行の別の色は 1 バイトも動かさない)。
 *
 * ⚠ `from` は押した時点の字 ── 一致しなければ `null`(別の窓の書込で行が変わっている。
 *   当てずっぽうで別の字を書き換えない)。
 * ⚠ `from` も `to` も**押して直せる形**(6 桁小文字)でなければ `null`。
 */
export function replaceColorSpan(line: string, nth: number, from: string, to: string): string | null {
  if (!isEditableColor(from) || !isEditableColor(to)) return null;
  const span = colorSpansOfLine(line)[nth];
  if (span === undefined || span.content !== from) return null;
  return line.slice(0, span.start) + to + line.slice(span.end);
}
