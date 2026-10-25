/**
 * PDF の 1 ページ目を焼く器(#529 W6)の判断。
 *
 * 守る主張(計算ワーカーの規律 ── CLAUDE.md §2-5):
 * 1. 遅延起動 ── 依頼が来るまで pdf.js を読まず、解析ワーカーも作らない
 * 2. 依頼は 1 件ずつ列に並ぶ(落とさない)
 * 3. 文書・頁・canvas を 1 件ごとにその場で捨てる(文書の読み込みを destroy、canvas を release)
 * 4. アイドルで解析ワーカーを destroy する。⚠ 飛んでいる間は殺さない。次の依頼で作り直す
 * 5. dispose は待っている依頼を必ず reject する
 * 6. 焼く大きさは「幅 × dpr」で、1 辺の上限で頭打ち
 */
import { describe, expect, it, vi } from 'vitest';
import { MAX_SIDE_PX, PdfPageBaker, type BakeCanvas, type PdfJsLib } from '../../src/adapter/platform/pdf/page-baker';

interface Rig {
  baker: PdfPageBaker;
  loads: number;
  workers: Array<{ destroyed: boolean }>;
  tasks: Array<{ destroyed: boolean }>;
  canvases: Array<{ w: number; h: number; released: boolean }>;
  /** 描画の完了を手で止める口。 */
  gate: { hold: boolean; release: () => void };
  timers: Array<() => void>;
  page: { w: number; h: number };
  renders: Array<{ scale: number; background: unknown }>;
}

function rig(): Rig {
  const r: Rig = {
    baker: null as unknown as PdfPageBaker,
    loads: 0,
    workers: [],
    tasks: [],
    canvases: [],
    gate: { hold: false, release: () => undefined },
    timers: [],
    page: { w: 600, h: 800 },
    renders: [],
  };
  const waiting: Array<() => void> = [];
  r.gate.release = () => {
    r.gate.hold = false;
    for (const w of waiting.splice(0)) w();
  };
  const lib = {
    GlobalWorkerOptions: { workerSrc: '' },
    PDFWorker: class {
      destroyed = false;
      constructor() {
        r.workers.push(this);
      }
      destroy(): void {
        this.destroyed = true;
      }
    },
    getDocument() {
      const task = {
        destroyed: false,
        promise: Promise.resolve({
          getPage: () =>
            Promise.resolve({
              getViewport: ({ scale }: { scale: number }) => ({ width: r.page.w * scale, height: r.page.h * scale, scale }),
              render: (o: { viewport: { scale: number }; background: unknown }) => ({
                promise: (async () => {
                  r.renders.push({ scale: o.viewport.scale, background: o.background });
                  if (r.gate.hold) await new Promise<void>((res) => waiting.push(res));
                })(),
              }),
              cleanup: () => undefined,
            }),
        }),
        destroy(): Promise<void> {
          task.destroyed = true;
          return Promise.resolve();
        },
      };
      r.tasks.push(task);
      return task;
    },
  } as unknown as PdfJsLib;
  r.baker = new PdfPageBaker({
    load: () => {
      r.loads += 1;
      return Promise.resolve({ lib, baseUrl: 'http://x.test/pdf/lib/' });
    },
    idleMs: 1000,
    setTimer: (fn) => {
      r.timers.push(fn);
      return r.timers.length;
    },
    clearTimer: (h) => {
      r.timers[(h as number) - 1] = () => undefined;
    },
    makeCanvas: (w, h): BakeCanvas => {
      const c = { w, h, released: false };
      r.canvases.push(c);
      return {
        context: {},
        toPng: () => Promise.resolve(new Blob(['png'], { type: 'image/png' })),
        release: () => {
          c.released = true;
        },
      };
    },
  });
  return r;
}

const bytes = (): ArrayBuffer => new Uint8Array([1, 2, 3]).buffer;
const tick = (): Promise<void> => new Promise((res) => setTimeout(res, 5));

