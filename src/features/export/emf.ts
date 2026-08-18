/**
 * EMF(Enhanced Metafile)を書く(#199 / #238)。
 *
 * 🔴 **なぜベクタで書くのか**(user 指示 2026-08-17):
 * 「**フローチャートのようないじれそうなものは emf とか wmf にして欲しい**」。
 * ⚠ ラスタを EMF で包んでも「いじれる」にはならない ── **図形の記録**として書く。
 *
 * ⚠ **バイナリなので、間違えても例外は出ない**(誰も読めない file が静かに出る)。
 * だから `tests/features/emf.test.ts` は**バイト列を解き直して**中身を数える。
 *
 * ## 座標系
 *
 * 論理単位 = SVG のユーザ単位 × `SCALE`(既定 10)。`MM_ANISOTROPIC` +
 * 窓/ビューポートの寸法で 1:1 に写す。⚠ **32bit の記録だけを使う**
 * (`*16` の記録は座標が ±32767 に制限され、10 倍した座標が溢れる)。
 */

/** MS-EMF の記録種別(使うものだけ)。 */
const R = {
  HEADER: 1,
  POLYGON: 3,
  POLYLINE: 4,
  POLYBEZIERTO: 5,
  SETWINDOWEXTEX: 9,
  SETWINDOWORGEX: 10,
  SETVIEWPORTEXTEX: 11,
  SETVIEWPORTORGEX: 12,
  EOF: 14,
  SETMAPMODE: 17,
  SETBKMODE: 18,
  SETPOLYFILLMODE: 19,
  SETTEXTALIGN: 22,
  SETTEXTCOLOR: 24,
  MOVETOEX: 27,
  SELECTOBJECT: 37,
  CREATEPEN: 38,
  CREATEBRUSHINDIRECT: 39,
  DELETEOBJECT: 40,
  ELLIPSE: 42,
  RECTANGLE: 43,
  ROUNDRECT: 44,
  LINETO: 54,
  BEGINPATH: 59,
  ENDPATH: 60,
  CLOSEFIGURE: 61,
  FILLPATH: 62,
  STROKEANDFILLPATH: 63,
  STROKEPATH: 64,
  EXTCREATEFONTINDIRECTW: 82,
  EXTTEXTOUTW: 84,
} as const;

/** 論理単位への倍率(0.1 ユーザ単位まで表せる)。 */
export const SCALE = 10;

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** 線の見た目。⚠ `color === null` は「描かない」(`PS_NULL`)。 */
export interface PenSpec {
  readonly color: number | null;
  /** 論理単位の太さ。 */
  readonly width: number;
  readonly dashed: boolean;
}

/** 塗り。⚠ `color === null` は「塗らない」(`BS_NULL`)。 */
export interface BrushSpec {
  readonly color: number | null;
}

export interface FontSpec {
  readonly height: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly face: string;
}

const PS_SOLID = 0;
const PS_DASH = 1;
const PS_NULL = 5;
const BS_SOLID = 0;
const BS_NULL = 1;
const TRANSPARENT = 1;
const MM_ANISOTROPIC = 8;
const ALTERNATE = 1;
/** TA_CENTER(6) / TA_LEFT(0) / TA_RIGHT(2) に TA_BASELINE(24) を足して使う。 */
export const TA = { LEFT: 0, RIGHT: 2, CENTER: 6, BASELINE: 24 } as const;

function rec(type: number, payload: Uint8Array): Uint8Array {
  const size = 8 + payload.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, type, true);
  dv.setUint32(4, size, true);
  out.set(payload, 8);
  return out;
}

function u32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => dv.setUint32(i * 4, v >>> 0, true));
  return out;
}

function i32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => dv.setInt32(i * 4, Math.round(v), true));
  return out;
}

/** GDI の色は **0x00bbggrr**(RGB が逆)。⚠ ここを間違えると赤と青が入れ替わる。 */
function bgr(rgb: number): number {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  return ((b << 16) | (g << 8) | r) >>> 0;
}

