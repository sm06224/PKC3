/** @vitest-environment node */
/**
 * ページの編集で PDF を作る所(`public/pdf/edit-core.js` と、それを呼ぶ worker `edit-worker.js`)(#275 段②-1b)。
 *
 * 🔴 守るもの:
 * 1. **外したページの中身が、出力の全 stream を展開しても 0 件**(設計 doc §2 の実測を回帰 test にしたもの)。
 *    開いた文書の中で `removePage` する道(A)は、外したページの文字が file に**残る** ── user は消えたと思って人に渡す。
 * 2. 出力のページの**並び**と**向き**が依頼どおり(元の向きがあるページには足し算になる)。
 * 3. 暗号化(パスワード付き)・読めない PDF・不正な依頼を、**種類つきで断る**(窓が user の言葉にする)。
 *
 * ⚠ 実物の pdf-lib(`node_modules`)で走らせる。⚠ 「無い」ことの検査は、**同じ読み取りで「ある」が見える対照群**
 *   (A の道で作った PDF)を同じ it に置く ── 置かないと、読み取りが何も見えていなくても緑になる。
 * ⚠ worker は **`importScripts` を差した vm の中で原文のまま**動かす(本物の worker と同じ読み込み順)。
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import vm from 'node:vm';
import * as PDFLib from 'pdf-lib';
import { describe, expect, it } from 'vitest';

interface Core {
  CODES: { encrypted: string; unreadable: string; badJob: string };
  check(lib: typeof PDFLib, bytes: Uint8Array): Promise<number>;
  checkJob(
    job: unknown,
    pageCount: number,
  ): { order: number[]; rotate: Record<number, number>; sources: { first: number; count: number }[] };
  build(lib: typeof PDFLib, bytes: Uint8Array, job: unknown, extras?: Uint8Array[]): Promise<Uint8Array>;
  verify(lib: typeof PDFLib, bytes: Uint8Array, pageCount: number): Promise<void>;
}

function loadCore(): Core {
  const root: { PkcPdfEditCore?: Core } = {};
  new Function('self', readFileSync('public/pdf/edit-core.js', 'utf-8'))(root);
  expect(root.PkcPdfEditCore, '原文が API を公開していない(空振り)').toBeDefined();
  return root.PkcPdfEditCore as Core;
}
const core = loadCore();

/** 各ページに**別の字**を持つ PDF。`rotations[i]` = 元の向き。 */
async function sample(marks: string[], rotations: number[] = []): Promise<Uint8Array> {
  const doc = await PDFLib.PDFDocument.create();
  doc.setTitle('元の題名');
  doc.setAuthor('元の作者');
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  marks.forEach((m, i) => {
    const page = doc.addPage([300 + i * 10, 400]);
    page.drawText(m, { x: 20, y: 200, size: 18, font });
    if (rotations[i]) page.setRotation(PDFLib.degrees(rotations[i] as number));
  });
  return doc.save();
}

/** file の全 stream を展開して、1 本の字にする(圧縮してあっても、外したページの字が残っていれば見える)。 */
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
      // 展開できない stream(画像など)は飛ばす
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

/** 出力の `i` ページ目の字(内容の stream を展開して)。 */
async function pageText(bytes: Uint8Array, i: number): Promise<string> {
  const doc = await PDFLib.PDFDocument.load(bytes);
  const page = doc.getPage(i);
  const contents = page.node.Contents();
  const streams = contents instanceof PDFLib.PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
  let out = '';
  for (const s of streams) {
    if (s instanceof PDFLib.PDFRawStream) out += Buffer.from(PDFLib.decodePDFRawStream(s).decode()).toString('latin1');
    else if (s) out += String((s as { getContentsString?: () => string }).getContentsString?.() ?? '');
  }
  return out;
}
const hexOf = (m: string): string => Buffer.from(m, 'latin1').toString('hex').toUpperCase();
const showsMark = (t: string, m: string): boolean => t.includes(m) || t.toUpperCase().includes(hexOf(m));

const A = 'MARK-ALPHA-111';
const B = 'MARK-BRAVO-222';
const C = 'MARK-CHARLIE-333';

describe('🔴 外したページの中身が、出力に残らない', () => {
  it('2 ページ目を外す: 出力の全 stream に B が無い ── 対照群(removePage の道)では B が残っている', async () => {
    const src = await sample([A, B, C]);
    // 対照群(道 A): 開いた文書の中で外す。この読み取りが「残っている」を見られることの証明
    const viaA = await PDFLib.PDFDocument.load(src);
    viaA.removePage(1);
    const aBytes = await viaA.save();
    expect(hasMark(aBytes, B), '対照群が B を見つけられない(読み取りが空振り)').toBe(true);
    // 本物(道 B)
    const out = await core.build(PDFLib, src, { order: [1, 3], rotate: {} });
    expect(hasMark(out, A)).toBe(true);
    expect(hasMark(out, C)).toBe(true);
    expect(hasMark(out, B), '外したページの字が file に残っている').toBe(false);
    expect((await PDFLib.PDFDocument.load(out)).getPageCount()).toBe(2);
  });

  it('並べ替えと回すだけの依頼でも、外していないページが全部ある(作り方は 1 本)', async () => {
    const src = await sample([A, B, C]);
    const out = await core.build(PDFLib, src, { order: [3, 1, 2], rotate: { 1: 90 } });
    for (const m of [A, B, C]) expect(hasMark(out, m), m).toBe(true);
  });
});

