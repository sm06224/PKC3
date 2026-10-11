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
import {
  isPlaceRectNumber,
  PLACE_RECT_KEYS,
  type PlaceRectInput,
  type PlaceRectValue,
} from './place-rect';
import { PLACE_TEMPLATES, placeTemplateBody, type PlaceTemplateId } from './place-template';
import {
  BOARD_STYLE_KEYS,
  isPlaceStyle,
  LINE_STYLE_KEYS,
  parsePlaceColor,
  parsePlaceWidth,
  placeArrowOf,
  placeSizeOf,
  type PlaceArrow,
  type PlaceSize,
  PLACE_STYLE_KEYS,
  type PlaceStyle,
  type PlaceStyleKey,
} from './place-color';
import { parseAnchorSpell } from './place-line';
import { isPlaceShape, placeShapeOf, type PlaceShape } from './place-shape';
import { blockSpanAt, scanContainers } from './source-blocks';

/**
 * 開き行が板の塊なら、その属性(描画と同じパース結果)。違えば null。
 * 🔑 描画が `pkc-place` の format 塊として受理する形の全部と、それだけを受理する。
 */
function placeOpenAttrs(line: string): BlockDirectiveAttrs | null {
  return formatOpenAttrs(line, 'pkc-place');
}

/**
 * 開き行が `cls` を持つ format 塊なら、その属性。違えば null。
 * 🔑 板(`pkc-place`)と線(`pkc-line`)は**同じ読み方**で受ける ── 受理の形を 2 本書くと、
 *   描画が線として読む形を消す側が受けない(押しても何も起きない)食い違いが生まれる(§7)。
 */
function formatOpenAttrs(line: string, cls: string): BlockDirectiveAttrs | null {
  const named = parseBlockDirectiveOpen(line.trim());
  if (named !== null) {
    if (named.name !== 'format') return null;
    return named.attrs.classes.includes(cls) ? named.attrs : null;
  }
  const tier1 = parseTier1FormatOpen(line);
  if (tier1 !== null && tier1.classes.includes(cls)) return tier1;
  return null;
}

/** 開き行が板の塊(`.pkc-place` のクラス札)か。 */
export function isPlaceOpen(line: string): boolean {
  return placeOpenAttrs(line) !== null;
}

/**
 * 🔴 **この本文の板が置いているノートの lid**(`entry=`)。fence の中の行は数えない。
 *
 * 用途は「いま画面に出ている板が要る抜粋を、上限で手放さない」(`app-state.ts` の `withPlaceBody`)。
 * 🔑 受理は `placeOpenAttrs`(= 描画と同じ関数)の 1 本 ── 描画が `data-pkc-place-entry` へ焼く値は
 *   この `kvs.entry` そのもの(`place-board.ts`)なので、数える相手が描画とずれない。
 */
export function placeEntryLids(body: string): string[] {
  const lines = body.split('\n');
  const mask = fenceMask(lines, frontmatterLineCount(body));
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (mask[i] === true) continue;
    const entry = placeOpenAttrs(lines[i]!)?.kvs.entry;
    if (typeof entry === 'string' && entry !== '') out.push(entry);
  }
  return out;
}

/**
 * 🔴 **その板の x= / y= / w= / h= の、いま書かれている字**(#529 W2 の窓に入れる値)。
 * 板でなければ `null`。書かれていない札は空の字(窓で空のまま決めれば、その札は変えない)。
 * 🔑 読むのは `placeOpenAttrs`(描画と同じ関数)の 1 本。
 */
export function placeRectOf(line: string): PlaceRectInput | null {
  const attrs = placeOpenAttrs(line);
  if (attrs === null) return null;
  const s = (v: unknown): string => (typeof v === 'string' ? v : '');
  return { x: s(attrs.kvs.x), y: s(attrs.kvs.y), w: s(attrs.kvs.w), h: s(attrs.kvs.h) };
}

/** 開き行が線の塊(`.pkc-line` のクラス札)か(#530 段③d。消す口が使う)。 */
export function isLineOpen(line: string): boolean {
  return formatOpenAttrs(line, 'pkc-line') !== null;
}

