/** @vitest-environment node */
/**
 * ハイライトの計画(`public/pdf/highlight.js`)(#275 段②-2b/c)── 選んだ範囲の長方形 → 重なりを除く → PDF の座標の `QuadPoints`。
 *
 * 🔴 守るもの:
 * 1. 色は 4 つ(黄・緑・青・ピンク)で、既定は黄。知らない id は黄に倒れる。
 * 2. **字の層の選びは、行ごとの長方形のほかに span 全体の長方形が重なって出る**(設計 doc §2.1)── 重なりは 1 つにする
 *    (乗算で重ねると色が濃くなる)。離れた別の行は残す。
 * 3. 画面の長方形 → PDF の `QuadPoints` が、ページの向き(/Rotate 0・90・180・270)・倍率・箱の端数(floor した幅)に依らず
 *    本当の位置になる(pdf.js の本物の viewport で、期待値は PDF の座標から別に作る)。複数ページにまたがる選びは頁ごとに分かれる。
 * ⚠ 素の JS(classic script)の**原文を読んで**走らせる。
 */
import { readFileSync } from 'node:fs';
import * as PDFLib from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';

interface R {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
interface Hl {
  COLORS: { id: string; label: string; rgb: number[] }[];
  DEFAULT_COLOR: string;
  colorOf(id: string): { id: string; rgb: number[] };
  dedupeRects(rects: R[], min?: number): R[];
  quadsFromViewportRects(rects: R[], toPdf: (x: number, y: number) => number[]): { quads: number[][]; rect: number[] };
  quadsOnPage(
    rects: R[],
    box: { left: number; top: number; width: number; height: number },
    vp: { width: number; height: number },
    toPdf: (x: number, y: number) => number[],
  ): { quads: number[][]; rect: number[] } | null;
  parseAnnotId(id: string): { num: number; gen: number } | null;
  sameQuads(a: number[][], b: number[][]): boolean;
  sameMarks(a: { uid: number; color: string }[], b: { uid: number; color: string }[]): boolean;
  sameRemovals(a: Map<string, unknown>, b: Map<string, unknown>): boolean;
  toJob(
    marks: { page: number; color: string; quads: number[][] }[],
    removals: Map<string, { page: number; id: string }>,
    order: number[],
  ): { highlights: { page: number; rgb: number[]; quads: number[][] }[]; removals: { page: number; id: string }[] };
  note(added: number, removed: number, withSave: boolean): string;
}

function load(): Hl {
  const root: { PkcPdfHighlight?: Hl } = {};
  new Function('self', readFileSync('public/pdf/highlight.js', 'utf-8'))(root);
  expect(root.PkcPdfHighlight, '原文が API を公開していない(空振り)').toBeDefined();
  return root.PkcPdfHighlight as Hl;
}
const hl = load();
const rect = (left: number, top: number, right: number, bottom: number): R => ({ left, top, right, bottom });

describe('色', () => {
  it('4 色(黄・緑・青・ピンク)で、既定は黄。色は 4 つとも違い、0〜1 の範囲。知らない id は黄', () => {
    expect(hl.COLORS.map((c) => c.id)).toEqual(['yellow', 'green', 'blue', 'pink']);
    expect(hl.COLORS.map((c) => c.label)).toEqual(['黄', '緑', '青', 'ピンク']);
    expect(hl.DEFAULT_COLOR).toBe('yellow');
    expect(new Set(hl.COLORS.map((c) => c.rgb.join(','))).size).toBe(4);
    for (const c of hl.COLORS) {
      expect(c.rgb).toHaveLength(3);
      for (const v of c.rgb) expect(v >= 0 && v <= 1, `${c.id}`).toBe(true);
    }
    expect(hl.colorOf('blue').id).toBe('blue');
    expect(hl.colorOf('zzz').id).toBe('yellow');
  });
});

describe('🔴 重なりを除く(span 全体の長方形が、行ごとの長方形と重なって出る)', () => {
  it('同じ範囲が 2 つ → 1 つ。大きい側と小さい側が重なるなら大きい側を残し、離れた別の行は残す。小さすぎる物は捨てる', () => {
    const line1 = rect(10, 10, 110, 24);
    // 対照: 重ねたままだと 2 つ(除かなければ乗算で濃くなる)
    expect(hl.dedupeRects([line1, { ...line1 }, rect(10, 30, 60, 44)])).toHaveLength(2);
    // span 全体(1 行目より少し大きい)+ 行ごと(中に収まる)→ 大きい 1 つ
    const out = hl.dedupeRects([rect(10, 9.5, 111, 24.5), rect(10, 10, 110, 24), rect(10, 30, 60, 44)]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(rect(10, 9.5, 111, 24.5));
    expect(out[1]).toEqual(rect(10, 30, 60, 44));
    // 幅 0・高さ 0 は捨てる(選びの端の改行の印など)
    expect(hl.dedupeRects([rect(10, 10, 10, 24), rect(10, 10, 110, 10)])).toEqual([]);
    // 同じ行の隣り合う別の語(少しだけ触れる)は別々に残る
    expect(hl.dedupeRects([rect(10, 10, 60, 24), rect(59, 10, 110, 24)])).toHaveLength(2);
    // 同じ大きさなら先にある 1 つを残す(順に依らず 1 つ)
    expect(hl.dedupeRects([rect(1, 1, 50, 20), rect(1, 1, 50, 20), rect(1, 1, 50, 20)])).toHaveLength(1);
  });
});

describe('QuadPoints の並びと Rect', () => {
  it('1 行 1 組 8 数(左上・右上・左下・右下)で、Rect は全体を囲む。恒等の変換(y 反転)での値', () => {
    // y を上向きにする(PDF の座標)── 高さ 100 の紙の上で
    const toPdf = (x: number, y: number): number[] => [x, 100 - y];
    const got = hl.quadsFromViewportRects([rect(10, 10, 60, 20), rect(10, 30, 40, 40)], toPdf);
    expect(got.quads[0]).toEqual([10, 90, 60, 90, 10, 80, 60, 80]);
    expect(got.quads[1]).toEqual([10, 70, 40, 70, 10, 60, 40, 60]);
    expect(got.rect).toEqual([10, 60, 60, 90]);
    expect(hl.quadsFromViewportRects([], toPdf)).toEqual({ quads: [], rect: [0, 0, 0, 0] });
  });
});

/** 本物の pdf.js の viewport(`/Rotate` と倍率つき)。 */
async function viewportOf(rotate: number, scale: number) {
  const d = await PDFLib.PDFDocument.create();
  const p = d.addPage([400, 800]);
  p.setRotation(PDFLib.degrees(rotate));
  const bytes = await d.save();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, verbosity: 0 });
  const vp = (await (await task.promise).getPage(1)).getViewport({ scale });
  await task.destroy();
  return vp;
}