/** 1 ページ目に、3 ページ目(と 2 ページ目)を指すリンクの注釈を持つ PDF。名前つきの行き先(名前 / 文字列)も含む。 */
async function linked(extra?: (p1: PDFLib.PDFPage, p3: PDFLib.PDFPage) => void): Promise<Uint8Array> {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const pages = [A, B, C].map((m) => {
    const p = doc.addPage([300, 400]);
    p.drawText(m, { x: 20, y: 200, size: 18, font });
    return p;
  });
  const [p1, p2, p3] = pages as [PDFLib.PDFPage, PDFLib.PDFPage, PDFLib.PDFPage];
  const ctx = doc.context;
  const link = (extraEntries: Record<string, unknown>): PDFLib.PDFRef =>
    ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 100, 30], Border: [0, 0, 0], ...extraEntries }));
  const links = [
    link({ Dest: [p3.ref, 'Fit'] }), // 外すページへ(/Dest)
    link({ A: { S: 'GoTo', D: [p3.ref, 'Fit'] } }), // 外すページへ(/A /GoTo)
    link({ Dest: [p2.ref, 'Fit'] }), // 残すページへ
    link({ Dest: 'chap3' }), // 名前(/Dests)→ 外すページ
    link({ Dest: PDFLib.PDFString.of('chap3s') }), // 文字列(/Names の木)→ 外すページ
  ];
  doc.catalog.set(PDFLib.PDFName.of('Dests'), ctx.obj({ chap3: [p3.ref, 'Fit'] }));
  doc.catalog.set(
    PDFLib.PDFName.of('Names'),
    ctx.obj({ Dests: { Names: [PDFLib.PDFString.of('chap3s'), [p3.ref, 'Fit']] } }),
  );
  p1.node.set(PDFLib.PDFName.of('Annots'), ctx.obj(links));
  extra?.(p1, p3);
  return doc.save();
}

/** 出力の `i` ページ目の `j` 番目の注釈が指す行き先のページ(出力の何ページ目か。ページを指さなければ -1)。 */
const linkTarget = async (bytes: Uint8Array, i: number, j: number): Promise<number> => {
  const doc = await PDFLib.PDFDocument.load(bytes);
  const annots = doc.getPage(i).node.Annots();
  const dict = annots?.lookup(j, PDFLib.PDFDict);
  if (!dict) return -2;
  let dest = dict.lookup(PDFLib.PDFName.of('Dest'));
  const act = dict.lookup(PDFLib.PDFName.of('A'));
  if (!dest && act instanceof PDFLib.PDFDict) dest = act.lookup(PDFLib.PDFName.of('D'));
  if (!(dest instanceof PDFLib.PDFArray)) return -1;
  const ref = dest.get(0);
  return doc.getPages().findIndex((p) => String(p.ref) === String(ref));
};

const annotCount = async (bytes: Uint8Array, i: number): Promise<number> => {
  const doc = await PDFLib.PDFDocument.load(bytes);
  return doc.getPage(i).node.Annots()?.size() ?? 0;
};

describe('🔴 外したページへのリンクから、外したページが孤立して残らない', () => {
  it('3 ページ目を外す: 1 ページ目のリンク(/Dest・/A GoTo・名前・文字列)が 3 ページ目を指していても、字が残らない ── 対照群では残る', async () => {
    const src = await linked();
    // 対照群: 素の copyPages(切り落としなし)。この読み取りが「残っている」を見られることの証明
    const loaded = await PDFLib.PDFDocument.load(src);
    const naive = await PDFLib.PDFDocument.create();
    for (const pg of await naive.copyPages(loaded, [0, 1])) naive.addPage(pg);
    expect(hasMark(await naive.save(), C), '対照群が C を見つけられない(再現できていない)').toBe(true);
    // 本物
    const out = await core.build(PDFLib, src, { order: [1, 2], rotate: {} });
    expect(hasMark(out, A)).toBe(true);
    expect(hasMark(out, B)).toBe(true);
    expect(hasMark(out, C), '外したページへのリンク経由で、外したページの字が残っている').toBe(false);
    expect((await PDFLib.PDFDocument.load(out)).getPageCount()).toBe(2);
    // 残すページへのリンク 1 つだけが残る(外すページへの 4 つは落とした)
    expect(await annotCount(out, 0)).toBe(1);
    // 残したリンクは、孤立した複製ではなく**出力の 2 ページ目**を指す(出力の Page 辞書は 2 つちょうど = 孤立が無い)
    expect(await linkTarget(out, 0, 0)).toBe(1);
  });

  it('何も外さなければ、リンクは 5 つとも残る(切り落とすのは外すページへの物だけ)', async () => {
    const out = await core.build(PDFLib, await linked(), { order: [1, 2, 3], rotate: {} });
    expect(await annotCount(out, 0)).toBe(5);
    expect(hasMark(out, C)).toBe(true);
    // 5 つとも、出力の正しいページ(3 つ目は 2 ページ目 / 他は 3 ページ目)を指す ── 名前・文字列の行き先は配列に直っている
    expect(await Promise.all([0, 1, 2, 3, 4].map((j) => linkTarget(out, 0, j)))).toEqual([2, 2, 1, 2, 2]);
  });

  it('🔴 最後の門: 注釈以外の道(ページ辞書の独自の項目)で外したページへ繋がっていたら、渡さずに leaked で断る', async () => {
    const src = await linked((p1, p3) => p1.node.set(PDFLib.PDFName.of('Foo'), p3.ref));
    let code: string | undefined;
    try {
      await core.build(PDFLib, src, { order: [1, 2], rotate: {} });
    } catch (e) {
      code = (e as { pkcCode?: string }).pkcCode;
    }
    expect(code).toBe('leaked');
    // ⚠ 何も外さなくても、この形は pdf-lib が行き先のページを孤立した複製として写すので断る(安全側。ページ辞書に
    //   別のページへの参照を持つ PDF はまれ ── 保存できないときは理由を言う)
  });
});

/** 他のアプリが付ける注釈: 3 ページとも、`/P`(属するページ)つき。ページごとに**別の目印**を `Contents` に持つ。 */
const NOTE = (m: string): string => `NOTE-${m}`;
async function annotated(kind: 'Highlight' | 'Text' | 'Link' | 'Square' = 'Highlight'): Promise<Uint8Array> {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const ctx = doc.context;
  [A, B, C].forEach((m) => {
    const p = doc.addPage([300, 400]);
    p.drawText(m, { x: 20, y: 200, size: 18, font });
    const base: Record<string, unknown> = {
      Type: 'Annot',
      Subtype: kind,
      Rect: [20, 195, 120, 220],
      Contents: PDFLib.PDFString.of(NOTE(m)),
      P: p.ref,
    };
    if (kind === 'Highlight') base.QuadPoints = [20, 220, 120, 220, 20, 195, 120, 195];
    if (kind === 'Link') base.A = { S: 'URI', URI: PDFLib.PDFString.of('https://example.com/') };
    const annot = ctx.obj(base as never) as unknown as PDFLib.PDFDict;
    const ref = ctx.register(annot);
    const list: PDFLib.PDFRef[] = [ref];
    if (kind === 'Text') {
      // /Popup を持つ形(ポップアップ側も /P を持つ)
      const popup = ctx.register(
        ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [130, 195, 250, 260], Parent: ref, P: p.ref }),
      );
      annot.set(PDFLib.PDFName.of('Popup'), popup);
      list.push(popup);
    }
    p.node.set(PDFLib.PDFName.of('Annots'), ctx.obj(list));
  });
  return doc.save();
}