/** fence の開き(``` / ~~~。3 つ以上・行頭 3 空白まで)。 */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * 各行が fence(```)の中か(fence の開き・閉じの行そのものは「中」に数えない)。
 * ⚠ 閉じの規則は `scanContainers` と同じ(同じ種類・同じ長さ以上・後ろに字が無い)。
 * 🔑 1 度の走査で全行ぶん出す ── 板を全部数える `raisePlace` が行ごとに走査し直すと
 *   O(n²) になるので、`insideFence` もこれを引く(判定は 1 本)。
 */
export function fenceMask(lines: readonly string[], from: number): boolean[] {
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
export function insideFence(lines: readonly string[], from: number, line: number): boolean {
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
function placeLinesAt(
  body: string,
  target: PlaceTarget,
  accept: (line: string) => boolean = isPlaceOpen,
): { lines: string[]; fm: number } | null {
  const fm = frontmatterLineCount(body);
  if (!Number.isInteger(target.line) || target.line < fm) return null;
  const lines = body.split('\n');
  const line = lines[target.line];
  if (line === undefined || line !== target.openLine) return null;
  if (!accept(line)) return null;
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

/**
 * 🔴 **位置と大きさを一度に書く**(#529 W2「位置と大きさ…」)── 開き行の x= / y= / w= / h= の
 * うち**渡された札だけ**を書き換える。
 *
 * 🔑 `movePlace` + `resizePlace` を 2 回撃たない ── 1 回目で開き行が変わるので、2 回目の
 *   「掴んだ時点の開き行」が byte 不一致になって**半分だけ書けた**状態を作る。門は同じ 1 本。
 * ⚠ 値は窓の検め(`parsePlaceRect`)と**同じ規則**(`isPlaceRectNumber`)で再度検める ──
 *   型は境界(postMessage / test の手組み)では効かない。1 つでも外れたら全体を断る(一部だけ書かない)。
 * 🔑 渡された札が 0 個なら body をそのまま返す(書く物が無い ≠ 競合。窓の「決める」を空欄で押した形)。
 */
export function setPlaceRect(body: string, target: PlaceTarget, rect: PlaceRectValue): string | null {
  const tokens: { x?: number; y?: number; w?: number; h?: number } = {};
  for (const k of PLACE_RECT_KEYS) {
    const v = rect[k];
    if (v === undefined) continue;
    if (!isPlaceRectNumber(k, v)) return null;
    tokens[k] = v;
  }
  return spliceOpenLine(body, target, tokens);
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
  return removeBlockAt(body, target, isPlaceOpen);
}

/**
 * 🔴 **線の塊を 1 つ消す**(#530 段③d)── 掴んで引いた線を、本文を開かずに外す
 * (user 指示 2026-08-23「片道の操作を作らない」── 置けるなら消せる)。
 *
 * 🔑 消し方は `removePlace` と**同じ 1 本**(開き行から閉じの `:::` + 隣の空行 1 本)。
 *   違うのは「どの開き行を受けるか」だけ ── 板の行を渡しても線は消えず、線の行を渡しても
 *   板は消えない(押していない物を消さない)。
 * ⚠ 繋がれていた板は 1 バイトも触らない(付けた名前 `#板1` も残る ── 本文の別の所から
 *   `from=板1` で指されているかもしれない。勝手に外すと、そちらが**黙って引けなくなる**)。
 */
export function removePlaceLine(body: string, target: PlaceTarget): string | null {
  return removeBlockAt(body, target, isLineOpen);
}

