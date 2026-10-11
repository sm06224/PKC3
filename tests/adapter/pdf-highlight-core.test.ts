/** @vitest-environment node */
/**
 * ハイライトを付ける・外す(`public/pdf/edit-core.js` の `build`、`edit-worker.js`)(#275 段②-2b/c)。
 *
 * 🔴 守るもの:
 * 1. 付けたハイライトが、**出力の正しいページ**に、**色・座標・外観つき**で入る(pdf.js が読み直せる = 本物の読み手)。
 *    外したページに付けた分は出力に出ない / 並べ替えに付いてくる。
 * 2. **ページの向き(元から /Rotate 0・90・180・270)でも、選んだ位置のまま**付く(窓の座標計算 → 作る → 読み直す を通す)。
 * 3. 外す: **他のアプリが付けたハイライト(`/P`・`/Popup`・返信つき)も外せ、コメント・図形などは残る**。外したハイライトの本文は
 *    出力の全 stream に 0 件(対照: 元には在る)。外せない依頼は黙って通さず `bad-highlight` で断る。
 * ⚠ 窓の座標計算(`highlight.js`)は原文のまま走らせ、pdf.js の本物の viewport を通す(期待値は PDF の座標から別に作る)。
 * ⚠ 「無い」ことの検査は、**同じ読み取りで「ある」が見える対照群**を同じ it に置く。
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import vm from 'node:vm';
import * as PDFLib from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';

interface Core {
  checkJob(job: unknown, pageCount: number): { order: number[]; highlights: { page: number }[]; removals: unknown[] };
  build(lib: typeof PDFLib, bytes: Uint8Array, job: unknown): Promise<Uint8Array>;
}
interface Hl {
  COLORS: { id: string; label: string; rgb: number[] }[];
  quadsOnPage(
    rects: { left: number; top: number; right: number; bottom: number }[],
    box: { left: number; top: number; width: number; height: number },
    vp: { width: number; height: number },
    toPdf: (x: number, y: number) => number[],
  ): { quads: number[][]; rect: number[] } | null;
  toJob(
    marks: { page: number; color: string; quads: number[][] }[],
    removals: Map<string, { page: number; id: string }>,
    order: number[],
  ): { highlights: unknown[]; removals: unknown[] };
}

function loadCore(): Core {
  const root: { PkcPdfEditCore?: Core } = {};
  new Function('self', readFileSync('public/pdf/edit-core.js', 'utf-8'))(root);
  expect(root.PkcPdfEditCore, '原文が API を公開していない(空振り)').toBeDefined();
  return root.PkcPdfEditCore as Core;
}
function loadHl(): Hl {
  const root: { PkcPdfHighlight?: Hl } = {};
  new Function('self', readFileSync('public/pdf/highlight.js', 'utf-8'))(root);
  expect(root.PkcPdfHighlight, '原文が API を公開していない(空振り)').toBeDefined();
  return root.PkcPdfHighlight as Hl;
}
const core = loadCore();
const hlLib = loadHl();

const A = 'MARK-ALPHA-111';
const B = 'MARK-BRAVO-222';
const C = 'MARK-CHARLIE-333';

/** 各ページに**別の字**を持つ PDF。 */
async function sample(marks: string[]): Promise<Uint8Array> {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  marks.forEach((m, i) => {
    const page = doc.addPage([300 + i * 10, 400]);
    page.drawText(m, { x: 20, y: 200, size: 18, font });
  });
  return doc.save();
}

