/** @vitest-environment happy-dom */
/**
 * 🔴 **画像に描き込む窓**(#683 段③)── 窓の中の振る舞い。
 *
 * 窓・復号・canvas を偽物に差し替え、user が見る結果を pin する:
 *   ①手放し(画像・canvas)が保存 / やめる / 窓を閉じた のどれでも 1 度ずつ効く
 *   ②拡大縮小して出した台でも、押した所に線が引かれる(座標の換算)
 *   ③2 本目の指で描きかけは消え、全部の指が離れるまで描かない
 *   ④保存を断られても窓と線が残る ⑤作れない / 読めない理由が窓に出る
 *   ⑥線が無ければ保存を押せない ⑦線を捨てる「やめる」は確かめる
 *
 * ⚠ 期待値は**偽の台の寸法から**計算する(換算の式を test で写さない)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAW_COLORS, strokeWidthFor, textFont, textSizeFor } from '../../src/features/asset/image-draw';
import {
  OPENER_GONE_TEXT,
  openImageDrawWindow,
  type ImageDrawBitmap,
  type ImageDrawSaveResult,
  type ImageDrawWindow,
} from '../../src/adapter/platform/image-draw-window';

interface Rec {
  arcs: Array<[number, number]>;
  lines: Array<[number, number]>;
  texts: Array<{ text: string; x: number; y: number; fill: string; font: string }>;
  gets: Array<[number, number, number, number]>;
  puts: Array<[number, number]>;
  widths: number[];
}

let rec: Rec;
let blobOut: Blob | null;
let toBlobCalls: number;

beforeEach(() => {
  rec = { arcs: [], lines: [], texts: [], gets: [], puts: [], widths: [] };
  blobOut = new Blob([new Uint8Array([9])], { type: 'image/png' });
  toBlobCalls = 0;
  const ctx = {
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    lineCap: 'butt',
    lineJoin: 'miter',
    beginPath: () => undefined,
    closePath: () => undefined,
    moveTo: () => undefined,
    lineTo: (x: number, y: number) => void rec.lines.push([x, y]),
    arc: (x: number, y: number) => void rec.arcs.push([x, y]),
    stroke: () => void rec.widths.push(ctx.lineWidth),
    fill: () => undefined,
    strokeRect: () => undefined,
    font: '',
    textBaseline: 'alphabetic',
    fillText: (text: string, x: number, y: number) =>
      void rec.texts.push({ text, x, y, fill: String(ctx.fillStyle), font: ctx.font }),
    getImageData: (x: number, y: number, w: number, h: number) => {
      rec.gets.push([x, y, w, h]);
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData: (_d: unknown, x: number, y: number) => void rec.puts.push([x, y]),
    clearRect: () => undefined,
    drawImage: () => undefined,
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ctx) as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(((cb: BlobCallback) => {
    toBlobCalls += 1;
    cb(blobOut);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

interface FakeWin {
  document: Document;
  closed: boolean;
  opener: object | null;
  focus: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  requestAnimationFrame: (cb: () => void) => number;
  cancelAnimationFrame: (n: number) => void;
  addEventListener: (type: string, fn: (ev: Event) => void) => void;
  listeners: Map<string, Array<(ev: Event) => void>>;
  runFrames: () => void;
}

function fakeWin(): FakeWin {
  const frames: Array<() => void> = [];
  const listeners = new Map<string, Array<(ev: Event) => void>>();
  const w: FakeWin = {
    document: document.implementation.createHTMLDocument(''),
    closed: false,
    opener: { closed: false },
    focus: vi.fn(),
    close: vi.fn(() => {
      w.closed = true;
    }),
    requestAnimationFrame: (cb) => frames.push(cb),
    cancelAnimationFrame: () => undefined,
    addEventListener: (type, fn) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    listeners,
    runFrames: () => {
      for (const f of frames.splice(0)) f();
    },
  };
  return w;
}

interface Setup {
  w: FakeWin;
  win: ImageDrawWindow;
  bitmap: ImageDrawBitmap & { close: ReturnType<typeof vi.fn> };
  closeWait: () => void;
  saves: Blob[];
  onClosed: ReturnType<typeof vi.fn>;
  q: (field: string) => HTMLElement;
  canvas: HTMLCanvasElement;
}

/** 窓を開いて組むところまで進める。 */
async function setup(
  opts: {
    save?: (png: Blob) => Promise<ImageDrawSaveResult>;
    bitmap?: { width: number; height: number };
    createBitmap?: (b: Blob) => Promise<ImageDrawBitmap>;
  } = {},
): Promise<Setup> {
  const w = fakeWin();
  const bitmap = { width: opts.bitmap?.width ?? 100, height: opts.bitmap?.height ?? 50, close: vi.fn() };
  let closeWait: () => void = () => undefined;
  const waited = new Promise<void>((r) => (closeWait = r));
  const onClosed = vi.fn();
  const win = openImageDrawWindow({
    title: 'p.png',
    windowName: 'pkc3-draw-k',
    onClosed,
    open: () => w as unknown as Window,
    waitClose: () => waited,
    createBitmap: opts.createBitmap ?? (async () => bitmap),
  });
  expect(win).not.toBeNull();
  const saves: Blob[] = [];
  await win!.start(new Blob([new Uint8Array(4)]), async (png) => {
    saves.push(png);
    return opts.save ? opts.save(png) : { ok: true };
  });
  const q = (field: string): HTMLElement => w.document.querySelector<HTMLElement>(`[data-pkc-field="${field}"]`)!;
  return { w, win: win!, bitmap, closeWait, saves, onClosed, q, canvas: q('image-draw-canvas') as HTMLCanvasElement };
}