/** 塊を消す共通部(板 / 線)。⚠ 範囲の取り方・空行の扱いは 1 本。 */
function removeBlockAt(
  body: string,
  target: PlaceTarget,
  accept: (line: string) => boolean,
): string | null {
  const at = placeLinesAt(body, target, accept);
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

/**
 * 🔴 **板の形を変える**(#530 案 A。user 裁定 2026-09-14)── 開き行の `shape=` **だけ**を書く。
 *
 * 🔑 門も「変わらなければ body をそのまま返す」も `movePlace` / `raisePlace` と同じ
 *   (板を書き換える口は 4 つになったが、**検める所は `placeLinesAt` の 1 本**である)。
 * ⚠ **知らない綴りは断る**(`null`)── 素通しにすると、PowerPoint の XML へ
 *   知らない図形名が漏れる(`place-shape.ts`)。
 * ⚠ 四角へ戻すのも**札を消すのではなく `shape=rect` を書く** ── 消す経路を
 *   新しく作らない(経路が 1 本減れば、そこで起きる失敗も 1 つ減る)。
 */
export function setPlaceShape(
  body: string,
  target: PlaceTarget,
  shape: PlaceShape,
): string | null {
  if (!isPlaceShape(shape)) return null;
  return spliceOpenLine(body, target, { shape });
}

/**
 * 🔴 **付箋の色(`fill=` / `stroke=`)と線の色・太さ(`stroke=` / `width=`)を書く**
 * (#530 段④。Gemini 裁定 A、2026-10-02)── 開き行の札**だけ**を書き換える。
 *
 * 🔑 門は `movePlace` / `setPlaceShape` と同じ 1 本(`placeLinesAt`)── 行番号 + 開き行の byte 一致 +
 *   塊の開き行 + frontmatter の外 + fence の外。⚠ 受ける開き行は**付箋と線の両方**
 *   (線の行を渡すと線の札、付箋の行を渡すと付箋の札 ── 押していない種類の札は書かない)。
 * ⚠ **持てない札は断る**(`null`)── 付箋に `width=` を書いても読む側は使わず、
 *   本文だけが増える(「書いたのに効かない」の入口)。
 * ⚠ **値は綴りを検めてから書く**(`isPlaceStyle`)── 素通しにすると、空白や引用符を含む字が
 *   開き行へ入って札の並びが壊れ、画面と PowerPoint へ知らない字が流れる(`place-color.ts`)。
 * 🔴 **`null` の札は消す**(置けるなら外せる)。⚠ 消す札が元から無くても**書かない**
 *   (body をそのまま返す = 済んでいる。`null` ではない)。
 * 🔑 同じ札が重なって書かれていたら(`fill=a fill=b`)、**全部消して 1 つだけ書く** ──
 *   読む側は後ろのものを採るので、前の 1 つを差し替えるだけでは**見た目が変わらない**。
 */
export function setPlaceStyle(
  body: string,
  target: PlaceTarget,
  style: PlaceStyle,
): string | null {
  if (!isPlaceStyle(style)) return null;
  const at = placeLinesAt(body, target, (l) => isLineOpen(l) || isPlaceOpen(l));
  if (at === null) return null;
  const line = at.lines[target.line]!;
  // ⚠ 両方のクラスを持つ塊は線として読む(書き出しも同じ ── `html-blocks.ts`)
  const asLine = isLineOpen(line);
  const allowed = asLine ? LINE_STYLE_KEYS : BOARD_STYLE_KEYS;
  const entries: Array<readonly [PlaceStyleKey, string | null]> = [];
  for (const k of PLACE_STYLE_KEYS) {
    const v = style[k];
    if (v === undefined) continue;
    if (!allowed.includes(k)) return null;
    // 🔴 矢じり / 文字の大きさ: `none` / `standard` は札を消す(「矢じりなし」= 札が無い。`none` と書き足さない)
    const text =
      v === null || v === 'none' || v === 'standard'
        ? null
        : k === 'width' || k === 'arrow' || k === 'size'
          ? String(v)
          : parsePlaceColor(v)!;
    entries.push([k, text]);
  }
  const next = spliceStyleLine(line, asLine ? 'pkc-line' : 'pkc-place', entries);
  if (next === null) return null;
  if (next === line) return body;
  at.lines[target.line] = next;
  return at.lines.join('\n');
}

/**
 * 🔴 **グループ**(#530 段⑤b。Gemini 裁定 2026-10-11 依頼 19 Q3)── 付箋の開き行の `group=名前`。
 *
 * 書き方は `:::format{.pkc-place x=40 y=40 group=グループ1}`。**同じ名前の付箋が 1 つのグループ**
 * (囲む塊は採らない ── 本文は平らなまま。設計 `board-next-stage-design-2026-10.md` §2)。
 * ⚠ 札が無い = グループに入っていない(古いノートは 1 字も変わらない)。
 * ⚠ 名前は**字・数字・`_`・`-` だけ**(空白や引用符を含む字は読めない = 札が無いのと同じ。本文は消さない)。
 * 🔑 読む規則は `parsePlaceGroup` の 1 本(画面のドラッグ・右クリック・書き込みが同じ関数を引く ── §7)。
 */
export const PLACE_GROUP_STEM = 'グループ';
const GROUP_NAME_RE = /^[\p{L}\p{N}_-]+$/u;

/** `group=` の値を読む。⚠ 読めない字 / 値なし / 空は `null`(グループに入っていない扱い)。 */
export function parsePlaceGroup(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return GROUP_NAME_RE.test(v) ? v : null;
}

/** その行が付箋(線ではない板の塊)なら、入っているグループの名前(無い / 読めない = `null`)。 */
export function placeGroupAt(line: string): string | null {
  if (isLineOpen(line)) return null;
  const attrs = placeOpenAttrs(line);
  return attrs === null ? null : parsePlaceGroup(attrs.kvs.group);
}

/** グループにする窓に並べる 1 枚。 */
export interface PlaceGroupItem {
  /** 開き行の行番号(**生の body** の 0 始まり)。 */
  readonly line: number;
  readonly openLine: string;
  /** 付箋の最初の 1 行(空なら空の字)。 */
  readonly label: string;
  /** 入っているグループ(無ければ `null`)。 */
  readonly group: string | null;
}

/** 窓の一覧に出す最初の 1 行の長さの上限(字)。 */
export const PLACE_GROUP_LABEL_MAX = 40;

/**
 * 🔴 **この本文の付箋を全部**(fence の外・線を除く)── グループにする窓の一覧と、動かす相手の探索の元。
 * 🔑 「付箋か」は `isPlaceOpen`(描画と同じ関数)の 1 本。最初の 1 行は開き行の次の、空でない最初の行。
 */
export function placeGroupItems(body: string): PlaceGroupItem[] {
  const fm = frontmatterLineCount(body);
  const lines = body.split('\n');
  const mask = fenceMask(lines, fm);
  const out: PlaceGroupItem[] = [];
  for (let i = fm; i < lines.length; i += 1) {
    if (mask[i] === true) continue;
    const open = lines[i]!;
    if (!isPlaceOpen(open) || isLineOpen(open)) continue;
    let label = '';
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trim();
      if (t === ':::') break;
      if (t !== '') {
        label = t;
        break;
      }
    }
    if (label.length > PLACE_GROUP_LABEL_MAX) label = `${label.slice(0, PLACE_GROUP_LABEL_MAX)}…`;
    out.push({ line: i, openLine: open, label, group: placeGroupAt(open) });
  }
  return out;
}