/** file の全 stream を展開して、1 本の字にする(圧縮してあっても、残っていれば見える)。 */
function allStreamText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes);
  const text = raw.toString('latin1');
  let out = text;
  let from = 0;
  for (;;) {
    const s = text.indexOf('stream', from);
    if (s === -1) break;
    const e = text.indexOf('endstream', s + 6);
    if (e === -1) break;
    let a = s + 6;
    if (text[a] === '\r') a += 1;
    if (text[a] === '\n') a += 1;
    try {
      out += '\n' + inflateSync(raw.subarray(a, e)).toString('latin1');
    } catch {
      // 展開できない stream は飛ばす
    }
    from = e + 9;
  }
  return out;
}
/** 標準書体の文字列は `(字)` でも `<16 進>` でも書かれる ── どちらの綴りでも探す。 */
function hasMark(bytes: Uint8Array, mark: string): boolean {
  const text = allStreamText(bytes);
  const hex = Buffer.from(mark, 'latin1').toString('hex').toUpperCase();
  return text.includes(mark) || text.toUpperCase().includes(hex);
}

/** 出力の `i` ページ目の content の字。 */
async function pageText(bytes: Uint8Array, i: number): Promise<string> {
  const doc = await PDFLib.PDFDocument.load(bytes);
  const contents = doc.getPage(i).node.Contents();
  const streams = contents instanceof PDFLib.PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
  let out = '';
  for (const s of streams) {
    if (s instanceof PDFLib.PDFRawStream) out += Buffer.from(PDFLib.decodePDFRawStream(s).decode()).toString('latin1');
  }
  return out;
}
const showsMark = (t: string, m: string): boolean =>
  t.includes(m) || t.toUpperCase().includes(Buffer.from(m, 'latin1').toString('hex').toUpperCase());

/** pdf.js(本物の読み手)で開く。⚠ `destroy()` は文書ではなく読み込みの課題(`task`)に在る。 */
function openJs(bytes: Uint8Array) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, verbosity: 0 });
  return { task, doc: task.promise };
}

/** pdf.js(本物の読み手)で `pageNo` ページ目の注釈を読む。 */
async function jsAnnots(bytes: Uint8Array, pageNo: number): Promise<Record<string, unknown>[]> {
  const { task, doc } = openJs(bytes);
  try {
    const page = await (await doc).getPage(pageNo);
    return (await page.getAnnotations()) as Record<string, unknown>[];
  } finally {
    await task.destroy();
  }
}
const highlightsOf = async (bytes: Uint8Array, pageNo: number): Promise<Record<string, unknown>[]> =>
  (await jsAnnots(bytes, pageNo)).filter((a) => a['annotationType'] === 9);

/** pdf-lib で読んだ `i` ページ目の注釈の辞書の並び。 */
async function annotDicts(bytes: Uint8Array, i: number): Promise<PDFLib.PDFDict[]> {
  const doc = await PDFLib.PDFDocument.load(bytes);
  const annots = doc.getPage(i).node.Annots();
  const out: PDFLib.PDFDict[] = [];
  for (let j = 0; j < (annots?.size() ?? 0); j += 1) out.push(annots?.lookup(j, PDFLib.PDFDict) as PDFLib.PDFDict);
  return out;
}
const subtypeOf = (d: PDFLib.PDFDict): string => String(d.get(PDFLib.PDFName.of('Subtype'))).replace('/', '');
const numsOf = (d: PDFLib.PDFDict, key: string): number[] =>
  (d.lookup(PDFLib.PDFName.of(key), PDFLib.PDFArray) as PDFLib.PDFArray).asArray().map((n) => (n as PDFLib.PDFNumber).asNumber());

const Q1 = [20, 220, 120, 220, 20, 195, 120, 195];
const Q2 = [20, 190, 90, 190, 20, 170, 90, 170];
const YELLOW = [1, 0.92, 0.2];
const near = (a: number[], b: number[], eps = 0.01): boolean =>
  a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] as number)) <= eps);