/** 出力の `i` ページ目の注釈それぞれの `/P` が指す出力のページ番号(`/P` が無ければ -1、どのページでもなければ -2)。 */
async function annotOwners(bytes: Uint8Array, i: number): Promise<number[]> {
  const doc = await PDFLib.PDFDocument.load(bytes);
  const annots = doc.getPage(i).node.Annots();
  const out: number[] = [];
  for (let j = 0; j < (annots?.size() ?? 0); j += 1) {
    const d = annots?.lookup(j, PDFLib.PDFDict);
    const ref = d?.get(PDFLib.PDFName.of('P'));
    out.push(ref === undefined ? -1 : doc.getPages().findIndex((pg) => String(pg.ref) === String(ref)));
  }
  return out;
}

describe('🔴 他のアプリが付けた注釈(`/P` つき)のある PDF も、ページを編集して保存できる(#275 段②-2a)', () => {
  it('対照群: 元の PDF には注釈が在り、素の copyPages は `/P` から外したページをもう 1 枚写す(再現できている)', async () => {
    const src = await annotated();
    expect(hasMark(src, NOTE(B))).toBe(true);
    const loaded = await PDFLib.PDFDocument.load(src);
    const naive = await PDFLib.PDFDocument.create();
    for (const pg of await naive.copyPages(loaded, [0])) naive.addPage(pg);
    // 1 ページしか頼んでいないのに、Page 辞書が 2 つ以上 ── 外すページ(の複製)が混ざる
    const reread = await PDFLib.PDFDocument.load(await naive.save());
    let dicts = 0;
    reread.context.enumerateIndirectObjects().forEach(([, o]) => {
      if (o instanceof PDFLib.PDFDict && o.get(PDFLib.PDFName.of('Type')) === PDFLib.PDFName.of('Page')) dicts += 1;
    });
    expect(dicts, '素の copyPages が `/P` からページを増やしていない').toBeGreaterThan(1);
  });

  for (const kind of ['Highlight', 'Text', 'Link', 'Square'] as const) {
    it(`${kind}: 並べ替え ── 断られず、注釈が全ページに残り、出力のページを指す`, async () => {
      const src = await annotated(kind);
      const out = await core.build(PDFLib, src, { order: [3, 1, 2], rotate: {} });
      await core.verify(PDFLib, out, 3);
      // 出力の i ページ目は元の [3,1,2][i] ページ目 ── 注釈の目印がページの字と一緒に動いている
      const marks = [C, A, B];
      for (let i = 0; i < 3; i += 1) {
        expect(showsMark(await pageText(out, i), marks[i] as string)).toBe(true);
        const doc = await PDFLib.PDFDocument.load(out);
        const first = doc.getPage(i).node.Annots()?.lookup(0, PDFLib.PDFDict);
        const text = (first?.lookup(PDFLib.PDFName.of('Contents')) as PDFLib.PDFString | undefined)?.decodeText();
        expect(text, `${i + 1} ページ目の注釈`).toBe(NOTE(marks[i] as string));
        expect((await annotOwners(out, i))[0], '`/P` は自分のページを指す').toBe(i);
      }
      if (kind === 'Text') {
        // /Popup 側の `/P` も自分のページ
        const doc = await PDFLib.PDFDocument.load(out);
        const popup = doc.getPage(0).node.Annots()?.lookup(0, PDFLib.PDFDict)?.lookup(PDFLib.PDFName.of('Popup'), PDFLib.PDFDict);
        expect(String(popup?.get(PDFLib.PDFName.of('P')))).toBe(String(doc.getPage(0).ref));
      }
    });

    it(`${kind}: 外す / 抜き出す ── 断られず、外したページの注釈と字は出力に 0 件、残したページの注釈は残る`, async () => {
      const src = await annotated(kind);
      for (const order of [[1, 3], [2]]) {
        const out = await core.build(PDFLib, src, { order, rotate: {} });
        await core.verify(PDFLib, out, order.length);
        const kept = order.map((n) => [A, B, C][n - 1] as string);
        const gone = [A, B, C].filter((m) => !kept.includes(m));
        for (const m of kept) {
          expect(hasMark(out, m), m).toBe(true);
          expect(hasMark(out, NOTE(m)), NOTE(m)).toBe(true);
        }
        for (const m of gone) {
          expect(hasMark(out, m), `外した ${m} の字`).toBe(false);
          expect(hasMark(out, NOTE(m)), `外した ${m} の注釈`).toBe(false);
        }
        for (let i = 0; i < order.length; i += 1) expect((await annotOwners(out, i))[0]).toBe(i);
        expect((await PDFLib.PDFDocument.load(out)).getPageCount()).toBe(order.length);
      }
    });
  }

  it('Text: どの出力ページでも、親と /Popup の両方の `/P` がその出力ページを指す(並べ替え / 外す / 抜き出し)', async () => {
    const src = await annotated('Text');
    for (const order of [[3, 1, 2], [1, 3], [2]]) {
      const out = await core.build(PDFLib, src, { order, rotate: {} });
      const doc = await PDFLib.PDFDocument.load(out);
      expect(doc.getPageCount()).toBe(order.length);
      for (let i = 0; i < order.length; i += 1) {
        const page = doc.getPage(i);
        const annots = page.node.Annots();
        expect(annots?.size(), `${order} の ${i + 1} ページ目: 親 + popup`).toBe(2);
        const parent = annots?.lookup(0, PDFLib.PDFDict);
        const popup = parent?.lookup(PDFLib.PDFName.of('Popup'), PDFLib.PDFDict);
        expect(String(parent?.get(PDFLib.PDFName.of('P'))), `${order} 親 ${i}`).toBe(String(page.ref));
        expect(String(popup?.get(PDFLib.PDFName.of('P'))), `${order} popup ${i}`).toBe(String(page.ref));
      }
    }
  });

  it('前の注釈(外すページへのリンク)が落とされて位置がずれても、残った注釈の `/P` は出力の自ページを指す', async () => {
    const doc = await PDFLib.PDFDocument.create();
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const pages = [A, B, C].map((m) => {
      const pg = doc.addPage([300, 400]);
      pg.drawText(m, { x: 20, y: 200, size: 18, font });
      return pg;
    });
    const [p1, , p3] = pages as [PDFLib.PDFPage, PDFLib.PDFPage, PDFLib.PDFPage];
    const ctx = doc.context;
    const dropLink = ctx.register(
      ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 100, 30], Dest: [p3.ref, 'Fit'] }),
    );
    const hl = ctx.register(
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Highlight',
        Rect: [20, 195, 120, 220],
        QuadPoints: [20, 220, 120, 220, 20, 195, 120, 195],
        Contents: PDFLib.PDFString.of(NOTE(A)),
        P: p1.ref,
      }),
    );
    p1.node.set(PDFLib.PDFName.of('Annots'), ctx.obj([dropLink, hl]));
    const out = await core.build(PDFLib, await doc.save(), { order: [1, 2], rotate: {} });
    expect(await annotCount(out, 0), 'リンクは落ち、ハイライトだけが残る').toBe(1);
    expect(hasMark(out, NOTE(A))).toBe(true);
    expect(await annotOwners(out, 0)).toEqual([0]);
    expect(hasMark(out, C), '外したページの字').toBe(false);
  });

  it('門は緩んでいない: `/P` の無い注釈でも、`/P` を残したまま別のページを指す独自の項目(/Foo)は leaked で断る', async () => {
    const src = await annotated('Highlight');
    const doc = await PDFLib.PDFDocument.load(src);
    const page3 = doc.getPage(2);
    doc.getPage(0).node.Annots()?.lookup(0, PDFLib.PDFDict)?.set(PDFLib.PDFName.of('Foo'), page3.ref);
    let code: string | undefined;
    try {
      await core.build(PDFLib, await doc.save(), { order: [1, 2], rotate: {} });
    } catch (e) {
      code = (e as { pkcCode?: string }).pkcCode;
    }
    expect(code).toBe('leaked');
  });
});