/** まだ使われていない `グループN`(N は 1 から)。⚠ 上限を置く(見つからなければ `null`)。 */
function freeGroupName(taken: ReadonlySet<string>): string | null {
  for (let i = 1; i <= AUTO_NAME_MAX; i += 1) {
    const n = `${PLACE_GROUP_STEM}${i}`;
    if (!taken.has(n)) return n;
  }
  return null;
}

/**
 * 複数の開き行を**まとめて**検める(1 つでも外れたら `null` = 1 つも書かない)。
 * 🔑 `placeLinesAt` を行ごとに呼ばない ── 1 回の走査で fence を数え、**全部を同じ lines に書く**
 *   (途中で一部だけ書けた状態を作らない)。同じ行を 2 度指していても断る。
 */
function placeLinesAtAll(
  body: string,
  targets: readonly PlaceTarget[],
  accept: (line: string) => boolean,
): { lines: string[]; fm: number } | null {
  if (targets.length === 0) return null;
  const fm = frontmatterLineCount(body);
  const lines = body.split('\n');
  const mask = fenceMask(lines, fm);
  const seen = new Set<number>();
  for (const t of targets) {
    if (!Number.isInteger(t.line) || t.line < fm || seen.has(t.line)) return null;
    seen.add(t.line);
    const l = lines[t.line];
    if (l === undefined || l !== t.openLine || !accept(l) || mask[t.line] === true) return null;
  }
  return { lines, fm };
}

/**
 * 🔴 **付箋をグループにする**(#530 段⑤b)── 渡した付箋の開き行に、同じ `group=グループN` を書く。
 *
 * - 名前は**使われていない最小の `グループN`**(本文に書かれている名前から数える)
 * - 2 枚未満は断る(1 枚だけのグループは作らない)
 * - 門は全部 `placeLinesAtAll`(行番号 + 開き行の byte 一致 + 付箋 + frontmatter の外 + fence の外)
 * - すでに別のグループに入っている付箋は、新しいグループへ**移る**(札が差し替わる)
 */
export function groupPlaces(body: string, targets: readonly PlaceTarget[]): string | null {
  if (targets.length < 2) return null;
  const at = placeLinesAtAll(body, targets, (l) => isPlaceOpen(l) && !isLineOpen(l));
  if (at === null) return null;
  const mask = fenceMask(at.lines, at.fm);
  const taken = new Set<string>();
  for (let i = at.fm; i < at.lines.length; i += 1) {
    if (mask[i] === true) continue;
    const g = placeGroupAt(at.lines[i]!);
    if (g !== null) taken.add(g);
  }
  const name = freeGroupName(taken);
  if (name === null) return null;
  for (const t of targets) {
    const next = spliceStyleLine(at.lines[t.line]!, 'pkc-place', [['group', name]]);
    if (next === null) return null;
    at.lines[t.line] = next;
  }
  return at.lines.join('\n');
}

