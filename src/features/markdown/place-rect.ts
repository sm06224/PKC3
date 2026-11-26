/**
 * 🔴 **枠の「位置と大きさ…」の入力を検める**(#529 W2。Gemini 裁定 = 採択、依頼 11〜13)。
 *
 * 右クリックの窓に打たれた x / y / 幅 / 高さの**字**を、本文へ書ける数にするか、断る理由にする。
 * 書くのは `place-notation.ts` の `setPlaceRect`(門は動かす・大きさを変えると同じ 1 本)── ここは
 * **窓の字を数にする所**だけを持つ(ブラウザの API を持たない)。
 *
 * ## 受ける形
 *
 * - **整数だけ**(px)。小数・数でない字・単位つきの字は、理由を言って断る(黙って丸めない)。
 * - 🔴 **x / y は負も受ける**(v4.0 Phase 2 / PR-09。無限キャンバスで左・上へ広げる)── 範囲は
 *   `-PLACE_RECT_MAX`〜`PLACE_RECT_MAX`。⚠ 幅・高さの負は今までどおり断る。
 * - 🔑 **全角数字(`１２０`)も受ける** ── 日本語入力のまま打てる(NFKC で半角へ揃える)。
 *   全角のマイナス(`－１２０`)も NFKC で半角の `-` に揃うので、x / y では負の数として読む。
 * - 🔑 **空欄は「変えない」** ── 幅・高さを書いていない枠(読む画面の幅で出る)の欄は、空のまま
 *   確定してよい。空欄を 0 と読むと、触っていない札が書き換わる。
 * - **上限は 100000 px**。描画は座標をそのまま CSS に渡すので、桁違いの値は
 *   スクロールの端を遠くへ押し出して「枠が消えた」ように見える。
 */

/** 窓に打たれる字(4 欄)。 */
export interface PlaceRectInput {
  readonly x: string;
  readonly y: string;
  readonly w: string;
  readonly h: string;
}

/** 本文へ書く数。⚠ 無い札は書かない(= 変えない)。 */
export interface PlaceRectValue {
  readonly x?: number;
  readonly y?: number;
  readonly w?: number;
  readonly h?: number;
}

export type PlaceRectKey = 'x' | 'y' | 'w' | 'h';

export const PLACE_RECT_KEYS: readonly PlaceRectKey[] = ['x', 'y', 'w', 'h'];

/** 欄の名前(窓の見出しと断り文の主語。同じ字を使う)。 */
export const PLACE_RECT_LABELS: Readonly<Record<PlaceRectKey, string>> = {
  x: 'x(左から)',
  y: 'y(上から)',
  w: '幅',
  h: '高さ',
};

export const PLACE_RECT_MAX = 100000;

/**
 * 欄ごとの下限。⚠ 幅・高さが 0 の枠は掴めない(描画の最小は 120 × 40)ので 1 から。
 * 🔴 x / y は負の端まで(無限キャンバス)── 通常表示でも描画が画面の中へ寄せて見せる(`place-board.ts`)。
 */
const MIN: Readonly<Record<PlaceRectKey, number>> = { x: -PLACE_RECT_MAX, y: -PLACE_RECT_MAX, w: 1, h: 1 };

/** 位置(x / y)の札か ── 負を受ける欄。 */
function signed(key: PlaceRectKey): boolean {
  return key === 'x' || key === 'y';
}

/** 位置の値として書けるか(x / y の共通の門。整数で `±PLACE_RECT_MAX` の中)。 */
export function isPlacePosition(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && Math.abs(n) <= PLACE_RECT_MAX;
}

/** 本文へ書ける 1 つの値か(`setPlaceRect` の門と窓の検めが同じ規則を引く)。 */
export function isPlaceRectNumber(key: PlaceRectKey, n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= MIN[key] && n <= PLACE_RECT_MAX;
}

export type PlaceRectResult =
  | { readonly ok: true; readonly rect: PlaceRectValue }
  | { readonly ok: false; readonly key: PlaceRectKey; readonly error: string };

/**
 * 窓の 4 欄を検める。⚠ 最初に断った欄で止める(`key` で窓がその欄へ焦点を返す)。
 * 4 欄とも空なら `ok` で空の値(= 何も変えない)。
 */
export function parsePlaceRect(input: PlaceRectInput): PlaceRectResult {
  const out: { x?: number; y?: number; w?: number; h?: number } = {};
  for (const key of PLACE_RECT_KEYS) {
    const raw = input[key].normalize('NFKC').trim();
    if (raw === '') continue;
    const name = PLACE_RECT_LABELS[key];
    // ⚠ NFKC は全角のマイナス(U+FF0D)を半角へ揃えるが、マイナス記号(U+2212)は揃えない ── 揃えてから読む
    const text = raw.replace(/^\u2212/, '-');
    if (text.startsWith('-') && !signed(key)) {
      return { ok: false, key, error: `${name}は 1 以上で入れてください` };
    }
    if (!/^-?\d+$/.test(text)) {
      return { ok: false, key, error: `${name}は整数(px)で入れてください` };
    }
    const n = Number(text);
    if (n > PLACE_RECT_MAX) {
      return { ok: false, key, error: `${name}は ${PLACE_RECT_MAX} 以下で入れてください` };
    }
    if (n < MIN[key]) {
      return { ok: false, key, error: `${name}は ${MIN[key]} 以上で入れてください` };
    }
    out[key] = n;
  }
  return { ok: true, rect: out };
}