describe('🔴 選んだページを抜き出す(#275 段②-1c)── 選んだページだけが入り、選ばなかったページの中身は残らない', () => {
  const D = 'MARK-DELTA-444';
  const E = 'MARK-ECHO-555';

  it('5 ページから 4 と 2 を(その順で・4 は回して)選ぶ: 出力は 2 ページで、選ばなかった 3 つの字は全 stream に無い。対照群で「ある」が見える', async () => {
    const src = await sample([A, B, C, D, E]);
    for (const m of [A, B, C, D, E]) expect(hasMark(src, m), `対照群: 元には ${m} が見える`).toBe(true);
    const out = await core.build(PDFLib, src, { order: [4, 2], rotate: { 4: 90 } });
    const doc = await PDFLib.PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(2);
    expect(showsMark(await pageText(out, 0), D)).toBe(true);
    expect(showsMark(await pageText(out, 1), B)).toBe(true);
    expect(doc.getPage(0).getRotation().angle).toBe(90);
    expect(doc.getPage(1).getRotation().angle).toBe(0);
    for (const m of [A, C, E]) expect(hasMark(out, m), `選ばなかったページの字 ${m} が残っている`).toBe(false);
  });

  it('1 ページだけ選んでも作れる(1 ページの PDF)/ 0 ページは作らない(bad-job)', async () => {
    const src = await sample([A, B, C]);
    const out = await core.build(PDFLib, src, { order: [2], rotate: {} });
    expect((await PDFLib.PDFDocument.load(out)).getPageCount()).toBe(1);
    expect(hasMark(out, B)).toBe(true);
    expect(hasMark(out, A) || hasMark(out, C)).toBe(false);
    let code: string | undefined;
    try {
      await core.build(PDFLib, src, { order: [], rotate: {} });
    } catch (e) {
      code = (e as { pkcCode?: string }).pkcCode;
    }
    expect(code).toBe('bad-job');
  });

  it('🔴 選ばなかったページが別の道(ページ辞書の独自の項目)で選んだページから辿れるなら、渡さずに leaked で断る', async () => {
    const src = await linked((p1, p3) => p1.node.set(PDFLib.PDFName.of('Foo'), p3.ref));
    let code: string | undefined;
    let out: Uint8Array | undefined;
    try {
      out = await core.build(PDFLib, src, { order: [1], rotate: {} });
    } catch (e) {
      code = (e as { pkcCode?: string }).pkcCode;
    }
    expect(out, '選ばなかったページを孤立して含んだまま渡した').toBeUndefined();
    expect(code).toBe('leaked');
  });
});

