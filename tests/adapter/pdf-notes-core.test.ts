/** @vitest-environment node */
/**
 * 付箋とペンを新しい PDF に書く(`public/pdf/edit-core.js` の `build`)(#275)。
 *
 * 🔴 守るもの:
 * 1. 付けた付箋が、**出力の正しいページ**に、PDF 本来の注釈 `/Text`(字は UTF-16 ── 日本語が読める)+ 外観つきで入る。
 *    pdf.js(本物の読み手)で読み直すと、字・場所が元のとおり。外したページに付けた分は出力に出ない / 並べ替えに付いてくる。
 * 2. 付けたペンの線が `/Ink`(点の並び・色・太さ・外観つき)で入り、pdf.js で読み直せる。
 * 3. 外す: 他のアプリが付けた付箋(`kind: 'note'`)を外すと、その字は出力に 0 件(対照: 元には在る)。
 *    ハイライト・図形・返信は残る。種類の違う物を外そうとしたら、黙って通さず `bad-highlight` で断る(両方向)。
 * 4. 不正な依頼は `bad-job`。足したページ(元の PDF の外)には付けない。
 * ⚠ 「無い」ことの検査は、同じ読み取りで「ある」が見える対照群を同じ it に置く。
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import * as PDFLib from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';

interface Core {
  build(lib: typeof PDFLib, bytes: Uint8Array, job: unknown, extras?: Uint8Array[]): Promise<Uint8Array>;
}

function loadCore(): Core {
  const root: { PkcPdfEditCore?: Core } = {};
  new Function('self', readFileSync('public/pdf/edit-core.js', 'utf-8'))(root);
  expect(root.PkcPdfEditCore, '原文が API を公開していない(空振り)').toBeDefined();
  return root.PkcPdfEditCore as Core;
}
const core = loadCore();

const TEXT_ANNOT = 1;
const INK_ANNOT = 15;
const NOTE_JA = '来週までに見積を取る(全角の字・記号も)';

async function sample(n: number): Promise<Uint8Array> {
  const doc = await PDFLib.PDFDocument.create();
  for (let i = 0; i < n; i += 1) doc.addPage([300 + i * 10, 400]);
  return doc.save();
}

async function jsAnnots(bytes: Uint8Array, pageNo: number): Promise<Record<string, unknown>[]> {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, verbosity: 0 });
  try {
    const page = await (await task.promise).getPage(pageNo);
    return (await page.getAnnotations()) as Record<string, unknown>[];
  } finally {
    await task.destroy();
  }
}
const ofType = async (bytes: Uint8Array, pageNo: number, type: number): Promise<Record<string, unknown>[]> =>
  (await jsAnnots(bytes, pageNo)).filter((a) => a['annotationType'] === type);
const textOf = (a: Record<string, unknown>): string =>
  String((a['contentsObj'] as { str?: string } | undefined)?.str ?? a['contents'] ?? '');

/** file の全 stream を展開して、1 本の字にする(object stream に入っていても、残っていれば見える)。 */
function allText(bytes: Uint8Array): string {
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

/** file のどこかに(圧縮を展開して)、字が UTF-16(先頭に BOM)の 16 進で在るか。 */
function hasHexText(bytes: Uint8Array, s: string): boolean {
  const hex = Buffer.from(String.fromCharCode(0xfeff) + s, 'utf16le').swap16().toString('hex').toUpperCase();
  return allText(bytes).toUpperCase().includes(hex);
}

describe('🔴 付箋を書く', () => {
  it('付箋は /Text として入り、pdf.js で読み直すと字(日本語)と場所が元のとおり。外観(/AP)も在る', async () => {
    const src = await sample(2);
    const out = await core.build(PDFLib, src, {
      order: [1, 2],
      rotate: {},
      notes: [{ page: 2, rect: [40, 300, 58, 318], text: NOTE_JA }],
    });
    expect((await ofType(out, 1, TEXT_ANNOT)).length, '付けていないページ').toBe(0);
    const got = await ofType(out, 2, TEXT_ANNOT);
    expect(got.length).toBe(1);
    expect(textOf(got[0] as Record<string, unknown>), '日本語の字がそのまま読める').toBe(NOTE_JA);
    expect(Array.from(got[0]?.['rect'] as number[])).toEqual([40, 300, 58, 318]);
    // 外観: 他のビューアが自前の絵を描かなくても見える
    const doc = await PDFLib.PDFDocument.load(out);
    const dict = doc.getPage(1).node.Annots()?.lookup(0, PDFLib.PDFDict) as PDFLib.PDFDict;
    const ap = dict.lookup(PDFLib.PDFName.of('AP'), PDFLib.PDFDict);
    expect(ap.lookup(PDFLib.PDFName.of('N')), '/AP /N の外観').toBeDefined();
    expect(dict.lookup(PDFLib.PDFName.of('Subtype'))).toBe(PDFLib.PDFName.of('Text'));
  });

  it('外したページに付けた付箋は出ない / 並べ替えに付いてくる / 作った PDF をもう一度編集しても付箋は自分のページに付いてくる', async () => {
    const src = await sample(3);
    const out = await core.build(PDFLib, src, {
      order: [3, 1],
      rotate: {},
      notes: [
        { page: 1, rect: [10, 10, 28, 28], text: '一枚目の付箋' },
        { page: 2, rect: [10, 10, 28, 28], text: '外したページの付箋' },
      ],
    });
    expect((await ofType(out, 1, TEXT_ANNOT)).length, '出力の 1 ページ目は元の 3 ページ目(付箋なし)').toBe(0);
    const second = await ofType(out, 2, TEXT_ANNOT);
    expect(second.map(textOf), '元の 1 ページ目の付箋は出力の 2 ページ目へ付いてくる').toEqual(['一枚目の付箋']);
    expect(hasHexText(out, '外したページの付箋'), '外したページの付箋は file のどこにも無い').toBe(false);
    expect(hasHexText(out, '一枚目の付箋'), '対照: 付けた付箋の字は file に在る').toBe(true);
    const twice = await core.build(PDFLib, out, { order: [2, 1], rotate: {} });
    expect((await ofType(twice, 1, TEXT_ANNOT)).map(textOf)).toEqual(['一枚目の付箋']);
  });

  for (const rot of [0, 90, 180, 270]) {
    it(`元から /Rotate ${String(rot)} のページでも、付箋の Rect は PDF の座標のまま入る(向きを足し引きしない)`, async () => {
      const d = await PDFLib.PDFDocument.create();
      d.addPage([400, 800]).setRotation(PDFLib.degrees(rot));
      const out = await core.build(PDFLib, await d.save(), {
        order: [1],
        rotate: {},
        notes: [{ page: 1, rect: [60, 500, 78, 518], text: 'ここ' }],
      });
      const got = await ofType(out, 1, TEXT_ANNOT);
      expect(Array.from(got[0]?.['rect'] as number[])).toEqual([60, 500, 78, 518]);
    });
  }
});

describe('🔴 ペンの線を書く', () => {
  it('線は /Ink として入り、点の並び・色・太さが読み直せる。外観(/AP)つき。外したページの線は出ない', async () => {
    const src = await sample(2);
    const out = await core.build(PDFLib, src, {
      order: [1],
      rotate: {},
      strokes: [
        { page: 1, rgb: [0.5, 0.78, 1], width: 2, paths: [[20, 30, 60, 90, 100, 40]] },
        { page: 2, rgb: [1, 0, 0], width: 2, paths: [[1, 1, 5, 5]] },
      ],
    });
    const inks = await ofType(out, 1, INK_ANNOT);
    expect(inks.length, '外したページの線は無く、1 本だけ').toBe(1);
    const lists = inks[0]?.['inkLists'] as ArrayLike<number>[];
    expect(lists.length).toBe(1);
    expect(Array.from(lists[0] as ArrayLike<number>), '点の並び(x, y, x, y …)').toEqual([20, 30, 60, 90, 100, 40]);
    const color = Array.from(inks[0]?.['color'] as ArrayLike<number>);
    expect(color).toEqual([128, 199, 255]);
    const doc = await PDFLib.PDFDocument.load(out);
    const dict = doc.getPage(0).node.Annots()?.lookup(0, PDFLib.PDFDict) as PDFLib.PDFDict;
    expect(dict.lookup(PDFLib.PDFName.of('AP'), PDFLib.PDFDict).lookup(PDFLib.PDFName.of('N'))).toBeDefined();
    const bs = dict.lookup(PDFLib.PDFName.of('BS'), PDFLib.PDFDict);
    expect((bs.lookup(PDFLib.PDFName.of('W')) as PDFLib.PDFNumber).asNumber(), '太さ').toBe(2);
    // 外観の外接は線より広い(太さの半分)── 端が切れて描かれない形にしない
    const rect = (dict.lookup(PDFLib.PDFName.of('Rect'), PDFLib.PDFArray).asArray() as PDFLib.PDFNumber[]).map((n) => n.asNumber());
    expect(rect[0]).toBeLessThan(20);
    expect(rect[2]).toBeGreaterThan(100);
  });

  it('付箋・線・ハイライトを同じ保存に混ぜても、全部が自分のページに入る(ページの回転も一緒)', async () => {
    const src = await sample(2);
    const out = await core.build(PDFLib, src, {
      order: [2, 1],
      rotate: { 2: 90 },
      highlights: [{ page: 1, rgb: [1, 0.92, 0.2], quads: [[10, 50, 60, 50, 10, 30, 60, 30]] }],
      notes: [{ page: 1, rect: [100, 100, 118, 118], text: '混ぜる' }],
      strokes: [{ page: 1, rgb: [0, 0, 0], width: 2, paths: [[5, 5, 50, 50]] }],
    });
    expect((await jsAnnots(out, 1)).length, '出力の 1 ページ目(元の 2 ページ目)は注釈なし').toBe(0);
    const kinds = (await jsAnnots(out, 2)).map((a) => a['annotationType']).sort();
    expect(kinds, '元の 1 ページ目 → 出力の 2 ページ目に 3 種類').toEqual([TEXT_ANNOT, 9, INK_ANNOT].sort());
  });
});

/** 他のアプリが付けた注釈のある 2 ページ。1 ページ目: 付箋 + ハイライト + 図形 + 付箋への返信。 */
const TXM = 'TEXTMARK-OTHER-APP';
const HLM = 'HLMARK-OTHER-APP';
const SQM = 'SQUAREMARK-OTHER-APP';
const RPM = 'REPLYMARK-OTHER-APP';
async function otherApp(): Promise<{ bytes: Uint8Array; noteId: string; hlId: string }> {
  const doc = await PDFLib.PDFDocument.create();
  const ctx = doc.context;
  const p1 = doc.addPage([300, 400]);
  doc.addPage([300, 400]);
  const base = (sub: string, contents: string): Record<string, unknown> => ({
    Type: 'Annot',
    Subtype: sub,
    Rect: [20, 195, 120, 220],
    Contents: PDFLib.PDFString.of(contents),
    P: p1.ref,
  });
  const text = ctx.register(ctx.obj(base('Text', TXM) as never));
  const hl = ctx.register(
    ctx.obj({ ...base('Highlight', HLM), QuadPoints: [20, 220, 120, 220, 20, 195, 120, 195], C: [1, 1, 0] } as never),
  );
  const square = ctx.register(ctx.obj(base('Square', SQM) as never));
  const reply = ctx.register(ctx.obj({ ...base('Text', RPM), IRT: text, RT: 'R' } as never));
  p1.node.set(PDFLib.PDFName.of('Annots'), ctx.obj([text, hl, square, reply]));
  return { bytes: await doc.save(), noteId: `${String(text.objectNumber)}R`, hlId: `${String(hl.objectNumber)}R` };
}

describe('🔴 付箋を外す ── 他のアプリが付けた付箋も外せ、ハイライト・図形・返信は残る', () => {
  it('kind: note で外す: 付箋の字は出力の全体に 0 件(対照: 元には在る)。ハイライト・図形・返信は残る(返信の /IRT だけ外れる)', async () => {
    const { bytes, noteId } = await otherApp();
    expect(allText(bytes), '対照: 元には付箋の字が在る').toContain(TXM);
    const out = await core.build(PDFLib, bytes, {
      order: [1, 2],
      rotate: {},
      removals: [{ page: 1, id: noteId, kind: 'note' }],
    });
    expect(allText(out)).not.toContain(TXM);
    const left = await jsAnnots(out, 1);
    const bodies = left.map(textOf);
    expect(bodies, '外していない物は残る').toEqual(expect.arrayContaining([HLM, SQM, RPM]));
    expect(bodies).not.toContain(TXM);
    expect(left.length).toBe(3);
  });

  it('種類の違う物は外さず断る(両方向): 付箋を kind 省略(ハイライト)で / ハイライトを kind: note で / 無い id', async () => {
    const { bytes, noteId, hlId } = await otherApp();
    const tryBuild = (removals: unknown[]): Promise<unknown> =>
      core.build(PDFLib, bytes, { order: [1, 2], rotate: {}, removals }).then(
        () => 'built',
        (e: { pkcCode?: string }) => e.pkcCode,
      );
    expect(await tryBuild([{ page: 1, id: noteId }]), '付箋をハイライトとして外そうとした').toBe('bad-highlight');
    expect(await tryBuild([{ page: 1, id: hlId, kind: 'note' }]), 'ハイライトを付箋として外そうとした').toBe('bad-highlight');
    expect(await tryBuild([{ page: 1, id: '999R', kind: 'note' }]), '無い id').toBe('bad-highlight');
    // 対照群: 正しい組み合わせは通る
    expect(await tryBuild([{ page: 1, id: noteId, kind: 'note' }])).toBe('built');
    expect(await tryBuild([{ page: 1, id: hlId }])).toBe('built');
  });
});

describe('不正な依頼は bad-job', () => {
  const badJob = (job: unknown, extras?: Uint8Array[]): Promise<unknown> =>
    sample(2).then((src) =>
      core.build(PDFLib, src, { order: [1, 2], rotate: {}, ...(job as object) }, extras).then(
        () => 'built',
        (e: { pkcCode?: string }) => e.pkcCode,
      ),
    );
  const okNote = { page: 1, rect: [0, 0, 10, 10], text: 'x' };
  const okInk = { page: 1, rgb: [0, 0, 0], width: 2, paths: [[0, 0, 5, 5]] };

  it('付箋: 字が空 / 字でない / 長すぎる / 四角が 4 数でない / ページが 0 / 数でない座標', async () => {
    expect(await badJob({ notes: [okNote] }), '対照: 正しい付箋は通る').toBe('built');
    for (const [name, bad] of [
      ['字が空', { ...okNote, text: '' }],
      ['字が数', { ...okNote, text: 5 }],
      ['長すぎる', { ...okNote, text: 'あ'.repeat(2001) }],
      ['四角が 3 数', { ...okNote, rect: [0, 0, 10] }],
      ['ページが 0', { ...okNote, page: 0 }],
      ['座標が NaN', { ...okNote, rect: [0, 0, Number.NaN, 10] }],
    ] as const) {
      expect(await badJob({ notes: [bad] }), name).toBe('bad-job');
    }
  });

  it('線: 色が範囲外 / 太さが 0 や極端 / 点の数が奇数・少なすぎる / 経路が無い', async () => {
    expect(await badJob({ strokes: [okInk] }), '対照: 正しい線は通る').toBe('built');
    for (const [name, bad] of [
      ['色が 1 超', { ...okInk, rgb: [2, 0, 0] }],
      ['太さ 0', { ...okInk, width: 0 }],
      ['太さが極端', { ...okInk, width: 500 }],
      ['点が奇数', { ...okInk, paths: [[0, 0, 5]] }],
      ['点が 1 つ分(2 数)', { ...okInk, paths: [[0, 0]] }],
      ['経路が無い', { ...okInk, paths: [] }],
    ] as const) {
      expect(await badJob({ strokes: [bad] }), name).toBe('bad-job');
    }
  });

  it('足したページ(元の PDF の外)には付箋も線も付けない / 外す kind は 2 つだけ', async () => {
    const extra = await sample(1);
    const withExtra = (more: object): Promise<unknown> =>
      sample(2).then((src) =>
        core.build(PDFLib, src, { order: [1, 2, 3], rotate: {}, sources: [{ first: 3, count: 1 }], ...more }, [extra]).then(
          () => 'built',
          (e: { pkcCode?: string }) => e.pkcCode,
        ),
      );
    expect(await withExtra({}), '対照: 足したページだけなら通る').toBe('built');
    expect(await withExtra({ notes: [{ ...okNote, page: 3 }] })).toBe('bad-job');
    expect(await withExtra({ strokes: [{ ...okInk, page: 3 }] })).toBe('bad-job');
    expect(await badJob({ removals: [{ page: 1, id: '4R', kind: 'ink' }] })).toBe('bad-job');
  });
});
