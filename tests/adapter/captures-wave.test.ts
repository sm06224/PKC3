/** @vitest-environment happy-dom */
/**
 * 🔴 **一覧の波形の帯**(#1232)── 鳴らしている音の行にだけ出る / 焼いた画像は寿命の終わりで返す /
 * 範囲と目盛りが state と文字起こしから置かれる。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const baked: string[] = [];
const bakedColors: string[] = [];
/** 焼きを止める栓(焼いている最中に別の行へ移る場面を作る)。 */
const gate: { wait: Promise<void> | null } = { wait: null };
vi.mock('../../src/adapter/ui/render/wave-bake', () => ({
  WAVE_HEIGHT: 40,
  bakeWavePng: async (_p: Float32Array, color: string) => {
    if (gate.wait) await gate.wait;
    const url = `blob:wave-${String(baked.length + 1)}`;
    baked.push(url);
    bakedColors.push(color);
    return url;
  },
}));

import { CapturesRenderer } from '../../src/adapter/ui/render/captures';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { captureItemsFrom } from '../../src/features/capture/capture-item';
import type { WaveProvider } from '../../src/adapter/platform/audio/wave-source';

const fm = (name: string, mime: string, key: string): string =>
  ['---', `attachment.name: ${name}`, `attachment.mime: ${mime}`, 'attachment.size: 1', `attachment.asset_key: ${key}`, '---', ''].join('\n');

const ITEMS = (): ReturnType<typeof captureItemsFrom> =>
  captureItemsFrom([
    { lid: 'a', title: 'a', body: `${fm('録音-2026-09-09-030102.webm', 'audio/webm', 'k-a')}\n0:30 はい\n1:00 ええ\n` },
    { lid: 'b', title: 'b', body: fm('録音-2026-09-09-040102.webm', 'audio/webm', 'k-b') },
    { lid: 'v', title: 'v', body: fm('画面収録-2026-09-09-030102.webm', 'video/webm', 'k-v') },
  ]);

const assets = {
  lend: async (k: string) => ({ url: `blob:${k}`, dispose: () => undefined }),
  getBlob: async () => new Blob([new Uint8Array(4)]),
};
const wave = (calls: string[] = []): WaveProvider => ({
  load: async (key) => {
    calls.push(key);
    return { peaks: new Float32Array([0.1, 0.9, 0.4]), durationMs: 120_000 };
  },
});
const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

function pane(source: WaveProvider | null): {
  host: HTMLElement;
  r: CapturesRenderer;
  paint: (s?: Partial<AppState>) => void;
} {
  const host = document.createElement('div');
  document.body.append(host);
  let cur = { ...initialState, captureItems: ITEMS() } as AppState;
  const r: CapturesRenderer = new CapturesRenderer(host, assets, () => r.render(cur), source);
  const paint = (s: Partial<AppState> = {}): void => {
    cur = { ...cur, ...s } as AppState;
    r.render(cur);
  };
  paint();
  return { host, r, paint };
}
const strips = (h: HTMLElement): HTMLElement[] => [...h.querySelectorAll<HTMLElement>('[data-pkc-region="capture-wave"]')];

afterEach(() => {
  baked.length = 0;
  bakedColors.length = 0;
  gate.wait = null;
  document.body.textContent = '';
});