let nextId = 1;
function ptr(
  target: HTMLElement,
  type: string,
  p: { id?: number; x?: number; y?: number; kind?: string; button?: number },
): void {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(ev, {
    pointerId: { value: p.id ?? 1 },
    pointerType: { value: p.kind ?? 'mouse' },
    button: { value: p.button ?? 0 },
    clientX: { value: p.x ?? 0 },
    clientY: { value: p.y ?? 0 },
  });
  target.dispatchEvent(ev);
}

/** 1 本引く(ペン)。 */
function stroke(s: Setup, id = nextId++): void {
  ptr(s.canvas, 'pointerdown', { id, x: 5, y: 5 });
  ptr(s.canvas, 'pointermove', { id, x: 20, y: 20 });
  ptr(s.canvas, 'pointerup', { id, x: 20, y: 20 });
}

const click = (el: HTMLElement): void => el.click();

describe('手放し ── 保存 / やめる / 窓を閉じた のどれでも効く', () => {
  it('🔴 保存し終えたら、画像を 1 度だけ手放し、台の寸法を 0 にして窓を閉じる', async () => {
    const s = await setup();
    expect(s.canvas.width).toBeGreaterThan(0);
    stroke(s);
    click(s.q('image-draw-save'));
    await flush();
    expect(s.saves).toHaveLength(1);
    expect(s.bitmap.close).toHaveBeenCalledTimes(1);
    expect([s.canvas.width, s.canvas.height]).toEqual([0, 0]);
    expect(s.w.close).toHaveBeenCalled();
    // 窓が閉じた知らせ(待ち)が後から来ても、二重に手放さない
    s.closeWait();
    await flush();
    expect(s.bitmap.close).toHaveBeenCalledTimes(1);
    expect(s.onClosed).toHaveBeenCalledTimes(1);
  });

  it('🔴 線が無いときの「やめる」は、確認なしで閉じて手放す', async () => {
    const s = await setup();
    click(s.q('image-draw-cancel'));
    await flush();
    expect(s.w.close).toHaveBeenCalled();
    expect(s.bitmap.close).toHaveBeenCalledTimes(1);
    expect([s.canvas.width, s.canvas.height]).toEqual([0, 0]);
    expect(s.saves).toHaveLength(0);
  });

  it('🔴 × で窓が閉じられたとき(待ちが解けたとき)も手放す', async () => {
    const s = await setup();
    stroke(s);
    s.w.closed = true;
    s.closeWait();
    await flush();
    expect(s.bitmap.close).toHaveBeenCalledTimes(1);
    expect([s.canvas.width, s.canvas.height]).toEqual([0, 0]);
    expect(s.onClosed).toHaveBeenCalledTimes(1);
  });

  it('読み込んでいる間に窓が閉じられたら、読めた画像をその場で手放す', async () => {
    const bm = { width: 10, height: 10, close: vi.fn() };
    let resolve!: (b: ImageDrawBitmap) => void;
    const w = fakeWin();
    const win = openImageDrawWindow({
      title: 'x',
      windowName: 'n',
      open: () => w as unknown as Window,
      waitClose: () => new Promise<void>(() => undefined),
      createBitmap: () => new Promise<ImageDrawBitmap>((r) => (resolve = r)),
    })!;
    const started = win.start(new Blob(), async () => ({ ok: true }));
    w.closed = true;
    resolve(bm);
    await started;
    expect(bm.close).toHaveBeenCalledTimes(1);
  });
});

