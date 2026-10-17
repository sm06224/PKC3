/** @vitest-environment node */
/**
 * 「注釈をページに書き込んで保存」の作り方(`public/pdf/edit-core.js` の `flatten`、#275 / #1163 依頼 31)。
 *
 * 🔴 守るもの:
 * 1. ハイライト・ペン・付箋が**注釈として出力に残らない**(他のビューアで消せない・注釈を表示しない設定でも見える)。
 *    元の PDF にあった物も、画面で付けた(まだ保存していない)物も。リンクなど**ほかの種類の注釈は残る**。
 * 2. 代わりに**ページの描画が増えている**(図形の Form・字)。付箋の字は「番号. 字」で下の端に、入りきらなければ**最後に足したページ**に。
 * 3. 外したページの注釈は描かない(字も出力に無い)。
 * 4. **日本語など標準の書体で描けない字は、canvas で描いた画像として貼る**。canvas が無い環境では `font` で断る ── `?` に潰して渡さない。
 * 5. どこからも辿れない物が出力に無い(`verify` が読み直して確かめる)。
 *
 * ⚠ 実物の pdf-lib で走らせる。⚠ 「無い」ことの検査は、**同じ読み取りで「ある」が見える対照群**(注釈のまま保存した出力)を同じ it に置く。
 */
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import * as PDFLib from 'pdf-lib';
import { describe, expect, it } from 'vitest';

interface Core {
  checkJob(job: unknown, pageCount: number): { flatten: boolean };
  build(lib: typeof PDFLib, bytes: Uint8Array, job: unknown, extras?: Uint8Array[], env?: { OffscreenCanvas?: unknown }): Promise<Uint8Array>;
  verify(lib: typeof PDFLib, bytes: Uint8Array, pageCount: number): Promise<void>;
}

function loadCore(): Core {
  const root: { PkcPdfEditCore?: Core } = {};
  new Function('self', readFileSync('public/pdf/edit-core.js', 'utf-8'))(root);
  expect(root.PkcPdfEditCore, '原文が API を公開していない(空振り)').toBeDefined();
  return root.PkcPdfEditCore as Core;
}
const core = loadCore();

/** 元の PDF に付けておく注釈の指定(1 ページ目に全部、2 ページ目に付箋 1 つ)。 */
async function withAnnots(): Promise<Uint8Array> {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const ctx = doc.context;
  const N = PDFLib.PDFName;
  for (let i = 0; i < 3; i += 1) {
    const page = doc.addPage([300, 400]);
    page.drawText(`page${String(i + 1)}`, { x: 20, y: 200, size: 18, font });
  }
  const [p1, p2] = doc.getPages() as [PDFLib.PDFPage, PDFLib.PDFPage, PDFLib.PDFPage];
  const hl = ctx.register(
    ctx.obj({
      Type: 'Annot', Subtype: 'Highlight', Rect: [20, 190, 100, 215], C: [1, 1, 0], F: 4,
      QuadPoints: [20, 215, 100, 215, 20, 190, 100, 190],
    }),
  );
  const popup = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [120, 200, 200, 260], Parent: hl }));
  ctx.lookup(hl, PDFLib.PDFDict).set(N.of('Popup'), popup);
  const ink = ctx.register(
    ctx.obj({ Type: 'Annot', Subtype: 'Ink', Rect: [10, 10, 60, 60], InkList: [[10, 10, 30, 40, 60, 60]], C: [1, 0, 0], BS: { W: 3 }, F: 4 }),
  );
  const note = ctx.register(
    ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [200, 300, 216, 316], Contents: PDFLib.PDFHexString.fromText('existing memo'), F: 4 }),
  );
  const reply = ctx.register(
    ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [200, 300, 216, 316], Contents: PDFLib.PDFHexString.fromText('reply'), IRT: note, F: 4 }),
  );
  const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [20, 100, 80, 120], Border: [0, 0, 0] }));
  p1.node.set(N.of('Annots'), ctx.obj([hl, popup, ink, note, reply, link]));
  const note2 = ctx.register(
    ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [100, 100, 116, 116], Contents: PDFLib.PDFHexString.fromText('secret on page two'), F: 4 }),
  );
  p2.node.set(N.of('Annots'), ctx.obj([note2]));
  return doc.save();
}