describe('🔴 ハイライトを付ける ── 出力の正しいページに、色・座標・外観つきで入る', () => {
  it('2 ページ目に 2 行ぶん付ける: 2 ページ目だけに /Highlight が 1 つ。色・QuadPoints・/F 4・外観(乗算)があり、/P は付けない', async () => {
    const src = await sample([A, B, C]);
    // 対照群: 元には注釈が 1 つも無い(読み取りが「在る」を見られることは、下の外すの it で別に示す)
    for (const n of [1, 2, 3]) expect(await jsAnnots(src, n)).toEqual([]);
    const out = await core.build(PDFLib, src, {
      order: [1, 2, 3],
      rotate: {},
      highlights: [{ page: 2, rgb: YELLOW, quads: [Q1, Q2] }],
    });
    expect((await annotDicts(out, 0)).length).toBe(0);
    expect((await annotDicts(out, 2)).length).toBe(0);
    const dicts = await annotDicts(out, 1);
    expect(dicts.length).toBe(1);
    const d = dicts[0] as PDFLib.PDFDict;
    expect(subtypeOf(d)).toBe('Highlight');
    expect(numsOf(d, 'QuadPoints')).toEqual([...Q1, ...Q2]);
    expect(near(numsOf(d, 'C'), YELLOW)).toBe(true);
    expect(near(numsOf(d, 'Rect'), [20, 170, 120, 220])).toBe(true);
    expect((d.get(PDFLib.PDFName.of('F')) as PDFLib.PDFNumber).asNumber(), '印刷する(/F 4)').toBe(4);
    expect(d.has(PDFLib.PDFName.of('P')), '/P は付けない(設計 doc §2.4)').toBe(false);
    // 外観: Form XObject が乗算で重なり、行ごとに塗る(2 行)
    const ap = d.lookup(PDFLib.PDFName.of('AP'), PDFLib.PDFDict).lookup(PDFLib.PDFName.of('N')) as PDFLib.PDFRawStream;
    const apText = Buffer.from(PDFLib.decodePDFRawStream(ap).decode()).toString('latin1');
    expect(apText.match(/ f/g)?.length, '外観が行ごとに塗っていない').toBe(2);
    expect(apText).toContain('1 0.92 0.2 rg');
    // 塗る輪郭は 左上 → 右上 → 右下 → 左下(QuadPoints の並びのまま塗ると、蝶ネクタイ形になって半分しか塗れない)
    expect(apText).toContain('20 220 m 120 220 l 120 195 l 20 195 l h f');
    expect(apText).toContain('20 190 m 90 190 l 90 170 l 20 170 l h f');
    expect(String(ap.dict.get(PDFLib.PDFName.of('Subtype')))).toBe('/Form');
    const gs = ap.dict
      .lookup(PDFLib.PDFName.of('Resources'), PDFLib.PDFDict)
      .lookup(PDFLib.PDFName.of('ExtGState'), PDFLib.PDFDict)
      .lookup(PDFLib.PDFName.of('GS0'), PDFLib.PDFDict);
    expect(String(gs.get(PDFLib.PDFName.of('BM'))), '字を隠さない(乗算)').toBe('/Multiply');
    // 本物の読み手(pdf.js)が読める: 種類・色・外観
    const js = await highlightsOf(out, 2);
    expect(js.length).toBe(1);
    expect(js[0]?.['hasAppearance']).toBe(true);
    expect(near(Array.from(js[0]?.['color'] as Uint8ClampedArray), [255, 235, 51], 1)).toBe(true);
    expect(Array.from(js[0]?.['quadPoints'] as Float32Array).length, '2 行ぶんの QuadPoints').toBe(16);
    expect((await highlightsOf(out, 1)).length).toBe(0);
  });

  it('色: 4 色それぞれの /C が窓の色の表どおりで、4 つとも違う(窓の表 → 作る → pdf.js で読む)', async () => {
    expect(hlLib.COLORS.map((c) => c.id)).toEqual(['yellow', 'green', 'blue', 'pink']);
    const src = await sample([A]);
    const seen: string[] = [];
    for (const c of hlLib.COLORS) {
      const job = hlLib.toJob([{ page: 1, color: c.id, quads: [Q1] }], new Map(), [1]);
      const out = await core.build(PDFLib, src, { order: [1], rotate: {}, ...job });
      const js = await highlightsOf(out, 1);
      expect(js.length, c.id).toBe(1);
      const got = Array.from(js[0]?.['color'] as Uint8ClampedArray);
      expect(
        near(
          got,
          c.rgb.map((v) => v * 255),
          1,
        ),
        `${c.id}: ${got.join(',')}`,
      ).toBe(true);
      seen.push(got.join(','));
    }
    expect(new Set(seen).size, '4 色が見分けられない').toBe(4);
  });

  it('ページの編集と同じ 1 回: 並べ替えに付いてくる / 外したページに付けた分は出力に無い / 回しても座標は変わらない', async () => {
    const src = await sample([A, B, C]);
    const out = await core.build(PDFLib, src, {
      order: [3, 1],
      rotate: { 3: 90 },
      highlights: [
        { page: 3, rgb: YELLOW, quads: [Q1] },
        { page: 2, rgb: [0, 0, 1], quads: [Q2] }, // 外したページ(2)に付けた分
      ],
    });
    expect((await PDFLib.PDFDocument.load(out)).getPageCount()).toBe(2);
    expect(showsMark(await pageText(out, 0), C), '出力の 1 ページ目は元の 3 ページ目').toBe(true);
    const first = await annotDicts(out, 0);
    expect(first.length).toBe(1);
    expect(numsOf(first[0] as PDFLib.PDFDict, 'QuadPoints'), '回しても注釈は用紙の座標のまま').toEqual(Q1);
    expect((await annotDicts(out, 1)).length, '付けていないページ').toBe(0);
    // 外したページに付けた青は、出力のどこにも無い
    expect(allStreamText(out)).not.toContain('0 0 1 rg');
  });

  it('作った PDF は、そのまま次のページ編集に使える(/P を付けないので門に断られず、ハイライトは自分のページに付いてくる)', async () => {
    const src = await sample([A, B, C]);
    const once = await core.build(PDFLib, src, { order: [1, 2, 3], rotate: {}, highlights: [{ page: 2, rgb: YELLOW, quads: [Q1] }] });
    const twice = await core.build(PDFLib, once, { order: [2, 3], rotate: {} });
    expect(showsMark(await pageText(twice, 0), B)).toBe(true);
    expect((await highlightsOf(twice, 1)).length, '2 ページ目だったハイライトが 1 ページ目に付いてくる').toBe(1);
    const dropped = await core.build(PDFLib, once, { order: [1, 3], rotate: {} });
    expect((await highlightsOf(dropped, 1)).length + (await highlightsOf(dropped, 2)).length).toBe(0);
  });
});

