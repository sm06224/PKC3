/**
 * 🔴 **自由配置の板の記法**(#283 P4 / #676)── `.pkc-place` を持つ format 塊の
 * 開き行の札(x= / y= / w= / h= / z=)だけを書き換える。#676 で**塊を足す・消す**も
 * ここに持つ ── 「その行が板の塊か」の判定と門は 1 本で、操作ごとに増やさない。
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
import { blockSpanAt, scanContainers } from './source-blocks';

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
 * 各行が fence(```)の中か(fence の開き・閉じの行そのものは「中」に数えない)。
 * ⚠ 閉じの規則は `scanContainers` と同じ(同じ種類・同じ長さ以上・後ろに字が無い)。
 * 🔑 1 度の走査で全行ぶん出す ── 板を全部数える `raisePlace` が行ごとに走査し直すと
 *   O(n²) になるので、`insideFence` もこれを引く(判定は 1 本)。
 */
function fenceMask(lines: readonly string[], from: number): boolean[] {
  const mask: boolean[] = new Array<boolean>(lines.length).fill(false);
  let fence: string | null = null;
  for (let i = from; i < lines.length; i += 1) {
    const f = FENCE.exec(lines[i]!);
    if (f === null) {
      mask[i] = fence !== null;
      continue;
    }
    if (fence === null) {
      fence = f[1]!;
    } else if (f[1]!.startsWith(fence[0]!) && f[1]!.length >= fence.length && f[2]!.trim() === '') {
      fence = null;
    } else {
      mask[i] = true; // 開いている fence の中の、別種の fence 記号(閉じない)
    }
  }
  return mask;
}

/**
 * `line` 番目(生の body の行番号)が fence(```)の中か。
 * 🔑 描画の行番号は fence の中を指さないが、**行番号は掴んだ時点のもの**なので、
 *   別の窓の書込で同じ字面の行が fence の中へ移った形を最後の門で止める。
 */
function insideFence(lines: readonly string[], from: number, line: number): boolean {
  return fenceMask(lines, from)[line] === true;
}

/** 板の塊を指す ── 開き行の行番号と、掴んだ時点の開き行そのもの。 */
export interface PlaceTarget {
  /** 開き行の行番号(**生の body** の 0 始まり。描画の source-line + frontmatter ぶん)。 */
  readonly line: number;
  /** 掴んだ時点の開き行そのもの ── disk 側と一致しなければ書かない。 */
  readonly openLine: string;
}

export interface PlaceMove extends PlaceTarget {
  readonly x: number;
  readonly y: number;
}

export interface PlaceResize extends PlaceTarget {
  readonly w: number;
  readonly h: number;
}

/**
 * 🔴 **板の書換が共通で通る門**(#676 で 1 本に寄せた)。
 *
 * `line` 番目の行が `openLine` と **byte 一致**し、板の開き行であり、frontmatter の外で
 * fence の中でないときだけ、行の並びを返す。ずれていれば null = 断る(店じまいは呼び側)。
 * ⚠ 操作ごとに門を書き直さない ── 1 つが緩むと、その操作だけ**別の塊に効く**(§7)。
 */
function placeLinesAt(body: string, target: PlaceTarget): { lines: string[]; fm: number } | null {
  const fm = frontmatterLineCount(body);
  if (!Number.isInteger(target.line) || target.line < fm) return null;
  const lines = body.split('\n');
  const line = lines[target.line];
  if (line === undefined || line !== target.openLine) return null;
  if (!isPlaceOpen(line)) return null;
  if (insideFence(lines, fm, target.line)) return null;
  return { lines, fm };
}

/** 整数で 0 以上か(座標・大きさ・重なりの値はどれもこの形だけを受ける)。 */
function isCoord(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
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
  if (!isCoord(move.x) || !isCoord(move.y)) return null;
  return spliceOpenLine(body, move, { x: move.x, y: move.y });
}

/**
 * 🔴 板の塊の大きさを変える(#676)── 開き行の w= / h= **だけ**を書き換える。
 * 門も「変わらなければ body をそのまま返す」も `movePlace` と同じ。
 */
