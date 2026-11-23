/** @vitest-environment happy-dom */
/**
 * 🔴 **輪郭の近接発光(ネオン)**(B2)── 付け外し・近いカードへの書き込み・測り直し・CSS の原文。
 *
 * 守る主張:
 * 1. 付けない環境(問いが偽 / `matchMedia` が無い・投げる / スマホ用画面 / `requestAnimationFrame` が無い)では、
 *    **`pointerover` も観測器も `scroll` / `resize` も 1 つも付けない**(残るのは環境の変化を聞く `change` だけ)
 * 2. 付ける環境でも `pointermove` などは**ゾーンに入っている間だけ**。出ると全部外れ、観測器も止まる
 * 3. 近いカード(半径内)にだけ印と局所座標が付き、遠いカード・出たカードからは消える(1 コマに 1 回)
 * 4. 矩形は**汚れの印が立つまで測り直さない**。子の追加・削除 / スクロール / ウィンドウの大きさで汚れ、**次のコマ**で測り直す
 *    (同期では測らない。スクロールしてもポインタが止まっていればそのコマで位置が追いつく)。自分の書き込みでは汚れない
 * 5. CSS: 半径が `NEON_RADIUS` と一致・疑似要素は画面だけ + 強制色なし・`background-attachment: fixed` / `filter` を使わない
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createNeonGlow, GLOW_QUERY, NEAR_ATTR, NEON_ZONES, type NeonGlow } from '../../src/adapter/ui/render/neon-glow';
import { NEON_RADIUS } from '../../src/features/neon/near-cards';
import { atBlock, blocksFor, stripComments } from '../helpers/css-blocks';

type Fn = () => void;
function media(matches: boolean) {
  const subs = new Set<Fn>();
  const m = {
    matches,
    addEventListener: (_: 'change', fn: Fn) => void subs.add(fn),
    removeEventListener: (_: 'change', fn: Fn) => void subs.delete(fn),
    set(v: boolean) {
      m.matches = v;
      for (const fn of [...subs]) fn();
    },
    subs,
  };
  return m;
}

const pointer = (type: string, x: number, y: number, bubbles = true): PointerEvent =>
  new (globalThis.PointerEvent ?? MouseEvent)(type, { clientX: x, clientY: y, bubbles }) as PointerEvent;

let frames: FrameRequestCallback[] = [];
const runFrame = (): void => {
  const f = frames;
  frames = [];
  for (const cb of f) cb(0);
};
const microtasks = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 観測器の差し替え(付け外しを数える)。 */
let observers: { kind: 'mo' | 'ro'; connected: boolean }[] = [];
let roCallbacks: ((entries: { target: Element }[]) => void)[] = [];
let roObserved = new Set<Element>();
class FakeRO {
  rec = { kind: 'ro' as const, connected: false };
  constructor(cb: (entries: { target: Element }[]) => void) {
    roCallbacks.push(cb);
    observers.push(this.rec);
  }
  observe(el: Element): void {
    this.rec.connected = true;
    roObserved.add(el);
  }
  unobserve(el: Element): void {
    roObserved.delete(el);
  }
  disconnect(): void {
    this.rec.connected = false;
    roObserved.clear();
  }
}

interface Rig {
  zone: HTMLElement;
  cards: HTMLElement[];
  rects: Map<HTMLElement, { left: number; top: number; width: number; height: number }>;
  measured: () => number;
}

/** ログ型のゾーンに、縦に並んだカード(高さ 50・間 10)を作る。 */
function makeLog(n = 3): Rig {
  document.body.innerHTML = '';
  const zone = document.createElement('div');
  zone.setAttribute('data-pkc-log-days', '');
  document.body.append(zone);
  const rects: Rig['rects'] = new Map();
  let count = 0;
  const cards: HTMLElement[] = [];
  const add = (top: number): HTMLElement => {
    const el = document.createElement('p');
    el.setAttribute('data-pkc-log-card', 'solo');
    rects.set(el, { left: 100, top, width: 400, height: 50 });
    el.getBoundingClientRect = () => {
      count += 1;
      const r = rects.get(el)!;
      return { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height, width: r.width, height: r.height, x: r.left, y: r.top, toJSON: () => ({}) } as DOMRect;
    };
    zone.append(el);
    cards.push(el);
    return el;
  };
  for (let i = 0; i < n; i += 1) add(100 + i * 60);
  (zone as unknown as { __add: typeof add }).__add = add;
  return { zone, cards, rects, measured: () => count };
}
const addCard = (rig: Rig, top: number): HTMLElement => (rig.zone as unknown as { __add: (t: number) => HTMLElement }).__add(top);

