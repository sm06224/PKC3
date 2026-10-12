/** @vitest-environment node */
/**
 * 付箋とペンの計画(`public/pdf/notes.js`)(#275)── 押した位置・なぞった線 → PDF の座標、付箋の並びの操作、保存の依頼。
 *
 * 🔴 守るもの:
 * 1. 画面の座標 → PDF の座標が、ページの向き(/Rotate 0・90・180・270)・倍率・箱の端数(floor した幅)に依らず本当の位置になる
 *    (pdf.js の本物の viewport で、期待値は PDF の座標から別に作る)。印の置き場所は PDF → 窓で元の場所へ戻る。
 * 2. 付箋の字: 前後の空白を除き、空は付けない / 直すと新しい uid(「保存した状態との違い」として数える)/ 外すと並びから消える。
 * 3. 線: 簡単にしても端は残り、曲がりは残る。押しただけ(1 点)は丸い点になる。線の上を押したかは太さの内側で決まる。
 * 4. 依頼 `toJob`: 外したページの物は渡さない / 色は表の 0〜1 / 外す付箋は `kind: 'note'`。
 * ⚠ 素の JS(classic script)の**原文を読んで**走らせる。
 */
import { readFileSync } from 'node:fs';
import * as PDFLib from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';

type Pt = [number, number];
interface Note {
  uid: number;
  page: number;
  rect: number[];
  text: string;
}
interface Stroke {
  uid: number;
  page: number;
  color: string;
  pts: number[][];
}
interface Nt {
  NOTE_SIZE: number;
  NOTE_MAX_CHARS: number;
  PEN_WIDTH: number;
  cleanText(s: unknown): string | null;
  clientToViewport(
    cx: number,
    cy: number,
    box: { left: number; top: number; width: number; height: number },
    vp: { width: number; height: number },
  ): number[];
  noteRect(x: number, y: number, toPdf: (x: number, y: number) => number[], size?: number): number[];
  viewportBox(
    rect: number[],
    toVp: (x: number, y: number) => number[],
    min?: number,
  ): { left: number; top: number; width: number; height: number };
  addNote(list: Note[], n: Note): Note[];
  editNote(list: Note[], uid: number, text: string, nextUid: number): Note[];
  removeNote(list: Note[], uid: number): Note[];
  sameUids(a: { uid: number }[], b: { uid: number }[]): boolean;
  diffCount(list: { uid: number }[], base: { uid: number }[]): { added: number; removed: number };
  simplify(points: number[][], tol?: number): number[][];
  strokeToPdf(points: number[][], toPdf: (x: number, y: number) => number[]): number[][];
  strokeHit(points: number[][], x: number, y: number, tol: number): boolean;
  toJob(
    notes: Note[],
    strokes: Stroke[],
    rgbOf: (id: string) => number[],
    order: number[],
  ): {
    notes: { page: number; rect: number[]; text: string }[];
    strokes: { page: number; rgb: number[]; width: number; paths: number[][] }[];
  };
  removalsJob(
    removals: Map<string, { page: number; id: string }>,
    order: number[],
  ): { page: number; id: string; kind: string }[];
  note(
    n: { added: number; removed: number },
    s: { added: number; removed: number },
    withSave: boolean,
  ): string;
}

function load(): Nt {
  const root: { PkcPdfNotes?: Nt } = {};
  new Function('self', readFileSync('public/pdf/notes.js', 'utf-8'))(root);
  expect(root.PkcPdfNotes, '原文が API を公開していない(空振り)').toBeDefined();
  return root.PkcPdfNotes as Nt;
}
const nt = load();

const note = (uid: number, page = 1, text = 'メモ'): Note => ({ uid, page, rect: [10, 10, 28, 28], text });

describe('付箋の字', () => {
  it('前後の空白(全角も)を除く。空・空白だけ・無いは付けない(null)。長すぎる分は切る', () => {
    expect(nt.cleanText('  買う物  ')).toBe('買う物');
    expect(nt.cleanText('　全角の空白　')).toBe('全角の空白');
    expect(nt.cleanText('')).toBeNull();
    expect(nt.cleanText('   ')).toBeNull();
    expect(nt.cleanText(undefined)).toBeNull();
    expect(nt.cleanText('あ'.repeat(nt.NOTE_MAX_CHARS + 50))?.length).toBe(nt.NOTE_MAX_CHARS);
  });
});