function points(pts: readonly Point[]): Uint8Array {
  const out = new Uint8Array(pts.length * 8);
  const dv = new DataView(out.buffer);
  pts.forEach((p, i) => {
    dv.setInt32(i * 8, Math.round(p.x), true);
    dv.setInt32(i * 8 + 4, Math.round(p.y), true);
  });
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * EMF を組み立てる。
 * ⚠ **記録を足す順がそのまま描く順**である(後のものが上に乗る)。
 */
export class EmfWriter {
  private readonly records: Uint8Array[] = [];
  private handles = 0;
  private readonly bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

  constructor(
    private readonly widthPx: number,
    private readonly heightPx: number,
  ) {
    const lw = Math.max(1, Math.round(widthPx * SCALE));
    const lh = Math.max(1, Math.round(heightPx * SCALE));
    this.records.push(rec(R.SETMAPMODE, u32(MM_ANISOTROPIC)));
    this.records.push(rec(R.SETWINDOWORGEX, i32(0, 0)));
    this.records.push(rec(R.SETWINDOWEXTEX, i32(lw, lh)));
    this.records.push(rec(R.SETVIEWPORTORGEX, i32(0, 0)));
    this.records.push(rec(R.SETVIEWPORTEXTEX, i32(Math.max(1, Math.round(widthPx)), Math.max(1, Math.round(heightPx)))));
    this.records.push(rec(R.SETBKMODE, u32(TRANSPARENT)));
    this.records.push(rec(R.SETPOLYFILLMODE, u32(ALTERNATE)));
  }

  /** 描いた範囲を覚える(header の `rclBounds` に要る)。 */
  private grow(pts: readonly Point[]): void {
    for (const p of pts) {
      this.bounds.minX = Math.min(this.bounds.minX, p.x);
      this.bounds.minY = Math.min(this.bounds.minY, p.y);
      this.bounds.maxX = Math.max(this.bounds.maxX, p.x);
      this.bounds.maxY = Math.max(this.bounds.maxY, p.y);
    }
  }

  private nextHandle(): number {
    this.handles += 1;
    return this.handles;
  }

  /** 線を作って選ぶ。返した handle は使い終わったら `deleteObject` する。 */
  selectPen(pen: PenSpec): number {
    const h = this.nextHandle();
    const style = pen.color === null ? PS_NULL : pen.dashed ? PS_DASH : PS_SOLID;
    // LOGPEN: style(4) width(POINTL 8) color(4)
    this.records.push(
      rec(R.CREATEPEN, concat([u32(h), u32(style), i32(Math.max(0, Math.round(pen.width)), 0), u32(bgr(pen.color ?? 0))])),
    );
    this.records.push(rec(R.SELECTOBJECT, u32(h)));
    return h;
  }

  /** 塗りを作って選ぶ。 */
  selectBrush(brush: BrushSpec): number {
    const h = this.nextHandle();
    // LOGBRUSH32: style(4) color(4) hatch(4)
    this.records.push(
      rec(R.CREATEBRUSHINDIRECT, concat([u32(h), u32(brush.color === null ? BS_NULL : BS_SOLID), u32(bgr(brush.color ?? 0)), u32(0)])),
    );
    this.records.push(rec(R.SELECTOBJECT, u32(h)));
    return h;
  }

  /** 字体を作って選ぶ。⚠ `LOGFONTW` は 92 バイト固定。 */
  selectFont(font: FontSpec): number {
    const h = this.nextHandle();
    const lf = new Uint8Array(92);
    const dv = new DataView(lf.buffer);
    // ⚠ 高さは**負**で「文字の高さ」を意味する(正だとセル高になり、字が小さく出る)
    dv.setInt32(0, -Math.abs(Math.round(font.height)), true); // lfHeight
    dv.setInt32(4, 0, true); // lfWidth
    dv.setInt32(8, 0, true); // lfEscapement
    dv.setInt32(12, 0, true); // lfOrientation
    dv.setInt32(16, font.bold ? 700 : 400, true); // lfWeight
    lf[20] = font.italic ? 1 : 0;
    lf[21] = 0; // underline
    lf[22] = 0; // strikeout
    lf[23] = 1; // DEFAULT_CHARSET
    lf[24] = 0; // OUT_DEFAULT_PRECIS
    lf[25] = 0; // CLIP_DEFAULT_PRECIS
    lf[26] = 0; // DEFAULT_QUALITY
    lf[27] = 0; // DEFAULT_PITCH | FF_DONTCARE
    const face = font.face.slice(0, 31);
    for (let i = 0; i < face.length; i += 1) dv.setUint16(28 + i * 2, face.charCodeAt(i), true);
    this.records.push(rec(R.EXTCREATEFONTINDIRECTW, concat([u32(h), lf])));
    this.records.push(rec(R.SELECTOBJECT, u32(h)));
    return h;
  }

  deleteObject(handle: number): void {
    this.records.push(rec(R.DELETEOBJECT, u32(handle)));
  }

  rectangle(x: number, y: number, w: number, h: number): void {
    this.grow([
      { x, y },
      { x: x + w, y: y + h },
    ]);
    this.records.push(rec(R.RECTANGLE, i32(x, y, x + w, y + h)));
  }

  roundRect(x: number, y: number, w: number, h: number, rx: number, ry: number): void {
    this.grow([
      { x, y },
      { x: x + w, y: y + h },
    ]);
    this.records.push(rec(R.ROUNDRECT, concat([i32(x, y, x + w, y + h), i32(rx * 2, ry * 2)])));
  }

  ellipse(cx: number, cy: number, rx: number, ry: number): void {
    this.grow([
      { x: cx - rx, y: cy - ry },
      { x: cx + rx, y: cy + ry },
    ]);
    this.records.push(rec(R.ELLIPSE, i32(cx - rx, cy - ry, cx + rx, cy + ry)));
  }

  polygon(pts: readonly Point[]): void {
    if (pts.length < 2) return;
    this.grow(pts);
    this.records.push(rec(R.POLYGON, concat([i32(...boundsOf(pts)), u32(pts.length), points(pts)])));
  }

  polyline(pts: readonly Point[]): void {
    if (pts.length < 2) return;
    this.grow(pts);
    this.records.push(rec(R.POLYLINE, concat([i32(...boundsOf(pts)), u32(pts.length), points(pts)])));
  }

  /**
   * 道(path)を 1 本描く。`fill` と `stroke` の両方を持てる。
   * ⚠ **`BEGINPATH` の前に線と塗りを選んでおく**(GDI は path を閉じるときの
   * 選択物で描く)。
   */
  pathBegin(): void {
    this.records.push(rec(R.BEGINPATH, new Uint8Array(0)));
  }

  moveTo(p: Point): void {
    this.grow([p]);
    this.records.push(rec(R.MOVETOEX, i32(p.x, p.y)));
  }

  lineTo(p: Point): void {
    this.grow([p]);
    this.records.push(rec(R.LINETO, i32(p.x, p.y)));
  }

  /** 3 次ベジェ(制御点 2 + 終点)。⚠ 個数は 3 の倍数でなければならない。 */
  bezierTo(pts: readonly Point[]): void {
    if (pts.length === 0 || pts.length % 3 !== 0) return;
    this.grow(pts);
    this.records.push(rec(R.POLYBEZIERTO, concat([i32(...boundsOf(pts)), u32(pts.length), points(pts)])));
  }

  closeFigure(): void {
    this.records.push(rec(R.CLOSEFIGURE, new Uint8Array(0)));
  }

  /** 道を閉じて描く。`mode` は塗り / 線 / 両方。 */
  pathEnd(mode: 'fill' | 'stroke' | 'both'): void {
    this.records.push(rec(R.ENDPATH, new Uint8Array(0)));
    const type = mode === 'fill' ? R.FILLPATH : mode === 'stroke' ? R.STROKEPATH : R.STROKEANDFILLPATH;
    this.records.push(rec(type, i32(...this.boundsRect())));
  }

  setTextColor(rgb: number): void {
    this.records.push(rec(R.SETTEXTCOLOR, u32(bgr(rgb))));
  }

  setTextAlign(mode: number): void {
    this.records.push(rec(R.SETTEXTALIGN, u32(mode)));
  }

  /**
   * 文字を置く。⚠ **UTF-16LE** で書く(`EXTTEXTOUTW`)。
   * ⚠ 文字送り(Dx)は渡さない ── 渡すと等幅に潰れる。
   */
  textOut(p: Point, text: string): void {
    if (text === '') return;
    this.grow([p]);
    const chars = [...text];
    const utf16: number[] = [];
    for (const ch of text) {
      const code = ch.codePointAt(0)!;
      if (code > 0xffff) {
        const v = code - 0x10000;
        utf16.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      } else utf16.push(code);
    }
    void chars;
    const strBytes = new Uint8Array(utf16.length * 2);
    const sdv = new DataView(strBytes.buffer);
    utf16.forEach((c, i) => sdv.setUint16(i * 2, c, true));
    // 4 バイト境界へ揃える(仕様の要求)
    const pad = (4 - (strBytes.length % 4)) % 4;
    const head = concat([
      i32(...this.boundsRect()), // rclBounds
      u32(1), // iGraphicsMode = GM_COMPATIBLE
      new Uint8Array(new Float32Array([1, 1]).buffer), // exScale, eyScale
      i32(p.x, p.y), // ptlReference
      u32(utf16.length), // nChars
      u32(0), // offString(あとで埋める)
      u32(0), // fOptions
      i32(0, 0, 0, 0), // rcl
      u32(0), // offDx
    ]);
    const offString = 8 + head.length; // 記録の先頭からの位置
    const dvHead = new DataView(head.buffer, head.byteOffset, head.byteLength);
    dvHead.setUint32(16 + 4 + 8 + 8 + 4, offString, true);
    this.records.push(rec(R.EXTTEXTOUTW, concat([head, strBytes, new Uint8Array(pad)])));
  }

  private boundsRect(): [number, number, number, number] {
    if (!Number.isFinite(this.bounds.minX)) return [0, 0, 0, 0];
    return [
      Math.round(this.bounds.minX),
      Math.round(this.bounds.minY),
      Math.round(this.bounds.maxX),
      Math.round(this.bounds.maxY),
    ];
  }

  /** 完成した EMF のバイト列。 */
  finish(): Uint8Array {
    const body = concat([...this.records, rec(R.EOF, u32(0, 16, 20))]);
    const nRecords = this.records.length + 2; // + HEADER + EOF
    const header = new Uint8Array(88);
    const dv = new DataView(header.buffer);
    const devW = Math.max(1, Math.round(this.widthPx));
    const devH = Math.max(1, Math.round(this.heightPx));
    dv.setUint32(0, R.HEADER, true);
    dv.setUint32(4, 88, true);
    // rclBounds(装置単位)
    dv.setInt32(8, 0, true);
    dv.setInt32(12, 0, true);
    dv.setInt32(16, devW, true);
    dv.setInt32(20, devH, true);
    // rclFrame(0.01mm)。⚠ ここが**紙の上の大きさ**を決める(96dpi 前提)
    dv.setInt32(24, 0, true);
    dv.setInt32(28, 0, true);
    dv.setInt32(32, Math.round((devW * 2540) / 96), true);
    dv.setInt32(36, Math.round((devH * 2540) / 96), true);
    dv.setUint32(40, 0x464d4520, true); // ' EMF'
    dv.setUint32(44, 0x00010000, true);
    dv.setUint32(48, 88 + body.length, true); // nBytes
    dv.setUint32(52, nRecords, true);
    dv.setUint16(56, this.handles + 1, true); // nHandles
    dv.setUint16(58, 0, true);
    dv.setUint32(60, 0, true); // nDescription
    dv.setUint32(64, 0, true); // offDescription
    dv.setUint32(68, 0, true); // nPalEntries
    dv.setInt32(72, 1920, true); // szlDevice.cx
    dv.setInt32(76, 1080, true);
    dv.setInt32(80, 508, true); // szlMillimeters.cx
    dv.setInt32(84, 286, true);
    return concat([header, body]);
  }
}

function boundsOf(pts: readonly Point[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return [Math.round(minX), Math.round(minY), Math.round(maxX), Math.round(maxY)];
}
