/**
 * 🔴 **板(付箋)と線の「色・太さ」の綴り**(#530 段④。Gemini 裁定 A、2026-10-02)。
 *
 * > user の物語: 図の付箋を「ここは要注意」と一目で分かる色にしたい。線も、
 * > 太い幹と細い補助線を描き分けたい。色は右クリックから選べて、外せば元の見た目に戻る。
 *
 * ## 書き方(本文が正本。面は別のデータを持たない)
 *
 * | 対象 | 札 | 値 |
 * |---|---|---|
 * | 付箋 | `fill=` | 塗りの色 |
 * | 付箋 | `stroke=` | 枠の色 |
 * | 線 | `stroke=` | 線の色 |
 * | 線 | `width=` | 太さ(px) |
 *
 * ## 🔴 値は**決まった綴りだけ**を受ける(素通しにしない)
 *
 * 色の字は**本文に user が手で書ける**。素通しにすると
 * ① 画面では CSS へ流れる(`fill=javascript:…` / `url(…)` のような字が値に入る)
 * ② PowerPoint の XML へ流れて**壊れた `.pptx`** になる。
 * 🔑 だから受けるのは **16 進の `#rgb` / `#rrggbb` だけ**で、読めない字は
 *   **描くときに無視する**(= 札が無いのと同じ見た目。本文からは消さない)。
 * ⚠ 色の名前(`red`)は受けない ── 名前の表をここに持つと、PowerPoint の側にも同じ表が要る
 *   (§7)。この版には「名前つきの見本」が無く、色を選ぶ口は既存の色の窓
 *   (`<input type="color">`。#1224)で、それが返すのは `#rrggbb` である。
 *
 * ## ⚠ pure module
 * browser API を使わない(`features` 層)。画面は `place-board.ts`、書き出しは `pptx.ts` が読む。
 */

/** 受ける綴り。⚠ `#` + 16 進の **3 桁 / 6 桁ちょうど**(4 桁・8 桁の透明度つきは受けない)。 */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * 色の綴りを読む。読めれば**正規形(`#rrggbb` の小文字)**、読めなければ `null`。
 * 🔑 3 桁は 6 桁へ広げる(`#f80` → `#ff8800`)── 読む側(画面・PowerPoint)が
 *   別々に広げると、同じ字が別の色になりうる(§7)。
 */
export function parsePlaceColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!HEX.test(v)) return null;
  const h = v.slice(1).toLowerCase();
  return h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : `#${h}`;
}

/** 線の太さの上限(px)。⚠ これより太い線は図の字を覆うので受けない。 */
export const PLACE_LINE_WIDTH_MAX = 16;

/** 右クリックで選べる太さ。⚠ 標準(= 札が無い)は 2px で、ここには持たない。 */
export const PLACE_LINE_WIDTH_THIN = 1;
export const PLACE_LINE_WIDTH_THICK = 4;
/** 札が無いときの太さ(画面の既定。`app.css` の `stroke-width` と同じ数 ── 同じ値を 2 か所に書かない)。 */
export const PLACE_LINE_WIDTH_DEFAULT = 2;

/**
 * 太さの綴りを読む。**1〜16 の整数**だけ(`px` などの単位・小数・0・負は `null`)。
 * 🔑 数だけ受ける ── 単位を許すと、書き出し側が単位を読み分ける羽目になる。
 */
export function parsePlaceWidth(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!/^\d{1,2}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= PLACE_LINE_WIDTH_MAX ? n : null;
}

/**
 * 塗りの上に載せる字の色(`#1a1a1a` か `#ffffff`)。
 *
 * 🔴 **地の色が変わると、字の色も合わせないと読めなくなる** ── 暗いテーマの字は明るいので、
 *   明るい黄色の付箋に載せると**字が消える**(実害)。🔑 見分けは相対輝度(sRGB の係数)で、
 *   境目は 0.5 ── 中間の色でも**どちらかには読める**側へ倒す。
 */
export function placeInkOf(color: string): string {
  const c = parsePlaceColor(color);
  if (c === null) return '#1a1a1a';
  const r = parseInt(c.slice(1, 3), 16);
  const g = parseInt(c.slice(3, 5), 16);
  const b = parseInt(c.slice(5, 7), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.5 ? '#1a1a1a' : '#ffffff';
}

/**
 * 書き換える札。`null` はその札を**消す**(= 既定の見た目へ戻す)。
 * 🔴 置けるなら外せる(user 指示 2026-08-23「片道の操作を作らない」)。
 * ⚠ 値は**綴り**(色は `#rgb` / `#rrggbb`、太さは整数)── 検めるのは `place-notation.ts` の `setPlaceStyle`。
 */
export interface PlaceStyle {
  readonly fill?: string | null;
  readonly stroke?: string | null;
  readonly width?: number | null;
}

/** 札の名前の全部。⚠ 並びが書き込みの順である(同じ本文を書くたびに札の並びが揺れない)。 */
export const PLACE_STYLE_KEYS = ['fill', 'stroke', 'width'] as const;
export type PlaceStyleKey = (typeof PLACE_STYLE_KEYS)[number];

/** 付箋が持てる札 / 線が持てる札。⚠ 持てない札を渡されたら書かない(`place-notation.ts`)。 */
export const BOARD_STYLE_KEYS: readonly PlaceStyleKey[] = ['fill', 'stroke'];
export const LINE_STYLE_KEYS: readonly PlaceStyleKey[] = ['stroke', 'width'];

/**
 * 渡された物が「書いてよい札」か(境界 ── postMessage / test の手組み)。
 * 知らない札・読めない値が 1 つでも混じれば `false`(一部だけ書かない)。
 */
export function isPlaceStyle(value: unknown): value is PlaceStyle {
  if (typeof value !== 'object' || value === null) return false;
  let any = false;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    if (k === 'fill' || k === 'stroke') {
      if (v !== null && parsePlaceColor(v) === null) return false;
    } else if (k === 'width') {
      if (v !== null && (typeof v !== 'number' || parsePlaceWidth(String(v)) === null)) return false;
    } else {
      return false;
    }
    any = true;
  }
  return any;
}