let glow: NeonGlow | null = null;
const origElementFromPoint = document.elementFromPoint;
beforeEach(() => {
  frames = [];
  observers = [];
  roCallbacks = [];
  roObserved = new Set();
  vi.restoreAllMocks();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
    frames = [];
  });
  vi.stubGlobal('ResizeObserver', FakeRO);
});
afterEach(() => {
  document.elementFromPoint = origElementFromPoint;
  glow?.destroy();
  glow = null;
  vi.unstubAllGlobals();
});

/** document / window / zone に付いたリスナーを(種類ごとに)数える(付けた - 外した)。 */
function counting(...targets: EventTarget[]): Record<string, number> {
  const n: Record<string, number> = {};
  for (const t of targets) {
    const add = t.addEventListener.bind(t);
    const remove = t.removeEventListener.bind(t);
    vi.spyOn(t, 'addEventListener').mockImplementation((type: string, l: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions) => {
      n[type] = (n[type] ?? 0) + 1;
      add(type, l, o);
    });
    vi.spyOn(t, 'removeEventListener').mockImplementation((type: string, l: EventListenerOrEventListenerObject | null, o?: boolean | EventListenerOptions) => {
      n[type] = (n[type] ?? 0) - 1;
      remove(type, l, o);
    });
  }
  return n;
}
const live = (n: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(n).filter(([, v]) => v !== 0));

describe('付ける環境 / 付けない環境', () => {
  it('🔴 問いは 3 条件(マウスあり・細かい指し示し・動きを減らさない)を 1 本で聞く', () => {
    expect(GLOW_QUERY).toContain('(hover: hover)');
    expect(GLOW_QUERY).toContain('(pointer: fine)');
    expect(GLOW_QUERY).toContain('(prefers-reduced-motion: no-preference)');
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
  ] as const)('🔴 %s ではリスナーも観測器も 1 つも付けない', async (_n, mm) => {
    const rig = makeLog();
    const n = counting(document, window, rig.zone);
    glow = createNeonGlow(document, mm as never);
    expect(glow.listening()).toBe(false);
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 120, 110));
    rig.zone.dispatchEvent(pointer('pointermove', 125, 112, false));
    await microtasks();
    expect(live(n), `付けた: ${JSON.stringify(n)}`).toEqual({});
    expect(observers, '観測器を作った').toEqual([]);
    expect(document.querySelector(`[${NEAR_ATTR}]`), '付けない環境で印を書いた').toBeNull();
    expect(frames, '描き直しを予約した').toEqual([]);
  });

  it('🔴 スマホ用画面では付けず、PC へ戻すと付く(往復)── 何度呼んでも二重に付かない', () => {
    const rig = makeLog();
    const n = counting(document);
    const m = media(true);
    glow = createNeonGlow(document, () => m);
    expect(n.pointerover).toBe(1);
    glow.setPhone(true);
    expect(n.pointerover, 'スマホで外れない').toBe(0);
    glow.setPhone(true);
    glow.setPhone(false);
    glow.setPhone(false);
    expect(n.pointerover, '戻しても付かない / 二重に付いた').toBe(1);
    void rig;
  });

  it('🔴 環境が変わると(動きを減らす設定を入れる)ゾーンの中でも全部外れ・印が消え、戻すと付く', () => {
    const rig = makeLog();
    const nd = counting(document, window, rig.zone);
    const m = media(true);
    glow = createNeonGlow(document, () => m);
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 120, 110));
    runFrame();
    expect(rig.cards[0]!.hasAttribute(NEAR_ATTR)).toBe(true);
    expect(glow.inZone()).toBe(true);
    m.set(false);
    expect(glow.listening()).toBe(false);
    expect(glow.inZone()).toBe(false);
    expect(live(nd), `残ったリスナー: ${JSON.stringify(nd)}`).toEqual({});
    expect(observers.every((o) => !o.connected), '観測器が残った').toBe(true);
    expect(rig.cards[0]!.hasAttribute(NEAR_ATTR), '印が残った').toBe(false);
    expect(rig.cards[0]!.style.getPropertyValue('--gx'), '座標が残った').toBe('');
    m.set(true);
    expect(glow.listening()).toBe(true);
  });
});