describe('PDF の 1 ページ目を焼く器', () => {
  it('🔴 遅延起動: 依頼が来るまで pdf.js を読まず、解析ワーカーも作らない', async () => {
    const r = rig();
    expect(r.loads).toBe(0);
    expect(r.baker.alive).toBe(false);
    await r.baker.bake(bytes(), 300, 1);
    expect(r.loads).toBe(1);
    expect(r.workers).toHaveLength(1);
    expect(r.baker.alive).toBe(true);
  });

  it('🔴 焼く大きさは 幅 × dpr(600×800 の頁を幅 300・dpr 2 なら 600×800 画素 / CSS は 300×400)', async () => {
    const r = rig();
    const out = await r.baker.bake(bytes(), 300, 2);
    expect(r.canvases[0]).toMatchObject({ w: 600, h: 800 });
    expect([out.cssWidth, out.cssHeight]).toEqual([300, 400]);
    expect(r.renders[0]!.scale).toBe(1);
    // 対照群: dpr 1 なら半分
    await r.baker.bake(bytes(), 300, 1);
    expect(r.canvases[1]).toMatchObject({ w: 300, h: 400 });
    expect(r.renders[0]!.background, 'PDF の頁は白地で焼く').toBe('#ffffff');
  });

  it('🔴 縦に極端に長い頁でも 1 辺の上限で頭打ち(canvas を作れず落ちない)', async () => {
    const r = rig();
    r.page = { w: 100, h: 100000 };
    await r.baker.bake(bytes(), 800, 2);
    const c = r.canvases[0]!;
    expect(Math.max(c.w, c.h)).toBeLessThanOrEqual(MAX_SIDE_PX);
    expect(c.h, '上限まで使っていない').toBeGreaterThan(MAX_SIDE_PX - 2);
  });

  it('🔴 1 件ごとに文書の読み込みと canvas をその場で捨てる(解析ワーカーは共有で残る)', async () => {
    const r = rig();
    await r.baker.bake(bytes(), 300, 1);
    await r.baker.bake(bytes(), 300, 1);
    expect(r.tasks).toHaveLength(2);
    expect(r.tasks.every((t) => t.destroyed), '文書の読み込みが残っている').toBe(true);
    expect(r.canvases.every((c) => c.released), 'canvas の画素が残っている').toBe(true);
    expect(r.workers, '解析ワーカーを毎回作り直している').toHaveLength(1);
    expect(r.workers[0]!.destroyed).toBe(false);
  });

  it('🔴 依頼は 1 件ずつ(同時に 2 つの文書を開かない)', async () => {
    const r = rig();
    r.gate.hold = true;
    const a = r.baker.bake(bytes(), 300, 1);
    const b = r.baker.bake(bytes(), 300, 1);
    await tick();
    expect(r.tasks, '先の 1 件が終わる前に次を始めている').toHaveLength(1);
    expect(r.baker.busy).toBe(2);
    r.gate.release();
    await Promise.all([a, b]);
    expect(r.tasks).toHaveLength(2);
  });

  it('🔴 アイドルで解析ワーカーを destroy する / 飛んでいる間は殺さない / 次の依頼で作り直す', async () => {
    const r = rig();
    r.gate.hold = true;
    const a = r.baker.bake(bytes(), 300, 1);
    await tick();
    expect(r.timers, '飛んでいる間にアイドルの予約を張っている').toHaveLength(0);
    r.gate.release();
    await a;
    expect(r.timers, '終わったのにアイドルの予約が無い').toHaveLength(1);
    expect(r.workers[0]!.destroyed, '予約の時間前に殺している').toBe(false);
    r.timers[0]!();
    expect(r.workers[0]!.destroyed, 'アイドルで畳んでいない').toBe(true);
    expect(r.baker.alive).toBe(false);
    await r.baker.bake(bytes(), 300, 1);
    expect(r.workers, '畳んだ後の依頼で作り直していない').toHaveLength(2);
    expect(r.workers[1]!.destroyed).toBe(false);
  });

  it('🔴 新しい依頼が来たらアイドルの予約を畳む(使っているワーカーを殺さない)', async () => {
    const r = rig();
    await r.baker.bake(bytes(), 300, 1);
    r.gate.hold = true;
    const p = r.baker.bake(bytes(), 300, 1);
    await tick();
    r.timers[0]!(); // 予約は取り消されている(取り消しの口が呼ばれて差し替わっている)
    expect(r.workers[0]!.destroyed).toBe(false);
    r.gate.release();
    await p;
  });

  it('🔴 dispose は待っている依頼を reject し、解析ワーカーを畳む(await を永久に待たせない)', async () => {
    const r = rig();
    r.gate.hold = true;
    const a = r.baker.bake(bytes(), 300, 1);
    const b = r.baker.bake(bytes(), 300, 1);
    await tick();
    const assertion = expect(b).rejects.toThrow();
    r.baker.dispose();
    await assertion;
    expect(r.workers[0]!.destroyed).toBe(true);
    r.gate.release();
    await a.catch(() => undefined);
    await expect(r.baker.bake(bytes(), 300, 1)).rejects.toThrow();
  });

  it('pdf.js が読めなければ依頼が reject する / 失敗を覚えない(次の依頼でまた読みに行く)', async () => {
    const spy = vi.fn(() => Promise.reject(new Error('offline')));
    const baker = new PdfPageBaker({ load: spy });
    await expect(baker.bake(bytes(), 300, 1)).rejects.toThrow('offline');
    await expect(baker.bake(bytes(), 300, 1)).rejects.toThrow('offline');
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