describe('🔴 画面の長方形 → PDF の座標(3 つのページの形 × 倍率 × 箱の端数)', () => {
  // 3 つの形: ① 向きの無いページ ② /Rotate 90(長方形が縦に出る)③ 字そのものが回っている(縦に並ぶ字 = 長方形が細長い)
  const T_H = [102.67, 500, 131.4, 513.3]; // 横に並ぶ字(設計 doc の "world" の範囲)
  const T_V = [200, 100, 213.3, 128.7]; // 縦に並ぶ字(字が 90° 回っている)
  const cases: { name: string; rotate: number; T: number[] }[] = [
    { name: '① 向きの無いページ', rotate: 0, T: T_H },
    { name: '② /Rotate 90 のページ', rotate: 90, T: T_H },
    { name: '② /Rotate 180 のページ', rotate: 180, T: T_H },
    { name: '② /Rotate 270 のページ', rotate: 270, T: T_H },
    { name: '③ 字が回っている(縦の長方形)・向きの無いページ', rotate: 0, T: T_V },
    { name: '③ 字が回っている・/Rotate 90 のページ(長方形は横に出る)', rotate: 90, T: T_V },
  ];
  for (const scale of [0.8, 1.5]) {
    for (const c of cases) {
      it(`${c.name}・倍率 ${String(scale)}: 選んだ位置が本当の位置(±0.2pt)で、箱が 1px 小さくても変わらない`, async () => {
        const vp = await viewportOf(c.rotate, scale);
        // 期待値は PDF の座標 T から**別に**作る(窓の計算の逆向きを通さない)
        const a = vp.convertToViewportPoint(c.T[0] as number, c.T[1] as number);
        const b = vp.convertToViewportPoint(c.T[2] as number, c.T[3] as number);
        const ox = 40;
        const oy = 70;
        const sel = rect(
          ox + Math.min(a[0] as number, b[0] as number),
          oy + Math.min(a[1] as number, b[1] as number),
          ox + Math.max(a[0] as number, b[0] as number),
          oy + Math.max(a[1] as number, b[1] as number),
        );
        for (const trim of [0, 1]) {
          const got = hl.quadsOnPage(
            [sel, { ...sel }], // 同じ範囲が 2 つ出る(重なりの除去も通す)
            { left: ox, top: oy, width: vp.width - trim, height: vp.height - trim },
            vp,
            (x, y) => vp.convertToPdfPoint(x, y),
          );
          expect(got, '拾われていない').not.toBeNull();
          const g = got as { quads: number[][]; rect: number[] };
          expect(g.quads, '同じ範囲が 2 つ出ても 1 行').toHaveLength(1);
          const eps = trim === 0 ? 0.05 : 0.8 / scale + 0.2;
          expect(
            g.rect.every((v, i) => Math.abs(v - (c.T[i] as number)) <= eps),
            `rect ${g.rect.join(',')} ≠ ${c.T.join(',')}(trim ${String(trim)})`,
          ).toBe(true);
        }
      });
    }
  }

  it('絶対値の錨: /Rotate 90・倍率 1.5 で、画面の (300,150) は PDF の (100,200)(viewport の向きを取り違えても気づく)', async () => {
    const vp = await viewportOf(90, 1.5);
    const got = hl.quadsOnPage(
      [rect(300 - 15, 150 - 7.5, 300 + 15, 150 + 7.5)],
      { left: 0, top: 0, width: vp.width, height: vp.height },
      vp,
      (x, y) => vp.convertToPdfPoint(x, y),
    );
    const rectOut = (got as { rect: number[] }).rect;
    // 中心 (100,200)・幅は縦(画面の y)10pt → PDF の x 方向 10、画面の x 方向 20pt → PDF の y 方向 20
    expect(rectOut.map((v) => Math.round(v * 100) / 100)).toEqual([95, 190, 105, 210]);
  });

  it('箱の大きさが viewport と違っても(2 倍・半分)、比で PDF の座標へ直す', async () => {
    const vp = await viewportOf(90, 1.5);
    const T = [60, 500, 160, 520];
    const a = vp.convertToViewportPoint(T[0] as number, T[1] as number);
    const b = vp.convertToViewportPoint(T[2] as number, T[3] as number);
    for (const k of [2, 0.5]) {
      // 画面の箱が k 倍の大きさで描かれている(拡大して見ているとき)── 長方形も k 倍
      const sel = rect(
        k * Math.min(a[0] as number, b[0] as number),
        k * Math.min(a[1] as number, b[1] as number),
        k * Math.max(a[0] as number, b[0] as number),
        k * Math.max(a[1] as number, b[1] as number),
      );
      const got = hl.quadsOnPage([sel], { left: 0, top: 0, width: vp.width * k, height: vp.height * k }, vp, (x, y) =>
        vp.convertToPdfPoint(x, y),
      );
      const r = (got as { rect: number[] }).rect;
      expect(
        r.every((v, i) => Math.abs(v - (T[i] as number)) <= 0.05),
        `倍率 ${String(k)}: ${r.join(',')} ≠ ${T.join(',')}`,
      ).toBe(true);
    }
  });

  it('複数ページにまたがる選び: 長方形の中心があるページの箱にだけ入り、ページごとに分かれる / どの箱にも入らない長方形は捨てる', async () => {
    const vp = await viewportOf(0, 1);
    const toPdf = (x: number, y: number): number[] => vp.convertToPdfPoint(x, y);
    const boxA = { left: 0, top: 0, width: vp.width, height: vp.height };
    const boxB = { left: 0, top: vp.height + 10, width: vp.width, height: vp.height };
    const rects = [rect(10, 700, 100, 714), rect(10, vp.height + 10 + 20, 100, vp.height + 10 + 34), rect(10, vp.height + 3, 100, vp.height + 6)];
    const a = hl.quadsOnPage(rects, boxA, vp, toPdf);
    const b = hl.quadsOnPage(rects, boxB, vp, toPdf);
    expect(a?.quads).toHaveLength(1);
    expect(b?.quads).toHaveLength(1);
    // 1 ページ目の長方形は紙の下の端(y=700 → PDF の y = 800 - 714 = 86)、2 ページ目のは上の端
    expect(a?.rect[1]).toBeCloseTo(86, 1);
    expect(b?.rect[3]).toBeCloseTo(800 - 20, 1);
    // 隙間(どの箱にも入らない)の長方形は、どちらにも入っていない
    expect(hl.quadsOnPage([rects[2] as R], boxA, vp, toPdf)).toBeNull();
    expect(hl.quadsOnPage([rects[2] as R], boxB, vp, toPdf)).toBeNull();
    expect(hl.quadsOnPage([], boxA, vp, toPdf)).toBeNull();
  });
});