describe('🔴 共有された Resources から、選ばなかったページの部品が出力に残らない', () => {
  const SECRET_FORM = 'SECRET-XOBJ-999';
  const SECRET_IMG = 'SECRET-IMG-777';
  const KEEP_FORM = 'KEEP-FORM-111';
  const INNER = 'INNER-FORM-222';

  /** 2 ページが**同じ Resources を共有**する。XObject: Secret(Form)/ Pic(画像)/ Keep(Form)。1 ページ目は Keep と Nest を使い、Nest の中で Inner を使う。 */
  async function shared(): Promise<Uint8Array> {
    const d = await PDFLib.PDFDocument.create();
    const font = await d.embedFont(PDFLib.StandardFonts.Helvetica);
    const p1 = d.addPage();
    const p2 = d.addPage();
    const ctx = d.context;
    const form = (text: string, extra: Record<string, unknown> = {}): PDFLib.PDFRef =>
      ctx.register(
        ctx.stream(`BT /F1 12 Tf 10 10 Td (${text}) Tj ET`, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 50], ...extra }),
      );
    const inner = form(INNER);
    const nest = ctx.register(
      ctx.stream('/Inner Do', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 200, 50],
        Resources: { XObject: { Inner: inner } },
      }),
    );
    const secret = form(SECRET_FORM);
    const keep = form(KEEP_FORM);
    const pic = ctx.register(
      ctx.stream(Buffer.from(SECRET_IMG, 'latin1'), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 8,
        Height: 2,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
      }),
    );
    const res = p1.node.Resources() as PDFLib.PDFDict;
    res.set(PDFLib.PDFName.of('XObject'), ctx.obj({ Secret: secret, Pic: pic, Keep: keep, Nest: nest }));
    p2.node.set(PDFLib.PDFName.of('Resources'), res); // 共有
    p1.drawText('PAGE-ONE', { font });
    p2.drawText('PAGE-TWO', { font });
    // 1 ページ目の content の最後に、使う XObject を足す(ページ 2 は Secret と Pic を使う)
    const add = (page: PDFLib.PDFPage, ops: string): void => {
      page.node.addContentStream(ctx.register(ctx.stream(ops)));
    };
    add(p1, '/Keep Do /Nest Do');
    add(p2, '/Secret Do /Pic Do');
    return d.save({ useObjectStreams: false });
  }

  it('2 ページ目だけが使う Form と画像は、1 ページ目だけ抜き出した出力に無い。対照群: 元には見え、1 ページ目が使う物は残る(入れ子の Form の中身も)', async () => {
    const src = await shared();
    for (const m of [SECRET_FORM, SECRET_IMG, KEEP_FORM, INNER]) expect(hasMark(src, m), `対照群: 元には ${m} が見える`).toBe(true);
    const out = await core.build(PDFLib, src, { order: [1], rotate: {} });
    expect(hasMark(out, SECRET_FORM), '選ばなかったページだけが使う Form が残っている').toBe(false);
    expect(Buffer.from(out).toString('latin1').includes(SECRET_IMG), '選ばなかったページだけが使う画像が残っている').toBe(false);
    expect(hasMark(out, KEEP_FORM), '選んだページが使う Form まで落とした').toBe(true);
    expect(hasMark(out, INNER), '選んだページが使う Form の中で使う Form まで落とした').toBe(true);
    expect(hasMark(out, 'PAGE-ONE') || showsMark(await pageText(out, 0), 'PAGE-ONE')).toBe(true);
    // 残した名前は、出力のページの Resources から実際に引ける
    const doc = await PDFLib.PDFDocument.load(out);
    const xo = (doc.getPage(0).node.Resources() as PDFLib.PDFDict).lookup(PDFLib.PDFName.of('XObject')) as PDFLib.PDFDict;
    expect(xo.entries().map(([k]) => k.decodeText()).sort()).toEqual(['Keep', 'Nest']);
  });

  it('2 ページ目を選んだときは、2 ページ目が使う物(Secret・Pic)が残り、1 ページ目だけが使う物は残らない', async () => {
    const src = await shared();
    const out = await core.build(PDFLib, src, { order: [2], rotate: {} });
    expect(hasMark(out, SECRET_FORM)).toBe(true);
    expect(Buffer.from(out).toString('latin1').includes(SECRET_IMG)).toBe(true);
    expect(hasMark(out, KEEP_FORM)).toBe(false);
    expect(hasMark(out, INNER)).toBe(false);
  });

  it('🔴 content が読めない(未対応の圧縮)なら、刈らずに leaked で断る', async () => {
    const src = await shared();
    const doc = await PDFLib.PDFDocument.load(src);
    const c = doc.getPage(0).node.Contents() as PDFLib.PDFArray;
    const first = doc.context.lookup(c.get(0)) as PDFLib.PDFRawStream;
    first.dict.set(PDFLib.PDFName.of('Filter'), PDFLib.PDFName.of('CCITTFaxDecode'));
    const bad = await doc.save({ useObjectStreams: false });
    let code: string | undefined;
    try {
      await core.build(PDFLib, bad, { order: [1], rotate: {} });
    } catch (e) {
      code = (e as { pkcCode?: string }).pkcCode;
    }
    expect(code).toBe('leaked');
  });

  it('🔴 門(verify): 文書の入口から辿れない間接オブジェクトが残っていたら leaked で断る / 無ければ通る(対照群)', async () => {
    const d = await PDFLib.PDFDocument.create();
    d.addPage();
    const clean = await d.save({ useObjectStreams: false });
    await expect(core.verify(PDFLib, clean, 1)).resolves.toBeUndefined();
    d.context.register(d.context.stream('ORPHAN-OBJ-555'));
    const dirty = await d.save({ useObjectStreams: false });
    expect(hasMark(dirty, 'ORPHAN-OBJ-555'), '対照群: 孤立した物が file に在る').toBe(true);
    let code: string | undefined;
    try {
      await core.verify(PDFLib, dirty, 1);
    } catch (e) {
      code = (e as { pkcCode?: string }).pkcCode;
    }
    expect(code).toBe('leaked');
  });
});

describe('出力のページの並びと向き', () => {
  it('order どおりの並び / 回したページだけ向きが変わる', async () => {
    const src = await sample([A, B, C]);
    const out = await core.build(PDFLib, src, { order: [3, 1, 2], rotate: { 3: 90, 2: 270 } });
    const doc = await PDFLib.PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(3);
    expect(showsMark(await pageText(out, 0), C)).toBe(true);
    expect(showsMark(await pageText(out, 1), A)).toBe(true);
    expect(showsMark(await pageText(out, 2), B)).toBe(true);
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([90, 0, 270]);
  });

  it('🔴 元から向きがあるページは足し算(90 のページを右へ 90 → 180、270 に 180 → 90)', async () => {
    const src = await sample([A, B, C], [90, 0, 270]);
    const out = await core.build(PDFLib, src, { order: [1, 2, 3], rotate: { 1: 90, 3: 180 } });
    const doc = await PDFLib.PDFDocument.load(out);
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([180, 0, 90]);
  });

  it('ページの大きさは写る(ページごとに違う大きさが、並べ替えに付いてくる)', async () => {
    const src = await sample([A, B, C]); // 幅 300 / 310 / 320
    const out = await core.build(PDFLib, src, { order: [3, 1], rotate: {} });
    const doc = await PDFLib.PDFDocument.load(out);
    expect(doc.getPages().map((p) => p.getWidth())).toEqual([320, 300]);
  });

  it('題名・作者は引き継ぐ(B の道は文書の情報を持たないので写し直している)', async () => {
    const src = await sample([A, B]);
    const doc = await PDFLib.PDFDocument.load(await core.build(PDFLib, src, { order: [2], rotate: {} }));
    expect(doc.getTitle()).toBe('元の題名');
    expect(doc.getAuthor()).toBe('元の作者');
  });
});