export function resizePlace(body: string, resize: PlaceResize): string | null {
  if (!isCoord(resize.w) || !isCoord(resize.h)) return null;
  return spliceOpenLine(body, resize, { w: resize.w, h: resize.h });
}

/** 門を通してから開き行の札を差し替える(動かす / 大きさを変える の共通部)。 */
function spliceOpenLine(body: string, target: PlaceTarget, tokens: PlaceTokens): string | null {
  const at = placeLinesAt(body, target);
  if (at === null) return null;
  const line = at.lines[target.line]!;
  const next = spliceTokens(line, tokens);
  if (next === null) return null;
  if (next === line) return body;
  at.lines[target.line] = next;
  return at.lines.join('\n');
}

/**
 * 🔴 **板の塊を消す**(#676)── 開き行から閉じの `:::` までと、隣の空行 1 本を消す。
 *
 * ⚠ 範囲は `blockSpanAt`(= 「この塊をコピー」が写す当の範囲)で取る ── ここで `:::` を
 *   数え直さない(§7)。⚠ **閉じていない塊は null で断る** ── 末尾まで飲んでいるので、
 *   消すと**その下の本文が丸ごと消える**。
 * 🔑 空行は**後ろを優先して 1 本**だけ消す(無ければ前の 1 本)── 板の前後は空行で
 *   区切って書くのが普通なので、消した後に空行が 2 本並ばないようにする。
 *   ⚠ 2 本以上は消さない ── 隣の段落の間隔まで詰めると、触っていない所が変わって見える。
 */
export function removePlace(body: string, target: PlaceTarget): string | null {
  const at = placeLinesAt(body, target);
  if (at === null) return null;
  // ⚠ 範囲は frontmatter を剥いだ座標で取る(`directiveBlockAt` と同じ座標系)
  const span = blockSpanAt(at.lines.slice(at.fm).join('\n'), target.line - at.fm);
  if (span === null || span.open) return null;
  const start = target.line;
  const end = span.end + at.fm;
  const lines = at.lines;
  if (end + 1 < lines.length && lines[end + 1] === '') lines.splice(start, end - start + 2);
  else if (start > at.fm && lines[start - 1] === '') lines.splice(start - 1, end - start + 2);
  else lines.splice(start, end - start + 1);
  return lines.join('\n');
}

/**
 * 🔴 **板を前へ出す**(#676 段②)── 他の板の z= の最大 + 1 を、この板の z= に書く。
 *
 * ⚠ 「後ろへ送る」は作らない ── 負の z は描画が捨てる(`place-board.ts` の `intAttr`)ので、
 *   下げる向きは「他を全部上げる」しか無く、触っていない板の行まで書き換えることになる。
 * ⚠ 数えるのは**fence の外の板の開き行だけ**(fence の中の `:::format{… z=99}` はコードの字)。
 *   z= を持たない板は 0 と数える(描画は z 無し = `auto`、z=1 はその上に乗る)。
 * 🔑 既に**独りで**いちばん前なら body をそのまま返す(書く物が無い ≠ 競合)。
 *   同じ z が並んでいる(引き分け)なら 1 つ上げる ── 押した人は前に出したいのである。
 */
export function raisePlace(body: string, target: PlaceTarget): string | null {
  const at = placeLinesAt(body, target);
  if (at === null) return null;
  const mask = fenceMask(at.lines, at.fm);
  let maxOther = 0;
  for (let i = at.fm; i < at.lines.length; i += 1) {
    if (i === target.line || mask[i] === true) continue;
    const attrs = placeOpenAttrs(at.lines[i]!);
    if (attrs !== null) maxOther = Math.max(maxOther, zOf(attrs));
  }
  const self = placeOpenAttrs(at.lines[target.line]!);
  if (self !== null && zOf(self) > maxOther) return body;
  return spliceOpenLine(body, target, { z: maxOther + 1 });
}

