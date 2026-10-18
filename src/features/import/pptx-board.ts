/**
 * 🔴 **PowerPoint(.pptx)のスライドを板(ホワイトボード)へ戻す**(#530 C)。
 *
 * 書き出し(`features/export/pptx.ts`、設計 `docs/development/board-to-pptx-design-2026-08.md`)の
 * 逆向きである。**スライド 1 枚 = 板 1 枚**(ノート 1 件)── 書き出しが「板は 1 枚で 1 スライド」と
 * 決めているので、対にするとこの形になる。
 *
 * - 🔑 **新しい記法を作らない。** 戻す先は既存の板の記法だけ(`.pkc-place` の `x= y= w= h= shape= fill= stroke=` と、
 *   `.pkc-line` の `from= to= route= stroke= width=`)。
 * - 🔑 **対応表は書き出しの表から引く**(`PRST_OF` / `CXN_PRST` / `CXN_IDX`)── 逆向きの表を別に持つと、
 *   書き出し側だけ直したとき往復が静かにずれる(§7)。
 * - ⚠ **戻せなかったものは数える**(`dropped`)。黙って捨てない ── 呼び側が件数を user に言う。
 *   数える対象は、図(`p:pic`)・表(`p:graphicFrame`)・位置を持たない図形・
 *   両端が解決できない線。
 * - 🔴 **グループ(`p:grpSp`)は開いて平らに読む**(#530 段⑤c)── 同じ `group=` を付ける。入れ子は内側だけ残す。
 *   **回転(`rot`)も読む**(段⑤e)── 群の回転は子の位置と向きに合成する。
 * - ⚠ **PKC3 以外が作った .pptx も、読めた範囲だけ**戻す。
 *
 * ## 座標(EMU → px)
 *
 * 書き出しは板を**枠の中央へ置き**(`boardShapes` の `originX/Y`)、大きい板は同じ率で縮める。
 * 受け手はその原点を知らないので、**書き出しの枠の取り方から逆算する**:
 * 縮めていない板なら右端・下端から板の大きさが一意に決まり、そこから原点が出る。
 * 逆算が成り立たない(縮められた板 / 本文や表が同居した枠 / 他アプリの file)ときは、
 * 図形の左上の最小値を原点にして**相対位置を保つ**(1 px = 9525 EMU)。
 *
 * ## ⚠ pure module
 * browser API を使わない(`features` 層)。XML は `xml-lite.ts` の最小パーサで読む(worker でも走る)。
 */

import {
  CXN_IDX,
  CXN_PRST,
  EMU_PER_PX,
  FRAME,
  PPTX_ROT_UNIT,
  PRST_OF,
} from '../export/pptx';
import { parseXml, textOf, walk, type XmlNode } from '../export/xml-lite';
import { foldBreaks } from './fold-breaks';
import {
  nearestPlaceSize,
  parsePlaceColor,
  parsePlaceWidth,
  PLACE_LINE_WIDTH_DEFAULT,
  PLACE_SIZE_PPTX_SZ,
  type PlaceSize,
} from '../markdown/place-color';
import { PLACE_EDGES, PLACE_ROUTES, type PlaceEdge, type PlaceRoute } from '../markdown/place-line';
import { parsePlaceGroup, PLACE_GROUP_STEM } from '../markdown/place-notation';
import { rotatedBounds, rotatePointAround } from '../markdown/place-rotate';
import { PLACE_SHAPES, type PlaceShape } from '../markdown/place-shape';

/** 取込の振り分けが見る拡張子(`isVcfFileName` と同じ作法 ── 中身では決めない)。 */
export function isPptxFileName(name: string): boolean {
  return /\.pptx$/i.test(name);
}

/** スライド 1 枚の読み結果。 */
export interface PptxBoardSlide {
  /** 題名の図形があればその字。無ければ `null`(呼び側が file 名から付ける)。 */
  readonly title: string | null;
  /** 板の本文(`.pkc-place` / `.pkc-line` の塊)。置ける図形が無ければ空文字。 */
  readonly body: string;
  /** 板に置いた付箋の数。 */
  readonly placed: number;
  /**
   * 🔴 位置を持たない本文(レイアウトから位置を借りる題名・本文の枠)から、**普通の本文として**取り込んだ枠の数
   * (#1163 依頼 124-1 = A)。字だけのスライドが 1 枚もノートにならなかった ── 本文は板ではなく上から順の段落にする。
   */
  readonly flowed: number;
  /** 引いた線の数。 */
  readonly lines: number;
  /** 戻せなかったものの数。 */
  readonly dropped: number;
  /**
   * 🔴 文字の大きさを**近い段へ丸めた**付箋の数(#530 段⑤a)。⚠ 段の値(14 / 18 / 27 / 40 pt)と**ちょうど同じ**なら
   * 数えない ── 自分が書き出した file は 0 になる。呼び側が件数を user に言う。
   */
  readonly rounded: number;
  /**
   * 🔴 **近い形に直した**付箋の数(#530 段⑤c・⑤e)── 入れ子のグループ(内側の名前だけ残る)と、反転(`flipH` / `flipV`。向きは失われる)。
   * ⚠ 呼び側が件数を user に言う。
   */
  readonly simplified: number;
}