/**
 * 🔴 **グループを解く**(#530 段⑤b。置けるなら外せる)── 渡した付箋の**グループの全員**から `group=` を消す。
 * 🔑 全員を探すのは fence の外の付箋の開き行(同じ名前)── 位置は動かさない。
 * ⚠ 渡した付箋が読めない `group=` を持つだけなら、その 1 枚の札だけ消す(他は巻き込まない)。
 * 🔑 グループに入っていない付箋なら body をそのまま返す(書く物が無い ≠ 競合)。
 */
export function ungroupPlace(body: string, target: PlaceTarget): string | null {
  const at = placeLinesAt(body, target, (l) => isPlaceOpen(l) && !isLineOpen(l));
  if (at === null) return null;
  const name = placeGroupAt(at.lines[target.line]!);
  const mask = fenceMask(at.lines, at.fm);
  let changed = false;
  for (let i = at.fm; i < at.lines.length; i += 1) {
    if (mask[i] === true) continue;
    const l = at.lines[i]!;
    if (!isPlaceOpen(l) || isLineOpen(l)) continue;
    const mine = i === target.line;
    if (!mine && (name === null || placeGroupAt(l) !== name)) continue;
    const next = spliceStyleLine(l, 'pkc-place', [['group', null]]);
    if (next === null || next === l) continue;
    at.lines[i] = next;
    changed = true;
  }
  return changed ? at.lines.join('\n') : body;
}

/** 複数の付箋を動かす 1 件(`PlaceMove` と同じ)。 */
export type PlaceGroupMove = PlaceMove;

/**
 * 🔴 **グループの全員を一度に動かす**(#530 段⑤b)── 各付箋の x= / y= だけを書く。
 * 🔑 **1 回の書込**(途中で一部だけ動いた状態にならない)── 1 枚でも門(開き行の byte 一致など)が外れたら
 *   **1 枚も書かず `null`**。全員が元の位置のままなら body をそのまま返す。
 */
export function movePlaces(body: string, moves: readonly PlaceGroupMove[]): string | null {
  for (const m of moves) if (!isCoord(m.x) || !isCoord(m.y)) return null;
  const at = placeLinesAtAll(body, moves, isPlaceOpen);
  if (at === null) return null;
  let changed = false;
  for (const m of moves) {
    const l = at.lines[m.line]!;
    const next = spliceTokens(l, { x: m.x, y: m.y });
    if (next === null) return null;
    if (next !== l) changed = true;
    at.lines[m.line] = next;
  }
  return changed ? at.lines.join('\n') : body;
}

/**
 * 🔴 **グループを掴んだときの動かす量**(画面の掴みと同じ規則の 1 本)。
 * 全員の左上が 0 を下回らないよう、**全員で同じだけ**手前で止める(形を崩さない)。
 * 1 枚だけのときは `max(0, start + d)` と同じ(今までの動き)。
 */
export function clampGroupDelta(
  starts: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  dx: number,
  dy: number,
): { dx: number; dy: number } {
  let minX = Infinity;
  let minY = Infinity;
  for (const s of starts) {
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
  }
  if (starts.length === 0) return { dx, dy };
  return { dx: Math.max(dx, -minX), dy: Math.max(dy, -minY) };
}

/** 開き行に付いている色・太さ。⚠ 読めない値は `null`(描く側が無視する物と同じ規則)。 */
export interface PlaceStyleRead {
  readonly fill: string | null;
  readonly stroke: string | null;
  readonly width: number | null;
  /** 🔴 矢じり(線だけ。札が無い / 読めない = `none`)。読む規則は `placeArrowOf` の 1 本(§7)。 */
  readonly arrow: PlaceArrow;
  /** 🔴 文字の大きさ(付箋だけ。札が無い / 読めない = `standard`)。読む規則は `placeSizeOf` の 1 本(§7)。 */
  readonly size: PlaceSize;
  /**
   * **その種類が持てる札のどれかが書かれているか**(値が読めなくても真)。
   * 🔑 右クリックの「色を外す」を出すかの判定 ── 読めない値(`fill=red`)も、外せなければ
   *   画面に出ない札が本文に残り続ける。
   * ⚠ **文字の大きさ(`size=`)は数えない** ── 「色を外す」は色の札しか消さないので、`size=` だけの付箋で
   *   出すと押しても何も起きない(無言の dead click)。大きさは `written.size` で見る。
   */
  readonly any: boolean;
  /** 札ごとの「書かれているか」(読めない値も真)。⚠ 持てない札は常に `false`。 */
  readonly written: Readonly<Record<PlaceStyleKey, boolean>>;
}

