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
 * | 線 | `arrow=` | 矢じり(`end` = 終わりに付ける / `both` = 両端に付ける。無ければ矢じりなし) |
 * | 付箋 | `size=` | 文字の大きさ(`small` / `large` / `xlarge`。無ければ標準) |
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
 * 🔴 **線の矢じり**(#530。Gemini 裁定 2026-10-11 依頼 15)。
 *
 * 書き方は `arrow=end`(終わり = `to=` 側だけ)/ `arrow=both`(両端)。⚠ **札が無い = 矢じりなし**
 * (古いノートは 1 字も変えずに今までの見た目)。`none` と書いても読める(= 札が無いのと同じ)が、
 * 画面から「矢じりなし」を選んだときは**札を消す**(`width=` を標準へ戻すのと同じ作法)。
 * ⚠ `to=` 側が「終わり」である ── 向きは `from=` → `to=`(PowerPoint の `tailEnd` が終わり側)。
 */
export type PlaceArrow = 'none' | 'end' | 'both';

/** ⚠ 空振り防止 ── 一覧が空なら、綴りの検査は何も見ていない。並びは右クリックの並びと同じ。 */
export const PLACE_ARROWS: readonly PlaceArrow[] = ['none', 'end', 'both'];

/** 3 つに分ける(書いていない / 読めない / 読めた)── 線の通り方(`route=`)と同じ作法。 */
export type ArrowRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'ok'; readonly arrow: PlaceArrow }
  | { readonly kind: 'bad'; readonly raw: string };

/** `arrow=end` を読む。⚠ 読めない字は `bad`(黙って矢じりなしに倒さない)。 */
export function parseArrowSpell(raw: unknown): ArrowRead {
  if (typeof raw !== 'string') return { kind: 'none' };
  const v = raw.trim();
  if (v === '') return { kind: 'none' };
  const hit = PLACE_ARROWS.find((a) => a === v);
  return hit === undefined ? { kind: 'bad', raw: v } : { kind: 'ok', arrow: hit };
}

/** 画面・書き出しが使う読み方 ── 読めない / 無いは `none`。⚠ 規則はここ 1 本(§7)。 */
export function placeArrowOf(raw: unknown): PlaceArrow {
  const r = parseArrowSpell(raw);
  return r.kind === 'ok' ? r.arrow : 'none';
}

/**
 * 🔴 **付箋の文字の大きさ**(#530 段⑤a。Gemini 裁定 2026-10-11 依頼 19 Q1)。
 *
 * 4 段(小 / 標準 / 大 / 特大)。名前と段の並びは**設定の「文字の大きさ」と同じ**(`text-scale.ts` の id)。
 * 書き方は `size=small` / `size=large` / `size=xlarge`。⚠ **札が無い = 標準**(古いノートは 1 字も変えずに今までの見た目)。
 * `standard` と書いても読める(= 札が無いのと同じ)が、画面から「標準」を選んだときは**札を消す**(`arrow=none` と同じ作法)。
 * 🔑 画面の大きさは**絶対値ではなく倍率**(`app.css` の `em`)── 設定の文字の大きさを変えると付箋も追従する。
 */
export type PlaceSize = 'small' | 'standard' | 'large' | 'xlarge';

/** ⚠ 空振り防止 ── 並びは右クリックの並びと同じ。 */
export const PLACE_SIZES: readonly PlaceSize[] = ['small', 'standard', 'large', 'xlarge'];

export type SizeRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'ok'; readonly size: PlaceSize }
  | { readonly kind: 'bad'; readonly raw: string };

/** `size=large` を読む。⚠ 読めない字は `bad`(`placeSizeOf` は標準に倒す ── 本文は消さない)。 */
export function parseSizeSpell(raw: unknown): SizeRead {
  if (typeof raw !== 'string') return { kind: 'none' };
  const v = raw.trim();
  if (v === '') return { kind: 'none' };
  const hit = PLACE_SIZES.find((a) => a === v);
  return hit === undefined ? { kind: 'bad', raw: v } : { kind: 'ok', size: hit };
}

/** 画面・書き出しが使う読み方 ── 読めない / 無いは `standard`。⚠ 規則はここ 1 本(§7)。 */
export function placeSizeOf(raw: unknown): PlaceSize {
  const r = parseSizeSpell(raw);
  return r.kind === 'ok' ? r.size : 'standard';
}

/**
 * 書き出し(PowerPoint の `sz`、100 分の 1 pt)の段の表。⚠ 標準 1800 は今までの固定値(`pptx.ts` の `SZ.body`)。
 * 🔑 「画面で何 px か」とは**換算しない**(画面の標準は設定で動く)── 段の**番号**を運ぶ。
 */
export const PLACE_SIZE_PPTX_SZ: Readonly<Record<PlaceSize, number>> = {
  small: 1400,
  standard: 1800,
  large: 2700,
  xlarge: 4000,
};

/** 取り込んだ `sz` に**いちばん近い段**(差の絶対値。同じ近さなら大きい側の段へ)。 */
export function nearestPlaceSize(sz: number): PlaceSize {
  let best: PlaceSize = 'standard';
  let bestD = Infinity;
  for (const k of PLACE_SIZES) {
    const d = Math.abs(PLACE_SIZE_PPTX_SZ[k] - sz);
    if (d < bestD || (d === bestD && PLACE_SIZE_PPTX_SZ[k] > PLACE_SIZE_PPTX_SZ[best])) {
      best = k;
      bestD = d;
    }
  }
  return best;
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
  /** 🔴 矢じり(線だけ)。`null` は札を**消す**(= 矢じりなし)。 */
  readonly arrow?: PlaceArrow | null;
  /** 🔴 文字の大きさ(付箋だけ)。`null` / `standard` は札を**消す**(= 標準)。 */
  readonly size?: PlaceSize | null;
}

/** 札の名前の全部。⚠ 並びが書き込みの順である(同じ本文を書くたびに札の並びが揺れない)。 */
export const PLACE_STYLE_KEYS = ['fill', 'stroke', 'width', 'arrow', 'size'] as const;
export type PlaceStyleKey = (typeof PLACE_STYLE_KEYS)[number];

/** 付箋が持てる札 / 線が持てる札。⚠ 持てない札を渡されたら書かない(`place-notation.ts`)。 */
export const BOARD_STYLE_KEYS: readonly PlaceStyleKey[] = ['fill', 'stroke', 'size'];
export const LINE_STYLE_KEYS: readonly PlaceStyleKey[] = ['stroke', 'width', 'arrow'];

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
    } else if (k === 'arrow') {
      if (v !== null && !PLACE_ARROWS.some((a) => a === v)) return false;
    } else if (k === 'size') {
      if (v !== null && !PLACE_SIZES.some((a) => a === v)) return false;
    } else {
      return false;
    }
    any = true;
  }
  return any;
}