// ───────── 別の PDF を後ろに足す(#275 結合)── 複数の文書から、残すページだけを 1 つの新しい文書へ

const X1 = 'MARK-XRAY-901';
const X2 = 'MARK-YANKEE-902';
const X3 = 'MARK-ZULU-903';

describe('🔴 複数の文書を 1 つの出力へ(通し番号: 元の PDF が 1〜N、足した PDF がその次から)', () => {
  const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
      await p;
    } catch (e) {
      return (e as { pkcCode?: string }).pkcCode;
    }
    return undefined;
  };

  it('ページ数は N+M / 並びは order のとおり(元と足した PDF を混ぜられる)/ 各ページの字がその位置に在る', async () => {
    const main = await sample([A, B, C]);
    const extra = await sample([X1, X2]);
    const out = await core.build(PDFLib, main, { order: [1, 2, 3, 4, 5], rotate: {}, sources: [{ first: 4, count: 2 }] }, [extra]);
    const doc = await PDFLib.PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(5);
    const want = [A, B, C, X1, X2];
    for (let i = 0; i < want.length; i += 1) expect(showsMark(await pageText(out, i), want[i] as string), `${String(i + 1)} ページ目`).toBe(true);
    // 混ぜて並べ替える(足したページを先頭へ、元のページの間へ)
    const mixed = await core.build(PDFLib, main, { order: [5, 1, 4, 3], rotate: {}, sources: [{ first: 4, count: 2 }] }, [extra]);
    const got = await PDFLib.PDFDocument.load(mixed);
    expect(got.getPageCount()).toBe(4);
    const want2 = [X2, A, X1, C];
    for (let i = 0; i < want2.length; i += 1) expect(showsMark(await pageText(mixed, i), want2[i] as string), `混ぜた ${String(i + 1)} ページ目`).toBe(true);
    // ページの大きさも付いてくる(元: 300/310/320 ── 足した: 300/310)
    expect(got.getPages().map((p) => p.getWidth())).toEqual([310, 300, 300, 320]);
  });

  it('向きが保たれる: 足したページを回すと足し算 / 足した PDF 元の向き(90)にも足し算 / 元のページの回しは元のまま', async () => {
    const main = await sample([A, B], [0, 270]);
    const extra = await sample([X1, X2], [90, 0]);
    const out = await core.build(
      PDFLib,
      main,
      { order: [1, 2, 3, 4], rotate: { 2: 90, 3: 90, 4: 180 }, sources: [{ first: 3, count: 2 }] },
      [extra],
    );
    const doc = await PDFLib.PDFDocument.load(out);
    // 元 [0, 270+90=0] / 足した [90+90=180, 0+180=180]
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([0, 0, 180, 180]);
  });

  it('🔴 外したページの中身は、元の PDF からも足した PDF からも出力に入らない ── 対照群で「ある」が見える', async () => {
    const main = await sample([A, B, C]);
    const extra = await sample([X1, X2, X3]);
    // 対照群: 全部残せば 6 つとも見える(読み取りが空振りしていない)
    const all = await core.build(PDFLib, main, { order: [1, 2, 3, 4, 5, 6], rotate: {}, sources: [{ first: 4, count: 3 }] }, [extra]);
    for (const m of [A, B, C, X1, X2, X3]) expect(hasMark(all, m), `対照群で ${m} が見えない`).toBe(true);
    // 元の 2 ページ目と、足した PDF の 1・3 ページ目を外す
    const out = await core.build(PDFLib, main, { order: [1, 3, 5], rotate: {}, sources: [{ first: 4, count: 3 }] }, [extra]);
    expect((await PDFLib.PDFDocument.load(out)).getPageCount()).toBe(3);
    for (const m of [A, C, X2]) expect(hasMark(out, m), `${m} が無い`).toBe(true);
    for (const m of [B, X1, X3]) expect(hasMark(out, m), `外したページの字 ${m} が file に残っている`).toBe(false);
  });

  it('足した PDF のページを 1 枚も残さなければ、その PDF の中身は出力に入らない(sources にあっても)', async () => {
    const main = await sample([A, B]);
    const extra = await sample([X1, X2]);
    const out = await core.build(PDFLib, main, { order: [2, 1], rotate: {}, sources: [{ first: 3, count: 2 }] }, [extra]);
    expect(hasMark(out, X1) || hasMark(out, X2)).toBe(false);
    expect(hasMark(out, A) && hasMark(out, B)).toBe(true);
  });

  it('🔴 オブジェクト番号が衝突する 2 つの文書でも混ざらない: 2 つとも同じ番号のページ・フォント・内容を持つ', async () => {
    const main = await sample([A, B]);
    const extra = await sample([X1, X2]);
    const m = await PDFLib.PDFDocument.load(main);
    const e = await PDFLib.PDFDocument.load(extra);
    // 前提: 同じ番号の Page 辞書が両方に在り、その中身(字)は違う ── 衝突していることを test 自身が確かめる
    const pageRefs = (d: PDFLib.PDFDocument): string[] => d.getPages().map((p) => String(p.ref));
    expect(pageRefs(m), '前提: 2 つの文書のページ辞書の番号が重なっていない').toEqual(pageRefs(e));
    const out = await core.build(PDFLib, main, { order: [3, 1, 4, 2], rotate: {}, sources: [{ first: 3, count: 2 }] }, [extra]);
    const doc = await PDFLib.PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(4);
    // 出力のページ辞書は 4 枚とも別の参照で、字は取り違えていない
    expect(new Set(doc.getPages().map((p) => String(p.ref))).size).toBe(4);
    const want = [X1, A, X2, B];
    for (let i = 0; i < want.length; i += 1) {
      const t = await pageText(out, i);
      expect(showsMark(t, want[i] as string), `${String(i + 1)} ページ目の字`).toBe(true);
      for (const other of [A, B, X1, X2].filter((x) => x !== want[i])) expect(showsMark(t, other), `${String(i + 1)} ページ目に ${other} が混ざった`).toBe(false);
    }
  });

  it('足した PDF のリンクが、足した PDF の外したページを指していても、そのページは出力に残らない(元の PDF と同じ道)', async () => {
    const main = await sample(['MAIN-ONE-001', 'MAIN-TWO-002']);
    const extra = await linked(); // 1 ページ目が 2・3 ページ目へのリンクを持つ(字は A・B・C)
    // 足した PDF の 3 ページ目(C)を外す
    const out = await core.build(PDFLib, main, { order: [1, 3, 4, 2], rotate: {}, sources: [{ first: 3, count: 3 }] }, [extra]);
    expect((await PDFLib.PDFDocument.load(out)).getPageCount()).toBe(4);
    expect(hasMark(out, A)).toBe(true);
    expect(hasMark(out, B)).toBe(true);
    expect(hasMark(out, C), '足した PDF の外したページの字が残っている').toBe(false);
    // 対照群: 3 ページとも残せば C が見える
    const kept = await core.build(PDFLib, main, { order: [1, 3, 4, 5], rotate: {}, sources: [{ first: 3, count: 3 }] }, [extra]);
    expect(hasMark(kept, C)).toBe(true);
  });

  it('🔴 最後の門は足した PDF にも掛かる: 足した PDF の独自の項目が外したページへ繋がっていたら leaked で断る', async () => {
    const main = await sample([A]);
    const extra = await linked((p1, p3) => p1.node.set(PDFLib.PDFName.of('Foo'), p3.ref));
    const job = { order: [1, 2, 3], rotate: {}, sources: [{ first: 2, count: 3 }] }; // 足した PDF の 1・2 ページ目だけ残す(3 を外す)
    expect(await codeOf(core.build(PDFLib, main, job, [extra]))).toBe('leaked');
  });

  it('不正な依頼は bad-job: 足した範囲が元の次から始まらない / 重なる / 空 / extras の数が違う / ページ数が違う / 範囲の外 / 足したページへのハイライト', async () => {
    const main = await sample([A, B]);
    const extra = await sample([X1, X2]);
    const ok = { order: [1, 3], rotate: {}, sources: [{ first: 3, count: 2 }] };
    expect((await PDFLib.PDFDocument.load(await core.build(PDFLib, main, ok, [extra]))).getPageCount()).toBe(2);
    const cases: Array<[string, unknown, Uint8Array[]]> = [
      ['範囲が元の次から始まらない(間が空く)', { ...ok, order: [1, 4], sources: [{ first: 4, count: 2 }] }, [extra]],
      ['範囲が元のページに重なる', { ...ok, sources: [{ first: 2, count: 2 }] }, [extra]],
      ['範囲が重なる', { ...ok, sources: [{ first: 3, count: 2 }, { first: 4, count: 1 }] }, [extra, extra]],
      ['count が 0', { ...ok, sources: [{ first: 3, count: 0 }] }, [extra]],
      ['extras が足りない', ok, []],
      ['extras が多い', ok, [extra, extra]],
      ['実際のページ数と count が違う', { ...ok, sources: [{ first: 3, count: 3 }] }, [extra]],
      ['order が範囲の外', { ...ok, order: [1, 5] }, [extra]],
      ['足したページへのハイライト', { ...ok, highlights: [{ page: 3, rgb: [1, 1, 0], quads: [[0, 10, 10, 10, 0, 0, 10, 0]] }] }, [extra]],
      ['足したページのハイライトを外す', { ...ok, removals: [{ page: 3, id: '14R' }] }, [extra]],
    ];
    for (const [why, job, extras] of cases) expect(await codeOf(core.build(PDFLib, main, job, extras)), why).toBe('bad-job');
  });

  it('足した PDF が暗号化 / 読めないときは種類つきで断る(元の PDF と同じ)', async () => {
    const main = await sample([A]);
    const enc = await PDFLib.PDFDocument.create();
    enc.addPage();
    enc.context.trailerInfo.Encrypt = enc.context.register(enc.context.obj({ Filter: 'Standard' }));
    const job = { order: [1, 2], rotate: {}, sources: [{ first: 2, count: 1 }] };
    expect(await codeOf(core.build(PDFLib, main, job, [await enc.save()]))).toBe('encrypted');
    expect(await codeOf(core.build(PDFLib, main, job, [new TextEncoder().encode('x')]))).toBe('unreadable');
  });

  it('checkJob: sources が無い依頼は今までどおり / 足したページは order に入れられる', () => {
    expect(core.checkJob({ order: [1, 2], rotate: {} }, 2).sources).toEqual([]);
    expect(core.checkJob({ order: [3, 1], rotate: { 3: 90 }, sources: [{ first: 3, count: 1 }] }, 2).sources).toEqual([{ first: 3, count: 1 }]);
    expect(() => core.checkJob({ order: [3], rotate: {} }, 2)).toThrow();
  });

  it('worker(edit-worker.js)── extras を受けて、足した PDF を含む出力を返す', async () => {
    const w = bootWorker();
    const main = await sample([A, B]);
    const extra = await sample([X1, X2]);
    const cut = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
    const r = await w.send({
      id: 9,
      op: 'build',
      bytes: cut(main),
      extras: [cut(extra)],
      job: { order: [1, 4], rotate: { 4: 90 }, sources: [{ first: 3, count: 2 }] },
    });
    expect(r.ok).toBe(true);
    const out = new Uint8Array(r.bytes as ArrayBuffer);
    const doc = await PDFLib.PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([0, 90]);
    expect(hasMark(out, X2) && hasMark(out, A)).toBe(true);
    expect(hasMark(out, B) || hasMark(out, X1)).toBe(false);
    // extras を付けずに sources を言う依頼は断る(bad-job)
    expect(
      await w.send({ id: 10, op: 'build', bytes: cut(main), job: { order: [1, 3], rotate: {}, sources: [{ first: 3, count: 2 }] } }),
    ).toMatchObject({ ok: false, code: 'bad-job' });
  });
});

