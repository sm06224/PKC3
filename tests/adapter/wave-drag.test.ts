/** @vitest-environment happy-dom */
/**
 * 🔴 **波形の上のドラッグ**(#1232)── 決まる範囲は、ボタンが作る印と**同じ**であること。
 *
 * 見るのは 3 つ:①ドラッグ → 印(CSS で縮んだ幅でも位置が合う)②動かさず離す → 再生位置が移る
 * ③ボタンで打った印と、ドラッグで打った印が **同じ state** になる(切り出しの流れが同じ物を受け取る)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState } from '../../src/adapter/state/app-state';
import { bindWaveDrag } from '../../src/adapter/ui/actions/wave-drag';

const DURATION = 600_000; // 10 分
const LEFT = 100;
const WIDTH = 250; // 画像の画素幅(山 1000 個)は CSS で 250px に縮んでいる

function setup(over: { trimmable?: boolean } = {}): {
  root: HTMLElement;
  d: Dispatcher;
  strip: HTMLElement;
  media: HTMLMediaElement;
  off: () => void;
} {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.innerHTML = `<div data-pkc-region="browse-host">
    <ul><li data-pkc-capture="a">
      <audio data-pkc-field="capture-media"></audio>
      <div data-pkc-region="capture-wave" data-pkc-capture-wave="a" data-pkc-duration-ms="${String(DURATION)}"
        data-pkc-trimmable="${over.trimmable === false ? '0' : '1'}">
        <div data-pkc-field="capture-wave-range" hidden></div>
        <span data-pkc-field="capture-wave-label" hidden></span>
      </div>
      <span data-pkc-region="capture-trim-bar">
        <button data-pkc-action="capture-trim-start" type="button">s</button>
        <button data-pkc-action="capture-trim-end" type="button">e</button>
      </span>
    </li></ul></div>`;
  document.body.append(root);
  const d = new Dispatcher({ ...initialState, phase: 'ready', selectedLid: 'n1', capturePlayingLid: 'a' });
  const strip = root.querySelector<HTMLElement>('[data-pkc-region="capture-wave"]')!;
  strip.getBoundingClientRect = () =>
    ({ left: LEFT, width: WIDTH, right: LEFT + WIDTH, top: 0, bottom: 40, height: 40, x: LEFT, y: 0 }) as DOMRect;
  const media = root.querySelector<HTMLMediaElement>('audio')!;
  const off = bindActions(root, d);
  return { root, d, strip, media, off };
}

const ptr = (type: string, x: number, y = 20, id = 1): Event => {
  const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(e, 'pointerId', { value: id });
  return e;
};
const drag = (strip: HTMLElement, from: number, to: number): void => {
  strip.dispatchEvent(ptr('pointerdown', from));
  strip.dispatchEvent(ptr('pointermove', (from + to) / 2));
  strip.dispatchEvent(ptr('pointermove', to));
  strip.dispatchEvent(ptr('pointerup', to));
};
const xOf = (ms: number): number => LEFT + (ms / DURATION) * WIDTH;

afterEach(() => {
  document.body.textContent = '';
});

describe('波形のドラッグ ── 印になる(#1232)', () => {
  it('ドラッグした範囲が、始まり・終わりの印に入る(CSS で縮んだ幅でも位置が合う)', () => {
    const t = setup();
    drag(t.strip, xOf(120_000), xOf(300_000));
    const m = t.d.getState().captureTrim!;
    expect(m.lid).toBe('a');
    // 250px で 10 分 = 1px が 2400ms。丸め誤差はその範囲内
    expect(Math.abs(m.startMs! - 120_000)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.endMs! - 300_000)).toBeLessThanOrEqual(1);
    t.off();
  });

  it('右から左へ引いても、小さいほうが始まりになる', () => {
    const t = setup();
    drag(t.strip, xOf(300_000), xOf(120_000));
    const m = t.d.getState().captureTrim!;
    expect(m.startMs).toBeLessThan(m.endMs!);
    expect(Math.abs(m.startMs! - 120_000)).toBeLessThanOrEqual(1);
    t.off();
  });

  it('🔴 ボタンで打った印と、同じ state になる(切り出しが受け取るものが同じ)', () => {
    const a = setup();
    // ボタン経路: 再生位置を 2:00 にして「始まり」、5:00 にして「終わり」
    a.media.currentTime = 120;
    a.root.querySelector<HTMLElement>('[data-pkc-action="capture-trim-start"]')!.click();
    a.media.currentTime = 300;
    a.root.querySelector<HTMLElement>('[data-pkc-action="capture-trim-end"]')!.click();
    const viaButtons = a.d.getState().captureTrim;
    a.off();

    const b = setup();
    drag(b.strip, xOf(120_000), xOf(300_000));
    const viaDrag = b.d.getState().captureTrim;
    b.off();
    expect(viaButtons).toEqual({ lid: 'a', startMs: 120_000, endMs: 300_000 });
    expect(viaDrag!.lid).toBe(viaButtons!.lid);
    expect(Math.abs(viaDrag!.startMs! - viaButtons!.startMs!)).toBeLessThanOrEqual(1);
    expect(Math.abs(viaDrag!.endMs! - viaButtons!.endMs!)).toBeLessThanOrEqual(1);
  });

  it('前の印が新しい範囲と交差しても、最後は引いた範囲になる(逆転を残さない)', () => {
    const t = setup();
    drag(t.strip, xOf(100_000), xOf(200_000));
    drag(t.strip, xOf(400_000), xOf(500_000));
    const m = t.d.getState().captureTrim!;
    expect(Math.abs(m.startMs! - 400_000)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.endMs! - 500_000)).toBeLessThanOrEqual(1);
    drag(t.strip, xOf(10_000), xOf(50_000));
    const n = t.d.getState().captureTrim!;
    expect(Math.abs(n.startMs! - 10_000)).toBeLessThanOrEqual(1);
    expect(Math.abs(n.endMs! - 50_000)).toBeLessThanOrEqual(1);
    t.off();
  });

  it('ドラッグ中は state に触らない(離して初めて印になる)/ 重ね描きと時刻は動く', () => {
    const t = setup();
    t.strip.dispatchEvent(ptr('pointerdown', xOf(60_000)));
    t.strip.dispatchEvent(ptr('pointermove', xOf(180_000)));
    expect(t.d.getState().captureTrim, '離す前に印になっている').toBeNull();
    const range = t.strip.querySelector<HTMLElement>('[data-pkc-field="capture-wave-range"]')!;
    expect(range.hidden).toBe(false);
    expect(parseFloat(range.style.left)).toBeCloseTo(10, 0);
    expect(parseFloat(range.style.width)).toBeCloseTo(20, 0);
    expect(t.strip.querySelector('[data-pkc-field="capture-wave-label"]')!.textContent).toBe('1:00〜3:00');
    t.strip.dispatchEvent(ptr('pointerup', xOf(180_000)));
    expect(t.d.getState().captureTrim).not.toBeNull();
    t.off();
  });

  it('動かさずに離したら印は付かず、その位置へ再生が移る', () => {
    const t = setup();
    drag(t.strip, xOf(240_000), xOf(240_000));
    expect(t.d.getState().captureTrim).toBeNull();
    expect(Math.abs(t.media.currentTime - 240)).toBeLessThan(0.01);
    t.off();
  });

  /**
   * 🔴 **一時停止中に押したときも、その位置から鳴らす**(台帳 #1852 束 O1 / 依頼 354 A。Gemini 回答 = 推薦どおり)。
   * 直す前は、波形に指を乗せると「押すとその位置から再生します」と出るのに、一時停止中に押すと位置が動くだけで鳴らなかった。
   */
  describe('一時停止中の波形の押下(依頼 354 A)', () => {
    const stub = (media: HTMLMediaElement, paused: boolean, played: Promise<void> = Promise.resolve()) => {
      Object.defineProperty(media, 'paused', { configurable: true, get: () => paused });
      const at: number[] = [];
      const play = vi.fn(() => {
        at.push(media.currentTime);
        return played;
      });
      media.play = play as never;
      return { play, at };
    };

    it('🔴 一時停止中: 押した位置へ移ってから鳴らす(位置は play の前に書く)', () => {
      const t = setup();
      const { play, at } = stub(t.media, true);
      drag(t.strip, xOf(240_000), xOf(240_000));
      expect(play, '一時停止中に押しても鳴らない').toHaveBeenCalledTimes(1);
      expect(Math.abs(at[0]! - 240), 'play の時点で押した位置に居ない(先頭から鳴って飛ぶ)').toBeLessThan(0.01);
      t.off();
    });

    it('⚠ 対照群 ── 鳴っているときは位置を移すだけで、play し直さない', () => {
      const t = setup();
      const { play } = stub(t.media, false);
      drag(t.strip, xOf(240_000), xOf(240_000));
      expect(Math.abs(t.media.currentTime - 240)).toBeLessThan(0.01);
      expect(play).not.toHaveBeenCalled();
      t.off();
    });

    it('⚠ 対照群 ── ドラッグ(範囲を決める)では鳴らさない', () => {
      const t = setup();
      const { play } = stub(t.media, true);
      drag(t.strip, xOf(120_000), xOf(300_000));
      expect(play, '範囲を決めただけで鳴り出した').not.toHaveBeenCalled();
      t.off();
    });

    it('鳴らせなかったら(自動再生が許されない等)理由を言う。押し直しの AbortError は言わない', async () => {
      const refused = setup();
      stub(refused.media, true, Promise.reject(new DOMException('no', 'NotAllowedError')));
      drag(refused.strip, xOf(60_000), xOf(60_000));
      await new Promise((r) => setTimeout(r, 0));
      expect(refused.d.getState().notice).toBe('再生を始められませんでした');
      refused.off();
      const aborted = setup();
      stub(aborted.media, true, Promise.reject(new DOMException('again', 'AbortError')));
      drag(aborted.strip, xOf(60_000), xOf(60_000));
      await new Promise((r) => setTimeout(r, 0));
      expect(aborted.d.getState().notice ?? '', '押し直しを失敗として言った').toBe('');
      aborted.off();
    });
  });

  it('切り出せない行(trimmable=0)は、ドラッグしても印は付かない(押せば移る)', () => {
    const t = setup({ trimmable: false });
    drag(t.strip, xOf(120_000), xOf(300_000));
    expect(t.d.getState().captureTrim).toBeNull();
    t.off();
  });

  it('切り出している最中は、印を打ち替えない', () => {
    const t = setup();
    t.d.dispatch({ type: 'SET_CAPTURE_TRIM_BUSY', busy: true });
    drag(t.strip, xOf(120_000), xOf(300_000));
    expect(t.d.getState().captureTrim).toBeNull();
    t.off();
  });

  it('取りやめ(pointercancel)では印を付けない', () => {
    const t = setup();
    t.strip.dispatchEvent(ptr('pointerdown', xOf(60_000)));
    t.strip.dispatchEvent(ptr('pointermove', xOf(180_000)));
    t.strip.dispatchEvent(ptr('pointercancel', xOf(180_000)));
    expect(t.d.getState().captureTrim).toBeNull();
    t.off();
  });

  it('🔴 波形を押しても、中央に開いているノートは閉じない(「何も無い所を押すと閉じる」に当たらない)', () => {
    const t = setup();
    // 対照群: 行の余白(何も無い所)を押すと閉じる ── この門が生きていること
    t.root.querySelector<HTMLElement>('li')!.click();
    expect(t.d.getState().selectedLid, '前提が崩れている(余白を押しても閉じない)').toBeNull();
    t.off();
    const u = setup();
    drag(u.strip, xOf(120_000), xOf(300_000));
    u.strip.click();
    expect(u.d.getState().selectedLid, '波形を押したら、開いていたノートが閉じた').toBe('n1');
    u.off();
  });

  it('🔴 別のポインタ(2 本目の指)の動き・離す・押すは、ドラッグに混ざらない', () => {
    const t = setup();
    t.strip.dispatchEvent(ptr('pointerdown', xOf(60_000), 20, 1));
    // 2 本目の指が押されても、ドラッグは作り直されない
    t.strip.dispatchEvent(ptr('pointerdown', xOf(500_000), 20, 2));
    t.strip.dispatchEvent(ptr('pointermove', xOf(180_000), 20, 1));
    t.strip.dispatchEvent(ptr('pointermove', xOf(500_000), 20, 2));
    // 見た目(範囲の重ね描き)も 1 本目だけを追う: 60k〜180k = 長さの 20%
    const range = t.strip.querySelector<HTMLElement>('[data-pkc-field="capture-wave-range"]')!;
    expect(parseFloat(range.style.width), '2 本目の動きで範囲が伸びた').toBeCloseTo(20, 0);
    // 2 本目が離れても、1 本目のドラッグは終わらない
    t.strip.dispatchEvent(ptr('pointerup', xOf(500_000), 20, 2));
    expect(t.d.getState().captureTrim, '別のポインタが離れただけで確定した').toBeNull();
    t.strip.dispatchEvent(ptr('pointercancel', xOf(500_000), 20, 2));
    expect(t.d.getState().captureTrim, '別のポインタの取りやめで終わった').toBeNull();
    expect(t.media.currentTime, '2 本目の指が「押しただけ」として再生位置を動かした').toBe(0);
    t.strip.dispatchEvent(ptr('pointerup', xOf(180_000), 20, 1));
    const m = t.d.getState().captureTrim!;
    expect(Math.abs(m.startMs! - 60_000)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.endMs! - 180_000)).toBeLessThanOrEqual(1);
    t.off();
  });

  it('🔴 縦に動き出したらドラッグをやめる(縦スクロールを奪わない)/ 横なら続ける', () => {
    const t = setup();
    t.strip.dispatchEvent(ptr('pointerdown', xOf(60_000), 20, 1));
    t.strip.dispatchEvent(ptr('pointermove', xOf(62_000), 60, 1)); // 縦 40px・横わずか
    t.strip.dispatchEvent(ptr('pointermove', xOf(300_000), 60, 1));
    t.strip.dispatchEvent(ptr('pointerup', xOf(300_000), 60, 1));
    expect(t.d.getState().captureTrim, '縦に動いた操作が範囲になった').toBeNull();
    // やめたあとは次のドラッグが普通に通る(「ドラッグ中」が残らない)
    drag(t.strip, xOf(100_000), xOf(200_000));
    expect(t.d.getState().captureTrim).not.toBeNull();
    // 横に動き出したあとの縦のぶれでは、やめない
    const u = setup();
    u.strip.dispatchEvent(ptr('pointerdown', xOf(60_000), 20, 1));
    // 最初の動きが斜めでも、横のほうが大きければ範囲選び(縦に 10px 動いても取りやめない)
    u.strip.dispatchEvent(ptr('pointermove', xOf(120_000), 30, 1));
    u.strip.dispatchEvent(ptr('pointermove', xOf(180_000), 80, 1));
    u.strip.dispatchEvent(ptr('pointerup', xOf(180_000), 80, 1));
    expect(u.d.getState().captureTrim).not.toBeNull();
    t.off();
    u.off();
  });

  it('一覧が作り直されて帯が消えても、次のドラッグは止まらない', () => {
    const t = setup();
    t.strip.dispatchEvent(ptr('pointerdown', xOf(60_000), 20, 1));
    t.strip.remove(); // pointerup は届かない
    const fresh = t.root.ownerDocument.createElement('div');
    fresh.innerHTML = t.strip.outerHTML;
    const strip2 = fresh.firstElementChild as HTMLElement;
    strip2.getBoundingClientRect = t.strip.getBoundingClientRect;
    t.root.querySelector('li')!.append(strip2);
    drag(strip2, xOf(100_000), xOf(200_000));
    expect(t.d.getState().captureTrim, '消えた帯の「ドラッグ中」が残って、次が無視された').not.toBeNull();
    t.off();
  });

  it('解除すると以後のドラッグは何もしない', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    root.innerHTML = `<div data-pkc-region="capture-wave" data-pkc-duration-ms="1000" data-pkc-trimmable="1"></div>`;
    document.body.append(root);
    const d = new Dispatcher({ ...initialState, capturePlayingLid: 'a' });
    const strip = root.firstElementChild as HTMLElement;
    strip.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;
    const off = bindWaveDrag(root, d);
    off();
    drag(strip, 10, 80);
    expect(d.getState().captureTrim).toBeNull();
  });
});