describe('注釈の id・同じ範囲・基準との比較', () => {
  it('pdf.js の id(14R / 14R2)を番号と世代へ / 読めなければ null', () => {
    expect(hl.parseAnnotId('14R')).toEqual({ num: 14, gen: 0 });
    expect(hl.parseAnnotId('14R2')).toEqual({ num: 14, gen: 2 });
    for (const bad of ['', 'abc', 'R14', '14', '14r']) expect(hl.parseAnnotId(bad), bad).toBeNull();
  });

  it('同じ範囲か(0.5pt 以内)/ 行数が違えば別', () => {
    const q = [[10, 90, 60, 90, 10, 80, 60, 80]];
    expect(hl.sameQuads(q, [[10.4, 90, 60, 90, 10, 80, 60, 80.3]])).toBe(true);
    expect(hl.sameQuads(q, [[11, 90, 60, 90, 10, 80, 60, 80]])).toBe(false);
    expect(hl.sameQuads(q, [...q, ...q])).toBe(false);
  });

  it('保存した状態との比較: 付けた物(uid と色)・外す物(頁:id)の違いを見る', () => {
    expect(hl.sameMarks([{ uid: 1, color: 'yellow' }], [{ uid: 1, color: 'yellow' }])).toBe(true);
    expect(hl.sameMarks([{ uid: 1, color: 'yellow' }], [{ uid: 1, color: 'blue' }])).toBe(false);
    expect(hl.sameMarks([{ uid: 1, color: 'yellow' }], [])).toBe(false);
    expect(hl.sameRemovals(new Map([['1:5R', {}]]), new Map([['1:5R', {}]]))).toBe(true);
    expect(hl.sameRemovals(new Map([['1:5R', {}]]), new Map([['1:6R', {}]]))).toBe(false);
    expect(hl.sameRemovals(new Map(), new Map([['1:6R', {}]]))).toBe(false);
  });
});