describe('ゾーンの出入り', () => {
  it('🔴 pointermove / scroll / resize / 観測器はゾーンに入っている間だけ。出ると全部外れる', () => {
    const rig = makeLog();
    const m = media(true);
    glow = createNeonGlow(document, () => m);
    const n = counting(document, window, rig.zone);
    expect(glow.inZone()).toBe(false);
    // 外の要素へ入っても何も付かない
    document.body.dispatchEvent(pointer('pointerover', 5, 5));
    expect(live(n)).toEqual({});
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 120, 110));
    expect(n.pointermove).toBe(1);
    expect(n.pointerleave).toBe(1);
    expect(n.scroll).toBe(1);
    expect(n.resize).toBe(1);
    expect(observers.filter((o) => o.connected).length, 'ResizeObserver を付けていない').toBe(1);
    rig.zone.dispatchEvent(pointer('pointerleave', 5, 5, false));
    expect(live(n), `出ても残った: ${JSON.stringify(n)}`).toEqual({});
    expect(observers.every((o) => !o.connected)).toBe(true);
  });

  it('別のゾーンへ移ると前のゾーンの分は外れる', () => {
    const rig = makeLog();
    const insp = document.createElement('div');
    insp.setAttribute('data-pkc-region', 'inspector');
    const card = document.createElement('dl');
    card.setAttribute('data-pkc-card', 'basic');
    insp.append(card);
    document.body.append(insp);
    const m = media(true);
    glow = createNeonGlow(document, () => m);
    const n = counting(rig.zone, insp);
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 120, 110));
    card.dispatchEvent(pointer('pointerover', 20, 20));
    expect(n.pointermove, '2 つのゾーンの pointermove が残っている').toBe(1);
    expect(live(n)).toEqual({ pointermove: 1, pointerleave: 1 });
  });

  it('🔴 ゾーンが描き直しで消えたら、通知(revalidate)の次のコマで外れる(ポインタは止まったまま・手で pointermove を撃たない)', () => {
    const rig = makeLog();
    const m = media(true);
    glow = createNeonGlow(document, () => m);
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 120, 110));
    runFrame();
    const n = counting(document, window, rig.zone);
    rig.zone.remove();
    expect(glow.inZone(), '通知の前に外れている(検査の前提)').toBe(true);
    glow.revalidate();
    runFrame();
    expect(glow.inZone()).toBe(false);
    expect(observers.every((o) => !o.connected), '観測器が残った').toBe(true);
    expect(Object.values(n).every((v) => v <= 0), `外れていない: ${JSON.stringify(n)}`).toBe(true);
  });

  it('🔴 差し替わったゾーンの下にポインタが止まっていれば、通知の次のコマでそのゾーンへ入り直して光る', () => {
    const rig = makeLog();
    const m = media(true);
    glow = createNeonGlow(document, () => m);
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 300, 110));
    runFrame();
    // 描き直し: 古いゾーンを外し、同じ位置に新しいゾーン(新しいカード)を置く
    const old = rig.zone;
    const fresh = makeLog();
    expect(old.isConnected).toBe(false);
    document.elementFromPoint = (() => fresh.cards[0]!) as typeof document.elementFromPoint;
    glow.revalidate();
    runFrame();
    runFrame();
    expect(glow.inZone(), '新しいゾーンへ入り直していない').toBe(true);
    expect(fresh.cards[0]!.hasAttribute(NEAR_ATTR), '新しいゾーンが光らない(次に要素をまたぐまで待たされる)').toBe(true);
  });

  it('🔴 ゾーンが生きている間の revalidate(ふつうの状態の通知)は rAF を 1 本も予約しない', () => {
    const rig = makeLog();
    glow = createNeonGlow(document, () => media(true));
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 300, 110));
    runFrame();
    expect(frames).toEqual([]);
    for (let i = 0; i < 5; i += 1) glow.revalidate();
    expect(frames, 'ゾーンが生きているのに予約した').toEqual([]);
    rig.zone.remove();
    glow.revalidate();
    expect(frames.length, '切り離されたのに予約しない').toBe(1);
  });

  it('🔴 ポインタがウィンドウの外へ出たら光を消して位置を忘れる ── 差し替えの後に古い座標で光らせない', () => {
    const rig = makeLog();
    glow = createNeonGlow(document, () => media(true));
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 300, 110));
    runFrame();
    expect(rig.cards[0]!.hasAttribute(NEAR_ATTR)).toBe(true);
    document.documentElement.dispatchEvent(pointer('pointerleave', 0, 0, false));
    expect(glow.inZone(), 'ウィンドウを出ても入ったまま').toBe(false);
    expect(rig.cards[0]!.hasAttribute(NEAR_ATTR), 'ウィンドウを出ても光が残った').toBe(false);
    const fresh = makeLog();
    document.elementFromPoint = (() => fresh.cards[0]!) as typeof document.elementFromPoint;
    glow.revalidate();
    runFrame();
    expect(glow.inZone(), '古い座標で光った').toBe(false);
    expect(fresh.cards[0]!.hasAttribute(NEAR_ATTR)).toBe(false);
  });

  it('ウィンドウの外へ出るリスナーも、付けない環境では付けず、外すと外れる', () => {
    makeLog();
    const n = counting(document.documentElement);
    const m = media(true);
    glow = createNeonGlow(document, () => m);
    expect(n.pointerleave).toBe(1);
    m.set(false);
    expect(n.pointerleave, '付けない環境でも付いている').toBe(0);
  });

  it('ゾーンの外にいる間の revalidate は何も予約しない(仕事 0)', () => {
    makeLog();
    glow = createNeonGlow(document, () => media(true));
    glow.revalidate();
    expect(frames).toEqual([]);
  });

  it('ゾーンの定義: 3 か所(ログ・情報ペイン・バー)。半径は NEON_RADIUS', () => {
    expect(NEON_ZONES.map((z) => z.radius)).toEqual([NEON_RADIUS.log, NEON_RADIUS.inspector, NEON_RADIUS.rail]);
    expect(NEON_ZONES.map((z) => z.zone).join(' ')).toMatch(/log-days.*inspector.*rail/);
  });
});

