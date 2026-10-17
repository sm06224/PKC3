/**
 * 🔴 **本文に貼った画像の大きさ・寄せ**(#1640 ③。🟣 Gemini 依頼 37 の答え「A」)。
 *
 * ## 書き方
 *
 * `![名前](asset:鍵){w=50% align=center}` ── 画像の**直後**に `{...}` を置く。
 * - `w=` は本文の幅に対する割合(1〜100 の整数に `%`)。書かなければ今までどおり画面の幅いっぱい(縮小のみ)
 * - `align=` は `left` / `center` / `right`
 * 🔑 `:::paragraph{align=left}` と同じ `キー=値` の綴り。画面からは右クリックの「大きさ」「寄せ」が書く。
 *
 * ## 守ること
 * - ⚠ **読めない `{...}` は画像の属性にしない**(字のまま残す)── 知らない綴りを黙って食わない
 * - ⚠ 他の Markdown の読み手(GitHub など)では `{...}` が字として見える ── マニュアルに書く
 * - ⚠ **pure module**。読む側(`markdown-render.ts`)と書く側(`body-rewrite.ts`)が**この 1 本**を使う
 *   (綴りを 2 か所に持たない ── CLAUDE.md §7)
 */

export type ImageAlign = 'left' | 'center' | 'right';

export const IMAGE_ALIGNS: readonly ImageAlign[] = ['left', 'center', 'right'];

/** 右クリックのメニューに並べる大きさ(%)。⚠ 100 は「書かない」(= いままでどおり)なので並べない。 */
export const IMAGE_WIDTH_CHOICES: readonly number[] = [25, 50, 75];

export interface ImageAttrs {
  /** 本文の幅に対する割合(1〜100)。`null` = 書かれていない。 */
  readonly w: number | null;
  readonly align: ImageAlign | null;
}

export const NO_IMAGE_ATTRS: ImageAttrs = { w: null, align: null };

/** 画像の直後の `{...}`(波括弧の入れ子と改行は受けない)。 */
const ATTR_BLOCK = /^\{([^{}\n]*)\}/;

/**
 * 文字列の**先頭**にある `{w=50% align=center}` を読む。読めなければ `null`(字のまま残す)。
 * ⚠ 空の `{}` / 未知のキー / 範囲外の値 / 同じキーの二重書きは**全部 `null`**。
 */
export function parseImageAttrs(s: string): { attrs: ImageAttrs; length: number } | null {
  const m = ATTR_BLOCK.exec(s);
  if (m === null) return null;
  const parts = m[1]!.split(/\s+/).filter((p) => p !== '');
  if (parts.length === 0) return null;
  let w: number | null = null;
  let align: ImageAlign | null = null;
  for (const part of parts) {
    const w2 = /^w=(\d{1,3})%$/.exec(part);
    if (w2 !== null) {
      const n = Number(w2[1]);
      if (w !== null || n < 1 || n > 100) return null;
      w = n;
      continue;
    }
    const a2 = /^align=(left|center|right)$/.exec(part);
    if (a2 !== null) {
      if (align !== null) return null;
      align = a2[1] as ImageAlign;
      continue;
    }
    return null;
  }
  return { attrs: { w, align }, length: m[0].length };
}

/** 書く形。何も無ければ `''`(`{}` は書かない)。⚠ 順序は `w` → `align` で固定。 */
export function formatImageAttrs(a: ImageAttrs): string {
  const parts: string[] = [];
  if (a.w !== null) parts.push(`w=${a.w}%`);
  if (a.align !== null) parts.push(`align=${a.align}`);
  return parts.length === 0 ? '' : `{${parts.join(' ')}}`;
}

/**
 * 描くときの `style`(書き出し HTML・Word・PDF の元になる HTML にも載る)。
 * ⚠ 寄せは画像を**行として**置く(`display:block`)── インラインのままでは左右に寄せられない。
 */
export function imageAttrsStyle(a: ImageAttrs): string {
  const css: string[] = [];
  if (a.w !== null) css.push(`width:${a.w}%`);
  if (a.align !== null) {
    css.push('display:block');
    if (a.align === 'center') css.push('margin-left:auto', 'margin-right:auto');
    else if (a.align === 'right') css.push('margin-left:auto');
    else css.push('margin-right:auto');
  }
  return css.length === 0 ? '' : `${css.join(';')};`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ImageRefAt {
  /** `!` の位置。 */
  readonly start: number;
  /** `)` の次(`{...}` は含まない)。 */
  readonly end: number;
  /** `{...}` を含めた終わり。`{...}` が無い / 読めないなら `end` と同じ。 */
  readonly attrEnd: number;
  readonly attrs: ImageAttrs;
}

/**
 * 1 行の中から、鍵が `key` の画像(`![…](asset:key)`)を探す。最初の 1 つ。
 * ⚠ 見つからなければ `null`(呼び側は書かない)。
 */
export function findImageRef(line: string, key: string, nth = 0): ImageRefAt | null {
  return findImageRefs(line, key)[nth] ?? null;
}

/** 1 行の中の、鍵が `key` の画像を左から全部。同じ画像が 2 回あっても別々に返す(押した 1 つを書くため)。 */
export function findImageRefs(line: string, key: string): ImageRefAt[] {
  const re = new RegExp(
    `!\\[(?:[^\\]\\\\]|\\\\.)*\\]\\(<?asset:${escapeRe(key)}>?(?:\\s+"(?:[^"\\\\]|\\\\.)*")?\\)`,
    'g',
  );
  const out: ImageRefAt[] = [];
  for (const m of line.matchAll(re)) {
    const end = m.index! + m[0].length;
    const parsed = parseImageAttrs(line.slice(end));
    out.push({
      start: m.index!,
      end,
      attrEnd: parsed === null ? end : end + parsed.length,
      attrs: parsed === null ? NO_IMAGE_ATTRS : parsed.attrs,
    });
  }
  return out;
}

/**
 * その行の画像 1 つの大きさ・寄せを書き換える。渡さなかった札は**いま書かれているものを保つ**、`null` は外す。
 * ⚠ 画像が見つからないときは `null`(何も書かない)。変わらないときも元の行を返す(呼び側が比べる)。
 */
export function writeImageAttrs(
  line: string,
  key: string,
  patch: { w?: number | null; align?: ImageAlign | null },
  nth = 0,
): string | null {
  const at = findImageRef(line, key, nth);
  if (at === null) return null;
  const next: ImageAttrs = {
    w: patch.w === undefined ? at.attrs.w : patch.w,
    align: patch.align === undefined ? at.attrs.align : patch.align,
  };
  return line.slice(0, at.end) + formatImageAttrs(next) + line.slice(at.attrEnd);
}
