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
  checkJob(job: unknown, pageCount: number): { order: number[]; rotate: Record<number, number> };
  build(lib: typeof PDFLib, bytes: Uint8Array, job: unknown): Promise<Uint8Array>;
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
      const m = msg as { id: number; op: string; bytes: ArrayBuffer; job?: unknown };
      sandbox['__id'] = m.id;
      sandbox['__op'] = m.op;
      sandbox['__bytes'] = m.bytes;
      sandbox['__job'] = JSON.stringify(m.job ?? null);
      await (vm.runInContext(
        'onmessage({ data: { id: __id, op: __op, bytes: __bytes, job: JSON.parse(__job) } })',
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
