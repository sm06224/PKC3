/** @vitest-environment happy-dom */
/**
 * 🔴 **左端の縦のバーの近接発光**(#1982 ③-a-2。user 裁定 2026-11-22 = G1)。
 *
 * 守る主張(user 指示「`hover: none` / `pointer: coarse` / `prefers-reduced-motion` / スマホ幅ではリスナー自体を付けない」):
 * 1. 光らせてよい環境では、バーに `pointerenter` / `pointerleave` だけを付け、`pointermove` は**入っている間だけ**付ける
 * 2. 付けない環境(問いが偽 / `matchMedia` が無い・投げる / スマホ用画面)では、**リスナーを 1 つも付けない**
 * 3. 動かすと位置の変数がバーからの相対で入り、出ると印と `pointermove` が外れる(1 コマに 1 回)
 * 4. 環境が変わる(動きを減らす設定を入れる)と外れ、戻すと付く ── 何度呼んでも二重に付かない
 * 5. CSS: 地は `--fg` の 10%(色相なし)・印の間だけ・`filter` を使わない
 *
 * ⚠ 描画の負荷は実ブラウザで測った(PR の本文)。ここは付け外しの規則だけを見る。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GLOW_ATTR, GLOW_FIELD, GLOW_QUERY, railGlowActive, syncRailGlow } from '../../src/adapter/ui/render/rail-glow';
import { blocksFor, stripComments, withoutMedia } from '../helpers/css-blocks';

type Fn = () => void;
function media(matches: boolean) {
  const subs = new Set<Fn>();
  const m = {
    matches,
    addEventListener: (_: 'change', fn: Fn) => void subs.add(fn),
    removeEventListener: (_: 'change', fn: Fn) => void subs.delete(fn),
    set(v: boolean) {
      m.matches = v;
      for (const fn of subs) fn();
    },
    subs,
  };
  return m;
}

/** バーに付いたリスナーを種類ごとに数える(付けた - 外した)。 */
function counted(rail: HTMLElement) {
  const n: Record<string, number> = {};
  const add = rail.addEventListener.bind(rail);
  const remove = rail.removeEventListener.bind(rail);
  vi.spyOn(rail, 'addEventListener').mockImplementation((t: string, l: EventListenerOrEventListenerObject, o?: boolean | AddEventListenerOptions) => {
    n[t] = (n[t] ?? 0) + 1;
    add(t, l, o);
  });
  vi.spyOn(rail, 'removeEventListener').mockImplementation((t: string, l: EventListenerOrEventListenerObject, o?: boolean | EventListenerOptions) => {
    n[t] = (n[t] ?? 0) - 1;
    remove(t, l, o);
  });
  return n;
}

function makeRail(): HTMLElement {
  const rail = document.createElement('div');
  rail.setAttribute('data-pkc-region', 'rail');
  document.body.append(rail);
  vi.spyOn(rail, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 100, width: 40, height: 600, right: 40, bottom: 700, x: 0, y: 100, toJSON: () => ({}) } as DOMRect);
  return rail;
}
const pointer = (type: string, x: number, y: number): PointerEvent =>
  new (globalThis.PointerEvent ?? MouseEvent)(type, { clientX: x, clientY: y, bubbles: false }) as PointerEvent;

beforeEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('付ける環境 / 付けない環境', () => {
  it('🔴 問いは 3 条件(マウスあり・細かい指し示し・動きを減らさない)を 1 本で聞く', () => {
    expect(GLOW_QUERY).toContain('(hover: hover)');
    expect(GLOW_QUERY).toContain('(pointer: fine)');
    expect(GLOW_QUERY).toContain('(prefers-reduced-motion: no-preference)');
  });

  it('🔴 光らせてよい環境: enter / leave だけを付け、move は入っている間だけ', () => {
    const rail = makeRail();
    const n = counted(rail);
    syncRailGlow(rail, false, () => media(true));
    expect(railGlowActive(rail)).toBe(true);
    expect(n.pointerenter).toBe(1);
    expect(n.pointerleave).toBe(1);
    expect(n.pointermove ?? 0, '入る前から move を聞いている(定常の仕事)').toBe(0);
    rail.dispatchEvent(pointer('pointerenter', 20, 150));
    expect(n.pointermove, '入っても move を聞かない').toBe(1);
    rail.dispatchEvent(pointer('pointerleave', 50, 150));
    expect(n.pointermove, '出ても move を外さない').toBe(0);
  });

  it.each([
    ['問いが偽(マウスの無い端末 / 指の端末 / 動きを減らす設定)', () => media(false)],
    ['matchMedia が無い器', null],
    [
      'matchMedia が投げる器',
      () => {
        throw new Error('sandbox');
      },
    ],
  ] as const)('🔴 %s ではリスナーを 1 つも付けない', (_name, mm) => {
    const rail = makeRail();
    const n = counted(rail);
    syncRailGlow(rail, false, mm as never);
    expect(railGlowActive(rail)).toBe(false);
    rail.dispatchEvent(pointer('pointerenter', 20, 150));
    expect(rail.querySelector(`[data-pkc-field="${GLOW_FIELD}"]`), '付けない環境で DOM を変えた').toBeNull();
    expect(Object.values(n).filter((v) => v !== 0), `付けた: ${JSON.stringify(n)}`).toEqual([]);
  });

  it('🔴 スマホ用画面ではリスナーを 1 つも付けず、PC へ戻すと付く(往復)', () => {
    const rail = makeRail();
    const n = counted(rail);
    const m = media(true);
    syncRailGlow(rail, true, () => m);
    expect(Object.values(n).filter((v) => v !== 0), 'スマホで付けた').toEqual([]);
    syncRailGlow(rail, false, () => m);
    expect(n.pointerenter, 'PC へ戻しても付かない').toBe(1);
    syncRailGlow(rail, true, () => m);
    expect(n.pointerenter, 'スマホへ戻したのに外れない').toBe(0);
  });

  it('🔴 環境が変わると外れ、戻すと付く ── 何度呼んでも二重に付かない', () => {
    const rail = makeRail();
    const n = counted(rail);
    const m = media(true);
    syncRailGlow(rail, false, () => m);
    syncRailGlow(rail, false, () => m);
    syncRailGlow(rail, false, () => m);
    expect(n.pointerenter, '呼ぶたびに重ねて付けた').toBe(1);
    rail.dispatchEvent(pointer('pointerenter', 20, 150));
    m.set(false); // 動きを減らす設定を入れた
    expect(railGlowActive(rail)).toBe(false);
    expect(n.pointerenter).toBe(0);
    expect(n.pointermove ?? 0, '入っている最中に設定を変えても move が残った').toBe(0);
    expect(rail.hasAttribute(GLOW_ATTR), '印が残った').toBe(false);
    m.set(true);
    expect(n.pointerenter).toBe(1);
  });
});