describe('断る ── 種類つきで投げる(窓が user の言葉にする)', () => {
  const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
      await p;
    } catch (e) {
      return (e as { pkcCode?: string }).pkcCode;
    }
    return undefined;
  };

  it('パスワード付き(暗号化)の PDF は encrypted', async () => {
    const doc = await PDFLib.PDFDocument.create();
    doc.addPage();
    // 暗号化の宣言(trailer の /Encrypt)だけを足す ── pdf-lib は読み込みの前に断る
    doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard' }));
    const bytes = await doc.save();
    expect(await codeOf(core.check(PDFLib, bytes))).toBe('encrypted');
    expect(await codeOf(core.build(PDFLib, bytes, { order: [1], rotate: {} }))).toBe('encrypted');
  });

  it('PDF でない / 空は unreadable(暗号化と取り違えない)', async () => {
    expect(await codeOf(core.check(PDFLib, new TextEncoder().encode('これは PDF ではありません')))).toBe('unreadable');
    expect(await codeOf(core.check(PDFLib, new Uint8Array(0)))).toBe('unreadable');
  });

  it('不正な依頼は bad-job ── 空の order / 範囲の外 / 重複 / 非整数 / order に無いページの回転 / 90 の倍数でない角度', async () => {
    const src = await sample([A, B, C]);
    const bad: unknown[] = [
      { order: [], rotate: {} },
      { order: [4], rotate: {} },
      { order: [0], rotate: {} },
      { order: [1, 1], rotate: {} },
      { order: [1.5], rotate: {} },
      { order: [1], rotate: { 2: 90 } },
      { order: [1], rotate: { 1: 45 } },
      { rotate: {} },
      null,
    ];
    for (const job of bad) {
      expect(await codeOf(core.build(PDFLib, src, job)), JSON.stringify(job)).toBe('bad-job');
    }
  });

  it('回転は 360 で割った余りに揃う(-90 は 270 / 450 は 90)', () => {
    expect(core.checkJob({ order: [1, 2], rotate: { 1: -90, 2: 450 } }, 2).rotate).toEqual({ 1: 270, 2: 90 });
  });
});