/** 開き行の z=(整数 ≥0)。無い・読めないときは 0(描画の `intAttr` が捨てる値と同じ扱い)。 */
function zOf(attrs: BlockDirectiveAttrs): number {
  const raw = attrs.kvs.z;
  if (typeof raw !== 'string') return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** 置いたばかりの板の大きさ(px)。⚠ 中身が空でも掴める大きさにする(CSS の min は 120×40)。 */
export const NEW_PLACE_W = 240;
export const NEW_PLACE_H = 120;

/**
 * 🔴 **板の塊を 1 つ足す**(#676)── 本文の末尾に、空の塊を書く。
 *
 * ⚠ **行番号を持たない** ── 足す先は常に末尾で、他の行は 1 byte も動かない。
 * 🔑 綴りはマニュアルが教える正式形(`:::format{.pkc-place x= y= w= h=}`)── 描画は
 *   中身が空でも `<div class="pkc-format-block pkc-place">` として描く(実測 2026-09-04)。
 * ⚠ 末尾の囲い(fence / `:::`)が閉じていなければ null で断る ── その中に書くと、
 *   板ではなく**コードの字**(または別の塊の中身)になって画面に出ない。
 */
export function addPlace(body: string, x: number, y: number): string | null {
  if (!isCoord(x) || !isCoord(y)) return null;
  const spans = scanContainers(body);
  const last = spans[spans.length - 1];
  if (last !== undefined && last.open) return null;
  const block = `:::format{.pkc-place x=${x} y=${y} w=${NEW_PLACE_W} h=${NEW_PLACE_H}}\n\n:::\n`;
  if (body === '') return block;
  return body + (body.endsWith('\n') ? '\n' : '\n\n') + block;
}

/** 開き行に書ける札。⚠ `entry=` は書かない(題名の札は user が書く物)。 */
type PlaceKey = 'x' | 'y' | 'w' | 'h' | 'z';
type PlaceTokens = Partial<Record<PlaceKey, number>>;
const PLACE_KEYS: readonly PlaceKey[] = ['x', 'y', 'w', 'h', 'z'];

/**
 * 開き行の札(x= y= w= h= z= のうち渡された物)を書き換える。
 * - `{}` を持つ形(`:::format{…}` / `::: {…}`)── 括弧の中の札だけ差し替える
 * - `{}` を持たない Tier 1 形(`:::.pkc-place` / `::: pkc-place`)── 座標を
 *   書ける場所が無いので、**同義の括弧つき形へ整える**(`::: {.pkc-place x=… y=…}`。
 *   描画は同じ塊として描く ── 実測 2026-08-28)
 */
function spliceTokens(line: string, tokens: PlaceTokens): string | null {
  const attrs = placeOpenAttrs(line);
  if (attrs === null) return null;
  const keys = PLACE_KEYS.filter((k) => tokens[k] !== undefined);
  const open = line.indexOf('{');
  const close = line.lastIndexOf('}');
  if (open !== -1 && close > open) {
    let inner = line.slice(open + 1, close);
    for (const k of keys) inner = setToken(inner, k, tokens[k]!);
    return line.slice(0, open + 1) + inner + line.slice(close);
  }
  const parts = attrs.classes.map((c) => `.${c}`);
  if (attrs.id !== undefined) parts.push(`#${attrs.id}`);
  for (const k of keys) parts.push(`${k}=${tokens[k]!}`);
  return `::: {${parts.join(' ')}}`;
}

/**
 * `key=値` の札を 1 つだけ書き換える(無ければ足す)。
 * ⚠ 値は**数字に見えない物も**丸ごと差し替える(`x="120"` / `x=+5` / `x=1e2`)──
 *   数字だけを狙うと、変な値の隣に **2 つ目の x=** を作る(そちらの害が大きい。
 *   描画は属性を数として読むだけなので、引用なしの整数へ揃えて同じに描ける)。
 */
function setToken(attrs: string, key: PlaceKey, value: number): string {
  const re = new RegExp(`(^|\\s)${key}=(?:"[^"]*"|\\S*)`);
  if (re.test(attrs)) return attrs.replace(re, `$1${key}=${value}`);
  return attrs === '' ? `${key}=${value}` : `${attrs} ${key}=${value}`;
}