describe('近いカードの書き込み', () => {
  it('🔴 半径内のカードだけに印と局所座標・遠いカードには付かない(境界はちょうど半径が近い側)', () => {
    const rig = makeLog(); // カード 0: top 100..150, 1: 160..210, 2: 220..270(x 100..500)
    glow = createNeonGlow(document, () => media(true));
    // ポインタ (300, 100 - 160 = -60) → カード 0 の上端まで 160(ちょうど)・カード 1 は 220 で遠い
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 300, -60));
    runFrame();
    expect(rig.cards[0]!.hasAttribute(NEAR_ATTR), 'ちょうど半径が外れた').toBe(true);
    expect(rig.cards[1]!.hasAttribute(NEAR_ATTR), '遠いカードが光った').toBe(false);
    expect(rig.cards[0]!.style.getPropertyValue('--gx')).toBe('200px');
    expect(rig.cards[0]!.style.getPropertyValue('--gy')).toBe('-160px');
    // 1px 外へ
    rig.zone.dispatchEvent(pointer('pointermove', 300, -61, false));
    runFrame();
    expect(rig.cards[0]!.hasAttribute(NEAR_ATTR), '半径の外なのに光っている').toBe(false);
    expect(rig.cards[0]!.style.getPropertyValue('--gx'), '離れても座標が残った').toBe('');
  });

  it('🔴 動くと近いカードが入れ替わり、離れたカードからは消える / 出ると全部消える', () => {
    const rig = makeLog(5);
    glow = createNeonGlow(document, () => media(true));
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 300, 110));
    runFrame();
    const lit = (): number[] => rig.cards.flatMap((c, i) => (c.hasAttribute(NEAR_ATTR) ? [i] : []));
    expect(lit()).toEqual([0, 1, 2]);
    rig.zone.dispatchEvent(pointer('pointermove', 300, 480, false));
    runFrame();
    expect(lit()).toEqual([3, 4]);
    rig.zone.dispatchEvent(pointer('pointerleave', 0, 0, false));
    expect(lit(), '出ても光が残った').toEqual([]);
  });

  it('🔴 1 コマに 1 回: 3 回動いても予約は 1 つ・描くまで印は付かない', () => {
    const rig = makeLog();
    glow = createNeonGlow(document, () => media(true));
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 300, 110));
    runFrame();
    rig.zone.dispatchEvent(pointer('pointermove', 301, 110, false));
    rig.zone.dispatchEvent(pointer('pointermove', 302, 110, false));
    rig.zone.dispatchEvent(pointer('pointermove', 303, 110, false));
    expect(frames.length).toBe(1);
    runFrame();
    expect(rig.cards[0]!.style.getPropertyValue('--gx')).toBe('203px');
  });

  it('隠れたカード(矩形 0)は原点の近くでも光らせない', () => {
    const rig = makeLog(1);
    rig.rects.set(rig.cards[0]!, { left: 0, top: 0, width: 0, height: 0 });
    glow = createNeonGlow(document, () => media(true));
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 5, 5));
    runFrame();
    expect(rig.cards[0]!.hasAttribute(NEAR_ATTR)).toBe(false);
  });
});