describe('付箋の並び(元の並びは変えない)', () => {
  it('付ける / 直す(新しい uid・場所は同じ)/ 外す', () => {
    const a = [note(1), note(2, 1, '二つ目')];
    const added = nt.addNote(a, note(3));
    expect(added.map((n) => n.uid)).toEqual([1, 2, 3]);
    expect(a.length, '元の並びは変わらない').toBe(2);
    const edited = nt.editNote(a, 2, '直した字', 9);
    expect(edited.map((n) => [n.uid, n.text])).toEqual([
      [1, 'メモ'],
      [9, '直した字'],
    ]);
    expect(edited[1]?.rect, '場所は動かない').toEqual(a[1]?.rect);
    expect(nt.removeNote(a, 1).map((n) => n.uid)).toEqual([2]);
    expect(nt.removeNote(a, 99).length, '無い uid を外しても何も起きない').toBe(2);
  });

  it('保存した状態との違い: 同じ並び=同じ / 付けた数・外した数 / 直すと「1 件外して 1 件付けた」になる', () => {
    const base = [note(1), note(2)];
    expect(nt.sameUids(base, [note(2), note(1)]), '順は問わない').toBe(true);
    expect(nt.sameUids(base, [note(1)])).toBe(false);
    expect(nt.sameUids(base, [note(1), note(3)]), '件数が同じでも uid が違えば違う').toBe(false);
    expect(nt.diffCount([note(1), note(2), note(3)], base)).toEqual({ added: 1, removed: 0 });
    expect(nt.diffCount([note(1)], base)).toEqual({ added: 0, removed: 1 });
    expect(nt.diffCount(nt.editNote(base, 2, '直した', 5), base)).toEqual({ added: 1, removed: 1 });
  });
});

describe('線', () => {
  it('簡単にしても両端は残り、まっすぐな途中の点だけ落ちる。曲がりの角は残る。点が 1 つ・2 つはそのまま', () => {
    const straight: Pt[] = [
      [0, 0],
      [5, 0.1],
      [10, 0],
      [15, -0.1],
      [20, 0],
    ];
    expect(nt.simplify(straight, 0.8)).toEqual([
      [0, 0],
      [20, 0],
    ]);
    const bent: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    expect(nt.simplify(bent, 0.8), '角を落とさない').toEqual(bent);
    expect(nt.simplify([[3, 4]])).toEqual([[3, 4]]);
    expect(nt.simplify([[0, 0], [1, 1]])).toEqual([[0, 0], [1, 1]]);
  });

  it('押しただけ(1 点)は同じ点を 2 つ並べる(丸い端が点になる)/ PDF の座標へ直す', () => {
    const toPdf = (x: number, y: number): number[] => [x / 2, 100 - y / 2];
    expect(nt.strokeToPdf([[10, 20]], toPdf)).toEqual([
      [5, 90],
      [5, 90],
    ]);
    expect(nt.strokeToPdf([[0, 0], [10, 0], [20, 0]], toPdf), '一直線は両端だけ').toEqual([
      [0, 100],
      [10, 100],
    ]);
  });

  it('線の上(許容の内側)を押したときだけ当たる。1 点の線も当たる', () => {
    const line: Pt[] = [
      [0, 0],
      [100, 0],
    ];
    expect(nt.strokeHit(line, 50, 3, 4)).toBe(true);
    expect(nt.strokeHit(line, 50, 5, 4), '許容の外').toBe(false);
    expect(nt.strokeHit(line, 120, 0, 4), '端の先').toBe(false);
    expect(nt.strokeHit([[10, 10]], 12, 12, 4)).toBe(true);
    expect(nt.strokeHit([[10, 10]], 30, 30, 4)).toBe(false);
  });
});

describe('保存の依頼', () => {
  const rgbOf = (id: string): number[] => (id === 'blue' ? [0.5, 0.78, 1] : [1, 0.92, 0.2]);

  it('外したページの付箋・線は渡さない。線の色は表の 0〜1、太さは PEN_WIDTH。値は複製(後で動いても依頼は変わらない)', () => {
    const notes = [note(1, 1), note(2, 2), note(3, 3, '三')];
    const strokes: Stroke[] = [
      { uid: 4, page: 1, color: 'blue', pts: [[1, 2], [3, 4]] },
      { uid: 5, page: 2, color: 'yellow', pts: [[1, 2], [3, 4]] },
    ];
    const job = nt.toJob(notes, strokes, rgbOf, [3, 1]);
    expect(job.notes.map((n) => [n.page, n.text])).toEqual([
      [1, 'メモ'],
      [3, '三'],
    ]);
    expect(job.strokes).toEqual([{ page: 1, rgb: [0.5, 0.78, 1], width: nt.PEN_WIDTH, paths: [[1, 2, 3, 4]] }]);
    (job.notes[0] as { rect: number[] }).rect[0] = 999;
    expect(notes[0]?.rect[0], '依頼を書き換えても元の計画は変わらない').toBe(10);
  });

  it('外す付箋は kind: note で、残すページの物だけ', () => {
    const removals = new Map([
      ['1:14R', { page: 1, id: '14R' }],
      ['2:15R', { page: 2, id: '15R' }],
    ]);
    expect(nt.removalsJob(removals, [1])).toEqual([{ page: 1, id: '14R', kind: 'note' }]);
    expect(nt.removalsJob(removals, [])).toEqual([]);
  });

  it('編集中の案内: 付けた・外した・書いたを言い、0 件なら空。保存の一言はページの編集が無いときだけ', () => {
    const none = { added: 0, removed: 0 };
    expect(nt.note(none, none, true)).toBe('');
    expect(nt.note({ added: 2, removed: 0 }, none, false)).toBe('付箋を 2 件付けています。');
    expect(nt.note({ added: 1, removed: 1 }, { added: 3, removed: 0 }, false)).toBe(
      '付箋を 1 件付け、付箋を 1 件外し、ペンの線を 3 本書いています。',
    );
    expect(nt.note(none, { added: 0, removed: 1 }, true)).toBe(
      'ペンの線を 1 本外しています。保存すると新しい PDF として添付に加わります(元の PDF は変わりません)。',
    );
  });
});