/** 名前の頭(`connectPlaces` が付ける名前と同じ。⚠ 日本語が使える)。 */
const NAME_STEM = '板';

const local = (tag: string): string => {
  const i = tag.indexOf(':');
  return i < 0 ? tag : tag.slice(i + 1);
};
const kids = (n: XmlNode, name: string): XmlNode[] =>
  n.children.filter((c) => c.tag !== '#text' && local(c.tag) === name);
const kid = (n: XmlNode | undefined, name: string): XmlNode | undefined =>
  n === undefined ? undefined : kids(n, name)[0];
const int = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

interface Rect { x: number; y: number; w: number; h: number }

interface ShapeRead {
  readonly id: string | null;
  readonly name: string;
  readonly isTitle: boolean;
  /** 扉の副題(題名と同じく板の付箋にしない)。 */
  readonly isSub: boolean;
  /** 板の形に無い図形(四角で置いた)。 */
  readonly reshaped: boolean;
  readonly rect: Rect;
  readonly shape: PlaceShape;
  readonly prst: string;
  readonly fill: string | null;
  readonly stroke: string | null;
  readonly text: string;
  /** 🔴 文字の大きさの段と、丸めたか(#530 段⑤a)。`sz` がどこにも無ければ `null`。 */
  readonly size: { readonly step: PlaceSize; readonly rounded: boolean } | null;
  /** 印を付けない素の字(題名に使う)。 */
  readonly plain: string;
  /** 🔴 回転(度、0〜359 の整数。#530 段⑤e)。回していなければ 0。 */
  readonly rot: number;
  /** 反転(`flipH` / `flipV`)が付いていたか。⚠ 読まない(数えて user へ言う)。 */
  readonly flipped: boolean;
  /** 🔴 入っているグループの通し番号(内側が勝つ)。無ければ `null`(#530 段⑤c)。 */
  readonly group: number | null;
  /** 入れ子の外側の群の名前を失った付箋か(内側の名前だけ残す。#530 段⑤c)。 */
  readonly lostOuter: boolean;
}

/** `prst` → 板の形。⚠ **書き出しの表を裏返す**。知らない図形名は四角。 */
function shapeOfPrst(prst: string): PlaceShape {
  for (const s of PLACE_SHAPES) if (PRST_OF[s] === prst) return s;
  return 'rect';
}

/** `<a:srgbClr val>` を持つ塗り(`solidFill`)の色。無い / 読めない / 色名なら `null`。 */
function solidOf(parent: XmlNode | undefined): string | null {
  const fill = kid(parent, 'solidFill');
  const clr = kid(fill, 'srgbClr');
  return clr === undefined ? null : parsePlaceColor(`#${clr.attrs.val ?? ''}`);
}

/** 本文の塊の先頭に来て、塊の構造を壊す行(`:::` / 見出し / 箇条書き …)を字として扱う。 */
function escapeLine(s: string): string {
  // 🔴 行頭の空白・タブは**記法の頭を隠さない**(描画側の閉じ判定は `^\s*:::\s*$`、開きは `trim()` する)── 空白の後ろに守りを置く
  const m = /^(\s*)([\s\S]*)$/.exec(s);
  const ws = m?.[1] ?? '';
  const rest = m?.[2] ?? s;
  return /^(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|:::|\x60{3}|~~~|-{3,}\s*$|\+{3,}\s*$)/.test(rest) ? `${ws}\\${rest}` : s;
}