describe('押した所に線が引かれる(座標の換算)', () => {
  it('🔴 台が半分の大きさで出ているとき、押した所の 2 倍の位置に線が引かれる', async () => {
    const s = await setup({ bitmap: { width: 200, height: 100 } });
    const rect = { left: 30, top: 10, width: s.canvas.width / 2, height: s.canvas.height / 2 };
    s.canvas.getBoundingClientRect = () => rect as DOMRect;
    ptr(s.canvas, 'pointerdown', { x: 40, y: 20 });
    // 期待値は偽の枠の寸法から計算する: (押した位置 − 枠の左上) × (台の大きさ / 枠の大きさ)
    const expected: [number, number] = [
      (40 - rect.left) * (s.canvas.width / rect.width),
      (20 - rect.top) * (s.canvas.height / rect.height),
    ];
    expect(expected).toEqual([20, 20]);
    expect(rec.arcs.at(-1)).toEqual(expected);
    ptr(s.canvas, 'pointermove', { x: 50, y: 30 });
    expect(rec.lines.at(-1)).toEqual([
      (50 - rect.left) * (s.canvas.width / rect.width),
      (30 - rect.top) * (s.canvas.height / rect.height),
    ]);
  });
});

describe('複数の指', () => {
  it('🔴 2 本目の指で描きかけは消え、全部の指が離れるまで描かない', async () => {
    const s = await setup();
    ptr(s.canvas, 'pointerdown', { id: 1, kind: 'touch', x: 5, y: 5 });
    ptr(s.canvas, 'pointermove', { id: 1, kind: 'touch', x: 9, y: 9 });
    ptr(s.canvas, 'pointerdown', { id: 2, kind: 'touch', x: 30, y: 30 }); // 2 本目
    const drawn = rec.arcs.length + rec.lines.length;
    ptr(s.canvas, 'pointermove', { id: 1, kind: 'touch', x: 12, y: 12 });
    ptr(s.canvas, 'pointermove', { id: 2, kind: 'touch', x: 33, y: 33 });
    ptr(s.canvas, 'pointerup', { id: 2, kind: 'touch' });
    ptr(s.canvas, 'pointermove', { id: 1, kind: 'touch', x: 14, y: 14 });
    ptr(s.canvas, 'pointerup', { id: 1, kind: 'touch' });
    expect(rec.arcs.length + rec.lines.length, '2 本目の後に線が引かれた').toBe(drawn);
    expect((s.q('image-draw-save') as HTMLButtonElement).disabled, '捨てたはずの線が残っている').toBe(true);
    // 全部離れた後は、また描ける
    stroke(s);
    expect((s.q('image-draw-save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('🔴 全部の指が離れきる前に、同じ指が押し直されても描き始めない', async () => {
    const s = await setup();
    ptr(s.canvas, 'pointerdown', { id: 1, kind: 'touch', x: 5, y: 5 });
    ptr(s.canvas, 'pointerdown', { id: 2, kind: 'touch', x: 6, y: 6 }); // 2 本目 → 捨てる
    ptr(s.canvas, 'pointerup', { id: 2, kind: 'touch' });
    // 指 1 はまだ触れたまま(離した知らせが届いていない)── ここで押しが来ても描き始めない
    const before = rec.arcs.length;
    ptr(s.canvas, 'pointerdown', { id: 1, kind: 'touch', x: 7, y: 7 });
    expect(rec.arcs.length, '指が残っているのに描き始めた').toBe(before);
  });

  it('指が残っている間は、新しく触れても描かない', async () => {
    const s = await setup();
    ptr(s.canvas, 'pointerdown', { id: 1, kind: 'touch', x: 5, y: 5 });
    ptr(s.canvas, 'pointerdown', { id: 2, kind: 'touch', x: 6, y: 6 });
    ptr(s.canvas, 'pointerup', { id: 2, kind: 'touch' });
    // 1 本目はまだ触れている ── 3 本目が触れても描き始めない
    const before = rec.arcs.length;
    ptr(s.canvas, 'pointerdown', { id: 3, kind: 'touch', x: 7, y: 7 });
    expect(rec.arcs.length).toBe(before);
  });

  it('🔴 捕まえた指を失ったら、そこで線を終える(押しっぱなしの記録が残らない)', async () => {
    const s = await setup();
    ptr(s.canvas, 'pointerdown', { id: 1, x: 5, y: 5 });
    ptr(s.canvas, 'pointermove', { id: 1, x: 9, y: 9 });
    ptr(s.canvas, 'lostpointercapture', { id: 1 });
    expect((s.q('image-draw-save') as HTMLButtonElement).disabled, '失った線が確定していない').toBe(false);
    // 押しっぱなしの記録が残っていれば、次の描き始めが「2 本目」扱いで捨てられる
    const before = rec.arcs.length;
    ptr(s.canvas, 'pointerdown', { id: 2, x: 15, y: 15 });
    expect(rec.arcs.length).toBe(before + 1);
  });
});

describe('保存', () => {
  it('🔴 線が 1 本も無いうちは保存を押せない / 引けば押せる / 戻して 0 本になればまた押せない', async () => {
    const s = await setup();
    const save = s.q('image-draw-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    click(save);
    await flush();
    expect(s.saves, '線が無いのに保存が走った').toHaveLength(0);
    stroke(s);
    expect(save.disabled).toBe(false);
    click(s.q('image-draw-undo'));
    expect(save.disabled).toBe(true);
  });

  it('🔴 保存を断られても、窓は開いたまま線も残り、理由が出て押し直せる', async () => {
    const s = await setup({ save: async () => ({ ok: false, message: '断られた理由' }) });
    stroke(s);
    click(s.q('image-draw-save'));
    await flush();
    expect(s.w.close).not.toHaveBeenCalled();
    expect(s.bitmap.close).not.toHaveBeenCalled();
    expect(s.canvas.width).toBeGreaterThan(0);
    expect(s.q('image-draw-status').textContent).toBe('断られた理由');
    expect((s.q('image-draw-save') as HTMLButtonElement).disabled, '押し直せない').toBe(false);
    expect((s.q('image-draw-undo') as HTMLButtonElement).disabled, '線が消えている').toBe(false);
  });

  it('🔴 画像を作れなかったとき(toBlob が null)は、保存を呼ばずに理由を出す', async () => {
    const s = await setup();
    blobOut = null;
    stroke(s);
    click(s.q('image-draw-save'));
    await flush();
    expect(toBlobCalls).toBe(1);
    expect(s.saves).toHaveLength(0);
    expect(s.q('image-draw-status').textContent).toBe('画像を作れませんでした');
    expect(s.w.close).not.toHaveBeenCalled();
  });

  it('🔴 画像を読み込めなかったら、理由を出して描く道具も保存も使えない', async () => {
    const s = await setup({
      createBitmap: async () => {
        throw new Error('decode');
      },
    });
    expect(s.q('image-draw-status').textContent).toBe('この画像は読み込めませんでした');
    expect((s.q('image-draw-save') as HTMLButtonElement).disabled).toBe(true);
    expect((s.q('image-draw-tool-pen') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('捨てる前に確かめる', () => {
  it('🔴 線があるときの「やめる」は閉じずに確かめる ── 「続ける」で戻り、「捨てて閉じる」で閉じる', async () => {
    const s = await setup();
    stroke(s);
    const confirm = s.q('image-draw-confirm');
    expect(confirm.hidden).toBe(true);
    click(s.q('image-draw-cancel'));
    expect(s.w.close, '確かめずに閉じた').not.toHaveBeenCalled();
    expect(confirm.hidden).toBe(false);
    expect(confirm.textContent).toContain('描いた線を捨てて閉じますか');
    click(s.q('image-draw-keep'));
    expect(confirm.hidden).toBe(true);
    expect(s.w.close).not.toHaveBeenCalled();
    click(s.q('image-draw-cancel'));
    click(s.q('image-draw-discard'));
    await flush();
    expect(s.w.close).toHaveBeenCalled();
    expect(s.bitmap.close).toHaveBeenCalledTimes(1);
    expect(s.saves).toHaveLength(0);
  });

  it('🔴 × で閉じるときのブラウザの確認は、線があるときだけ出る', async () => {
    const s = await setup();
    const fire = (): Event => {
      const ev = new Event('beforeunload', { cancelable: true });
      for (const f of s.w.listeners.get('beforeunload') ?? []) f(ev);
      return ev;
    };
    expect(s.w.listeners.get('beforeunload')?.length, '確認の番人が付いていない').toBe(1);
    expect(fire().defaultPrevented, '線が無いのに確認が出る').toBe(false);
    stroke(s);
    expect(fire().defaultPrevented, '線があるのに確認が出ない').toBe(true);
    // 保存し終えて自分で閉じるときは出さない
    click(s.q('image-draw-save'));
    await flush();
    expect(fire().defaultPrevented, '保存後の閉じに確認が出る').toBe(false);
  });
});

describe('窓そのもの', () => {
  it('🔴 窓は同期で開く(await を挟まない)/ 開けなければ null', () => {
    const open = vi.fn<(u: string, t: string, f: string) => Window | null>(() => null);
    expect(openImageDrawWindow({ title: 't', windowName: 'n', open })).toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toBe('about:blank');
    expect(open.mock.calls[0]![1]).toBe('n');
  });

  it('組む前は「読み込んでいます」が出て、題名が付く / focus は窓へ届く', () => {
    const w = fakeWin();
    const win = openImageDrawWindow({
      title: '地図.png',
      windowName: 'n',
      open: () => w as unknown as Window,
      waitClose: () => new Promise<void>(() => undefined),
    })!;
    expect(w.document.title).toBe('地図.png に描き込む');
    expect(w.document.body.textContent).toContain('読み込んでいます');
    win.focus();
    expect(w.focus).toHaveBeenCalledTimes(1);
    win.fail('中身が無い');
    expect(w.document.body.textContent).toContain('中身が無い');
  });

  it('🔴 本体が消えたとき押しても無反応にならない番人が、窓の側に置かれる', async () => {
    const s = await setup();
    const scripts = [...s.w.document.querySelectorAll('script')].map((e) => e.textContent ?? '');
    expect(scripts.length).toBe(1);
    expect(scripts[0]).toContain(OPENER_GONE_TEXT);
    expect(scripts[0]).toContain('window.opener');
    // 保存とやめるの 2 つを見張る
    expect(scripts[0]).toContain('image-draw-save');
    expect(scripts[0]).toContain('image-draw-cancel');
  });

  it('選んでいる道具と色が aria-pressed に出る', async () => {
    const s = await setup();
    expect(s.q('image-draw-tool-pen').getAttribute('aria-pressed')).toBe('true');
    click(s.q('image-draw-tool-rect'));
    expect(s.q('image-draw-tool-rect').getAttribute('aria-pressed')).toBe('true');
    expect(s.q('image-draw-tool-pen').getAttribute('aria-pressed')).toBe('false');
    click(s.q('image-draw-color-black'));
    expect(s.q('image-draw-color-black').getAttribute('aria-pressed')).toBe('true');
    expect(s.q('image-draw-color-red').getAttribute('aria-pressed')).toBe('false');
  });

  it('「やめる」は「新しい画像として保存」から離れている(保存の隣に並ばない)', async () => {
    const s = await setup();
    const kids = [...s.q('image-draw-bar').children];
    const cancel = kids.indexOf(s.q('image-draw-cancel'));
    const save = kids.indexOf(s.q('image-draw-save'));
    expect(cancel).toBeGreaterThanOrEqual(0);
    expect(save).toBeGreaterThan(cancel + 3);
    // 保存は右の端
    expect(save).toBe(kids.length - 1);
  });
});

/** 台を等倍で出す(枠 = 台の大きさ)。押した位置 = 台の座標。 */
function actualSize(s: Setup): void {
  s.canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: s.canvas.width, height: s.canvas.height }) as DOMRect;
}
const textBox = (s: Setup): HTMLInputElement | null =>
  s.w.document.querySelector<HTMLInputElement>('[data-pkc-field="image-draw-text-input"]');
function keydown(el: HTMLElement, init: { key: string; isComposing?: boolean; keyCode?: number }): void {
  const ev = new Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperties(ev, {
    key: { value: init.key },
    isComposing: { value: init.isComposing ?? false },
    keyCode: { value: init.keyCode ?? 0 },
    shiftKey: { value: false },
  });
  el.dispatchEvent(ev);
}
function tapAt(s: Setup, x: number, y: number): void {
  ptr(s.canvas, 'pointerdown', { id: 7, x, y });
  ptr(s.canvas, 'pointerup', { id: 7, x, y });
}

describe('文字', () => {
  it('🔴 押した所に入力欄が出て、Enter で確定すると押した所へ字が置かれ、保存できるようになる', async () => {
    const s = await setup({ bitmap: { width: 200, height: 100 } });
    actualSize(s);
    click(s.q('image-draw-tool-text'));
    expect(s.q('image-draw-save')).toHaveProperty('disabled', true);
    tapAt(s, 30, 40);
    const box = textBox(s)!;
    expect(box).not.toBeNull();
    box.value = 'ここを確認';
    keydown(box, { key: 'Enter' });
    expect(textBox(s)).toBeNull();
    const t = rec.texts.at(-1)!;
    expect([t.text, t.x, t.y]).toEqual(['ここを確認', 30, 40]);
    expect(t.fill).toBe(DRAW_COLORS.red);
    expect(t.font).toBe(textFont(Number(/^(\d+)px/.exec(t.font)![1])));
    expect(s.q('image-draw-save')).toHaveProperty('disabled', false);
  });

  it('🔴 日本語の変換中の Enter では確定しない(変換が済んだ Enter で確定する)', async () => {
    const s = await setup();
    actualSize(s);
    click(s.q('image-draw-tool-text'));
    tapAt(s, 10, 10);
    const box = textBox(s)!;
    box.value = 'にほんご';
    keydown(box, { key: 'Enter', isComposing: true });
    keydown(box, { key: 'Enter', keyCode: 229 });
    expect(textBox(s)).toBe(box); // まだ入力中
    expect(rec.texts).toHaveLength(0);
    box.value = '日本語';
    keydown(box, { key: 'Enter' });
    expect(rec.texts.at(-1)!.text).toBe('日本語');
  });

  it('Esc でやめると何も置かれない / 空のまま確定しても何も置かれない', async () => {
    const s = await setup();
    actualSize(s);
    click(s.q('image-draw-tool-text'));
    tapAt(s, 10, 10);
    textBox(s)!.value = 'やめる';
    keydown(textBox(s)!, { key: 'Escape' });
    expect(textBox(s)).toBeNull();
    tapAt(s, 12, 12);
    keydown(textBox(s)!, { key: 'Enter' });
    expect(textBox(s)).toBeNull();
    expect(rec.texts).toHaveLength(0);
    expect(s.q('image-draw-save')).toHaveProperty('disabled', true);
  });

  it('打っている途中で保存を押す(押す前に入力欄から焦点が外れる)と、打った字が入った画像が保存される', async () => {
    const s = await setup();
    actualSize(s);
    click(s.q('image-draw-tool-text'));
    tapAt(s, 10, 10);
    const box = textBox(s)!;
    box.value = '途中';
    box.dispatchEvent(new Event('blur'));
    click(s.q('image-draw-save'));
    await flush();
    expect(rec.texts.at(-1)!.text).toBe('途中');
    expect(s.saves).toHaveLength(1);
  });

  it('🔴 打っている途中で窓を手放すと、入力欄も外れる', async () => {
    const s = await setup();
    actualSize(s);
    click(s.q('image-draw-tool-text'));
    tapAt(s, 10, 10);
    expect(textBox(s)).not.toBeNull();
    s.closeWait();
    await flush();
    expect(textBox(s)).toBeNull();
    expect([s.canvas.width, s.canvas.height]).toEqual([0, 0]);
  });

  it('🔴 打っている途中で別の所を押すと、打った字を置いてから次の入力欄を出す', async () => {
    const s = await setup({ bitmap: { width: 200, height: 100 } });
    actualSize(s);
    click(s.q('image-draw-tool-text'));
    tapAt(s, 10, 10);
    textBox(s)!.value = '一つ目';
    // ⚠ 焦点が外れる(blur)を飛ばさない ── 押した処理だけで確定することを見る
    tapAt(s, 80, 60);
    expect(rec.texts.map((t) => [t.text, t.x, t.y]), '別の所を押しても前の字が置かれない').toEqual([['一つ目', 10, 10]]);
    expect(s.w.document.querySelectorAll('[data-pkc-field="image-draw-text-input"]').length, '入力欄が 2 つ残った').toBe(1);
  });

  it('🔴 打っている最中の Ctrl+Z は、直前に描いた線を消さない', async () => {
    const s = await setup();
    actualSize(s);
    stroke(s);
    expect(s.q('image-draw-undo')).toHaveProperty('disabled', false);
    click(s.q('image-draw-tool-text'));
    tapAt(s, 30, 30);
    const box = textBox(s)!;
    const ev = new Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperties(ev, { key: { value: 'z' }, ctrlKey: { value: true }, metaKey: { value: false }, shiftKey: { value: false }, isComposing: { value: false }, keyCode: { value: 90 } });
    box.dispatchEvent(ev);
    expect(ev.defaultPrevented, '入力欄の打ち消しを潰した').toBe(false);
    expect(s.q('image-draw-undo'), '線が消えた(元に戻すが押せなくなった)').toHaveProperty('disabled', false);
    // 対照群: 入力欄の外の Ctrl+Z は線を消す
    box.value = '';
    keydown(box, { key: 'Escape' });
    const ev2 = new Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperties(ev2, { key: { value: 'z' }, ctrlKey: { value: true }, metaKey: { value: false }, shiftKey: { value: false } });
    s.w.document.body.dispatchEvent(ev2);
    expect(s.q('image-draw-undo'), '対照群: 入力欄の外の Ctrl+Z が効かない').toHaveProperty('disabled', true);
  });

  it('🔴 打ちかけの字があれば、保存を押せる / × で閉じるときに確認が出る', async () => {
    const s = await setup();
    actualSize(s);
    click(s.q('image-draw-tool-text'));
    tapAt(s, 10, 10);
    const box = textBox(s)!;
    const fire = (): Event => {
      const ev = new Event('beforeunload', { cancelable: true });
      for (const f of s.w.listeners.get('beforeunload') ?? []) f(ev);
      return ev;
    };
    expect(fire().defaultPrevented, '空の入力欄で確認が出た').toBe(false);
    expect(s.q('image-draw-save')).toHaveProperty('disabled', true);
    box.value = '打ちかけ';
    box.dispatchEvent(new Event('input'));
    expect(fire().defaultPrevented, '打ちかけの字があるのに確認なしで閉じる').toBe(true);
    expect(s.q('image-draw-save'), '打ちかけの字があるのに保存を押せない').toHaveProperty('disabled', false);
  });

  it('🔴 「太い」を選ぶと、文字が大きく置かれる', async () => {
    const s = await setup({ bitmap: { width: 400, height: 200 } });
    actualSize(s);
    click(s.q('image-draw-tool-text'));
    const place = (x: number): number => {
      tapAt(s, x, 10);
      textBox(s)!.value = 'a';
      keydown(textBox(s)!, { key: 'Enter' });
      return Number(/^(\d+(?:\.\d+)?)px/.exec(rec.texts.at(-1)!.font)![1]);
    };
    const thin = place(10);
    click(s.q('image-draw-thickness-thick'));
    const thick = place(50);
    expect(thin).toBe(textSizeFor(400, 200, 'thin'));
    expect(thick).toBe(textSizeFor(400, 200, 'thick'));
    expect(thick).toBeGreaterThan(thin);
  });

  it('選んだ色で置かれる(青)', async () => {
    const s = await setup();
    actualSize(s);
    click(s.q('image-draw-tool-text'));
    click(s.q('image-draw-color-blue'));
    tapAt(s, 10, 10);
    textBox(s)!.value = 'a';
    keydown(textBox(s)!, { key: 'Enter' });
    expect(rec.texts.at(-1)!.fill).toBe(DRAW_COLORS.blue);
  });
});

describe('モザイク', () => {
  it('🔴 なぞった四角の範囲の画素を読んで書き戻す(台の外へはみ出す分は台の中へ収める)', async () => {
    const s = await setup({ bitmap: { width: 200, height: 100 } });
    actualSize(s);
    click(s.q('image-draw-tool-mosaic'));
    ptr(s.canvas, 'pointerdown', { id: 3, x: 50, y: 20 });
    ptr(s.canvas, 'pointermove', { id: 3, x: 400, y: 60 }); // 台(200 幅)の外
    ptr(s.canvas, 'pointerup', { id: 3, x: 400, y: 60 });
    expect(rec.gets.at(-1)).toEqual([50, 20, 150, 40]);
    expect(rec.puts.at(-1)).toEqual([50, 20]);
    expect(s.q('image-draw-save')).toHaveProperty('disabled', false);
  });
});

describe('色と太さ', () => {
  it('🔴 「太い」を選ぶと、線が太く引かれる', async () => {
    const s = await setup({ bitmap: { width: 400, height: 200 } });
    actualSize(s);
    stroke(s);
    const thin = Math.max(...rec.widths);
    click(s.q('image-draw-thickness-thick'));
    rec.widths = [];
    stroke(s);
    expect(thin).toBe(strokeWidthFor(400, 200, 'thin'));
    expect(rec.widths, '「太い」が線に届かない').toContain(strokeWidthFor(400, 200, 'thick'));
  });

  it('🔴 色は 4 つ、太さは 2 つのボタンがあり、選んだ物が aria-pressed に出る', async () => {
    const s = await setup();
    for (const c of ['red', 'black', 'blue', 'yellow']) expect(s.q(`image-draw-color-${c}`), c).not.toBeNull();
    click(s.q('image-draw-color-yellow'));
    expect(s.q('image-draw-color-yellow').getAttribute('aria-pressed')).toBe('true');
    expect(s.q('image-draw-color-red').getAttribute('aria-pressed')).toBe('false');
    expect(s.q('image-draw-thickness-thin').getAttribute('aria-pressed')).toBe('true');
    click(s.q('image-draw-thickness-thick'));
    expect(s.q('image-draw-thickness-thick').getAttribute('aria-pressed')).toBe('true');
    expect(s.q('image-draw-thickness-thin').getAttribute('aria-pressed')).toBe('false');
  });

  it('🔴 「選んでいる」を見た目に写す CSS が、道具・色・太さに同じ規則で効く', async () => {
    const s = await setup();
    const css = s.w.document.querySelector('style')!.textContent!;
    expect(css).toContain('[data-pkc-field="image-draw-bar"] button[aria-pressed="true"]');
    // 色・太さのボタンも、その規則が当たる「バーの中の button」である
    for (const f of ['image-draw-color-blue', 'image-draw-thickness-thick', 'image-draw-tool-mosaic']) {
      expect(s.q(f).closest('[data-pkc-field="image-draw-bar"]'), f).not.toBeNull();
      expect(s.q(f).tagName).toBe('BUTTON');
    }
  });
});
