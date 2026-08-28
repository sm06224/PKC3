/**
 * 🔴 **自由配置の板の記法**(#283 P4)── `.pkc-place` を持つ format 塊の
 * 開き行の位置(x= / y=)だけを書き換える。
 *
 * ## 位置の正本は本文である(裁定 2026-08-19 Q1)
 *
 * 位置は「板 × ノート」の関係の属性に見えるが、**板の本文の記法に書けば
 * 関係テーブルは要らない**。だからこの module は「その行が板の塊か」と
 * 「その行の x= / y= をどう書き換えるか」だけを持つ。
 *
 * ## 🔴 塊は「行番号 + 開き行そのもの」で指す(レビュー 2026-08-28 で作り直し)
 *
 * 初版は「N 番目の板の塊」(ordinal)で指し、**数える規則を描画と別に持っていた**。
 * ⚠ それは CLAUDE.md §7(同じ問いに答える口が 2 つ)の型で、実測 3 件の
 * 「掴んだ付箋と**別の行**に書く」を作った ── brace 形(`::: {.pkc-place}`)は
 * 描画されるのに数えず、`:::if` の中の行は描画されないのに数えていた。
 * 🔑 描画は読む面に `data-pkc-source-line`(剥がした本文の行番号)を焼いている
 * (実測 2026-08-28 ── 初版の「無い」という前提が誤りだった)ので、
 * **描いた当の描画器が言う行番号**で指す。数え直しの第 2 の規則は持たない。
 *
 * 掴んだ時点の**開き行そのもの**を添えて、書く直前に byte 一致を検める ──
 * 一致しなければ書かない(`undo-append` の「足した行そのものを持つ」と同じ作法。
 * 別の窓の書込で行が動いた・増えた形で**別の塊を動かさない**)。
 *
 * ## 🔴 受理は描画と**同じ関数**で判定する
 *
 * 描画は正式形 `:::format{…}` のほかに Tier 1 の寛容形
 * (`::: {.pkc-place x=…}` / `:::.pkc-place` / `::: pkc-place`)も
 * `pkc-place` の塊として描く。判定は `parseBlockDirectiveOpen` /
 * `parseTier1FormatOpen`(= 描画が使う当のもの)へ寄せる。
 * ⚠ `::::format{…}`(4 コロン)は描画されない ── ここでも受理しない。
 */
import type { BlockDirectiveAttrs } from './block-directive-attrs';
import { parseBlockDirectiveOpen, parseTier1FormatOpen } from './block-directive-attrs';
import { frontmatterLineCount } from './frontmatter';

/**
 * 開き行が板の塊なら、その属性(描画と同じパース結果)。違えば null。
 * 🔑 描画が `pkc-place` の format 塊として受理する形の全部と、それだけを受理する。
 */
function placeOpenAttrs(line: string): BlockDirectiveAttrs | null {
  const named = parseBlockDirectiveOpen(line.trim());
  if (named !== null) {
    if (named.name !== 'format') return null;
    return named.attrs.classes.includes('pkc-place') ? named.attrs : null;
  }
  const tier1 = parseTier1FormatOpen(line);
  if (tier1 !== null && tier1.classes.includes('pkc-place')) return tier1;
  return null;
}

/** 開き行が板の塊(`.pkc-place` のクラス札)か。 */
export function isPlaceOpen(line: string): boolean {
  return placeOpenAttrs(line) !== null;
}

