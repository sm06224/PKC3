/**
 * 🔴 **ER の四角をどこに置くか**(#918 段⑤b)。**pure**。
 *
 * ## なぜ「決定的」でなければならないか
 *
 * 🔑 同じ構造なら**毎回同じ絵**になる ── 乱数も、時刻も、測った値も使わない。
 * ⚠ 使うと test が書けなくなり、**押し所の位置が回ごとに動く**ので
 *   「さっき押した所」が次に別の物になる。
 *
 * ## ⚠ 大きさを「測って」決めない
 *
 * 🔴 `offsetWidth` は **happy-dom では 0** なので、判断をあちらへ置くと
 *   **unit から永久に見えない**(`place-line.ts` が同じ理由で同じ作りをしている)。
 * 🔑 だから幅は**字の数**から出す ── 半角 1 / 全角 2 で数え、px へ写す。
 *   ⚠ 実際の書体と 1px 単位で一致はしない。**一致させる必要も無い**
 *   (四角は字より少し広ければよく、足りなければ中身が折り返すだけである)。
 *
 * ## 線は作り直さない
 *
 * 🔑 **`place-line.ts` の `placeLineOf` をそのまま使う**(#530 段③a)──
 *   いちばん近い辺どうしを結ぶ規則は、板でも ER でも同じである。
 */

import { placeLineOf, type PlaceLine, type PlaceRect } from '@features/markdown/place-line';
import { schemaKindLabel } from './schema-digest';
import type { SchemaColumn, SchemaLink, SchemaModel, SchemaTable } from './schema-digest';

/** 画面に出す列の数。⚠ これを超えた分は「ほか N 列」に畳む(表の見出しを押せば全部見える)。 */
export const ER_COLUMNS_SHOWN = 8;

/** 半角 1 文字ぶんの幅(px)。⚠ 実測値ではなく**見積もり**である(上の docstring)。 */
const CELL_W = 7;
const PAD_X = 12;
const PAD_Y = 8;
/** 表の名前が乗る行の高さ。 */
const HEAD_H = 26;
/** 列 1 行の高さ。 */
const ROW_H = 18;
/** 四角どうしの間。 */
const GAP = 28;
const MIN_W = 132;
const MAX_W = 280;

/**
 * 字の**幅**を半角いくつぶんで数える。
 * ⚠ 全角を 1 と数えると、日本語の表名で四角が**必ず溢れる**(#764 と同じ向きの穴)。
 */
export function cellsOf(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    // ⚠ 半角カナ(U+FF61〜U+FF9F)は**全角の見た目ではない** ── 1 と数える
    n += c < 0x0100 || (c >= 0xff61 && c <= 0xff9f) ? 1 : 2;
  }
  return n;
}

/** 四角 1 つ。 */
export interface ErBox {
  readonly table: SchemaTable;
  readonly rect: PlaceRect;
  /** 画面に出す列(先頭 `ER_COLUMNS_SHOWN` 件)。 */
  readonly columns: readonly SchemaColumn[];
  /** 畳んだ列の数(0 なら畳んでいない)。 */
  readonly hidden: number;
}

/** 引く線 1 本(どの繋がりか + どこからどこへ)。 */
export interface ErLine {
  readonly link: SchemaLink;
  readonly line: PlaceLine;
  /**
   * 🔴 **自分で引いた線か**(#918 段⑤d-1)。⚠ `false` = DB が宣言した外部キー
   *   (こちらが作った物ではないので、描く側はここで**消せる口を出さない**)。
   */
  readonly mine: boolean;
}

/** 引けなかった繋がりと、その理由。⚠ **黙って捨てない**(画面に理由を出す)。 */
export interface ErDropped {
  readonly link: SchemaLink;
  readonly why: string;
}

export interface ErDiagram {
  readonly width: number;
  readonly height: number;
  readonly boxes: readonly ErBox[];
  readonly lines: readonly ErLine[];
  readonly dropped: readonly ErDropped[];
}

/** その表の見出しに出す字(幅の見積もりにも、描画にも、同じ物を使う)。 */
export function erHeadLabel(t: SchemaTable): string {
  // 🔑 字は `schemaKindLabel` 1 か所(markdown と同じ字を出す ── CLAUDE.md §7)
  const kind = schemaKindLabel(t.kind);
  return t.rows === null ? `${t.name}(${kind})` : `${t.name}(${kind}・${t.rows} 行)`;
}

/** その列の行に出す字。 */
export function erColumnLabel(c: SchemaColumn): string {
  const mark = c.primaryKey ? ' 🔑' : '';
  return c.type === '' ? `${c.name}${mark}` : `${c.name} ${c.type}${mark}`;
}