describe('🔴 ページの向きが 4 通りでも、選んだ位置のまま付く(窓の座標計算 → 作る → pdf.js で読み直す)', () => {
  for (const rot of [0, 90, 180, 270]) {
    it(`元から /Rotate ${String(rot)}: 選んだ長方形(画面の座標)と、できた PDF を同じ倍率で開いたときの注釈の位置が一致する`, async () => {
      const d = await PDFLib.PDFDocument.create();
      const pg = d.addPage([400, 800]);
      pg.setRotation(PDFLib.degrees(rot));
      const bytes = await d.save();
      const o1 = openJs(bytes);
      const vp = (await (await o1.doc).getPage(1)).getViewport({ scale: 1.5 });
      await o1.task.destroy();
      expect(vp.width, `/Rotate ${String(rot)} の viewport の向き`).toBe(rot % 180 === 0 ? 600 : 1200);
      // 本当の位置(PDF の座標)→ 画面での長方形。⚠ 期待値は窓の計算(逆向き)を通さずに作る
      const T = [60, 500, 160, 520];
      const c0 = vp.convertToViewportPoint(T[0] as number, T[1] as number);
      const c1 = vp.convertToViewportPoint(T[2] as number, T[3] as number);
      const sel = {
        left: 30 + Math.min(c0[0] as number, c1[0] as number),
        right: 30 + Math.max(c0[0] as number, c1[0] as number),
        top: 50 + Math.min(c0[1] as number, c1[1] as number),
        bottom: 50 + Math.max(c0[1] as number, c1[1] as number),
      };
      // 箱は viewport より 1px 小さい(floor した幅)── 比で吸収していること
      const got = hlLib.quadsOnPage([sel], { left: 30, top: 50, width: vp.width - 1, height: vp.height - 1 }, vp, (x, y) =>
        vp.convertToPdfPoint(x, y),
      );
      expect(got, '選んだ長方形が拾われていない').not.toBeNull();
      const out = await core.build(PDFLib, bytes, {
        order: [1],
        rotate: {},
        highlights: [{ page: 1, rgb: YELLOW, quads: (got as { quads: number[][] }).quads }],
      });
      const hs = await highlightsOf(out, 1);
      expect(hs.length).toBe(1);
      const rect = Array.from(hs[0]?.['rect'] as number[]);
      // 1px の比のずれ(約 0.2%)を許す ── 向きの取り違え(数百 pt 動く)は通さない
      expect(near(rect, T, 2), `rect ${rect.join(',')} ≠ ${T.join(',')}`).toBe(true);
      // 見えている位置: できた PDF を同じ倍率で開き、注釈の rect を画面へ戻すと、選んだ長方形に重なる
      const o2 = openJs(out);
      const vp2 = (await (await o2.doc).getPage(1)).getViewport({ scale: 1.5 });
      await o2.task.destroy();
      const a = vp2.convertToViewportPoint(rect[0] as number, rect[1] as number);
      const b = vp2.convertToViewportPoint(rect[2] as number, rect[3] as number);
      expect(Math.min(a[0] as number, b[0] as number) + 30).toBeCloseTo(sel.left, -1);
      expect(Math.max(a[0] as number, b[0] as number) + 30).toBeCloseTo(sel.right, -1);
      expect(Math.min(a[1] as number, b[1] as number) + 50).toBeCloseTo(sel.top, -1);
      expect(Math.max(a[1] as number, b[1] as number) + 50).toBeCloseTo(sel.bottom, -1);
    });
  }
});