/** ページ(0 始まり)の注釈の種類の並び。 */
function subtypes(doc: PDFLib.PDFDocument, at: number): string[] {
  const node = (doc.getPages()[at] as PDFLib.PDFPage).node;
  const annots = node.lookup(PDFLib.PDFName.of('Annots'));
  if (!(annots instanceof PDFLib.PDFArray)) return [];
  const out: string[] = [];
  for (let i = 0; i < annots.size(); i += 1) {
    const d = annots.lookup(i, PDFLib.PDFDict);
    out.push(String(d.lookup(PDFLib.PDFName.of('Subtype'))).replace(/^\//, ''));
  }
  return out;
}

function decode(st: unknown): string {
  return Buffer.from(PDFLib.decodePDFRawStream(st as PDFLib.PDFRawStream).decode()).toString('latin1');
}

/** ページの内容と、ページが呼ぶ Form の中身を 1 本の字にする。 */
function drawn(doc: PDFLib.PDFDocument, at: number): string {
  const node = (doc.getPages()[at] as PDFLib.PDFPage).node;
  const c = node.lookup(PDFLib.PDFName.of('Contents'));
  let out = '';
  const streams: unknown[] = [];
  if (c instanceof PDFLib.PDFArray) for (let i = 0; i < c.size(); i += 1) streams.push(c.lookup(i));
  else streams.push(c);
  streams.forEach((s) => {
    out += decode(s) + '\n';
  });
  const xo = (node.Resources() as PDFLib.PDFDict).lookup(PDFLib.PDFName.of('XObject'));
  if (xo instanceof PDFLib.PDFDict) xo.entries().forEach(([k]) => (out += decode(xo.lookup(k)) + '\n'));
  return out;
}

/** 字の列を `(字)` と 16 進のどちらの綴りでも探す。 */
function hasText(s: string, text: string): boolean {
  const hex = Buffer.from(text, 'latin1').toString('hex').toUpperCase();
  return s.includes(`(${text})`) || s.toUpperCase().includes(`<${hex}>`);
}


/** 本物の PNG(単色)。pdf-lib の `embedPng` が読める形。 */
function png(w: number, h: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer): number => {
    let c = 0xffffffff;
    for (const x of b) c = (crcTable[(c ^ x) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 4, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return new Uint8Array(
    Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]),
  );
}

/** 使える canvas の stand-in。描いた字(fillText)と作った画像の大きさを控える。 */
function stubCanvas(): { env: { OffscreenCanvas: unknown }; drawn: string[]; sizes: [number, number][] } {
  const drawn: string[] = [];
  const sizes: [number, number][] = [];
  const ctx = {
    font: '10px sans-serif',
    fillStyle: '',
    textBaseline: '',
    measureText(t: string) {
      const px = Number(/^([0-9.]+)px/.exec(this.font)?.[1] ?? 10);
      return { width: Array.from(t).length * px * 0.6 };
    },
    fillText(t: string) {
      drawn.push(t);
    },
  };
  class Canvas {
    constructor(
      readonly w: number,
      readonly h: number,
    ) {
      sizes.push([w, h]);
    }
    getContext() {
      return ctx;
    }
    convertToBlob() {
      const bytes = png(this.w, this.h);
      return Promise.resolve({ arrayBuffer: () => Promise.resolve(bytes.buffer) });
    }
  }
  return { env: { OffscreenCanvas: Canvas }, drawn, sizes };
}

const FLAT = { order: [1, 2, 3], rotate: {}, flatten: true };

describe('注釈をページに書き込んで保存(flatten)', () => {
  it('元の PDF にあったハイライト・ペン・付箋とその吹き出し・返信は注釈として残らず、描画になる。リンクは残る(対照群: 注釈のまま保存)', async () => {
    const src = await withAnnots();
    const kept = await PDFLib.PDFDocument.load(await core.build(PDFLib, src, { order: [1, 2, 3], rotate: {} }));
    // 対照群: 描き込まずに保存した出力には、同じ注釈が全部ある(読み取りが注釈を見えていることの証拠)
    expect(subtypes(kept, 0)).toEqual(['Highlight', 'Popup', 'Ink', 'Text', 'Text', 'Link']);

    const bytes = await core.build(PDFLib, src, FLAT);
    const out = await PDFLib.PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(3);
    expect(subtypes(out, 0)).toEqual(['Link']);
    expect(subtypes(out, 1)).toEqual([]);
    // 描画が増えている: 元の内容(page1)に加えて、Form を呼ぶ命令と、ハイライト(乗算)・ペン(線)の図形
    const text = drawn(out, 0);
    expect(text).toContain('/PkcFlat');
    expect(text).toMatch(/\/GS0 gs 1 1 0 rg 20 215 m 100 215 l 100 190 l 20 190 l h f/);
    expect(text).toMatch(/1 J 1 j 3 w 1 0 0 RG 10 10 m 30 40 l 60 60 l S/);
    expect(drawn(kept, 0)).not.toContain('/PkcFlat');
    // 付箋の字は番号つきで下の端に(元の付箋 + 返信の 2 つ)
    expect(hasText(text, '1. existing memo')).toBe(true);
    expect(hasText(text, '2. reply')).toBe(true);
    // 読み直しの門(辿れない物が無い・ページ数ちょうど)
    await core.verify(PDFLib, bytes, 3);
  });

  it('画面で付けた(まだ保存していない)ハイライト・ペン・付箋も注釈にならず、描かれる', async () => {
    const doc = await PDFLib.PDFDocument.create();
    doc.addPage([300, 400]);
    const src = await doc.save();
    const bytes = await core.build(PDFLib, src, {
      order: [1],
      rotate: {},
      flatten: true,
      highlights: [{ page: 1, rgb: [0, 1, 0], quads: [[10, 50, 90, 50, 10, 30, 90, 30]] }],
      strokes: [{ page: 1, rgb: [0, 0, 1], width: 2, paths: [[5, 5, 50, 80]] }],
      notes: [{ page: 1, rect: [100, 100, 116, 116], text: 'new memo' }],
    });
    const out = await PDFLib.PDFDocument.load(bytes);
    expect(subtypes(out, 0)).toEqual([]);
    const text = drawn(out, 0);
    expect(text).toMatch(/0 1 0 rg 10 50 m 90 50 l 90 30 l 10 30 l h f/);
    expect(text).toMatch(/2 w 0 0 1 RG 5 5 m 50 80 l S/);
    expect(hasText(text, '1. new memo')).toBe(true);
    // 付箋の位置の目印(番号 1)
    expect(hasText(text, '1')).toBe(true);
    await core.verify(PDFLib, bytes, 1);
    // 対照群: flatten でない保存は、同じ入力を注釈にする
    const asAnnots = await PDFLib.PDFDocument.load(
      await core.build(PDFLib, src, {
        order: [1],
        rotate: {},
        highlights: [{ page: 1, rgb: [0, 1, 0], quads: [[10, 50, 90, 50, 10, 30, 90, 30]] }],
        notes: [{ page: 1, rect: [100, 100, 116, 116], text: 'new memo' }],
      }),
    );
    expect(subtypes(asAnnots, 0)).toEqual(['Highlight', 'Text']);
  });

  it('外したページの注釈は描かない(字も出力に無い)', async () => {
    const src = await withAnnots();
    const bytes = await core.build(PDFLib, src, { order: [1, 3], rotate: {}, flatten: true });
    const out = await PDFLib.PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(2);
    const all = [0, 1].map((i) => drawn(out, i)).join('\n');
    expect(all).not.toContain('secret');
    expect(Buffer.from(bytes).toString('latin1')).not.toContain('secret');
    // 対照群: 外さなければ 2 ページ目の付箋の字は出力にある
    const both = await PDFLib.PDFDocument.load(await core.build(PDFLib, src, FLAT));
    expect(hasText(drawn(both, 1), '3. secret on page two')).toBe(true);
    await core.verify(PDFLib, bytes, 2);
  });

  it('付箋の字が下の端に入りきらなければ、最後にページを足してそこに「番号. 字」を並べる', async () => {
    const doc = await PDFLib.PDFDocument.create();
    doc.addPage([300, 400]);
    doc.addPage([300, 400]);
    const src = await doc.save();
    const notes = [1, 2, 3, 4, 5].map((n) => ({ page: 1, rect: [10 * n, 100, 10 * n + 8, 108], text: `memo number ${String(n)}` }));
    notes.push({ page: 2, rect: [10, 10, 18, 18], text: 'short' });
    const bytes = await core.build(PDFLib, src, { order: [1, 2], rotate: {}, flatten: true, notes });
    const out = await PDFLib.PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(3);
    const last = drawn(out, 2);
    for (let n = 1; n <= 5; n += 1) expect(hasText(last, `${String(n)}. memo number ${String(n)}`), `${String(n)} 番`).toBe(true);
    // 1 ページ目の下の端には並べない(足したページにある)/ 2 ページ目は入るので下の端に、番号は通しの 6
    expect(hasText(drawn(out, 0), '1. memo number 1')).toBe(false);
    expect(hasText(drawn(out, 1), '6. short')).toBe(true);
    expect(hasText(last, '6. short')).toBe(false);
    await core.verify(PDFLib, bytes, 3);
  });

  it('canvas が無い環境では、日本語など標準の書体で描けない字は潰さずに font で断る。字の無い書き込み・英数字の付箋は断らない', async () => {
    const doc = await PDFLib.PDFDocument.create();
    doc.addPage([300, 400]);
    const src = await doc.save();
    const job = (text: string) => ({ order: [1], rotate: {}, flatten: true, notes: [{ page: 1, rect: [10, 10, 26, 26], text }] });
    await expect(core.build(PDFLib, src, job('会議のメモ'))).rejects.toMatchObject({ pkcCode: 'font' });
    // 英数字に 1 字だけ日本語が混じっても断る(一部だけ ? になって渡さない)
    await expect(core.build(PDFLib, src, job('memo 1 件'))).rejects.toMatchObject({ pkcCode: 'font' });
    const ok = await core.build(PDFLib, src, job('plain memo (ok) 12:30'));
    expect(hasText(drawn(await PDFLib.PDFDocument.load(ok), 0), '1. plain memo (ok) 12:30')).toBe(true);
    // 付箋の無いハイライトだけの書き込みは、字が無いので断らない
    const hlOnly = await core.build(PDFLib, src, {
      order: [1], rotate: {}, flatten: true, highlights: [{ page: 1, rgb: [1, 1, 0], quads: [[1, 9, 9, 9, 1, 1, 9, 1]] }],
    });
    expect(subtypes(await PDFLib.PDFDocument.load(hlOnly), 0)).toEqual([]);
    // 注釈のままの保存(flatten でない)は、日本語の付箋もそのまま通る(字が見える形に書くのは flatten だけ)
    await expect(core.build(PDFLib, src, { order: [1], rotate: {}, notes: job('会議のメモ').notes })).resolves.toBeInstanceOf(Uint8Array);
  });

  it('canvas が使えれば、日本語の付箋は端末のフォントで描いた画像として貼る(注釈は 0 件・画像が増える・verify が通る)', async () => {
    const doc = await PDFLib.PDFDocument.create();
    doc.addPage([300, 400]);
    const src = await doc.save();
    const cv = stubCanvas();
    const bytes = await core.build(
      PDFLib, src,
      { order: [1], rotate: {}, flatten: true, notes: [{ page: 1, rect: [10, 10, 26, 26], text: '会議のメモ' }] },
      [], cv.env,
    );
    const out = await PDFLib.PDFDocument.load(bytes);
    expect(subtypes(out, 0)).toEqual([]);
    // 字の帯は画像で貼られ(Do)、canvas には「番号. 字」がそのまま渡った(? に潰れていない)
    expect(cv.drawn).toEqual(['1. 会議のメモ']);
    const res = (out.getPages()[0] as PDFLib.PDFPage).node.Resources() as PDFLib.PDFDict;
    const xo = res.lookup(PDFLib.PDFName.of('XObject'), PDFLib.PDFDict);
    const kinds = xo.entries().map(([k]) => String(((xo.lookup(k) as PDFLib.PDFRawStream).dict as PDFLib.PDFDict).lookup(PDFLib.PDFName.of('Subtype'))));
    expect(kinds).toContain('/Image');
    // 画像の大きさは上限の内側で、文字が読める倍率(3 倍)で作っている
    cv.sizes.forEach(([w, h]) => {
      expect(w).toBeLessThanOrEqual(4096);
      expect(h).toBeLessThanOrEqual(4096);
    });
    expect(cv.sizes.some(([, h]) => h >= 7 * 3)).toBe(true);
    await core.verify(PDFLib, bytes, 1);
    // 番号の四角の数字は字で書く(画像にしない)
    expect(hasText(drawn(out, 0), '1')).toBe(true);
    // 英数字だけなら、canvas が使えても字で書く(画像を作らない)
    const cv2 = stubCanvas();
    await core.build(PDFLib, src, { order: [1], rotate: {}, flatten: true, notes: [{ page: 1, rect: [10, 10, 26, 26], text: 'plain' }] }, [], cv2.env);
    expect(cv2.sizes).toEqual([]);
    expect(cv2.drawn).toEqual([]);
  });

  it('日本語の付箋が下の端に入りきらなければ、足すページにも画像で並べる(見出しは「N ページ」)', async () => {
    const doc = await PDFLib.PDFDocument.create();
    doc.addPage([300, 400]);
    const src = await doc.save();
    const cv = stubCanvas();
    const notes = [1, 2, 3, 4, 5].map((n) => ({ page: 1, rect: [10 * n, 100, 10 * n + 8, 108], text: `メモ${String(n)}` }));
    const bytes = await core.build(PDFLib, src, { order: [1], rotate: {}, flatten: true, notes }, [], cv.env);
    const out = await PDFLib.PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(2);
    expect(cv.drawn).toContain('1 ページ');
    for (let n = 1; n <= 5; n += 1) expect(cv.drawn).toContain(`${String(n)}. メモ${String(n)}`);
    await core.verify(PDFLib, bytes, 2);
  });

  it('画像が上限を超えるとき・2d の文脈が無いときは、潰さず font で断る', async () => {
    const doc = await PDFLib.PDFDocument.create();
    doc.addPage([300, 400]);
    const src = await doc.save();
    const job = { order: [1], rotate: {}, flatten: true, notes: [{ page: 1, rect: [10, 10, 26, 26], text: '会議' }] };
    class NoCtx {
      getContext() {
        return null;
      }
    }
    await expect(core.build(PDFLib, src, job, [], { OffscreenCanvas: NoCtx })).rejects.toMatchObject({ pkcCode: 'font' });
    // 幅がどれだけでも 4096 画素に収まらない物差し(1 字が巨大)
    const cv = stubCanvas();
    const Wide = cv.env.OffscreenCanvas as new (w: number, h: number) => { getContext(): { measureText(t: string): { width: number } } };
    const wideCtx = new Wide(1, 1).getContext();
    wideCtx.measureText = () => ({ width: 1e6 });
    await expect(core.build(PDFLib, src, job, [], cv.env)).rejects.toMatchObject({ pkcCode: 'font' });
  });

  it('回したページでは、字を見たままの向きに書く(下の端はページを見たときの下)', async () => {
    const doc = await PDFLib.PDFDocument.create();
    doc.addPage([300, 400]);
    const src = await doc.save();
    const bytes = await core.build(PDFLib, src, {
      order: [1], rotate: { 1: 90 }, flatten: true, notes: [{ page: 1, rect: [100, 100, 116, 116], text: 'turned' }],
    });
    const out = await PDFLib.PDFDocument.load(bytes);
    const text = drawn(out, 0);
    expect(hasText(text, '1. turned')).toBe(true);
    // 右へ 90° 回した見た目の下の端 = ページの右の端(x = 300 のそば)に、縦に流れる字行列(0 1 -1 0)で
    const tm = [...text.matchAll(/(\S+) (\S+) (\S+) (\S+) (\S+) (\S+) Tm/g)].map((m) => m.slice(1, 7).map(Number));
    const rotated = tm.filter((m) => Math.abs(m[0] as number) < 1e-6 && Math.abs((m[1] as number) - 1) < 1e-6);
    expect(rotated.length).toBeGreaterThan(0);
    expect(rotated.some((m) => (m[4] as number) > 250)).toBe(true);
    await core.verify(PDFLib, bytes, 1);
  });

  it('依頼の flatten が真偽でなければ bad-job', () => {
    expect(core.checkJob({ order: [1], flatten: true }, 1).flatten).toBe(true);
    expect(core.checkJob({ order: [1] }, 1).flatten).toBe(false);
    expect(() => core.checkJob({ order: [1], flatten: 'yes' }, 1)).toThrow(/bad-job/);
  });
});