/** `<a:p>` 1 つ → markdown の 1 行。 */
function paragraphOf(p: XmlNode): string {
  const pPr = kid(p, 'pPr');
  const lvl = Math.max(0, Math.min(8, int(pPr?.attrs.lvl) ?? 0));
  let runs = '';
  for (const r of p.children) {
    if (r.tag === '#text') continue;
    const t = local(r.tag);
    if (t === 'br') { runs += ' '; continue; }
    if (t !== 'r' && t !== 'fld') continue;
    // 🔴 字の中の改行は空白 1 つに畳む(`<a:br>` と同じ扱い)。畳まないと、`:::` や `:::format{…}` の行を
    //   字の中に隠して板の塊を閉じ、別の付箋・線を差し込める
    const text = foldBreaks(textOf(kid(r, 't') ?? { tag: '#text', attrs: {}, children: [] }));
    if (text === '') continue;
    const rPr = kid(r, 'rPr');
    let s = text;
    // ⚠ 前後の空白は印の外へ出す(`** a **` は強調にならない)
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
    const inner = m?.[2] ?? s;
    if (inner !== '') {
      let w = inner;
      if (rPr?.attrs.strike !== undefined && rPr.attrs.strike !== 'noStrike') w = `~~${w}~~`;
      if (rPr?.attrs.i === '1') w = `*${w}*`;
      if (rPr?.attrs.b === '1') w = `**${w}**`;
      s = `${m?.[1] ?? ''}${w}${m?.[3] ?? ''}`;
    }
    runs += s;
  }
  runs = runs.replace(/\s+$/, '');
  if (kid(pPr, 'buAutoNum') !== undefined) return `${'  '.repeat(lvl)}1. ${runs}`;
  if (kid(pPr, 'buChar') !== undefined) return `${'  '.repeat(lvl)}- ${runs}`;
  return escapeLine(runs);
}

/**
 * 🔴 **付箋の文字の大きさ**(#530 段⑤a)── 字数でいちばん多い `sz` を採り、`normAutofit` の `fontScale` を掛けてから、
 * **いちばん近い段**(`nearestPlaceSize`。段の値は書き出しの表 `PLACE_SIZE_PPTX_SZ` が正本)へ丸める。
 * ⚠ 丸めは失われる情報なので `rounded` で言う(段の値とちょうど同じなら偽)。
 * ⚠ `sz` を持つ run が 1 つも無ければ `null`(= 標準。数えない)。
 */
function readSize(tx: XmlNode): ShapeRead['size'] {
  const chars = new Map<number, number>();
  for (const p of kids(tx, 'p')) {
    for (const r of kids(p, 'r')) {
      const sz = int(kid(r, 'rPr')?.attrs.sz);
      if (sz === null || sz <= 0) continue;
      const n = foldBreaks(textOf(kid(r, 't') ?? { tag: '#text', attrs: {}, children: [] })).length;
      chars.set(sz, (chars.get(sz) ?? 0) + n);
    }
  }
  let best: number | null = null;
  for (const [sz, n] of chars) {
    if (best === null || n > chars.get(best)! || (n === chars.get(best)! && sz > best)) best = sz;
  }
  if (best === null) return null;
  const fs = int(kid(kid(tx, 'bodyPr'), 'normAutofit')?.attrs.fontScale);
  const scaled = fs !== null && fs > 0 ? Math.round((best * fs) / 100000) : best;
  const step = nearestPlaceSize(scaled);
  return { step, rounded: PLACE_SIZE_PPTX_SZ[step] !== scaled };
}

/** `<a:xfrm rot>`(60000 分の 1 度)→ 度(整数、0〜359)。読めない / 0 は 0。 */
function rotDegOf(xfrm: XmlNode | undefined): number {
  const r = int(xfrm?.attrs.rot);
  if (r === null) return 0;
  return ((Math.round(r / PPTX_ROT_UNIT) % 360) + 360) % 360;
}

/**
 * 🔴 **`<p:grpSp>` の座標の写し**(#530 段⑤c)── 子の座標 `c` は `off + (c − chOff) × ext / chExt` でスライドの座標へ戻す。
 * 群が回っている(`rot`)ときは、子の**中心を群の中心の周りに回し**、子の向きに群の向きを足す(§3.3)。
 * ⚠ 群の枠が読めない / 大きさが 0 なら恒等(写さない)。
 */
function groupTransform(grp: XmlNode): (s: ShapeRead) => ShapeRead {
  const xfrm = kid(kid(grp, 'grpSpPr'), 'xfrm');
  const off = kid(xfrm, 'off');
  const ext = kid(xfrm, 'ext');
  const chOff = kid(xfrm, 'chOff');
  const chExt = kid(xfrm, 'chExt');
  const ox = int(off?.attrs.x);
  const oy = int(off?.attrs.y);
  const ew = int(ext?.attrs.cx);
  const eh = int(ext?.attrs.cy);
  const cx0 = int(chOff?.attrs.x);
  const cy0 = int(chOff?.attrs.y);
  const cw = int(chExt?.attrs.cx);
  const ch = int(chExt?.attrs.cy);
  if (ox === null || oy === null || ew === null || eh === null
    || cx0 === null || cy0 === null || cw === null || ch === null || cw <= 0 || ch <= 0) {
    return (s) => s;
  }
  const sx = ew / cw;
  const sy = eh / ch;
  const grot = rotDegOf(xfrm);
  return (s) => {
    const w = s.rect.w * sx;
    const h = s.rect.h * sy;
    let x = ox + (s.rect.x - cx0) * sx;
    let y = oy + (s.rect.y - cy0) * sy;
    if (grot !== 0) {
      const c = rotatePointAround(x + w / 2, y + h / 2, ox + ew / 2, oy + eh / 2, grot);
      x = c.x - w / 2;
      y = c.y - h / 2;
    }
    return {
      ...s,
      rect: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) },
      rot: (s.rot + grot) % 360,
      flipped: s.flipped || xfrm?.attrs.flipH === '1' || xfrm?.attrs.flipV === '1',
    };
  };
}

