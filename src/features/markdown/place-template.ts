/**
 * 🔴 **板のテンプレート**(#529 W4。Gemini 裁定 = 採択、依頼 11〜13)── 板の本文に書き足す
 * **既存の記法の断片**を返す純関数。
 *
 * ## 新しい記法・新しいデータを作らない
 *
 * 出すのは `:::format{.pkc-place x= y= w= h=}`(枠)と `:::format{.pkc-line from= to=}`(線)だけ ──
 * 板の読み手(描画・PowerPoint・書き出し)が既に読む綴りである。テンプレートは「字を貼る」物で、
 * 貼った後は user が書いた枠と区別が付かない(動かす・消す・色を変えるが、そのまま効く)。
 * 🔑 だから枠の綴りは `place-notation.ts` の `addPlace` と**同じ並び**(`#名 .pkc-place x y w h`)。
 *
 * ## 名前(`#板N`)は呼び側が空きを探して渡す
 *
 * 流れ図は線が枠を `from=` / `to=` で指すので、枠に名前が要る。名前が本文の別の所と
 * 重なると線が**別の枠を指す**ので、空き探しは `place-notation.ts` の `freeName` の 1 本に任せ、
 * ここは渡された名前を書くだけ(§7: 名前の規則を 2 か所に持たない)。
 */

export type PlaceTemplateId = 'sticky4' | 'flow3' | 'matrix2';

export interface PlaceTemplate {
  readonly id: PlaceTemplateId;
  /** 選ぶ窓の行の字。 */
  readonly label: string;
  /** 行の下に添える 1 行(何が置かれるか)。 */
  readonly note: string;
  /** 置かれる枠の数(線は数えない)。 */
  readonly frames: number;
  /** 枠に付ける名前の数(0 なら名前を使わない)。 */
  readonly names: number;
}

/** ⚠ 並びが選ぶ窓の並び。ここが正本(窓も test もここから引く)。 */
export const PLACE_TEMPLATES: readonly PlaceTemplate[] = [
  { id: 'sticky4', label: '付箋 4 枚', note: '空の付箋を 2 × 2 に並べます', frames: 4, names: 0 },
  { id: 'flow3', label: '3 段の流れ図', note: '左から右へ、3 つの枠を線でつなぎます', frames: 3, names: 3 },
  { id: 'matrix2', label: '2 × 2 の表', note: '4 つの枠と、縦・横の見出しを置きます', frames: 8, names: 0 },
];

export function isPlaceTemplateId(v: unknown): v is PlaceTemplateId {
  return PLACE_TEMPLATES.some((t) => t.id === v);
}

/** 付箋 1 枚の大きさ(px)と、並べるときの間隔。 */
const W = 240;
const H = 120;
const GAP = 20;

function frame(x: number, y: number, w: number, h: number, text: string, name?: string): string {
  const id = name === undefined ? '' : `#${name} `;
  return `:::format{${id}.pkc-place x=${x} y=${y} w=${w} h=${h}}\n${text}\n:::`;
}

/** 2 × 2 の 4 マス(左上・右上・左下・右下の順)。 */
const CELLS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

/**
 * テンプレートの本文(枠と線の塊を空行で区切って並べた字)。末尾の改行は付けない。
 *
 * @param x y 左上の位置(px。負は呼び側が弾く)
 * @param names 枠に付ける名前(`PlaceTemplate.names` 個。足りなければ null を返す)
 */
export function placeTemplateBody(
  id: PlaceTemplateId,
  x: number,
  y: number,
  names: readonly string[],
): string | null {
  const parts: string[] = [];
  if (id === 'sticky4') {
    for (const [dx, dy] of CELLS) parts.push(frame(x + dx * (W + GAP), y + dy * (H + GAP), W, H, ''));
  } else if (id === 'flow3') {
    if (names.length < 3) return null;
    const w = 200;
    const h = 100;
    const step = w + 80;
    for (let i = 0; i < 3; i += 1) parts.push(frame(x + i * step, y, w, h, `手順 ${i + 1}`, names[i]!));
    // 🔴 流れ図なので、最初から終わりに矢じりを付ける(#530。Gemini 裁定 2026-10-11 依頼 15)
    parts.push(`:::format{.pkc-line from=${names[0]!} to=${names[1]!} arrow=end}\n:::`);
    parts.push(`:::format{.pkc-line from=${names[1]!} to=${names[2]!} arrow=end}\n:::`);
  } else {
    // 見出しの帯を 1 本ぶん空けて、その右下に 2 × 2 の象限を置く
    const headW = 100;
    const headH = 40;
    const left = x + headW + GAP;
    const top = y + headH + GAP;
    parts.push(frame(left, y, W, headH, '見出し A'));
    parts.push(frame(left + W + GAP, y, W, headH, '見出し B'));
    parts.push(frame(x, top, headW, H, '見出し 1'));
    parts.push(frame(x, top + H + GAP, headW, H, '見出し 2'));
    for (const [dx, dy] of CELLS) parts.push(frame(left + dx * (W + GAP), top + dy * (H + GAP), W, H, ''));
  }
  return parts.join('\n\n');
}