describe('矩形の測り直し(汚れの印)', () => {
  it('🔴 動いても測り直さない・自分の書き込みでも汚れない', async () => {
    const rig = makeLog();
    glow = createNeonGlow(document, () => media(true));
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 300, 110));
    runFrame();
    const base = rig.measured();
    expect(base, '入ったときに測っていない').toBeGreaterThan(0);
    for (let i = 0; i < 5; i += 1) {
      rig.zone.dispatchEvent(pointer('pointermove', 300 + i, 111, false));
      runFrame();
    }
    await microtasks(); // 自分の `style` / 印の変化が観測器へ届く
    rig.zone.dispatchEvent(pointer('pointermove', 320, 112, false));
    runFrame();
    expect(rig.measured(), '動くたびに測り直している / 自分の書き込みで汚れた').toBe(base);
  });

  it('🔴 子を足すと(観測器)、同期では測らず、次のコマで測り直して新しいカードも光る', async () => {
    const rig = makeLog(1);
    glow = createNeonGlow(document, () => media(true));
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 300, 110));
    runFrame();
    const base = rig.measured();
    const added = addCard(rig, 160);
    await microtasks();
    expect(rig.measured(), '変更の瞬間に同期で測った').toBe(base);
    expect(frames.length, '次のコマを予約していない').toBe(1);
    runFrame();
    expect(rig.measured(), '測り直していない').toBeGreaterThan(base);
    expect(added.hasAttribute(NEAR_ATTR), '足したカードが光らない(古い矩形のまま)').toBe(true);
  });

  it('🔴 カードを消す / 属性が変わる(畳み)でも汚れる', async () => {
    const rig = makeLog(2);
    glow = createNeonGlow(document, () => media(true));
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 300, 110));
    runFrame();
    const base = rig.measured();
    rig.cards[1]!.hidden = true;
    rig.rects.set(rig.cards[1]!, { left: 0, top: 0, width: 0, height: 0 });
    await microtasks();
    runFrame();
    expect(rig.measured()).toBeGreaterThan(base);
    expect(rig.cards[1]!.hasAttribute(NEAR_ATTR), '畳んだカードが光ったまま').toBe(false);
  });

  it('🔴 スクロール(カードが動く)+ ポインタ静止 → そのコマで位置が追いつく(pointermove 無し)', () => {
    const rig = makeLog(1);
    glow = createNeonGlow(document, () => media(true));
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 300, 110));
    runFrame();
    expect(rig.cards[0]!.style.getPropertyValue('--gy')).toBe('10px');
    // 画面が 30px 下へ送られた(カードが上へ動く)
    rig.rects.set(rig.cards[0]!, { left: 100, top: 70, width: 400, height: 50 });
    document.body.dispatchEvent(pointer('pointermove', 0, 0, false)); // 関係の無い動き(ゾーン外)── 影響しない
    window.dispatchEvent(new Event('scroll'));
    expect(frames.length, 'スクロールで次のコマを予約していない').toBe(1);
    runFrame();
    expect(rig.cards[0]!.style.getPropertyValue('--gy'), '光が置いていかれた(ずれた)').toBe('40px');
  });

  it('ウィンドウの大きさが変わっても汚れる / ゾーンの大きさ(ResizeObserver)でも汚れる(観測開始の 1 回目は除く)', () => {
    const rig = makeLog(1);
    glow = createNeonGlow(document, () => media(true));
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 300, 110));
    runFrame();
    const base = rig.measured();
    const ro = observers.find((o) => o.kind === 'ro')!;
    expect(ro.connected).toBe(true);
    rig.rects.set(rig.cards[0]!, { left: 100, top: 100, width: 300, height: 50 });
    window.dispatchEvent(new Event('resize'));
    runFrame();
    expect(rig.measured()).toBeGreaterThan(base);
    expect(rig.cards[0]!.style.getPropertyValue('--gx')).toBe('200px');
  });
});

describe('ゾーンの大きさ(ResizeObserver)', () => {
  it('🔴 観測開始の 1 回目の通知は汚れではない・2 回目(大きさが変わった)は汚れて次のコマで測り直す', () => {
    const rig = makeLog(1);
    glow = createNeonGlow(document, () => media(true));
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 300, 110));
    runFrame();
    const base = rig.measured();
    roCallbacks[0]!([{ target: rig.zone }]); // 1 回目 = いまの大きさ
    expect(frames.length, '1 回目の通知で汚れた').toBe(0);
    rig.rects.set(rig.cards[0]!, { left: 100, top: 100, width: 200, height: 50 });
    roCallbacks[0]!([{ target: rig.zone }]);
    expect(rig.measured(), '同期で測った').toBe(base);
    runFrame();
    expect(rig.measured()).toBeGreaterThan(base);
  });
});