/**
 * その行が付箋 / 線なら、いま付いている色・太さ。どちらでもなければ `null`。
 * 🔑 読む規則は描画(`place-board.ts`)と書き出し(`html-blocks.ts`)と**同じ**
 *   `parsePlaceColor` / `parsePlaceWidth`(§7)。
 */
export function placeStyleAt(line: string): PlaceStyleRead | null {
  const asLine = isLineOpen(line);
  const attrs = asLine ? formatOpenAttrs(line, 'pkc-line') : placeOpenAttrs(line);
  if (attrs === null) return null;
  const keys = asLine ? LINE_STYLE_KEYS : BOARD_STYLE_KEYS;
  return {
    fill: keys.includes('fill') ? parsePlaceColor(attrs.kvs.fill) : null,
    stroke: parsePlaceColor(attrs.kvs.stroke),
    width: keys.includes('width') ? parsePlaceWidth(attrs.kvs.width) : null,
    arrow: keys.includes('arrow') ? placeArrowOf(attrs.kvs.arrow) : 'none',
    size: keys.includes('size') ? placeSizeOf(attrs.kvs.size) : 'standard',
    any: keys.some((k) => k !== 'size' && attrs.kvs[k] !== undefined),
    written: {
      fill: keys.includes('fill') && attrs.kvs.fill !== undefined,
      stroke: attrs.kvs.stroke !== undefined,
      width: keys.includes('width') && attrs.kvs.width !== undefined,
      arrow: keys.includes('arrow') && attrs.kvs.arrow !== undefined,
      size: keys.includes('size') && attrs.kvs.size !== undefined,
    },
  };
}

/** `key=値`(引用符つきも)を全部拾う正規表現。⚠ 前の空白ごと拾う(消したとき隙間を残さない)。 */
const styleTokenRe = (key: string): RegExp =>
  new RegExp(`(^|\\s)${key}=(?:"[^"]*"|'[^']*'|\\S*)`, 'g');

/** 札を全部消す。 */
function removeToken(attrs: string, key: string): string {
  return attrs.replace(styleTokenRe(key), '').replace(/^\s+/, '');
}

/** 札を 1 つだけにして書く(無ければ足す / 1 つなら**その場で**差し替える / 重なっていれば全部消して末尾へ)。 */
function setStyleToken(attrs: string, key: string, value: string): string {
  const count = attrs.match(styleTokenRe(key))?.length ?? 0;
  if (count === 1) return attrs.replace(styleTokenRe(key), `$1${key}=${value}`);
  const rest = count === 0 ? attrs : removeToken(attrs, key);
  return rest === '' ? `${key}=${value}` : `${rest} ${key}=${value}`;
}

/**
 * 開き行の色・太さの札を書き換える(`spliceTokens` の線対応版 ── こちらは**札を消せる**)。
 * - `{}` を持つ形 ── 括弧の中の札だけ差し替える
 * - `{}` を持たない Tier 1 形 ── 札を**持てない**ので、足す物があるときだけ括弧つきへ整える
 *   (消すだけなら**行に触らない** ── 消す物が無い)
 */
function spliceStyleLine(
  line: string,
  cls: string,
  entries: ReadonlyArray<readonly [string, string | null]>,
): string | null {
  const attrs = formatOpenAttrs(line, cls);
  if (attrs === null) return null;
  const open = line.indexOf('{');
  const close = line.lastIndexOf('}');
  if (open !== -1 && close > open) {
    let inner = line.slice(open + 1, close);
    for (const [k, v] of entries) inner = v === null ? removeToken(inner, k) : setStyleToken(inner, k, v);
    return line.slice(0, open + 1) + inner + line.slice(close);
  }
  if (!entries.some(([, v]) => v !== null)) return line;
  const parts = attrs.classes.map((c) => `.${c}`);
  if (attrs.id !== undefined) parts.push(`#${attrs.id}`);
  for (const [k, v] of entries) if (v !== null) parts.push(`${k}=${v}`);
  return `::: {${parts.join(' ')}}`;
}

/**
 * その行が板なら、いま付いている形。板でなければ `null`。
 * 🔑 読む側の既定(札が無い = 四角)は `placeShapeOf` の 1 か所(§7)。
 */