/** `<p:sp>` 1 つを読む。位置が無ければ `null`(= 戻せない図形)。 */
function readShape(sp: XmlNode): ShapeRead | null {
  const nv = kid(sp, 'nvSpPr');
  const c = kid(nv, 'cNvPr');
  const spPr = kid(sp, 'spPr');
  const xfrm = kid(spPr, 'xfrm');
  const off = kid(xfrm, 'off');
  const ext = kid(xfrm, 'ext');
  const x = int(off?.attrs.x);
  const y = int(off?.attrs.y);
  const w = int(ext?.attrs.cx);
  const h = int(ext?.attrs.cy);
  if (x === null || y === null || w === null || h === null) return null;
  const name = c?.attrs.name ?? '';
  const ph = kid(kid(nv, 'nvPr'), 'ph');
  const isTitle = name === '題名' || ph?.attrs.type === 'title' || ph?.attrs.type === 'ctrTitle';
  const isSub = name === '副題' || ph?.attrs.type === 'subTitle';
  const prstNode = kid(spPr, 'prstGeom');
  const prst = prstNode?.attrs.prst ?? 'rect';
  // 形が変わる = 知らない図形名 / 自前の形(custGeom)。⚠ 形の指定が無いものは四角のまま
  const reshaped =
    kid(spPr, 'custGeom') !== undefined ||
    (prstNode !== undefined && !(Object.values(PRST_OF) as string[]).includes(prst));
  const ln = kid(spPr, 'ln');
  const tx = kid(sp, 'txBody') ?? { tag: '', attrs: {}, children: [] };
  const paras = kids(tx, 'p').map(paragraphOf);
  const plain = foldBreaks(textOf(tx)).trim();
  while (paras.length > 0 && paras[paras.length - 1]!.trim() === '') paras.pop();
  return {
    id: c?.attrs.id ?? null,
    name,
    isTitle,
    isSub,
    reshaped,
    rect: { x, y, w, h },
    shape: shapeOfPrst(prst),
    prst,
    fill: solidOf(spPr),
    stroke: solidOf(ln),
    text: paras.join('\n'),
    size: readSize(tx),
    plain,
    rot: rotDegOf(xfrm),
    flipped: xfrm?.attrs.flipH === '1' || xfrm?.attrs.flipV === '1',
    group: null,
    lostOuter: false,
  };
}

/**
 * 🔴 **位置を持たない題名・本文の枠**(#1163 依頼 124-1 = A)。PowerPoint の普通のスライドは、題名と本文の枠の位置を
 * レイアウトから借りるので `<a:xfrm>` を持たない。位置が無い枠は板に置けないが、字は失わない:
 * 題名はノートの題名に、本文(副題を含む)は上から順の段落にする。
 * - 日付・フッター・スライド番号の枠は、スライドの中身ではないので黙って読み飛ばす
 * - 図・表・グラフの枠(`pic` / `tbl` / …)と、枠の種類が分からないものは今までどおり「取り込めなかったもの」に数える(`null`)
 * ⚠ 字が無い枠(「クリックして入力」の空の枠)は何も返さない(数えない)。
 */
function readFlowShape(sp: XmlNode): { kind: 'title' | 'body' | 'skip'; plain: string; paras: string[] } | null {
  const ph = kid(kid(kid(sp, 'nvSpPr'), 'nvPr'), 'ph');
  if (ph === undefined) return null;
  const type = ph.attrs.type;
  if (type === 'dt' || type === 'ftr' || type === 'sldNum') return { kind: 'skip', plain: '', paras: [] };
  const isTitle = type === 'title' || type === 'ctrTitle';
  if (!isTitle && type !== undefined && type !== 'body' && type !== 'subTitle' && type !== 'obj') return null;
  const tx = kid(sp, 'txBody') ?? { tag: '', attrs: {}, children: [] };
  // 空の段落は読み飛ばす(スライドの余白のための改行 ── markdown の段落の区切りは空行で足りる)
  const paras = kids(tx, 'p').map(paragraphOf).filter((l) => l.trim() !== '');
  return { kind: isTitle ? 'title' : 'body', plain: foldBreaks(textOf(tx)).trim(), paras };
}