/** 他のアプリが付けた注釈のある 2 ページ。1 ページ目: ハイライト(/P・/Popup・返信つき)+ コメント + 図形。2 ページ目: ハイライト。 */
const HLM = 'HLMARK-ONE';
const H2M = 'HLMARK-TWO';
const TXM = 'TEXTMARK';
const SQM = 'SQUAREMARK';
const RPM = 'REPLYMARK';
async function otherApp(): Promise<Uint8Array> {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const ctx = doc.context;
  const p1 = doc.addPage([300, 400]);
  const p2 = doc.addPage([300, 400]);
  p1.drawText(A, { x: 20, y: 200, size: 18, font });
  p2.drawText(B, { x: 20, y: 200, size: 18, font });
  const base = (sub: string, contents: string, page: PDFLib.PDFPage): Record<string, unknown> => ({
    Type: 'Annot',
    Subtype: sub,
    Rect: [20, 195, 120, 220],
    Contents: PDFLib.PDFString.of(contents),
    P: page.ref,
  });
  const hl1 = ctx.obj({ ...base('Highlight', HLM, p1), QuadPoints: Q1, C: [1, 1, 0] } as never) as unknown as PDFLib.PDFDict;
  const hl1Ref = ctx.register(hl1);
  const popup = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [130, 195, 250, 260], Parent: hl1Ref, P: p1.ref }));
  hl1.set(PDFLib.PDFName.of('Popup'), popup);
  const text = ctx.register(ctx.obj(base('Text', TXM, p1) as never));
  const square = ctx.register(ctx.obj(base('Square', SQM, p1) as never));
  const reply = ctx.register(ctx.obj({ ...base('Text', RPM, p1), IRT: hl1Ref, RT: 'R' } as never));
  p1.node.set(PDFLib.PDFName.of('Annots'), ctx.obj([hl1Ref, popup, text, square, reply]));
  const hl2 = ctx.register(ctx.obj({ ...base('Highlight', H2M, p2), QuadPoints: Q1, C: [0, 1, 0] } as never));
  p2.node.set(PDFLib.PDFName.of('Annots'), ctx.obj([hl2]));
  return doc.save();
}

