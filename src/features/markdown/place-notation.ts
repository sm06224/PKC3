/**
 * 🔴 **自由配置の板の記法**(#283 P4)── `.pkc-place` を持つ `:::format{…}` の
 * 開き行を数え、位置(x= / y=)だけを書き換える。
 *
 * ## 位置の正本は本文である(裁定 2026-08-19 Q1)
 *
 * 位置は「板 × ノート」の関係の属性に見えるが、**板の本文の記法に書けば
 * 関係テーブルは要らない**。だからこの module は「本文のどの行が板の塊か」と
 * 「その行の x= / y= をどう書き換えるか」だけを持つ。
 *
 * ## ⚠ 塊は「N 番目 + 開き行そのもの」で指す
 *
 * 本文の面の描画は source-line の印を持たない(Split View だけの物 ── 実測
 * 2026-08-28)ので、行番号を DOM から採れない。代わりに
 * **N 番目の板の塊**(DOM の並び = 原文の並び)で指し、掴んだ時点の
 * **開き行そのもの**を添えて、書く直前に byte 一致を検める ──
 * 一致しなければ書かない(`undo-append` の「足した行そのものを持つ」と同じ作法。
 * 別の窓の書込で行が動いた・増えた形で**別の塊を動かさない**)。
 *
 * ⚠ 既知の限界: 引用値の中に `.pkc-place` と書く(`note=".pkc-place"`)ような
 * 作為的な行は、描画側の数え方とずれうる。byte 一致の検めで**別の行への書込は
 * 起きない**が、その形では動かせないことがある(断られる)。
 */
import { frontmatterLineCount } from './frontmatter';

/** `:::format{…}` の開き行(閉じ `}` まで 1 行)。 */
const FORMAT_OPEN = /^:{3,}format\{([^}]*)\}\s*$/;

/** 開き行が板の塊(`.pkc-place` のクラス札)か。 */
export function isPlaceOpen(line: string): boolean {
  const m = FORMAT_OPEN.exec(line);
  if (m === null) return false;
  return /(^|\s)\.pkc-place(?=\s|$)/.test(m[1] ?? '');
}

/** fence の開き(``` / ~~~。3 つ以上・行頭 3 空白まで)。 */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * 板の塊の開き行を、上から順に数える(原文 = 生の body の行番号)。
 * ⚠ frontmatter の中と fence(```)の中は数えない ── 描画も描かない場所である。
 * ⚠ fence は**自前で歩く**(`scanContainers` は囲み(directive)を丸ごと飲むので、
 *   囲みの中の fence が見えない ── そこに置いた偽の開き行で数がずれる)。
 *   閉じの規則は `scanContainers` と同じ(同じ種類・同じ長さ以上・後ろに字が無い)。
 */
export function placeOpenLines(body: string): number[] {
  const lines = body.split('\n');
  const fm = frontmatterLineCount(body);
  const out: number[] = [];
  let fence: string | null = null;
  for (let i = fm; i < lines.length; i += 1) {
    const line = lines[i]!;
    const f = FENCE.exec(line);
    if (fence !== null) {
      if (
        f !== null &&
        f[1]!.startsWith(fence[0]!) &&
        f[1]!.length >= fence.length &&
        f[2]!.trim() === ''
      )
        fence = null;
      continue;
    }
    if (f !== null) {
      fence = f[1]!;
      continue;
    }
    if (isPlaceOpen(line)) out.push(i);
  }
  return out;
}

/** ordinal 番目の板の開き行の**字そのもの**(無ければ null)── 捕捉に使う。 */
export function placeOpenLineAt(body: string, ordinal: number): string | null {
  const at = placeOpenLines(body)[ordinal];
  if (at === undefined) return null;
  return body.split('\n')[at] ?? null;
}

export interface PlaceMove {
  /** 何番目の板の塊か(0 始まり。DOM の並び = 原文の並び)。 */
  readonly ordinal: number;
  /** 掴んだ時点の開き行そのもの ── disk 側と一致しなければ書かない。 */
  readonly openLine: string;
  readonly x: number;
  readonly y: number;
}

/**
 * 🔴 板の塊を動かす ── 開き行の x= / y= **だけ**を書き換える。
 *
 * ⚠ 検証つき splice: ordinal 番目の板の開き行が `openLine` と **byte 一致**する
 *   ときだけ書く。ずれていれば null = 断る(店じまいは呼び側の仕事)。
 * ⚠ 値が同じで 1 byte も変わらないときも null ── 同じ本文を書き直して
 *   更新日時だけ動かさない(`adopt-images` と同じ向き)。
 */
export function movePlace(body: string, move: PlaceMove): string | null {
  if (!Number.isInteger(move.x) || !Number.isInteger(move.y)) return null;
  if (move.x < 0 || move.y < 0) return null;
  const at = placeOpenLines(body)[move.ordinal];
  if (at === undefined) return null;
  const lines = body.split('\n');
  const line = lines[at];
  if (line === undefined || line !== move.openLine) return null;
  const next = spliceXY(line, move.x, move.y);
  if (next === null || next === line) return null;
  lines[at] = next;
  return lines.join('\n');
}

/** 開き行の `{}` の中の x= / y= を書き換える(無ければ末尾に足す)。 */
function spliceXY(line: string, x: number, y: number): string | null {
  const m = FORMAT_OPEN.exec(line);
  if (m === null) return null;
  let attrs = m[1]!;
  attrs = setToken(attrs, 'x', x);
  attrs = setToken(attrs, 'y', y);
  const open = line.indexOf('{');
  const close = line.lastIndexOf('}');
  return line.slice(0, open + 1) + attrs + line.slice(close);
}

/**
 * `key=値` の札を 1 つだけ書き換える(無ければ足す)。
 * ⚠ 引用つき(`x="120"`)も受けて、**引用なしへ揃える**(描画は属性値を数として
 *   読むだけなので同じに描ける。2 つ目の x= を作るほうが害が大きい)。
 */
function setToken(attrs: string, key: 'x' | 'y', value: number): string {
  const re = new RegExp(`(^|\\s)${key}="?-?\\d+"?(?=\\s|$)`);
  if (re.test(attrs)) return attrs.replace(re, `$1${key}=${value}`);
  return attrs === '' ? `${key}=${value}` : `${attrs} ${key}=${value}`;
}