/** fence の開き(``` / ~~~。3 つ以上・行頭 3 空白まで)。 */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * `line` 番目(生の body の行番号)が fence(```)の中か。
 * ⚠ 閉じの規則は `scanContainers` と同じ(同じ種類・同じ長さ以上・後ろに字が無い)。
 * 🔑 描画の行番号は fence の中を指さないが、**行番号は掴んだ時点のもの**なので、
 *   別の窓の書込で同じ字面の行が fence の中へ移った形を最後の門で止める。
 */
function insideFence(lines: readonly string[], from: number, line: number): boolean {
  let fence: string | null = null;
  for (let i = from; i < line; i += 1) {
    const f = FENCE.exec(lines[i]!);
    if (f === null) continue;
    if (fence === null) {
      fence = f[1]!;
    } else if (f[1]!.startsWith(fence[0]!) && f[1]!.length >= fence.length && f[2]!.trim() === '') {
      fence = null;
    }
  }
  return fence !== null;
}

export interface PlaceMove {
  /** 開き行の行番号(**生の body** の 0 始まり。描画の source-line + frontmatter ぶん)。 */
  readonly line: number;
  /** 掴んだ時点の開き行そのもの ── disk 側と一致しなければ書かない。 */
  readonly openLine: string;
  readonly x: number;
  readonly y: number;
}

/**
 * 🔴 板の塊を動かす ── 開き行の x= / y= **だけ**を書き換える。
 *
 * ⚠ 検証つき splice: `line` 番目の行が `openLine` と **byte 一致**し、かつ
 *   その行が板の開き行であるときだけ書く。ずれていれば null = 断る
 *   (店じまいは呼び側の仕事)。
 * 🔑 値が同じで 1 byte も変わらないときは **body をそのまま返す**(書く物が
 *   無い = 済んでいる)── null と区別する。null を「競合」と読む呼び側
 *   (`store-effects`)が、取りやめた drop に嘘の赤帯を出さないため。
 */
export function movePlace(body: string, move: PlaceMove): string | null {
  if (!Number.isInteger(move.x) || !Number.isInteger(move.y)) return null;
  if (move.x < 0 || move.y < 0) return null;
  const fm = frontmatterLineCount(body);
  if (!Number.isInteger(move.line) || move.line < fm) return null;
  const lines = body.split('\n');
  const line = lines[move.line];
  if (line === undefined || line !== move.openLine) return null;
  if (!isPlaceOpen(line)) return null;
  if (insideFence(lines, fm, move.line)) return null;
  const next = spliceXY(line, move.x, move.y);
  if (next === null) return null;
  if (next === line) return body;
  lines[move.line] = next;
  return lines.join('\n');
}

/**
 * 開き行の x= / y= を書き換える。
 * - `{}` を持つ形(`:::format{…}` / `::: {…}`)── 括弧の中の札だけ差し替える
 * - `{}` を持たない Tier 1 形(`:::.pkc-place` / `::: pkc-place`)── 座標を
 *   書ける場所が無いので、**同義の括弧つき形へ整える**(`::: {.pkc-place x=… y=…}`。
 *   描画は同じ塊として描く ── 実測 2026-08-28)
 */
function spliceXY(line: string, x: number, y: number): string | null {
  const attrs = placeOpenAttrs(line);
  if (attrs === null) return null;
  const open = line.indexOf('{');
  const close = line.lastIndexOf('}');
  if (open !== -1 && close > open) {
    let inner = line.slice(open + 1, close);
    inner = setToken(inner, 'x', x);
    inner = setToken(inner, 'y', y);
    return line.slice(0, open + 1) + inner + line.slice(close);
  }
  const tokens = attrs.classes.map((c) => `.${c}`);
  if (attrs.id !== undefined) tokens.push(`#${attrs.id}`);
  return `::: {${tokens.join(' ')} x=${x} y=${y}}`;
}

/**
 * `key=値` の札を 1 つだけ書き換える(無ければ足す)。
 * ⚠ 値は**数字に見えない物も**丸ごと差し替える(`x="120"` / `x=+5` / `x=1e2`)──
 *   数字だけを狙うと、変な値の隣に **2 つ目の x=** を作る(そちらの害が大きい。
 *   描画は属性を数として読むだけなので、引用なしの整数へ揃えて同じに描ける)。
 */
function setToken(attrs: string, key: 'x' | 'y', value: number): string {
  const re = new RegExp(`(^|\\s)${key}=(?:"[^"]*"|\\S*)`);
  if (re.test(attrs)) return attrs.replace(re, `$1${key}=${value}`);
  return attrs === '' ? `${key}=${value}` : `${attrs} ${key}=${value}`;
}