/** 段落の列を本文にする。箇条書きの行どうしは続け、ふつうの段落は空行で分ける(markdown の段落になる)。 */
function joinFlowParas(paras: readonly string[]): string {
  const isItem = (l: string): boolean => /^\s*(?:[-*+]|\d+\.)\s/.test(l);
  let out = '';
  paras.forEach((l, i) => {
    if (i === 0) out = l;
    else out += (isItem(l) && isItem(paras[i - 1]!) ? '\n' : '\n\n') + l;
  });
  return out;
}

/** 逆算に使う枠(書き出しの `FRAME`)。 */
type Frame = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

/**
 * 枠の中央に置かれた長さ `U`(縮めていない)の右端 `E` から `U` を戻す。
 * 書き出しは `origin = f + floor((F - U) / 2)`、右端 `E = origin + U` なので
 * `E - f = floor((F + U) / 2)` ── `U` は `2(E - f) - F` か、その +1。
 * 🔑 板の大きさは px の整数 × 9525 なので、**9525 の倍数になる方**だけを採る(縮めた板は倍数にならない)。
 */
function lengthFromEdge(edge: number, f: number, F: number, loose: boolean): number | null {
  const base = 2 * (edge - f) - F;
  /**
   * 🔴 回した付箋がある板(#530 段⑤e)── 外接四角の右端・下端は 9525 の倍数にならない(15° の `sin` は割り切れない)。
   * ⚠ 倍数かどうかの検めは外す(丸めた EMU の 1〜2 の誤差は px に直すと消える)。外すのは**回した付箋があるときだけ** ──
   *   回していない板の検めは今までどおり(縮められた板・他アプリの file を「書き出しの板」と誤読しない)。
   */
  if (loose) {
    const u = Math.round(base);
    return u > 0 && u <= F + 2 ? Math.min(u, F) : null;
  }
  for (const u of [base, base + 1]) {
    if (u > 0 && u <= F && u % EMU_PER_PX === 0) return u;
  }
  return null;
}

/** 書き出しの枠の取り方から原点を逆算する。成り立たなければ `null`(呼び側が相対位置へ倒す)。 */
function originFromExport(
  rects: readonly Rect[],
  frame: Frame,
  loose: boolean,
): { x: number; y: number } | null {
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    right = Math.max(right, r.x + r.w);
    bottom = Math.max(bottom, r.y + r.h);
  }
  const U = lengthFromEdge(right, frame.x, frame.w, loose);
  const H = lengthFromEdge(bottom, frame.y, frame.h, loose);
  if (U === null || H === null) return null;
  // 左上の図形が板の外へ出ていたら、逆算が外れている
  const o = { x: right - U, y: bottom - H };
  const slack = loose ? 2 : 0;
  for (const r of rects) if (r.x < o.x - slack || r.y < o.y - slack) return null;
  return o;
}

/** 辺の番号(`idx`)→ 辺。⚠ 書き出しの表を裏返す。当たらなければ `null`(= 自動に任せる)。 */
function edgeOf(shape: PlaceShape, idx: number | null): PlaceEdge | null {
  if (idx === null) return null;
  for (const e of PLACE_EDGES) if (CXN_IDX[shape][e] === idx) return e;
  return null;
}

function routeOf(prst: string): PlaceRoute | null {
  // ⚠ 直線は既定なので書かない(`PLACE_ROUTES` の先頭が straight)
  for (const r of PLACE_ROUTES) {
    if (r === 'straight') continue;
    if (prst.startsWith(CXN_PRST[r].replace(/\d+$/, ''))) return r;
  }
  return null;
}

/** 書き出しが「色なし」でも出す線の色。⚠ これと同じなら書かない(往復で同じ見た目になる)。 */
const LINE_DEFAULT_RGB = '#808080';

/**
 * スライド XML 1 枚 → 板。壊れた XML は投げる(呼び側が断り文にする)。
 */