describe('🔴 ハイライトを外す ── 他のアプリが付けたハイライトも外せ、コメント・図形は残る', () => {
  it('1 ページ目の他アプリのハイライト(/P・/Popup つき)を外す: ハイライトと吹き出しは無く、コメント・図形・返信は残る。外したハイライトの本文は全 stream に 0 件', async () => {
    const src = await otherApp();
    // 対照群: 元には全部在り、pdf.js がハイライトを 1 つ・id つきで読める
    for (const m of [HLM, H2M, TXM, SQM, RPM]) expect(hasMark(src, m), `元の ${m}`).toBe(true);
    const before = await highlightsOf(src, 1);
    expect(before.length).toBe(1);
    const id = before[0]?.['id'] as string;
    expect(id).toMatch(/^\d+R$/);
    const out = await core.build(PDFLib, src, { order: [1, 2], rotate: {}, removals: [{ page: 1, id }] });
    expect(hasMark(out, HLM), '外したハイライトの本文が残っている').toBe(false);
    for (const m of [H2M, TXM, SQM, RPM]) expect(hasMark(out, m), `残るはずの ${m}`).toBe(true);
    const dicts = await annotDicts(out, 0);
    expect(dicts.map(subtypeOf), '吹き出しも一緒に外れ、残りの注釈はそのまま').toEqual(['Text', 'Square', 'Text']);
    expect(await highlightsOf(out, 1)).toEqual([]);
    expect((await highlightsOf(out, 2)).length, '2 ページ目のハイライトは触らない').toBe(1);
    // 返信は残るが、外したハイライトを指す /IRT は外れている(残すと外したハイライトが戻る)
    expect((dicts[2] as PDFLib.PDFDict).has(PDFLib.PDFName.of('IRT'))).toBe(false);
    // 残った注釈の /P は(2a の仕組みで)出力の自ページを指したまま
    const doc = await PDFLib.PDFDocument.load(out);
    for (const d of dicts) expect(String(d.get(PDFLib.PDFName.of('P')))).toBe(String(doc.getPage(0).ref));
  });

  it('並べ替え・外すと同時でも効く(外すハイライトは元のページ番号で指し、出力のページ位置は問わない)', async () => {
    const src = await otherApp();
    const id1 = ((await highlightsOf(src, 1))[0] as Record<string, unknown>)['id'] as string;
    const id2 = ((await highlightsOf(src, 2))[0] as Record<string, unknown>)['id'] as string;
    const out = await core.build(PDFLib, src, { order: [2, 1], rotate: { 2: 90 }, removals: [{ page: 2, id: id2 }] });
    expect(hasMark(out, H2M)).toBe(false);
    expect((await highlightsOf(out, 1)).length, '出力の 1 ページ目(元の 2)のハイライトは外れた').toBe(0);
    expect((await highlightsOf(out, 2)).length, '出力の 2 ページ目(元の 1)のハイライトは残る').toBe(1);
    expect(hasMark(out, HLM)).toBe(true);
    // 外したページへの外す指定は捨てる(断らない)
    const dropped = await core.build(PDFLib, src, { order: [1], rotate: {}, removals: [{ page: 2, id: id2 }] });
    expect(hasMark(dropped, H2M)).toBe(false);
    expect((await highlightsOf(dropped, 1)).length).toBe(1);
    expect(id1).not.toBe(id2);
  });

  it('付ける + 外す を同じ依頼で: 外した跡に新しい色のハイライトだけが残る', async () => {
    const src = await otherApp();
    const id = ((await highlightsOf(src, 2))[0] as Record<string, unknown>)['id'] as string;
    const out = await core.build(PDFLib, src, {
      order: [1, 2],
      rotate: {},
      removals: [{ page: 2, id }],
      highlights: [{ page: 2, rgb: [0, 0, 1], quads: [Q2] }],
    });
    const hs = await highlightsOf(out, 2);
    expect(hs.length).toBe(1);
    expect(near(Array.from(hs[0]?.['color'] as Uint8ClampedArray), [0, 0, 255], 1)).toBe(true);
    expect(hasMark(out, H2M), '外した他アプリのハイライトの本文').toBe(false);
  });

  it('往復: 付けて保存した PDF を開き直し(id は読み直した物)、外して保存すると、ハイライトも外観も無い', async () => {
    const src = await sample([A, B]);
    const once = await core.build(PDFLib, src, { order: [1, 2], rotate: {}, highlights: [{ page: 2, rgb: YELLOW, quads: [Q1] }] });
    expect(allStreamText(once), '対照: 付けた PDF には乗算の外観が在る').toContain('Multiply');
    const id = ((await highlightsOf(once, 2))[0] as Record<string, unknown>)['id'] as string;
    const twice = await core.build(PDFLib, once, { order: [1, 2], rotate: {}, removals: [{ page: 2, id }] });
    expect(await highlightsOf(twice, 2)).toEqual([]);
    expect(allStreamText(twice), '外観も残っていない').not.toContain('Multiply');
    expect((await PDFLib.PDFDocument.load(twice)).getPageCount()).toBe(2);
  });

  it('🔴 外せない依頼は黙って通さず断る: 知らない id / ハイライトでない注釈の id / 別ページの id → bad-highlight。形の不正は bad-job', async () => {
    const src = await otherApp();
    const text = ((await jsAnnots(src, 1)).find((a) => a['annotationType'] === 1) as Record<string, unknown>)['id'] as string;
    const code = async (removals: unknown): Promise<string | undefined> => {
      try {
        await core.build(PDFLib, src, { order: [1, 2], rotate: {}, removals });
      } catch (e) {
        return (e as { pkcCode?: string }).pkcCode;
      }
      return undefined;
    };
    expect(await code([{ page: 1, id: '9999R' }]), '知らない id').toBe('bad-highlight');
    expect(await code([{ page: 1, id: text }]), 'コメント(Text)は外さない').toBe('bad-highlight');
    const hid = ((await highlightsOf(src, 1))[0] as Record<string, unknown>)['id'] as string;
    expect(await code([{ page: 2, id: hid }]), '別のページのハイライトの id').toBe('bad-highlight');
    expect(await code([{ page: 1, id: 'abc' }]), '形の不正').toBe('bad-job');
    expect(await code([{ page: 0, id: hid }]), 'ページ番号の不正').toBe('bad-job');
    expect(await code('x'), '配列でない').toBe('bad-job');
    // 対照: 正しい依頼は通る
    expect(await code([{ page: 1, id: hid }])).toBeUndefined();
  });
});