export function placeShapeAt(line: string): PlaceShape | null {
  const attrs = placeOpenAttrs(line);
  return attrs === null ? null : placeShapeOf(attrs.kvs.shape);
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

/**
 * 🔴 **板のテンプレートを (x, y) を左上にして足す**(#529 W4)── 本文の末尾に、既存の記法の
 * 枠(と線)を書く。門・末尾の書き方は `addPlace` と同じ(閉じていない囲いの中へは書かない)。
 *
 * ⚠ 流れ図の枠の名前は本文で**使われていない `板N`** を取る(`connectPlaces` が付ける名前と同じ
 *   規則 ── 線が別の枠を指さない)。取れなければ null(当て推量の名前を書かない)。
 */
export function addPlaceTemplate(
  body: string,
  x: number,
  y: number,
  id: PlaceTemplateId,
): string | null {
  if (!isCoord(x) || !isCoord(y)) return null;
  const tpl = PLACE_TEMPLATES.find((t) => t.id === id);
  if (tpl === undefined) return null;
  const spans = scanContainers(body);
  const last = spans[spans.length - 1];
  if (last !== undefined && last.open) return null;
  const taken = takenNames(body.split('\n'));
  const names: string[] = [];
  for (let i = 0; i < tpl.names; i += 1) {
    const n = freeName(taken);
    if (n === null) return null;
    taken.add(n);
    names.push(n);
  }
  const text = placeTemplateBody(id, x, y, names);
  if (text === null) return null;
  const block = `${text}\n`;
  if (body === '') return block;
  return body + (body.endsWith('\n') ? '\n' : '\n\n') + block;
}

/** 開き行に書ける札。⚠ `entry=` は書かない(題名の札は user が書く物)。 */
type PlaceKey = 'x' | 'y' | 'w' | 'h' | 'z' | 'shape';
/**
 * 書き換える札。⚠ **座標は数、形は決まった綴りだけ**(#530)──
 * 値を `string` で素通しにすると、空白や引用符を含む字が開き行へ入って
 * **札の並びが壊れる**(`place-shape.ts` の docstring)。
 */
type PlaceTokens = {
  readonly x?: number;
  readonly y?: number;
  readonly w?: number;
  readonly h?: number;
  readonly z?: number;
  readonly shape?: PlaceShape;
};
const PLACE_KEYS: readonly PlaceKey[] = ['x', 'y', 'w', 'h', 'z', 'shape'];

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
function setToken(attrs: string, key: PlaceKey, value: number | string): string {
  const re = new RegExp(`(^|\\s)${key}=(?:"[^"]*"|\\S*)`);
  if (re.test(attrs)) return attrs.replace(re, `$1${key}=${value}`);
  return attrs === '' ? `${key}=${value}` : `${attrs} ${key}=${value}`;
}

/**
 * 🔴 **板どうしを線で繋ぐ**(#530 段③d)── 掴んで引いた結果を本文へ書く。
 *
 * ⚠ **本文が増える操作である** ── 名前の無い板には `#板1` が足される。
 *   だから門は**移動と同じだけ**持つ(行番号 + 開き行の byte 一致 + 板の開き行 +
 *   frontmatter の外 + fence の外)。1 つでも緩むと、**押していない板の行が書き換わる**。
 */
export interface PlaceConnect {
  readonly from: PlaceTarget;
  readonly to: PlaceTarget;
  /**
   * 手で選んだ接続点の綴り(`right` / `right@1/4`)。無ければ自動(書かない)。
   * 🔴 **読めない綴りは書かずに断る** ── 読む側(`place-line.ts`)が受けない字を
   *   書き込むと、**本文は変わったのに線は出ない**という、いちばん気づけない
   *   壊れ方になる(#689 の「読む側と書く側で門の段数が違う」)。
   */
  readonly fromAnchor?: string | null;
  readonly toAnchor?: string | null;
}

/** 付ける名前の頭。⚠ 日本語が使える(#530、user 裁定 2026-09-15)。 */
const AUTO_NAME_STEM = '板';
/** ⚠ 上限を置く ── 見つからなければ**作らずに断る**(当て推量の名前を書かない)。 */
const AUTO_NAME_MAX = 999;

/** 本文で既に使われている名前(板・図・その他の `:::` の塊すべて)。 */
function takenNames(lines: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const l of lines) {
    const named = parseBlockDirectiveOpen(l.trim());
    if (named !== null) {
      if (named.attrs.id !== undefined) out.add(named.attrs.id);
      continue;
    }
    const tier1 = parseTier1FormatOpen(l);
    if (tier1?.id !== undefined) out.add(tier1.id);
  }
  return out;
}