describe('測り直しの穴(自分の書き込み・外からの style・動いたゾーン・読み込み)', () => {
  it('🔴 カードが半径を出て光が消えた次のコマで、全カードを測り直さない(自分の `style` の消去は汚れでない)', async () => {
    const rig = makeLog(5);
    glow = createNeonGlow(document, () => media(true));
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 300, 110));
    runFrame();
    await microtasks();
    const base = rig.measured();
    // カード 0・1・2 が光っている → 遠くへ動かして 0・1 が消える
    rig.zone.dispatchEvent(pointer('pointermove', 300, 330, false));
    runFrame();
    expect(rig.cards[0]!.hasAttribute(NEAR_ATTR), '検査の前提: 光が消えた').toBe(false);
    await microtasks(); // 自分の消去の記録が観測器へ届く(takeRecords で捨てていなければ汚れになる)
    rig.zone.dispatchEvent(pointer('pointermove', 300, 331, false));
    runFrame();
    expect(rig.measured(), '消えるたびに全部測り直している(自分の書き込みを汚れと数えた)').toBe(base);
  });

  it('🔴 他の誰かがカードの style で大きさを変えたら、(自分の書き込みと区別して)測り直す', async () => {
    const rig = makeLog(1);
    glow = createNeonGlow(document, () => media(true));
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 300, 110));
    runFrame();
    await microtasks();
    const base = rig.measured();
    rig.rects.set(rig.cards[0]!, { left: 100, top: 100, width: 400, height: 200 });
    rig.cards[0]!.style.height = '200px'; // 外からの style の変更
    await microtasks();
    runFrame();
    expect(rig.measured(), '外からの style の変更を自分の書き込みと取り違えて見逃した').toBeGreaterThan(base);
  });

  it('🔴 ゾーンが動いた(大きさは同じ。上に別の塊が現れた)ら、次のポインタのコマで測り直す', () => {
    const rig = makeLog(1);
    const box = { left: 100, top: 50, right: 500, bottom: 400, width: 400, height: 350, x: 100, y: 50 };
    rig.zone.getBoundingClientRect = () => ({ ...box, toJSON: () => ({}) }) as DOMRect;
    glow = createNeonGlow(document, () => media(true));
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 300, 110));
    runFrame();
    const base = rig.measured();
    rig.rects.set(rig.cards[0]!, { left: 100, top: 140, width: 400, height: 50 });
    box.top = 90;
    box.bottom = 440;
    box.y = 90; // 同じ大きさのまま 40px 下へ
    // 毎コマは読まない(200ms ごと)── 直後のコマでは測り直さず、200ms 後のコマで追いつく
    rig.zone.dispatchEvent(pointer('pointermove', 300, 111, false));
    runFrame();
    expect(rig.measured(), '毎コマ ゾーンの矩形を読んでいる(強制再計算が増える)').toBe(base);
    const t0 = performance.now();
    vi.spyOn(performance, 'now').mockReturnValue(t0 + 300);
    rig.zone.dispatchEvent(pointer('pointermove', 300, 111, false));
    runFrame();
    expect(rig.measured(), '動いたゾーンを見逃した').toBeGreaterThan(base);
    expect(rig.cards[0]!.style.getPropertyValue('--gy')).toBe('-29px');
  });

  it('🔴 ゾーンが横にだけ動いた(left だけ変わった。大きさ・top は同じ)ときも、200ms 後のコマで測り直す', () => {
    const rig = makeLog(1);
    const box = { left: 100, top: 50, right: 500, bottom: 400, width: 400, height: 350, x: 100, y: 50 };
    rig.zone.getBoundingClientRect = () => ({ ...box, toJSON: () => ({}) }) as DOMRect;
    glow = createNeonGlow(document, () => media(true));
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 300, 110));
    runFrame();
    const base = rig.measured();
    box.left = 130;
    box.right = 530;
    box.x = 130;
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 300);
    rig.zone.dispatchEvent(pointer('pointermove', 300, 111, false));
    runFrame();
    expect(rig.measured(), 'left だけの移動を見逃した').toBeGreaterThan(base);
  });

  it('🔴 光っているカードの大きさが変わったら(画像・字体の読み込み)、次のコマで測り直す。光が消えたカードは観測しない', () => {
    const rig = makeLog(5);
    glow = createNeonGlow(document, () => media(true));
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 300, 110));
    runFrame();
    expect(roObserved.has(rig.cards[0]!), '光っているカードを観測していない').toBe(true);
    expect(roObserved.has(rig.cards[4]!), '光っていないカードまで観測している(費用が膨らむ)').toBe(false);
    const base = rig.measured();
    // 1 回目の通知(いま)── 汚れでない
    roCallbacks[0]!([{ target: rig.cards[0]! }]);
    expect(frames.length).toBe(0);
    // 画像が読み込まれてカード 0 が伸びた
    rig.rects.set(rig.cards[0]!, { left: 100, top: 100, width: 400, height: 90 });
    roCallbacks[0]!([{ target: rig.cards[0]! }]);
    expect(rig.measured(), '同期で測った').toBe(base);
    runFrame();
    expect(rig.measured(), '大きさの変化を見逃した').toBeGreaterThan(base);
    // 遠くへ動かして光が消えたカードは観測から外れる
    rig.zone.dispatchEvent(pointer('pointermove', 300, 480, false));
    runFrame();
    expect(roObserved.has(rig.cards[0]!), '光が消えたカードを観測し続けている').toBe(false);
  });

  it('🔴 字体の読み込み完了(document.fonts の loadingdone)でも汚れる。ゾーンを出ると外れる', () => {
    const rig = makeLog(1);
    const fonts = new EventTarget();
    Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
    const n = counting(fonts);
    glow = createNeonGlow(document, () => media(true));
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 300, 110));
    runFrame();
    expect(n.loadingdone).toBe(1);
    const base = rig.measured();
    fonts.dispatchEvent(new Event('loadingdone'));
    runFrame();
    expect(rig.measured()).toBeGreaterThan(base);
    rig.zone.dispatchEvent(pointer('pointerleave', 0, 0, false));
    expect(n.loadingdone, '出ても外れない').toBe(0);
    delete (document as unknown as { fonts?: unknown }).fonts;
  });

  it('バーのボタンは群の中に入れ子で並んでいても光る(direct: false)', () => {
    document.body.innerHTML = '';
    const rail = document.createElement('div');
    rail.setAttribute('data-pkc-region', 'rail');
    const group = document.createElement('div');
    const btn = document.createElement('button');
    btn.getBoundingClientRect = () => ({ left: 4, top: 40, right: 36, bottom: 72, width: 32, height: 32, x: 4, y: 40, toJSON: () => ({}) }) as DOMRect;
    group.append(btn);
    rail.append(group);
    document.body.append(rail);
    glow = createNeonGlow(document, () => media(true));
    btn.dispatchEvent(pointer('pointerover', 20, 56));
    runFrame();
    expect(btn.hasAttribute(NEAR_ATTR), '入れ子のバーのボタンが光らない').toBe(true);
  });

  it('💭 直接の子だけを対象にする(CSS が `>` で書いている所。入れ子のカードの印には光らせない)', () => {
    const rig = makeLog(1);
    const nested = document.createElement('div');
    const inner = document.createElement('p');
    inner.setAttribute('data-pkc-log-card', 'mid');
    inner.getBoundingClientRect = () => ({ left: 100, top: 100, right: 500, bottom: 150, width: 400, height: 50, x: 100, y: 100, toJSON: () => ({}) }) as DOMRect;
    nested.append(inner);
    rig.zone.append(nested);
    glow = createNeonGlow(document, () => media(true));
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 300, 110));
    runFrame();
    expect(rig.cards[0]!.hasAttribute(NEAR_ATTR)).toBe(true);
    expect(inner.hasAttribute(NEAR_ATTR), '入れ子のカードへ書いた').toBe(false);
    expect(NEON_ZONES.map((z) => z.direct)).toEqual([true, true, false]);
  });
});