describe('ハイライトの依頼の検め(checkJob)', () => {
  it('不正な色・QuadPoints・数は bad-job / 外したページの物は捨てる / 無ければ空', () => {
    const base = { order: [1, 2], rotate: {} };
    const bad = (h: unknown): string | undefined => {
      try {
        core.checkJob({ ...base, highlights: h }, 2);
      } catch (e) {
        return (e as { pkcCode?: string }).pkcCode;
      }
      return undefined;
    };
    expect(bad([{ page: 1, rgb: [2, 0, 0], quads: [Q1] }]), '色が範囲の外').toBe('bad-job');
    expect(bad([{ page: 1, rgb: [1, 0], quads: [Q1] }]), '色が 2 成分').toBe('bad-job');
    expect(bad([{ page: 1, rgb: YELLOW, quads: [] }]), '行が無い').toBe('bad-job');
    expect(bad([{ page: 1, rgb: YELLOW, quads: [[1, 2, 3]] }]), '8 数でない').toBe('bad-job');
    expect(bad([{ page: 1, rgb: YELLOW, quads: [[1, 2, 3, 4, 5, 6, 7, Number.NaN]] }]), 'NaN').toBe('bad-job');
    expect(bad('x'), '配列でない').toBe('bad-job');
    expect(bad([{ page: 1, rgb: YELLOW, quads: [Q1] }]), '対照: 正しい形は通る').toBeUndefined();
    const plan = core.checkJob(
      { order: [2], rotate: {}, highlights: [{ page: 1, rgb: YELLOW, quads: [Q1] }, { page: 2, rgb: YELLOW, quads: [Q1] }] },
      2,
    );
    expect(plan.highlights.map((h) => h.page), '残さないページの分は捨てる').toEqual([2]);
    expect(core.checkJob(base, 2)).toMatchObject({ highlights: [], removals: [] });
  });
});