describe('worker へ渡す依頼', () => {
  it('残すページに属する物だけ・色は表の rgb・外す物は頁と id。元の配列を共有しない', () => {
    const marks = [
      { page: 1, color: 'pink', quads: [[1, 2, 3, 4, 5, 6, 7, 8]] },
      { page: 2, color: 'blue', quads: [[1, 2, 3, 4, 5, 6, 7, 8]] },
    ];
    const removals = new Map([
      ['1:5R', { page: 1, id: '5R' }],
      ['2:9R', { page: 2, id: '9R' }],
    ]);
    const job = hl.toJob(marks, removals, [1]);
    expect(job.highlights).toEqual([{ page: 1, rgb: hl.colorOf('pink').rgb, quads: [[1, 2, 3, 4, 5, 6, 7, 8]] }]);
    expect(job.removals).toEqual([{ page: 1, id: '5R' }]);
    (job.highlights[0] as { quads: number[][] }).quads[0]![0] = 99;
    expect(marks[0]?.quads[0]?.[0], '依頼を直しても元の計画が動く').toBe(1);
    expect(hl.toJob(marks, removals, [])).toEqual({ highlights: [], removals: [] });
  });

  it('案内の 1 行: 付けた数・外した数(どちらも 0 なら空)/ ページの編集が無いときだけ保存するとどうなるかも言う', () => {
    expect(hl.note(0, 0, true)).toBe('');
    expect(hl.note(2, 0, false)).toBe('ハイライトを 2 件付けています。');
    expect(hl.note(0, 1, false)).toBe('ハイライトを 1 件外しています。');
    expect(hl.note(2, 1, false)).toBe('ハイライトを 2 件付け、1 件外しています。');
    expect(hl.note(1, 0, true)).toBe('ハイライトを 1 件付けています。保存すると新しい PDF として添付に加わります(元の PDF は変わりません)。');
  });
});