describe('動かしたとき', () => {
  it('🔴 位置はバーからの相対で入り、出ると印が外れる', () => {
    const rail = makeRail();
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    syncRailGlow(rail, false, () => media(true));
    rail.dispatchEvent(pointer('pointerenter', 20, 150));
    rail.dispatchEvent(pointer('pointermove', 22, 160));
    rail.dispatchEvent(pointer('pointermove', 24, 170));
    // 🔴 1 コマに 1 回 ── 3 回動いても予約は 1 つ
    expect(frames.length, '動くたびに描き直しを予約している').toBe(1);
    expect(rail.hasAttribute(GLOW_ATTR), '描く前から印が付いた').toBe(false);
    frames.shift()!(0);
    // 🔴 動かすのは光の要素の transform だけ(バーに変数を書くと子孫全部の style を計算し直す ── 実測で約 1.2 秒 / 600 回)
    const layer = rail.querySelector<HTMLElement>(`[data-pkc-field="${GLOW_FIELD}"]`)!;
    expect(layer, '光の要素が無い').not.toBeNull();
    expect(layer.style.transform, '位置がバーからの相対(中心 = ポインタ)でない').toBe('translate(-48px, -2px)');
    expect(rail.getAttribute('style') ?? '', 'バーに位置の変数を書いている(子孫の再計算を起こす)').not.toMatch(/--pkc-glow/);
    expect(rail.hasAttribute(GLOW_ATTR)).toBe(true);
    rail.dispatchEvent(pointer('pointerleave', 60, 170));
    expect(rail.hasAttribute(GLOW_ATTR), '出ても光が残った').toBe(false);
  });
});

describe('CSS(原文)', () => {
  const css = withoutMedia(stripComments(readFileSync(join(__dirname, '../../src/styles/app.css'), 'utf-8')));
  it('🔴 光は `--fg` の 10%(色相なし)・ボタンの下・印の間だけ見える・filter を使わない・合成だけで動く', () => {
    const rule = blocksFor(css, `[data-pkc-field='${GLOW_FIELD}']`).join('\n');
    expect(rule, '光の規則が無い').toMatch(/radial-gradient\(/);
    expect(rule).toMatch(/color-mix\(in srgb,\s*var\(--fg\)\s*10%,\s*transparent\)/);
    expect(rule, 'アクセント色を使っている(色は意味にだけ)').not.toMatch(/--accent/);
    expect(rule, 'filter を使っている(重い)').not.toMatch(/filter\s*:/);
    expect(rule, '光がボタンの上に乗る').toMatch(/z-index:\s*-1/);
    expect(rule, '光が押し所を奪う').toMatch(/pointer-events:\s*none/);
    expect(rule, '印が無くても見えている').toMatch(/opacity:\s*0/);
    expect(rule).toMatch(/width:\s*144px/);
    const on = blocksFor(css, `[data-pkc-region='rail'][${GLOW_ATTR}] [data-pkc-field='${GLOW_FIELD}']`).join('\n');
    expect(on, '印の間に見せる規則が無い').toMatch(/opacity:\s*1/);
    // バーは重なりの基準(光をボタンの下に敷くため)
    expect(blocksFor(css, "[data-pkc-region='rail']").join('\n')).toMatch(/isolation:\s*isolate/);
  });
});