interface WorkerReply {
  id: number;
  ok: boolean;
  bytes?: ArrayBuffer;
  code?: string;
}

/** `importScripts` を差した vm の中で worker の原文を走らせる(`pdf-edit-core.test.ts` と同じ作り)。 */
function bootWorker(): { send(msg: { id: number; op: string; bytes: ArrayBuffer; job?: unknown }): Promise<WorkerReply> } {
  const replies: WorkerReply[] = [];
  const sandbox: Record<string, unknown> = {};
  sandbox['self'] = sandbox;
  sandbox['postMessage'] = (m: WorkerReply) => replies.push(m);
  const ctx = vm.createContext(sandbox);
  sandbox['importScripts'] = (...paths: string[]) => {
    for (const p of paths) {
      const file = p === './lib/pdf-lib.min.js' ? 'node_modules/pdf-lib/dist/pdf-lib.min.js' : `public/pdf/${p.replace('./', '')}`;
      vm.runInContext(readFileSync(file, 'utf-8'), ctx, { filename: file });
    }
  };
  vm.runInContext(readFileSync('public/pdf/edit-worker.js', 'utf-8'), ctx, { filename: 'edit-worker.js' });
  return {
    send: async (m) => {
      const before = replies.length;
      // 依頼は vm の中で作る(本物の worker は構造化複製で自分の realm の Array / Object を受け取る)
      sandbox['__id'] = m.id;
      sandbox['__op'] = m.op;
      sandbox['__bytes'] = m.bytes;
      sandbox['__job'] = JSON.stringify(m.job ?? null);
      await (vm.runInContext('onmessage({ data: { id: __id, op: __op, bytes: __bytes, job: JSON.parse(__job) } })', ctx) as Promise<void>);
      expect(replies.length, '返事が 1 つも出ていない').toBe(before + 1);
      return replies[before] as WorkerReply;
    },
  };
}

describe('worker(edit-worker.js)でもハイライトを付ける・外す', () => {
  it('build の依頼に highlights を付けると注釈が入り、removals で外せ、外せない依頼は bad-highlight を返す', async () => {
    const w = bootWorker();
    const src = await sample([A, B]);
    const copy = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
    const r = await w.send({
      id: 1,
      op: 'build',
      bytes: copy(src),
      job: { order: [1, 2], rotate: {}, highlights: [{ page: 2, rgb: YELLOW, quads: [Q1] }] },
    });
    expect(r.ok).toBe(true);
    const out = new Uint8Array(r.bytes as ArrayBuffer);
    const hs = await highlightsOf(out, 2);
    expect(hs.length).toBe(1);
    const id = hs[0]?.['id'] as string;
    const r2 = await w.send({ id: 2, op: 'build', bytes: copy(out), job: { order: [1, 2], rotate: {}, removals: [{ page: 2, id }] } });
    expect(r2.ok).toBe(true);
    expect(await highlightsOf(new Uint8Array(r2.bytes as ArrayBuffer), 2)).toEqual([]);
    const r3 = await w.send({ id: 3, op: 'build', bytes: copy(src), job: { order: [1, 2], rotate: {}, removals: [{ page: 2, id: '7R' }] } });
    expect(r3).toMatchObject({ ok: false, code: 'bad-highlight' });
  });
});
