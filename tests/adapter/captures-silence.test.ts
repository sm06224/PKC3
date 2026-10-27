/** @vitest-environment happy-dom */
/**
 * 🔴 **「前後の無音を除く範囲にする」**(#1232。user 指示 2026-10-26「全部やるのです」)。
 *
 * 見るのは user が見て押せるもの:
 * ①波形ができるまでは押せず、理由が title に出る ②声の前後に無音が在れば押せて、押すと**既存の切り出しの印**(始まり・終わり)に入る
 * ③声が全体に在る(除く物が無い)・ほぼ無音のときは押せず、理由を言う ④動画の行・鳴らしていない行には出ない
 * ⑤入れた印は、既存の「この範囲で切り出す」で切れる(印の入口は 1 つ)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/adapter/ui/render/wave-bake', () => ({
  WAVE_HEIGHT: 40,
  bakeWavePng: async () => 'blob:wave',
}));

import { CapturesRenderer } from '../../src/adapter/ui/render/captures';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { captureItemsFrom } from '../../src/features/capture/capture-item';
import type { WaveProvider } from '../../src/adapter/platform/audio/wave-source';

const fm = (name: string, mime: string, key: string): string =>
  ['---', `attachment.name: ${name}`, `attachment.mime: ${mime}`, 'attachment.size: 1', `attachment.asset_key: ${key}`, '---', ''].join('\n');

const assets = {
  lend: async (k: string) => ({ url: `blob:${k}`, dispose: () => undefined }),
  getBlob: async () => new Blob([new Uint8Array(4)]),
};
const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

/** 100 秒・20 個の山。声は山 4〜15(= 20 秒〜80 秒)。 */
const VOICE_IN_MIDDLE = new Float32Array(20).map((_, i) => (i >= 4 && i <= 15 ? 0.6 : 0.002));
/** 波形の読み込みを手で止められる(できる前の様子を見るため)。 */
const hold: { wait: Promise<void> | null } = { wait: null };
const wave = (peaks: Float32Array): WaveProvider => ({
  load: async () => {
    if (hold.wait) await hold.wait;
    return { peaks, durationMs: 100_000 };
  },
});

function setup(peaks: Float32Array) {
  const host = document.createElement('div');
  document.body.append(host);
  const d = new Dispatcher();
  const items = captureItemsFrom([
    { lid: 'a', title: 'a', body: `${fm('録音-2026-09-09-030102.webm', 'audio/webm', 'k-a')}` },
    { lid: 'v', title: 'v', body: `${fm('画面収録-2026-09-09-030102.webm', 'video/webm', 'k-v')}` },
  ]);
  const r: CapturesRenderer = new CapturesRenderer(host, assets, () => r.render(d.getState()), wave(peaks));
  d.onState((s) => r.render(s));
  bindActions(host, d);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  // 一覧の元(`captureItems`)は集めて state に入る ── ここでは直に入れる
  (d as unknown as { state: unknown }).state = { ...d.getState(), captureItems: items };
  d.dispatch({ type: 'SET_CAPTURE_PLAYING', lid: 'a' });
  const btn = (): HTMLButtonElement | null => host.querySelector('[data-pkc-field="capture-trim-silence"]');
  return { host, d, btn };
}

afterEach(() => {
  hold.wait = null;
  document.body.textContent = '';
});

describe('前後の無音を除く範囲にする(#1232)', () => {
  it('🔴 波形ができる前は押せず、理由が title に出る', async () => {
    let release: () => void = () => {};
    hold.wait = new Promise<void>((r) => (release = r));
    const s = setup(VOICE_IN_MIDDLE);
    await flush();
    // 前提: 一覧の元が入って行と帯が描かれている(空振り防止)
    expect(s.host.querySelector('[data-pkc-capture="a"]'), '行が描かれていない').not.toBeNull();
    const b = s.btn();
    expect(b, 'ボタンが出ていない').not.toBeNull();
    expect(b!.disabled).toBe(true);
    expect(b!.title).toContain('波形を作っています');
    // 対照: 波形ができると、同じボタンが押せるようになる(帯を組み直さずに差し替わる)
    release();
    await flush();
    expect(s.btn(), '波形ができたのに、別のボタンに作り替わった').toBe(b);
    expect(b!.disabled).toBe(false);
  });

  it('🔴 声の前後に無音があれば押せ、押すと切り出しの印(始まり・終わり)に入る', async () => {
    const s = setup(VOICE_IN_MIDDLE);
    await flush();
    const b = s.btn()!;
    expect(b.disabled).toBe(false);
    // 声は 20 秒〜80 秒 ── 余白 0.3 秒を残す
    expect(b.getAttribute('data-pkc-start-ms')).toBe('19700');
    expect(b.getAttribute('data-pkc-end-ms')).toBe('80300');
    expect(b.title).toContain('0:19');
    b.click();
    expect(s.d.getState().captureTrim).toEqual({ lid: 'a', startMs: 19_700, endMs: 80_300 });
    // 印が入ると、既存の「この範囲で切り出す」が出る(切るのは 1 つの入口)
    expect(s.host.querySelector('[data-pkc-action="capture-trim-run"]'), '印が入ったのに切り出しの口が出ない').not.toBeNull();
  });

  it('前の印が残っていても、新しい範囲に置き換わる(逆転した片側だけが残らない)', async () => {
    const s = setup(VOICE_IN_MIDDLE);
    await flush();
    s.d.dispatch({ type: 'SET_CAPTURE_TRIM_MARK', edge: 'start', ms: 90_000 });
    s.btn()!.click();
    expect(s.d.getState().captureTrim).toEqual({ lid: 'a', startMs: 19_700, endMs: 80_300 });
  });

  it('🔴 声が全体にあるとき(除く物が無い)は押せず、理由を言う', async () => {
    const s = setup(new Float32Array(20).fill(0.5));
    await flush();
    expect(s.btn()!.disabled).toBe(true);
    expect(s.btn()!.title).toContain('除ける無音はありません');
    expect(s.btn()!.hasAttribute('data-pkc-start-ms')).toBe(false);
  });

  it('🔴 ほぼ無音のときは押せず、理由を言う', async () => {
    const s = setup(new Float32Array(20).fill(0.001));
    await flush();
    expect(s.btn()!.disabled).toBe(true);
    expect(s.btn()!.title).toContain('声が見つかりません');
  });

  it('片側だけ除けるとき(後ろだけ無音)は、前は 0 のまま', async () => {
    const s = setup(new Float32Array(20).map((_, i) => (i <= 9 ? 0.6 : 0.001)));
    await flush();
    expect(s.btn()!.getAttribute('data-pkc-start-ms')).toBe('0');
    expect(s.btn()!.getAttribute('data-pkc-end-ms')).toBe('50300');
  });

  it('動画の行・鳴らしていない行には出ない', async () => {
    const s = setup(VOICE_IN_MIDDLE);
    await flush();
    s.d.dispatch({ type: 'SET_CAPTURE_PLAYING', lid: 'v' });
    await flush();
    expect(s.btn(), '動画の行に無音を除くボタンが出ている').toBeNull();
    s.d.dispatch({ type: 'SET_CAPTURE_PLAYING', lid: null });
    expect(s.btn()).toBeNull();
  });
});