export function readPptxSlide(xml: string): PptxBoardSlide {
  const root = parseXml(xml);
  const tree = kid(kid(root, 'cSld'), 'spTree');
  if (tree === undefined) throw new Error('スライドの中身(spTree)が見つかりません');
  let dropped = 0;
  // 🔴 板に置かない副題(扉)の数。⚠ `dropped` には足さない ── `pure`(位置の逆算の可否)を変えてしまう。最後に件数だけ足す
  let subtitles = 0;
  // 形を変えて(四角で)置いた数。⚠ 位置の逆算の可否(`pure`)には数えない
  let reshaped = 0;
  const conns: XmlNode[] = [];
  let title: string | null = null;
  let hasBodyText = false;
  // 🔴 位置を持たない本文の枠から読んだ段落(#1163 依頼 124-1)と、その枠の数
  const flowParas: string[] = [];
  let flowed = 0;
  // 🔴 グループ(#530 段⑤c)── `<p:grpSp>` を**開いて平らに**読む。名前は後でまとめて決める(下の ⑤)
  const groupNames: string[] = [];
  const walk = (nodes: readonly XmlNode[], depth: number): ShapeRead[] => {
    const got: ShapeRead[] = [];
    for (const el of nodes) {
      if (el.tag === '#text') continue;
      const t = local(el.tag);
      if (t === 'sp') {
        const s = readShape(el);
        if (s === null) {
          const flow = readFlowShape(el);
          if (flow === null) { dropped += 1; continue; }
          if (flow.kind === 'title') {
            if (title === null) title = flow.plain;
          } else if (flow.kind === 'body' && flow.paras.length > 0) {
            flowParas.push(...flow.paras);
            flowed += 1;
          }
          continue;
        }
        if (s.isTitle) {
          if (title === null) title = s.plain;
          continue;
        }
        // 副題は付箋にしない(板に戻せない)。字があるものは黙って消えないよう数える(空の置き場は数えない)
        if (s.isSub) {
          if (s.plain !== '') subtitles += 1;
          continue;
        }
        if (s.reshaped) reshaped += 1;
        if (s.name === '本文') hasBodyText = true;
        got.push(s);
      } else if (t === 'cxnSp') {
        // ⚠ グループの中の線も読む(`id` はスライド内で一意 ── 引き方は変わらない)
        conns.push(el);
      } else if (t === 'grpSp') {
        const gi = groupNames.length;
        groupNames.push(kid(kid(el, 'nvGrpSpPr'), 'cNvPr')?.attrs.name ?? '');
        const move = groupTransform(el);
        for (const c of walk(el.children, depth + 1)) {
          const m = move(c);
          // 🔑 入れ子は内側が勝つ(`group=` は 1 枚に 1 つ)
          got.push(m.group === null ? { ...m, group: gi } : { ...m, lostOuter: true });
        }
      } else if (t === 'pic' || t === 'graphicFrame' || t === 'contentPart') {
        dropped += 1;
      }
    }
    return got;
  };
  const shapes = walk(tree.children, 0);
  if (title === '') title = null;

  // ① 原点を決める
  let origin = { x: 0, y: 0 };
  if (shapes.length > 0) {
    // 🔴 回した付箋は、回した後の外接四角で測る(#530 段⑤e)── 書き出しが外接四角で枠を取るので、逆算も合わせる
    const turned = shapes.some((s) => s.rot !== 0);
    const bounds = shapes.map((s) => rotatedBounds(s.rect, s.rot));
    // ⚠ 座標は回す前の四角(`x=` `y=` と同じ約束)で書くので、相対位置の原点も**回す前の四角の最小**で取る。
    //   回した後の外接四角の最小で取ると、原点と座標の基準が食い違い、回した付箋の隣との間隔が縮む
    origin = { x: Math.min(...shapes.map((s) => s.rect.x)), y: Math.min(...shapes.map((s) => s.rect.y)) };
    // 書き出しの板のスライドは「題名(あれば)+ 板だけ」。他の図形(本文 / 図 / 表)が同居する枠は逆算しない
    const pure = !hasBodyText && dropped === 0;
    if (pure) {
      // 扉(題名が大きく中央にある)の直後に置かれた板は、枠が扉の本文側
      const sectionTitle = tree.children.some((el) => {
        if (el.tag === '#text' || local(el.tag) !== 'sp') return false;
        const s = readShape(el);
        return s !== null && s.isTitle && s.rect.y === FRAME.coverTitle.y;
      });
      const found = originFromExport(bounds, sectionTitle ? FRAME.coverBody : FRAME.body, turned);
      if (found !== null) origin = found;
    }
  }
  const px = (emu: number, o: number): number => Math.max(0, Math.round((emu - o) / EMU_PER_PX));

  // ② 名前は線で指された図形にだけ付ける(`connectPlaces` と同じ流儀)
  const byId = new Map<string, number>();
  shapes.forEach((s, i) => { if (s.id !== null && !byId.has(s.id)) byId.set(s.id, i); });
  const names = new Map<number, string>();
  const nameOf = (i: number): string => {
    let n = names.get(i);
    if (n === undefined) { n = `${NAME_STEM}${names.size + 1}`; names.set(i, n); }
    return n;
  };

  // ③ 線(先に読んで、名前を確定させる)
  const wires: string[] = [];
  for (const c of conns) {
    const cNv = kid(kid(c, 'nvCxnSpPr'), 'cNvCxnSpPr');
    const st = kid(cNv, 'stCxn');
    const en = kid(cNv, 'endCxn');
    const a = st?.attrs.id === undefined ? undefined : byId.get(st.attrs.id);
    const b = en?.attrs.id === undefined ? undefined : byId.get(en.attrs.id);
    if (a === undefined || b === undefined || a === b) { dropped += 1; continue; }
    const spPr = kid(c, 'spPr');
    const ea = edgeOf(shapes[a]!.shape, int(st?.attrs.idx));
    const eb = edgeOf(shapes[b]!.shape, int(en?.attrs.idx));
    /**
     * 🔴 **矢じり**(#530)── `a:tailEnd`(終わり)/ `a:headEnd`(始まり)の `type` が `none` 以外なら付いている。
     * ⚠ 種類(三角・矢・ひし形…)は区別しない ── 画面の矢じりは塗りつぶしの三角 1 種類。
     * 🔑 **始まりだけ**に付いた線は PKC3 に「始まりだけ」が無いので、**向きを入れ替えて** `to=` 側へ付ける
     *   (見た目は同じ ── 矢じりが指す板が変わらない)。⚠ 接続点も一緒に入れ替える。
     */
    const lnEl = kid(spPr, 'ln');
    const hasEnd = (tag: string): boolean => {
      const t = kid(lnEl, tag)?.attrs.type;
      return t !== undefined && t !== 'none';
    };
    const headArrow = hasEnd('headEnd');
    const tailArrow = hasEnd('tailEnd');
    const reverse = headArrow && !tailArrow;
    const arrow: 'end' | 'both' | null = headArrow || tailArrow ? (headArrow && tailArrow ? 'both' : 'end') : null;
    const [fromIdx, fromEdge, toIdx, toEdge] = reverse ? [b, eb, a, ea] : [a, ea, b, eb];
    const attrs = [
      `from=${nameOf(fromIdx)}${fromEdge === null ? '' : `:${fromEdge}`}`,
      `to=${nameOf(toIdx)}${toEdge === null ? '' : `:${toEdge}`}`,
    ];
    const route = routeOf(kid(spPr, 'prstGeom')?.attrs.prst ?? '');
    if (route !== null) attrs.push(`route=${route}`);
    const ln = lnEl;
    const stroke = solidOf(ln);
    if (stroke !== null && stroke !== LINE_DEFAULT_RGB) attrs.push(`stroke=${stroke}`);
    const wEmu = int(ln?.attrs.w);
    const width = wEmu === null ? null : parsePlaceWidth(String(Math.round(wEmu / EMU_PER_PX)));
    if (width !== null && width !== PLACE_LINE_WIDTH_DEFAULT) attrs.push(`width=${width}`);
    if (arrow !== null) attrs.push(`arrow=${arrow}`);
    wires.push(`:::format{.pkc-line ${attrs.join(' ')}}\n:::\n`);
  }

  // ⑤ グループの名前(#530 段⑤c)── 2 枚に満たない群は作らない(`groupPlaces` と同じ)。
  //   名前は PowerPoint 側の名前が `parsePlaceGroup` で読めて、板の中で重ならないときだけ使い、それ以外は `グループN`
  //   (使われていない最小の N)。⚠ 読める名前を先に全部確保してから番号を振る(番号が後の名前を奪わない)
  const members = new Map<number, number>();
  for (const s of shapes) if (s.group !== null) members.set(s.group, (members.get(s.group) ?? 0) + 1);
  const taken = new Set<string>();
  const groupOf = new Map<number, string>();
  groupNames.forEach((raw, gi) => {
    if ((members.get(gi) ?? 0) < 2) return;
    const n = parsePlaceGroup(raw);
    if (n !== null && !taken.has(n)) { taken.add(n); groupOf.set(gi, n); }
  });
  let seq = 0;
  groupNames.forEach((_raw, gi) => {
    if ((members.get(gi) ?? 0) < 2 || groupOf.has(gi)) return;
    let n: string;
    do { seq += 1; n = `${PLACE_GROUP_STEM}${seq}`; } while (taken.has(n));
    taken.add(n);
    groupOf.set(gi, n);
  });

  // ④ 付箋
  const blocks: string[] = [];
  shapes.forEach((s, i) => {
    const attrs: string[] = [];
    const nm = names.get(i);
    if (nm !== undefined) attrs.push(`#${nm}`);
    attrs.push('.pkc-place', `x=${px(s.rect.x, origin.x)}`, `y=${px(s.rect.y, origin.y)}`);
    attrs.push(`w=${Math.max(1, Math.round(s.rect.w / EMU_PER_PX))}`);
    attrs.push(`h=${Math.max(1, Math.round(s.rect.h / EMU_PER_PX))}`);
    if (s.shape !== 'rect') attrs.push(`shape=${s.shape}`);
    if (s.fill !== null) attrs.push(`fill=${s.fill}`);
    // ⚠ 書き出しは四角以外に灰色の縁を必ず引く ── それと同じなら書かない(往復で色が増えない)
    const defaultEdge = s.shape !== 'rect' && s.stroke === LINE_DEFAULT_RGB;
    if (s.stroke !== null && !defaultEdge) attrs.push(`stroke=${s.stroke}`);
    // 🔴 文字の大きさ(#530 段⑤a)── 標準は札を書かない(往復で札が増えない)
    if (s.size !== null && s.size.step !== 'standard') attrs.push(`size=${s.size.step}`);
    // 🔴 回転・グループ(#530 段⑤e・⑤c)── 回していない / 群に入っていないなら札を書かない(往復で札が増えない)
    if (s.rot !== 0) attrs.push(`rotate=${s.rot}`);
    const g = s.group === null ? undefined : groupOf.get(s.group);
    if (g !== undefined) attrs.push(`group=${g}`);
    blocks.push(`:::format{${attrs.join(' ')}}\n${s.text}${s.text === '' ? '' : '\n'}:::\n`);
  });

  const boardBody = [...blocks, ...wires].join('\n');
  const flowBody = flowParas.length > 0 ? `${joinFlowParas(flowParas)}\n` : '';
  return {
    title,
    // 🔴 位置を持たない本文は、板の塊の前に普通の段落として置く(#1163 依頼 124-1)
    body: flowBody !== '' && boardBody !== '' ? `${flowBody}\n${boardBody}` : flowBody + boardBody,
    flowed,
    placed: shapes.length,
    lines: wires.length,
    dropped: dropped + reshaped + subtitles,
    rounded: shapes.filter((s) => s.size?.rounded === true).length,
    simplified: shapes.filter((s) => s.flipped || s.lostOuter).length,
  };
}