describe('CSS(原文)', () => {
  const raw = readFileSync(join(__dirname, '../../src/styles/app.css'), 'utf-8');
  const css = stripComments(raw);
  const tail = css.slice(css.lastIndexOf('@media screen {', css.indexOf("[data-pkc-glow-near][data-pkc-glow-near]::before")));

  it('🔴 光の半径(`--neon-r`)は NEON_RADIUS と一致する(ログ / 情報ペイン / バー)', () => {
    const r = (sel: string): string => blocksFor(css, sel).join('\n').match(/--neon-r:\s*(\d+)px/)?.[1] ?? '';
    expect(r('[data-pkc-log-days] > [data-pkc-log-card]')).toBe(String(NEON_RADIUS.log));
    expect(r("[data-pkc-region='inspector'] > [data-pkc-card]")).toBe(String(NEON_RADIUS.inspector));
    expect(r("[data-pkc-region='rail'] button")).toBe(String(NEON_RADIUS.rail));
  });

  it('🔴 輪郭の光は画面だけ + 強制色なし・近いカードにだけ疑似要素・飾りだけ(pointer-events: none)・マスクで内側を抜く', () => {
    const { body } = atBlock(css, '@media screen and (forced-colors: none)');
    expect(body, '近いカードの印に限っていない').toContain('[data-pkc-glow-near]');
    for (const pseudo of ['::before', '::after']) {
      const rules = [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1]!.trim().endsWith(pseudo));
      expect(rules.length, `${pseudo} の規則が無い`).toBe(1);
      const d = rules[0]![2]!;
      expect(d, `${pseudo}: 飾りが押し所を奪う`).toMatch(/pointer-events:\s*none/);
      if (pseudo === '::before') {
        expect(d, `${pseudo}: 内側を抜いていない(地が光る)`).toMatch(/mask-composite:\s*exclude/);
        expect(d, `${pseudo}: webkit の対応が無い`).toMatch(/-webkit-mask-composite:\s*xor/);
        expect(d, `${pseudo}: 局所座標でない`).toMatch(/at calc\(var\(--gx|at var\(--gx/);
      } else {
        // にじみ: 線の外縁に接した影(滑らかな減衰)を、局所座標の放射状マスクで近い所だけにする。平らな帯(background)にしない
        expect(d, `${pseudo}: にじみが影でない(平らな帯だと線から浮いて二重線に見える)`).toMatch(/box-shadow:\s*0 0 \d+px/);
        expect(d, `${pseudo}: 近い所だけにするマスクが局所座標でない`).toMatch(/mask-image:\s*radial-gradient\(circle var\(--neon-r\) at calc\(var\(--gx/);
        expect(d, `${pseudo}: 箱の外の影を残さない`).toMatch(/mask-clip:\s*no-clip/);
        expect(d, `${pseudo}: 枠の無い辺へ出る`).toMatch(/clip-path:\s*inset\(/);
        expect(d, `${pseudo}: 背景の帯になっている`).not.toMatch(/(^|;)\s*background:/);
      }
    }
    // 画面 + 強制色なしの外(印刷・強制色)には、光の規則が 1 つも無い(塊は 2 つ: 疑似要素の輪郭 / 横スクロールの器の背景)
    let outside = css;
    let blocks = 0;
    while (outside.includes('@media screen and (forced-colors: none)')) {
      const { body: b } = atBlock(outside, '@media screen and (forced-colors: none)');
      outside = outside.replace(`@media screen and (forced-colors: none) {${b}}`, '');
      blocks += 1;
    }
    expect(blocks, '光の塊が 2 つでない').toBe(2);
    expect(outside, '画面の外にも光の規則がある').not.toContain('[data-pkc-glow-near]');
  });

  it('🔴 横スクロールの器(`.pkc-md-block`)は疑似要素でなく器自身の背景で輪郭を描く(疑似要素は overflow に切られる)', () => {
    const { body } = atBlock(css, '@media screen and (forced-colors: none)');
    // 疑似要素の規則からは器を除く
    expect(body).toMatch(/\[data-pkc-log-card\]:not\(\.pkc-md-block, \.pkc-details\)/);
    // 器の 4 つの辺の型(途中 / 先頭 / 末尾 / 単独)すべてに光の層がある
    const second = css.slice(css.indexOf('@media screen and (forced-colors: none)', css.indexOf('@media screen and (forced-colors: none)') + 10));
    for (const edge of ['first', 'last', 'solo']) expect(second, `器の ${edge} に光の層が無い`).toContain(`[data-pkc-log-card='${edge}'][data-pkc-glow-near]`);
    expect(second).toContain('var(--sf), var(--ng)');
    expect(second, '疑似要素で描いている').not.toMatch(/::before|::after/);
  });

  it('🔴 `background-attachment: fixed` / `filter` / `:root` の座標変数を使わない(実測で再計算 40 秒 / 600 回)', () => {
    const { body } = atBlock(css, '@media screen and (forced-colors: none)');
    expect(body).not.toMatch(/background-attachment|filter\s*:|--mx|--my/);
    expect(tail).not.toMatch(/:root/);
  });

  /** 近接発光の塊(末尾)。引用符は JS 側(二重)に揃える。 */
  const neon = raw.slice(raw.indexOf('輪郭の近接発光(ネオン。B2)── ここから末尾まで')).replace(/'/g, '"');

  it.each(NEON_ZONES.map((z) => [z.zone, z] as const))('🔴 %s: `direct` は CSS の書き方(`ゾーン > カード` か、入れ子を許す `ゾーン カード` か)と一致する', (_n, z) => {
    const child = neon.includes(`${z.zone} > ${z.cards}`);
    const nested = neon.includes(`${z.zone} ${z.cards}`);
    expect(child, `${z.zone}: CSS が直接の子で書いているかと direct(${String(z.direct)})が食い違う`).toBe(z.direct);
    if (!z.direct) expect(nested, `${z.zone}: 入れ子を許すのに CSS が見つからない`).toBe(true);
  });

  it('🔴 器の背景の輪郭を描く 5 規則(共通・途中・先頭・末尾・単独)は、全部 `.pkc-md-block` と `.pkc-details` の両方を対象にする', () => {
    const second = neon.slice(neon.lastIndexOf('@media screen and (forced-colors: none)'));
    const withBoth = second.match(/> :is\(\.pkc-md-block, \.pkc-details\)\[data-pkc-log-card\]/g) ?? [];
    expect(withBoth.length, '5 規則すべてが両方を対象にしていない').toBe(5);
    expect(second, '`.pkc-md-block` だけの規則が残っている').not.toMatch(/> \.pkc-md-block\[data-pkc-log-card\]/);
  });

  it('🔴 main.ts は描き直しの後に revalidateNeonGlow を呼ぶ(状態の通知 `onState` の中)── 外すとゾーンの差し替えに追従しない', () => {
    const src = stripComments(readFileSync(join(__dirname, '../../src/main.ts'), 'utf-8')).replace(/^\s*\/\/.*$/gm, '');
    expect(src, 'import が無い').toMatch(/import \{[^}]*revalidateNeonGlow[^}]*\} from '@adapter\/ui\/render\/neon-glow'/);
    expect(src, 'onState の通知の中で呼んでいない').toMatch(/onState\(\s*\(\s*\)\s*=>\s*(\{\s*)?revalidateNeonGlow\(\)/);
  });

  it('旧い灰色の光(G1)の規則・要素は残っていない', () => {
    expect(css).not.toContain('rail-glow');
    expect(css).not.toContain('data-pkc-glow]');
  });
});