/**
 * 🔴 **並べる順**(決定的)。
 *
 * ① 🔴 **DB の表が先、本文の csv は後**(#918 段⑤d-2)── 混ぜて並べると
 *    「どれがこの DB の構造か」が読めなくなる(本文の表は**引くたびに組む** temp である)
 * ② **指されている数が多い順**(外部キーの受け手 = 本体らしい表が左上へ来る)
 * ③ **行数が多い順**(⚠ 採れていない表は `null` なので**いちばん後ろ**)
 * ④ **名前順**
 *
 * ⚠ 名前の比較に `localeCompare` を使わない ── 並びが環境の言語設定で変わると、
 *   「同じ構造なら同じ絵」が崩れる。
 */
export function erOrder(model: SchemaModel): readonly SchemaTable[] {
  const inbound = new Map<string, number>();
  for (const l of model.links) inbound.set(l.to, (inbound.get(l.to) ?? 0) + 1);
  // 🔑 本文の csv だけを後ろへ ── 他の 3 段は 1 ミリも変えない
  const rank = (t: SchemaTable): number => (t.kind === 'csv' ? 1 : 0);
  return [...model.tables].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const ia = inbound.get(a.name) ?? 0;
    const ib = inbound.get(b.name) ?? 0;
    if (ia !== ib) return ib - ia;
    const ra = a.rows ?? -1;
    const rb = b.rows ?? -1;
    if (ra !== rb) return rb - ra;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/**
 * 構造から**絵の設計図**を作る。⚠ DOM は 1 つも触らない。
 *
 * 🔑 四角は**全部同じ幅**にする ── 幅が揃っていないと、格子に並べたときに
 *   線が斜めに走って読めない。⚠ 高さは列の数で変わる(揃える意味が無い)。
 *
 * @param mine 🔴 **自分で引いた繋がり**(#918 段⑤d-1)。⚠ 既定値は `[]` ──
 *   DB が宣言した外部キーしか無い呼び出し元(既存の test / 呼び出し)を
 *   1 つも直さずに済む形にしてある。
 */
export function erLayout(model: SchemaModel, mine: readonly SchemaLink[] = []): ErDiagram {
  const order = erOrder(model);
  if (order.length === 0) {
    return { width: 0, height: 0, boxes: [], lines: [], dropped: [] };
  }

  // ── ① いちばん長い字から、共通の幅を決める
  let widest = 0;
  for (const t of order) {
    widest = Math.max(widest, cellsOf(erHeadLabel(t)));
    for (const c of t.columns.slice(0, ER_COLUMNS_SHOWN)) {
      widest = Math.max(widest, cellsOf(erColumnLabel(c)));
    }
  }
  const w = Math.min(MAX_W, Math.max(MIN_W, PAD_X * 2 + widest * CELL_W));

  // ── ② 格子に並べる(1 行に ceil(sqrt(N)) 個)
  const perRow = Math.max(1, Math.ceil(Math.sqrt(order.length)));
  const boxes: ErBox[] = [];
  let y = 0;
  for (let i = 0; i < order.length; i += perRow) {
    const row = order.slice(i, i + perRow);
    let rowH = 0;
    row.forEach((t, j) => {
      const columns = t.columns.slice(0, ER_COLUMNS_SHOWN);
      const hidden = t.columns.length - columns.length;
      const h = PAD_Y * 2 + HEAD_H + (columns.length + (hidden > 0 ? 1 : 0)) * ROW_H;
      rowH = Math.max(rowH, h);
      boxes.push({ table: t, rect: { x: j * (w + GAP), y, w, h }, columns, hidden });
    });
    y += rowH + GAP;
  }

  // ── ③ 線を引く(引けない物は理由つきで残す)
  // 🔑 **宣言された外部キー + 自分で引いた繋がりを、同じ扱いで通す**(#918 段⑤d-1)。
  //   判定(相手が図に居るか / 自分自身を指していないか)は出どころで変えない。
  const byName = new Map(boxes.map((b) => [b.table.name, b] as const));
  const lines: ErLine[] = [];
  const dropped: ErDropped[] = [];
  const tagged: readonly { readonly link: SchemaLink; readonly mine: boolean }[] = [
    ...model.links.map((link) => ({ link, mine: false })),
    ...mine.map((link) => ({ link, mine: true })),
  ];
  for (const { link, mine: isMine } of tagged) {
    const from = byName.get(link.from);
    const to = byName.get(link.to);
    if (from === undefined || to === undefined) {
      // ⚠ 相手が図に居ない(名前の取り違え / ビューを指している)
      const missing = from === undefined ? link.from : link.to;
      dropped.push({ link, why: `「${missing}」という表が図にありません` });
      continue;
    }
    if (from === to) {
      // ⚠ 自分自身を指す外部キーは、線にすると**点になって見えない**
      dropped.push({ link, why: `「${link.from}」は自分自身を指しています` });
      continue;
    }
    lines.push({ link, line: placeLineOf(from.rect, to.rect), mine: isMine });
  }

  let width = 0;
  let height = 0;
  for (const b of boxes) {
    width = Math.max(width, b.rect.x + b.rect.w);
    height = Math.max(height, b.rect.y + b.rect.h);
  }
  return { width, height, boxes, lines, dropped };
}