/** zip の中のスライドの部品名を、スライド番号の順に並べる。 */
export function pptxSlideNames(names: readonly string[]): string[] {
  const out: { n: number; name: string }[] = [];
  for (const name of names) {
    const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
    if (m !== null) out.push({ n: Number(m[1]), name });
  }
  return out.sort((a, b) => a.n - b.n).map((x) => x.name);
}

/**
 * 🔴 **スライドの順番を `presentation.xml` の `sldIdLst` で決める**。`slideN.xml` の番号は作られた順で、
 * PowerPoint でスライドを並べ替えると**番号と見える順がずれる**。`_rels/presentation.xml.rels` で `r:id` を部品名へ引く。
 * - ⚠ どちらかが無い・読めない・1 枚も引けないときは**番号順に倒す**({@link pptxSlideNames})。
 * - `sldIdLst` に載っていないスライド(PowerPoint では見えない)は読まない。
 */
export function pptxSlideNamesInOrder(
  names: readonly string[],
  presentationXml: string | null,
  relsXml: string | null,
): string[] {
  const byNumber = pptxSlideNames(names);
  if (presentationXml === null || relsXml === null) return byNumber;
  try {
    const targetOf = new Map<string, string>();
    for (const { node } of walk(parseXml(relsXml))) {
      if (node.tag === '#text' || local(node.tag) !== 'Relationship') continue;
      const id = node.attrs.Id;
      const target = node.attrs.Target;
      if (id === undefined || target === undefined) continue;
      // 相対は `ppt/` 起点(`slides/slide1.xml` / `../ppt/slides/slide1.xml`)、`/` 始まりは zip の根から
      const parts = (target.startsWith('/') ? target.slice(1) : `ppt/${target}`).split('/');
      const out: string[] = [];
      for (const seg of parts) {
        if (seg === '..') out.pop();
        else if (seg !== '.' && seg !== '') out.push(seg);
      }
      targetOf.set(id, out.join('/'));
    }
    const known = new Set(byNumber);
    const ordered: string[] = [];
    for (const { node } of walk(parseXml(presentationXml))) {
      if (node.tag === '#text' || local(node.tag) !== 'sldId') continue;
      const key = Object.keys(node.attrs).find((k) => k.endsWith(':id'));
      const name = key === undefined ? undefined : targetOf.get(node.attrs[key] ?? '');
      if (name !== undefined && known.has(name) && !ordered.includes(name)) ordered.push(name);
    }
    return ordered.length > 0 ? ordered : byNumber;
  } catch {
    return byNumber;
  }
}