// ───────── worker の原文(edit-worker.js)を、本物と同じ読み込み順で動かす

interface WorkerReply {
  id: number;
  ok: boolean;
  pages?: number;
  bytes?: ArrayBuffer;
  code?: string;
}

/** `importScripts` を差した vm の中で worker の原文を走らせる。 */
function bootWorker(): { send(msg: object): Promise<WorkerReply>; loaded: string[] } {
  const loaded: string[] = [];
  const replies: WorkerReply[] = [];
  const sandbox: Record<string, unknown> = {};
  sandbox['self'] = sandbox;
  sandbox['postMessage'] = (m: WorkerReply) => replies.push(m);
  const ctx = vm.createContext(sandbox);
  sandbox['importScripts'] = (...paths: string[]) => {
    for (const p of paths) {
      loaded.push(p);
      // 窓の `pdf/lib/pdf-lib.min.js` は build が node_modules から写す物 ── ここでは同じ実体を読む
      const file = p === './lib/pdf-lib.min.js' ? 'node_modules/pdf-lib/dist/pdf-lib.min.js' : `public/pdf/${p.replace('./', '')}`;
      vm.runInContext(readFileSync(file, 'utf-8'), ctx, { filename: file });
    }
  };
  vm.runInContext(readFileSync('public/pdf/edit-worker.js', 'utf-8'), ctx, { filename: 'edit-worker.js' });
  expect(typeof sandbox['onmessage'], 'worker が onmessage を置いていない(空振り)').toBe('function');
  return {
    loaded,
    send: async (msg) => {
      const before = replies.length;
      // 🔴 依頼は **vm の中で作る**。本物の worker は構造化複製で自分の realm の Array / Object を受け取る ──
      //    外の realm の配列をそのまま渡すと、pdf-lib の `instanceof Array` の検めが落ちる(test の人工物)
      const m = msg as { id: number; op: string; bytes: ArrayBuffer; job?: unknown; extras?: ArrayBuffer[] };
      sandbox['__extras'] = m.extras;
      sandbox['__id'] = m.id;
      sandbox['__op'] = m.op;
      sandbox['__bytes'] = m.bytes;
      sandbox['__job'] = JSON.stringify(m.job ?? null);
      await (vm.runInContext(
        'onmessage({ data: { id: __id, op: __op, bytes: __bytes, job: JSON.parse(__job), extras: __extras } })',
        ctx,
      ) as Promise<void>);
      expect(replies.length, '返事が 1 つも出ていない').toBe(before + 1);
      return replies[before] as WorkerReply;
    },
  };
}

describe('worker(edit-worker.js)', () => {
  it('起動時に edit-core.js と pdf-lib.min.js を読む / 作る依頼に新しい PDF の bytes を返す', async () => {
    const w = bootWorker();
    expect(w.loaded).toEqual(['./edit-core.js', './lib/pdf-lib.min.js']);
    const src = await sample([A, B, C]);
    const buf = src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength) as ArrayBuffer;
    const r = await w.send({ id: 7, op: 'build', bytes: buf, job: { order: [3, 1], rotate: { 3: 90 } } });
    expect(r.ok).toBe(true);
    expect(r.id).toBe(7);
    const out = new Uint8Array(r.bytes as ArrayBuffer);
    const doc = await PDFLib.PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([90, 0]);
    expect(hasMark(out, B), '外したページの字が worker の出力に残っている').toBe(false);
    expect(hasMark(out, C)).toBe(true);
  });

  it('check はページ数を返す / 暗号化・読めない・不正な依頼・知らない op は種類つきで断る', async () => {
    const w = bootWorker();
    const src = await sample([A, B]);
    const copy = (): ArrayBuffer => src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength) as ArrayBuffer;
    expect(await w.send({ id: 1, op: 'check', bytes: copy() })).toMatchObject({ ok: true, pages: 2 });
    const junk = new TextEncoder().encode('xx').buffer as ArrayBuffer;
    expect(await w.send({ id: 2, op: 'check', bytes: junk })).toMatchObject({ ok: false, code: 'unreadable' });
    expect(await w.send({ id: 3, op: 'build', bytes: copy(), job: { order: [], rotate: {} } })).toMatchObject({
      ok: false,
      code: 'bad-job',
    });
    expect(await w.send({ id: 4, op: 'zzz', bytes: copy() })).toMatchObject({ ok: false, code: 'bad-job' });
    const enc = await PDFLib.PDFDocument.create();
    enc.addPage();
    enc.context.trailerInfo.Encrypt = enc.context.register(enc.context.obj({ Filter: 'Standard' }));
    const eb = await enc.save();
    const r = await w.send({
      id: 5,
      op: 'check',
      bytes: eb.buffer.slice(eb.byteOffset, eb.byteOffset + eb.byteLength) as ArrayBuffer,
    });
    expect(r).toMatchObject({ ok: false, code: 'encrypted' });
  });
});
