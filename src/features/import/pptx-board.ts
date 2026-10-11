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
 *   数える対象は、図(`p:pic`)・表(`p:graphicFrame`)・グループ(`p:grpSp`)・位置を持たない図形・
 *   両端が解決できない線。
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
  PRST_OF,
} from '../export/pptx';
import { parseXml, textOf, type XmlNode } from '../export/xml-lite';
import { parsePlaceColor, parsePlaceWidth, PLACE_LINE_WIDTH_DEFAULT } from '../markdown/place-color';
import { PLACE_EDGES, PLACE_ROUTES, type PlaceEdge, type PlaceRoute } from '../markdown/place-line';
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
  /** 引いた線の数。 */
  readonly lines: number;
  /** 戻せなかったものの数。 */
  readonly dropped: number;
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
  /** 印を付けない素の字(題名に使う)。 */
  readonly plain: string;
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
  return /^(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|:::|\x60{3}|~~~|-{3,}\s*$|\+{3,}\s*$)/.test(s) ? `\\${s}` : s;
}

/** 改行の類(`\r \n` / NEL / 行区切り / 段落区切り / `\v \f`)を空白 1 つにする。 */
function foldBreaks(s: string): string {
  return s.replace(/[\r\n\u0085\u2028\u2029\v\f]+/g, ' ');
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
    plain,
  };
}

/** 逆算に使う枠(書き出しの `FRAME`)。 */
type Frame = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

/**
 * 枠の中央に置かれた長さ `U`(縮めていない)の右端 `E` から `U` を戻す。
 * 書き出しは `origin = f + floor((F - U) / 2)`、右端 `E = origin + U` なので
 * `E - f = floor((F + U) / 2)` ── `U` は `2(E - f) - F` か、その +1。
 * 🔑 板の大きさは px の整数 × 9525 なので、**9525 の倍数になる方**だけを採る(縮めた板は倍数にならない)。
 */
function lengthFromEdge(edge: number, f: number, F: number): number | null {
  const base = 2 * (edge - f) - F;
  for (const u of [base, base + 1]) {
    if (u > 0 && u <= F && u % EMU_PER_PX === 0) return u;
  }
  return null;
}

/** 書き出しの枠の取り方から原点を逆算する。成り立たなければ `null`(呼び側が相対位置へ倒す)。 */
function originFromExport(rects: readonly Rect[], frame: Frame): { x: number; y: number } | null {
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    right = Math.max(right, r.x + r.w);
    bottom = Math.max(bottom, r.y + r.h);
  }
  const U = lengthFromEdge(right, frame.x, frame.w);
  const H = lengthFromEdge(bottom, frame.y, frame.h);
  if (U === null || H === null) return null;
  // 左上の図形が板の外へ出ていたら、逆算が外れている
  const o = { x: right - U, y: bottom - H };
  for (const r of rects) if (r.x < o.x || r.y < o.y) return null;
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
  // 形を変えて(四角で)置いた数。⚠ 位置の逆算の可否(`pure`)には数えない
  let reshaped = 0;
  const shapes: ShapeRead[] = [];
  const conns: XmlNode[] = [];
  let title: string | null = null;
  let hasBodyText = false;
  for (const el of tree.children) {
    if (el.tag === '#text') continue;
    const t = local(el.tag);
    if (t === 'sp') {
      const s = readShape(el);
      if (s === null) { dropped += 1; continue; }
      if (s.isTitle) {
        if (title === null) title = s.plain;
        continue;
      }
      if (s.isSub) continue;
      if (s.reshaped) reshaped += 1;
      if (s.name === '本文') hasBodyText = true;
      shapes.push(s);
    } else if (t === 'cxnSp') {
      conns.push(el);
    } else if (t === 'pic' || t === 'graphicFrame' || t === 'grpSp' || t === 'contentPart') {
      dropped += 1;
    }
  }
  if (title === '') title = null;

  // ① 原点を決める
  const rects = shapes.map((s) => s.rect);
  let origin = { x: 0, y: 0 };
  if (rects.length > 0) {
    origin = { x: Math.min(...rects.map((r) => r.x)), y: Math.min(...rects.map((r) => r.y)) };
    // 書き出しの板のスライドは「題名(あれば)+ 板だけ」。他の図形(本文 / 図 / 表)が同居する枠は逆算しない
    const pure = !hasBodyText && dropped === 0;
    if (pure) {
      // 扉(題名が大きく中央にある)の直後に置かれた板は、枠が扉の本文側
      const sectionTitle = tree.children.some((el) => {
        if (el.tag === '#text' || local(el.tag) !== 'sp') return false;
        const s = readShape(el);
        return s !== null && s.isTitle && s.rect.y === FRAME.coverTitle.y;
      });
      const found = originFromExport(rects, sectionTitle ? FRAME.coverBody : FRAME.body);
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
    const attrs = [
      `from=${nameOf(a)}${ea === null ? '' : `:${ea}`}`,
      `to=${nameOf(b)}${eb === null ? '' : `:${eb}`}`,
    ];
    const route = routeOf(kid(spPr, 'prstGeom')?.attrs.prst ?? '');
    if (route !== null) attrs.push(`route=${route}`);
    const ln = kid(spPr, 'ln');
    const stroke = solidOf(ln);
    if (stroke !== null && stroke !== LINE_DEFAULT_RGB) attrs.push(`stroke=${stroke}`);
    const wEmu = int(ln?.attrs.w);
    const width = wEmu === null ? null : parsePlaceWidth(String(Math.round(wEmu / EMU_PER_PX)));
    if (width !== null && width !== PLACE_LINE_WIDTH_DEFAULT) attrs.push(`width=${width}`);
    wires.push(`:::format{.pkc-line ${attrs.join(' ')}}\n:::\n`);
  }

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
    blocks.push(`:::format{${attrs.join(' ')}}\n${s.text}${s.text === '' ? '' : '\n'}:::\n`);
  });

  return {
    title,
    body: [...blocks, ...wires].join('\n'),
    placed: shapes.length,
    lines: wires.length,
    dropped: dropped + reshaped,
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