/** まだ使われていない `板N` を 1 つ。⚠ 無ければ `null`(名前を作らない)。 */
function freeName(taken: ReadonlySet<string>): string | null {
  for (let i = 1; i <= AUTO_NAME_MAX; i += 1) {
    const n = `${AUTO_NAME_STEM}${i}`;
    if (!taken.has(n)) return n;
  }
  return null;
}

/**
 * その行の板に名前を付ける(既に在ればそれを返す)。⚠ `lines` をその場で書き換える。
 * 🔑 Tier 1 の寛容形は `spliceTokens` と同じく**括弧つきへ整える**(書ける場所を作る)。
 */
function ensureName(lines: string[], line: number, taken: Set<string>): string | null {
  const cur = lines[line];
  if (cur === undefined) return null;
  const attrs = placeOpenAttrs(cur);
  if (attrs === null) return null;
  if (attrs.id !== undefined) return attrs.id;
  const name = freeName(taken);
  if (name === null) return null;
  const braced = spliceTokens(cur, {});
  if (braced === null) return null;
  const open = braced.indexOf('{');
  const close = braced.lastIndexOf('}');
  if (open === -1 || close <= open) return null;
  const inner = braced.slice(open + 1, close);
  lines[line] = `${braced.slice(0, open + 1)}#${name}${inner === '' ? '' : ' '}${inner}`
    + braced.slice(close);
  taken.add(name);
  return name;
}

/** `a` / `a:right@1/4`。⚠ 読めない綴りは `null`(呼び側が断る)。 */
function connectSpell(id: string, anchor: string | null | undefined): string | null {
  if (anchor === null || anchor === undefined || anchor === '') return id;
  return parseAnchorSpell(anchor) === null ? null : `${id}:${anchor}`;
}

/** `from=` / `to=` が同じ綴りの線の塊が、fence の外に在るか。 */
function hasLineBetween(
  lines: readonly string[],
  fm: number,
  fromSpell: string,
  toSpell: string,
): boolean {
  const mask = fenceMask(lines, fm);
  for (let i = fm; i < lines.length; i += 1) {
    if (mask[i] === true) continue;
    const attrs = formatOpenAttrs(lines[i]!, 'pkc-line');
    if (attrs !== null && attrs.kvs.from === fromSpell && attrs.kvs.to === toSpell) return true;
  }
  return false;
}

/**
 * 🔴 2 枚の板を線で繋いだ本文を返す(名前が無ければ付ける)。断るときは `null`。
 *
 * ⚠ **同じ板どうしは繋がない** ── 引く物が無いので、本文だけ増えて線は出ない。
 * ⚠ 線の塊は**本文のいちばん後ろ**へ足す(`addPlace` と同じ作法)── 板の塊の
 *   途中へ差し込むと、後ろの板の行番号が全部ずれる。
 */
export function connectPlaces(body: string, c: PlaceConnect): string | null {
  if (c.from.line === c.to.line) return null;
  const a = placeLinesAt(body, c.from);
  if (a === null) return null;
  // ⚠ 2 枚目も**同じ門**を通す(片方だけ検めると、もう片方は別の塊でも書ける)
  if (placeLinesAt(body, c.to) === null) return null;
  const lines = a.lines;
  const taken = takenNames(lines);
  const from = ensureName(lines, c.from.line, taken);
  const to = ensureName(lines, c.to.line, taken);
  if (from === null || to === null) return null;
  const fromSpell = connectSpell(from, c.fromAnchor);
  const toSpell = connectSpell(to, c.toAnchor);
  if (fromSpell === null || toSpell === null) return null;
  const next = lines.join('\n');
  /**
   * 🔑 **同じ 2 点を同じ綴りで結ぶ線が既に在れば、書かない**(= 済んでいる。null ではない)。
   * ⚠ 同じ掴み方を 2 度すると、**重なって 1 本に見える線が本文に 2 つ**できる ──
   *   消す口は 1 つずつ消すので、「消したのに線が残る」になる(片道の操作を作らない)。
   * ⚠ 名前を足した回(`next !== body`)は見ない ── 足したばかりの名前を指す線は在りえない。
   */
  if (next === body && hasLineBetween(lines, a.fm, fromSpell, toSpell)) return body;
  // ⚠ 閉じていない塊の中へ足さない(`addPlace` と同じ門)
  const spans = scanContainers(next);
  const last = spans[spans.length - 1];
  if (last !== undefined && last.open) return null;
  const block = `:::format{.pkc-line from=${fromSpell} to=${toSpell}}\n:::\n`;
  return next + (next.endsWith('\n') ? '\n' : '\n\n') + block;
}