describe('🔴 ページの向きが 4 通りでも、押した場所のまま(窓の座標計算 → pdf.js の本物の viewport)', () => {
  for (const rot of [0, 90, 180, 270]) {
    it(`/Rotate ${String(rot)}: 押した位置 → 付箋の Rect(PDF の座標)→ 窓へ戻すと、押した位置から右下へ NOTE_SIZE 四方`, async () => {
      const d = await PDFLib.PDFDocument.create();
      d.addPage([400, 800]).setRotation(PDFLib.degrees(rot));
      const task = pdfjs.getDocument({ data: new Uint8Array(await d.save()), useWorkerFetch: false, verbosity: 0 });
      const vp = (await (await task.promise).getPage(1)).getViewport({ scale: 1.5 });
      await task.destroy();
      expect(vp.width, `/Rotate ${String(rot)} の viewport の向き`).toBe(rot % 180 === 0 ? 600 : 1200);
      const box = { left: 30, top: 50, width: vp.width - 1, height: vp.height - 1 }; // floor した幅
      const click = { x: 30 + 210, y: 50 + 130 };
      const at = nt.clientToViewport(click.x, click.y, box, vp);
      const toPdf = (x: number, y: number): number[] => vp.convertToPdfPoint(x, y);
      const rect = nt.noteRect(at[0] as number, at[1] as number, toPdf);
      // 期待値は別の観測から: 窓の座標の四角(押した位置から右下へ)を、本物の viewport で PDF へ直した外接
      const k = vp.width / box.width;
      const pts = [
        toPdf(at[0] as number, at[1] as number),
        toPdf((at[0] as number) + nt.NOTE_SIZE, at[1] as number),
        toPdf(at[0] as number, (at[1] as number) + nt.NOTE_SIZE),
        toPdf((at[0] as number) + nt.NOTE_SIZE, (at[1] as number) + nt.NOTE_SIZE),
      ];
      expect(rect[0]).toBeCloseTo(Math.min(...pts.map((p) => p[0] as number)), 2);
      expect(rect[3]).toBeCloseTo(Math.max(...pts.map((p) => p[1] as number)), 2);
      expect(rect[2]! - rect[0]!, '幅が NOTE_SIZE/倍率').toBeCloseTo(nt.NOTE_SIZE / 1.5, 2);
      expect(rect[3]! - rect[1]!, '高さが NOTE_SIZE/倍率').toBeCloseTo(nt.NOTE_SIZE / 1.5, 2);
      // 押した位置が、四角の内側(左上の角)にある ── 向きの取り違えなら数百 pt 動く
      const back = nt.viewportBox(rect, (x, y) => vp.convertToViewportPoint(x, y), 1);
      expect(back.left).toBeCloseTo(at[0] as number, 1);
      expect(back.top).toBeCloseTo(at[1] as number, 1);
      expect(back.width).toBeCloseTo(nt.NOTE_SIZE, 1);
      expect(k, '箱は viewport より 1px 小さい(比で吸収している前提)').toBeGreaterThan(1);
    });

    it(`/Rotate ${String(rot)}: 線の点は PDF の座標へ直り、窓へ戻すと元の位置`, async () => {
      const d = await PDFLib.PDFDocument.create();
      d.addPage([400, 800]).setRotation(PDFLib.degrees(rot));
      const task = pdfjs.getDocument({ data: new Uint8Array(await d.save()), useWorkerFetch: false, verbosity: 0 });
      const vp = (await (await task.promise).getPage(1)).getViewport({ scale: 1 });
      await task.destroy();
      const drawn: Pt[] = [
        [50, 60],
        [100, 200],
        [160, 90],
      ];
      const pdf = nt.strokeToPdf(drawn, (x, y) => vp.convertToPdfPoint(x, y));
      expect(pdf.length, '曲がりは残る').toBe(3);
      pdf.forEach((p, i) => {
        const back = vp.convertToViewportPoint(p[0] as number, p[1] as number);
        expect(back[0]).toBeCloseTo((drawn[i] as Pt)[0], 1);
        expect(back[1]).toBeCloseTo((drawn[i] as Pt)[1], 1);
      });
    });
  }

  it('印は小さくなりすぎる倍率でも、押せる大きさ(min)を保つ', () => {
    const b = nt.viewportBox([0, 0, 9, 9], (x, y) => [x * 0.2, y * 0.2], 14);
    expect(b.width).toBe(14);
    expect(b.height).toBe(14);
  });
});