describe('一覧の波形(#1232)', () => {
  it('鳴らしていない行・動画の行には帯を出さない(押していない録音の bytes を借りない)', async () => {
    const calls: string[] = [];
    const p = pane(wave(calls));
    await flush();
    p.paint(); // 何も鳴らしていない一覧を、もう一度描く
    await flush();
    expect(strips(p.host)).toHaveLength(0);
    expect(calls, '鳴らしていない録音の bytes を借りて復号している').toEqual([]);
    p.paint({ capturePlayingLid: 'v' });
    await flush();
    expect(strips(p.host)).toHaveLength(0);
    expect(calls, '動画の音まで復号している').toEqual([]);
  });

  it('音を鳴らすと、その行に帯が 1 本出て、焼いた画像が 1 枚載る', async () => {
    const calls: string[] = [];
    const p = pane(wave(calls));
    p.paint({ capturePlayingLid: 'a' });
    await flush();
    p.paint();
    const s = strips(p.host);
    expect(s).toHaveLength(1);
    expect(s[0]!.getAttribute('data-pkc-capture-wave')).toBe('a');
    expect(s[0]!.hidden).toBe(false);
    expect(s[0]!.getAttribute('data-pkc-duration-ms')).toBe('120000');
    expect(s[0]!.querySelectorAll('img')).toHaveLength(1);
    expect(s[0]!.querySelector('img')!.getAttribute('src')).toBe('blob:wave-1');
    expect(calls).toEqual(['k-a']);
  });

  it('文字起こしの行ごとに目盛りが 1 本(時刻の位置)', async () => {
    const p = pane(wave());
    p.paint({ capturePlayingLid: 'a' });
    await flush();
    p.paint();
    const ticks = [...p.host.querySelectorAll<HTMLElement>('[data-pkc-field="capture-wave-tick"]')];
    expect(ticks.map((t) => t.style.left)).toEqual(['25.000%', '50.000%']);
    // 再描画しても増えない
    p.paint({ filterQuery: '' });
    p.paint();
    expect(p.host.querySelectorAll('[data-pkc-field="capture-wave-tick"]')).toHaveLength(2);
  });

  it('文字起こしの無い録音には目盛りが無い', async () => {
    const p = pane(wave());
    p.paint({ capturePlayingLid: 'b' });
    await flush();
    p.paint();
    expect(strips(p.host)).toHaveLength(1);
    expect(p.host.querySelectorAll('[data-pkc-field="capture-wave-tick"]')).toHaveLength(0);
  });

  it('範囲は state の印から置く(ボタンで打った印も帯に映る)/ 外すと消える', async () => {
    const p = pane(wave());
    p.paint({ capturePlayingLid: 'a' });
    await flush();
    p.paint({ captureTrim: { lid: 'a', startMs: 30_000, endMs: 90_000 } });
    const range = p.host.querySelector<HTMLElement>('[data-pkc-field="capture-wave-range"]')!;
    expect(range.hidden).toBe(false);
    expect(range.style.left).toBe('25.000%');
    expect(range.style.width).toBe('50.000%');
    p.paint({ captureTrim: null });
    expect(range.hidden).toBe(true);
  });

  it('🔴 焼いた画像は寿命の終わりで返す: 別の行へ移る / やめる / 面を閉じる', async () => {
    const revoked: string[] = [];
    const spy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => void revoked.push(u));
    try {
      const p = pane(wave());
      p.paint({ capturePlayingLid: 'a' });
      await flush();
      expect(revoked).toEqual([]);
      p.paint({ capturePlayingLid: 'b' });
      expect(revoked, '別の行へ移ったのに前の画像を返していない').toEqual(['blob:wave-1']);
      await flush();
      p.paint({ capturePlayingLid: null });
      expect(revoked).toEqual(['blob:wave-1', 'blob:wave-2']);
      p.paint({ capturePlayingLid: 'a' });
      await flush();
      p.r.dispose();
      expect(revoked).toEqual(['blob:wave-1', 'blob:wave-2', 'blob:wave-3']);
    } finally {
      spy.mockRestore();
    }
  });

  it('焼いている間に別の行へ移ったら、古い結果は載せない', async () => {
    let release: (() => void) | undefined;
    const slow: WaveProvider = {
      load: () =>
        new Promise((resolve) => {
          release = () => resolve({ peaks: new Float32Array([0.5]), durationMs: 1000 });
        }),
    };
    const p = pane(slow);
    p.paint({ capturePlayingLid: 'a' });
    await flush();
    p.paint({ capturePlayingLid: 'b' }); // a の結果が来る前に移る
    release!();
    await flush();
    p.paint();
    expect(p.host.querySelector('[data-pkc-capture-wave="a"] img')).toBeNull();
    expect(baked, '古い結果を焼いている').toEqual([]);
  });

  it('波形の部品が無い(null)・読めない音(null)なら、帯は出ない(聞く・切り出すは止めない)', async () => {
    const none = pane(null);
    none.paint({ capturePlayingLid: 'a' });
    await flush();
    expect(strips(none.host)).toHaveLength(0);
    const bad = pane({ load: async () => null });
    bad.paint({ capturePlayingLid: 'a' });
    await flush();
    bad.paint();
    expect(bad.host.querySelectorAll('[data-pkc-field="capture-wave-img"]')).toHaveLength(0);
    // 🔴 場所は取ったまま、失敗の字が出る(黙って消えない)
    expect(strips(bad.host)).toHaveLength(1);
    expect(strips(bad.host)[0]!.hidden).toBe(false);
    expect(strips(bad.host)[0]!.textContent).toContain('この音は波形を出せません(ボタンでは切り出せます)');
    expect(bad.host.querySelector('[data-pkc-field="capture-trim-start"]')).not.toBeNull();
  });

  it('🔴 A → B → A と速く替えても、生きている URL は 1 つだけ(残りは全部返す)', async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const spy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => void revoked.push(u));
    try {
      const resolvers: Array<() => void> = [];
      const slow: WaveProvider = {
        load: () =>
          new Promise((resolve) => {
            resolvers.push(() => resolve({ peaks: new Float32Array([0.5]), durationMs: 1000 }));
          }),
      };
      const p = pane(slow);
      p.paint({ capturePlayingLid: 'a' });
      await flush();
      p.paint({ capturePlayingLid: 'b' });
      await flush();
      p.paint({ capturePlayingLid: 'a' });
      await flush();
      expect(resolvers).toHaveLength(3);
      // 1 本目(古い A)を焼いている最中に止める ── 栓を開けたとき世代はもう進んでいる
      let open!: () => void;
      gate.wait = new Promise<void>((r) => (open = r));
      resolvers[0]!();
      await flush();
      resolvers[1]!();
      resolvers[2]!();
      await flush();
      gate.wait = null;
      open();
      await flush();
      created.push(...baked);
      const alive = created.filter((u) => !revoked.includes(u));
      expect(alive, `生きている URL: ${JSON.stringify(alive)} / 作った: ${JSON.stringify(created)}`).toHaveLength(1);
      p.paint();
      expect(p.host.querySelectorAll('[data-pkc-capture-wave="a"] img')).toHaveLength(1);
      expect(p.host.querySelector('[data-pkc-capture-wave="a"] img')!.getAttribute('src')).toBe(alive[0]);
    } finally {
      spy.mockRestore();
    }
  });

  it('🔴 焼いている最中に別の行へ移って戻ったら、その古い絵は焼き上がった時点で返す', async () => {
    const revoked: string[] = [];
    const spy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => void revoked.push(u));
    try {
      const resolvers: Array<() => void> = [];
      const slow: WaveProvider = {
        load: () => new Promise((resolve) => void resolvers.push(() => resolve({ peaks: new Float32Array([0.5]), durationMs: 1000 }))),
      };
      const p = pane(slow);
      let open!: () => void;
      gate.wait = new Promise<void>((r) => (open = r));
      p.paint({ capturePlayingLid: 'a' });
      await flush();
      resolvers[0]!(); // 1 本目: 復号は済み、焼きの栓で止まる(世代はまだ有効)
      await flush();
      p.paint({ capturePlayingLid: 'b' });
      await flush();
      p.paint({ capturePlayingLid: 'a' });
      await flush();
      resolvers[1]!();
      resolvers[2]!();
      gate.wait = null;
      open();
      await flush();
      const alive = baked.filter((u) => !revoked.includes(u));
      expect(baked.length, '前提: 古い焼きが実際に走った').toBeGreaterThanOrEqual(2);
      expect(alive, `生きている URL: ${JSON.stringify(alive)}`).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('🔴 やめたあとに届いた結果は載せない(世代はやめた時点で進む)', async () => {
    const revoked: string[] = [];
    const spy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => void revoked.push(u));
    try {
      let go!: () => void;
      const slow: WaveProvider = {
        load: () => new Promise((resolve) => void (go = () => resolve({ peaks: new Float32Array([0.5]), durationMs: 1000 }))),
      };
      const p = pane(slow);
      p.paint({ capturePlayingLid: 'a' });
      await flush();
      p.paint({ capturePlayingLid: null });
      go();
      await flush();
      p.paint();
      expect(baked, 'やめたあとに焼いている').toEqual([]);
      expect(p.host.querySelector('img')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('🔴 作れなかった行は、行が替わるまで作り直さない(描くたびに復号し直さない)', async () => {
    const calls: string[] = [];
    const p = pane({
      load: async (k) => {
        calls.push(k);
        return null;
      },
    });
    p.paint({ capturePlayingLid: 'a' });
    await flush();
    for (let i = 0; i < 4; i++) {
      p.paint({ filterQuery: '' });
      p.paint();
      await flush();
    }
    expect(calls, '失敗した音を描くたびに復号し直している').toEqual(['k-a']);
    // 行が替われば別の音なので試す。戻ってきたらもう一度試す
    p.paint({ capturePlayingLid: 'b' });
    await flush();
    p.paint({ capturePlayingLid: 'a' });
    await flush();
    expect(calls).toEqual(['k-a', 'k-b', 'k-a']);
  });

  it('場所は最初から取り、作っている間は字、焼けたら絵に替わる(高さは動かない)/ 案内の字', async () => {
    let done!: () => void;
    const wait = new Promise<void>((r) => (done = r));
    const p = pane({
      load: async () => {
        await wait;
        return { peaks: new Float32Array([0.5]), durationMs: 120_000 };
      },
    });
    // 「音を聞く」の案内
    expect(p.host.querySelector<HTMLElement>('[data-pkc-capture="a"] [data-pkc-field="capture-play"]')!.title).toBe(
      '聞くと、下に波形が出ます。波形をなぞると切り出す範囲を選べます。',
    );
    p.paint({ capturePlayingLid: 'a' });
    await flush();
    p.paint();
    const strip = strips(p.host)[0]!;
    expect(strip.hidden).toBe(false);
    expect(strip.textContent).toContain('波形を作っています…');
    expect(strip.querySelector('img')).toBeNull();
    expect(p.host.querySelector('[data-pkc-field="capture-trim"]')!.textContent, '作っている間に案内を出している').not.toContain(
      '波形をなぞっても選べます',
    );
    // 目盛りがあるとき、帯の案内に一言
    expect(strip.title).toContain('下の小さい線は文字起こしの時刻です');
    const startBtn = p.host.querySelector('[data-pkc-field="capture-trim-start"]');
    expect(startBtn, '前提: 押し所が出ている').not.toBeNull();
    done();
    await flush();
    expect(p.host.querySelector('[data-pkc-field="capture-trim-start"]'), '波形が焼けたとき、押し所を作り替えた').toBe(startBtn);
    // ⚠ 描き直さずに見る ── 焼けた瞬間に帯と説明文が自分で追うこと(外から描き直されて初めて直る形にしない)
    const after = strips(p.host)[0]!;
    expect(after.querySelector('[data-pkc-field="capture-wave-status"]')!.hasAttribute('hidden')).toBe(true);
    expect(after.querySelector('img')).not.toBeNull();
    expect(p.host.querySelector('[data-pkc-field="capture-trim"]')!.textContent).toContain('波形をなぞっても選べます');
    // 範囲を決めたら案内は出さない
    p.paint({ captureTrim: { lid: 'a', startMs: 1000, endMs: null } });
    expect(p.host.querySelector('[data-pkc-field="capture-trim"]')!.textContent).not.toContain('波形をなぞっても選べます');
  });

  it('作れなかったときは「なぞっても選べます」を言わない / 目盛りの無い録音の帯の案内に目盛りの話が無い', async () => {
    const p = pane({ load: async () => null });
    p.paint({ capturePlayingLid: 'b' });
    await flush();
    p.paint();
    expect(p.host.querySelector('[data-pkc-field="capture-trim"]')!.textContent).not.toContain('なぞっても');
    expect(strips(p.host)[0]!.title).not.toContain('文字起こしの時刻');
  });

  it('🔴 配色が変わったら焼き直し、前の絵は返す', async () => {
    const revoked: string[] = [];
    const spy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => void revoked.push(u));
    try {
      const p = pane(wave());
      p.host.style.color = 'rgb(10, 10, 10)';
      p.paint({ capturePlayingLid: 'a' });
      await flush();
      p.paint();
      expect(baked).toHaveLength(1);
      p.host.style.color = 'rgb(240, 240, 240)';
      p.paint();
      await flush();
      p.paint();
      expect(baked, '配色が変わったのに焼き直していない').toHaveLength(2);
      expect(bakedColors[0]).not.toBe(bakedColors[1]);
      expect(revoked).toEqual(['blob:wave-1']);
      expect(p.host.querySelector('[data-pkc-capture-wave="a"] img')!.getAttribute('src')).toBe('blob:wave-2');
    } finally {
      spy.mockRestore();
    }
  });
});
