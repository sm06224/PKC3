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
import { createNeonGlow, GLOW_QUERY, NEAR_ATTR, NEON_FIELDS, NEON_ZONES, OUT_ATTR, zoneOf, type NeonGlow, type NeonTimers } from '../../src/adapter/ui/render/neon-glow';
import { NEON_ENTER_DELAY_MS, NEON_ENTER_DURATION_MS, NEON_LEAVE_DURATION_MS, NEON_RADIUS } from '../../src/features/neon/near-cards';
import { atBlock, blocksFor, stripComments, withoutMedia } from '../helpers/css-blocks';

/** `@media screen and (forced-colors: none)` の n 番目(1 始まり)の塊を、閉じの波括弧まで切り出す。 */
function nthNoneBlock(css: string, n: number): string {
  const head = '@media screen and (forced-colors: none)';
  let at = -1;
  for (let i = 0; i < n; i += 1) at = css.indexOf(head, at + 1);
  expect(at, `${n} 番目の ${head} が無い`).toBeGreaterThanOrEqual(0);
  return `${head} {${atBlock(css.slice(at), head).body}}`;
}

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

  it('ゾーンの定義: 7 か所(ログ・情報ペイン・バー・本文・追記欄・検索欄・SQL)。半径は NEON_RADIUS', () => {
    expect(NEON_ZONES.map((z) => z.targets.map((t) => t.radius))).toEqual([
      [NEON_RADIUS.log],
      [NEON_RADIUS.inspector, NEON_RADIUS.field],
      [NEON_RADIUS.rail],
      [NEON_RADIUS.block],
      [NEON_RADIUS.block],
      [NEON_RADIUS.field],
      [NEON_RADIUS.block],
    ]);
    expect(NEON_ZONES.map((z) => z.zone)).toEqual([
      '[data-pkc-log-days]',
      '[data-pkc-region="inspector"]',
      '[data-pkc-region="rail"]',
      '.pkc-md-rendered',
      '[data-pkc-region="append"]',
      '[data-pkc-region="find-bar"]',
      '[data-pkc-field="sql-editor"]',
    ]);
  });

  it('⚠ 本文のゾーンはログのゾーンより後ろ(ログの本文も `.pkc-md-rendered` のとき、先頭のログのゾーンが握る)', () => {
    const order = NEON_ZONES.map((z) => z.zone);
    expect(order.indexOf('[data-pkc-log-days]')).toBeLessThan(order.indexOf('.pkc-md-rendered'));
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
    expect(NEON_ZONES.slice(0, 3).flatMap((z) => z.targets.map((t) => t.direct))).toEqual([true, true, false, false]);
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
      // 描く規則(`content` を持つ)は 1 つ。⚠ 点き方・消え方(#2096)の `opacity` / `transition` / `@starting-style` の規則は別に数える(下の describe)
      const rules = [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1]!.trim().endsWith(pseudo) && /content:/.test(m[2]!));
      expect(rules.length, `${pseudo} の規則が無い`).toBe(1);
      expect(rules[0]![1], `${pseudo}: 余韻の印(glow-out)の間も描かない(消える前に疑似要素ごと消える)`).toContain('[data-pkc-glow-out]');
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
    // 画面 + 強制色なしの外(印刷・強制色)には、光の規則が 1 つも無い(塊は 3 つ: 疑似要素の輪郭 / ログの器の背景 / 本文のブロック・入力欄)
    let outside = css;
    let blocks = 0;
    while (outside.includes('@media screen and (forced-colors: none)')) {
      const { body: b } = atBlock(outside, '@media screen and (forced-colors: none)');
      outside = outside.replace(`@media screen and (forced-colors: none) {${b}}`, '');
      blocks += 1;
    }
    expect(blocks, '光の塊が 3 つでない(疑似要素の輪郭 / 横スクロールの器の背景 / 本文のブロック・入力欄)').toBe(3);
    expect(outside, '画面の外にも光の規則がある').not.toContain('[data-pkc-glow-near]');
    expect(outside, '画面の外にも余韻の規則がある').not.toContain('[data-pkc-glow-out]');
    expect(outside, '画面の外に @starting-style がある').not.toContain('@starting-style');
  });

  it('🔴 横スクロールの器(`.pkc-md-block`)は疑似要素でなく器自身の背景で輪郭を描く(疑似要素は overflow に切られる)', () => {
    const { body } = atBlock(css, '@media screen and (forced-colors: none)');
    // 疑似要素の規則からは器を除く
    expect(body).toMatch(/\[data-pkc-log-card\]:not\(\.pkc-md-block, \.pkc-details\)/);
    // 器の 4 つの辺の型(途中 / 先頭 / 末尾 / 単独)すべてに光の層がある
    const second = nthNoneBlock(css, 2);
    for (const edge of ['first', 'last', 'solo']) expect(second, `器の ${edge} に光の層が無い`).toContain(`[data-pkc-log-card='${edge}']:is([data-pkc-glow-near], [data-pkc-glow-out])`);
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

  it.each(NEON_ZONES.slice(0, 3).flatMap((z) => z.targets.map((t) => [`${z.zone} → ${t.cards.slice(0, 30)}`, z.zone, t] as const)))(
    '🔴 %s: `direct` は CSS の書き方(`ゾーン > カード` か、入れ子を許す `ゾーン カード` か)と一致する',
    (_n, zone, t) => {
      // 入力欄(`NEON_FIELDS`)は要素名の並びで、ゾーンとの親子の書き方を持たない(疑似要素でなく枠そのものを描く)── 対象は直接の子のカードとバーのボタン
      if (t.cards === NEON_FIELDS) return;
      const child = neon.includes(`${zone} > ${t.cards}`);
      const nested = neon.includes(`${zone} ${t.cards}`);
      expect(child, `${zone}: CSS が直接の子で書いているかと direct(${String(t.direct)})が食い違う`).toBe(t.direct);
      if (!t.direct) expect(nested, `${zone}: 入れ子を許すのに CSS が見つからない`).toBe(true);
    },
  );

  it('🔴 器の背景の輪郭を描く 5 規則(共通・途中・先頭・末尾・単独)は、全部 `.pkc-md-block` と `.pkc-details` の両方を対象にする', () => {
    const second = nthNoneBlock(neon, 2);
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

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2 PR-2: 本文のブロック・入力欄のゾーン / 画面内の候補だけ(IntersectionObserver)/ フォーカス
// ─────────────────────────────────────────────────────────────────────────────

/** 観測器(画面に出ているか)の差し替え。`io.show(el, true|false)` で通知を撃つ。 */
let ioInstances: FakeIO[] = [];
class FakeIO {
  observed = new Set<Element>();
  disconnected = false;
  constructor(private readonly cb: (entries: { target: Element; isIntersecting: boolean }[]) => void) {
    ioInstances.push(this);
  }
  observe(el: Element): void {
    this.observed.add(el);
  }
  unobserve(el: Element): void {
    this.observed.delete(el);
  }
  disconnect(): void {
    this.disconnected = true;
    this.observed.clear();
  }
  show(el: Element, isIntersecting: boolean): void {
    this.cb([{ target: el, isIntersecting }]);
  }
}

const rectOf = (left: number, top: number, w: number, h: number): (() => DOMRect) => {
  return () => ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
};

/** 本文型のゾーン(`.pkc-md-rendered`)に、コードの枠・表の枠・引用を縦に並べる(高さ 50・間 10)。 */
function makeBody(): { zone: HTMLElement; code: HTMLElement; table: HTMLElement; quote: HTMLElement; callout: HTMLElement } {
  document.body.innerHTML = '';
  const zone = document.createElement('div');
  zone.className = 'pkc-md-rendered';
  const code = document.createElement('div');
  code.className = 'pkc-md-block';
  code.getBoundingClientRect = rectOf(100, 100, 400, 50);
  const table = document.createElement('div');
  table.className = 'pkc-md-block';
  table.setAttribute('data-pkc-md-block-kind', 'table');
  table.getBoundingClientRect = rectOf(100, 160, 400, 50);
  const quote = document.createElement('blockquote');
  quote.getBoundingClientRect = rectOf(100, 220, 400, 50);
  const callout = document.createElement('blockquote');
  callout.className = 'pkc-section-callout';
  callout.getBoundingClientRect = rectOf(100, 280, 400, 50);
  zone.append(code, table, quote, callout);
  document.body.append(zone);
  return { zone, code, table, quote, callout };
}

describe('本文のブロックのゾーン(`.pkc-md-rendered`)', () => {
  beforeEach(() => {
    ioInstances = [];
  });

  it('🔴 コード・表・引用の枠が光り、注意書き(callout)は対象外。半径は NEON_RADIUS.block', () => {
    const rig = makeBody();
    glow = createNeonGlow(document, () => media(true));
    rig.code.dispatchEvent(pointer('pointerover', 300, 125));
    runFrame();
    expect(glow.inZone()).toBe(true);
    expect(rig.code.hasAttribute(NEAR_ATTR)).toBe(true);
    expect(rig.table.hasAttribute(NEAR_ATTR)).toBe(true);
    expect(rig.quote.hasAttribute(NEAR_ATTR)).toBe(true);
    expect(rig.callout.hasAttribute(NEAR_ATTR), '注意書きまで光った').toBe(false);
  });

  it('🔴 同じゾーンの入力欄は小さい半径(NEON_RADIUS.field)で光る。⚠ 半径は物ごと(ブロックは遠くまで・欄は近くだけ)', () => {
    document.body.innerHTML = '';
    const zone = document.createElement('div');
    zone.setAttribute('data-pkc-region', 'inspector');
    const card = document.createElement('div');
    card.setAttribute('data-pkc-card', '');
    card.getBoundingClientRect = rectOf(100, 100, 400, 50);
    const input = document.createElement('input');
    input.getBoundingClientRect = rectOf(100, 500, 200, 26);
    zone.append(card, input);
    document.body.append(zone);
    glow = createNeonGlow(document, () => media(true));
    // ポインタ(300, 60): カードまで 40(半径 160 の内)/ 欄(top 500)まで 440(欄の半径 96 の外)
    card.dispatchEvent(pointer('pointerover', 300, 60));
    runFrame();
    expect(card.hasAttribute(NEAR_ATTR)).toBe(true);
    expect(input.hasAttribute(NEAR_ATTR), '欄が遠いのに光った').toBe(false);
    // 欄の 96 の内へ
    zone.dispatchEvent(pointer('pointermove', 300, 500 - NEON_RADIUS.field));
    runFrame();
    expect(input.hasAttribute(NEAR_ATTR), '欄の半径の内なのに光らない').toBe(true);
    expect(card.hasAttribute(NEAR_ATTR), 'カードの半径(160)の外なのに光った').toBe(false);
    // 欄の半径の 1px 外
    zone.dispatchEvent(pointer('pointermove', 300, 500 - NEON_RADIUS.field - 1));
    runFrame();
    expect(input.hasAttribute(NEAR_ATTR)).toBe(false);
  });

  it('🔴 チェックボックス・ラジオ・隠し欄は欄の対象に入らない(NEON_FIELDS)', () => {
    document.body.innerHTML = '';
    const zone = document.createElement('div');
    zone.setAttribute('data-pkc-region', 'find-bar');
    const mk = (type: string): HTMLInputElement => {
      const i = document.createElement('input');
      i.type = type;
      i.getBoundingClientRect = rectOf(100, 100, 100, 26);
      return i;
    };
    const text = mk('text');
    const cb = mk('checkbox');
    const radio = mk('radio');
    const hidden = mk('hidden');
    zone.append(text, cb, radio, hidden);
    document.body.append(zone);
    glow = createNeonGlow(document, () => media(true));
    text.dispatchEvent(pointer('pointerover', 150, 110));
    runFrame();
    expect(text.hasAttribute(NEAR_ATTR)).toBe(true);
    for (const el of [cb, radio, hidden]) expect(el.hasAttribute(NEAR_ATTR), `${el.type} が光った`).toBe(false);
  });
});

describe('🔴 ゾーンの入れ子: 外側のログ・情報ペイン・バーが、内側の本文のゾーンに優先する', () => {
  it('ログの本文の中の `.pkc-md-rendered` のブロックへ直接ポインタが入っても、ログのゾーンに入りログのカードが光る(`closest` の最内に奪われない)', () => {
    const rig = makeLog();
    const inner = document.createElement('div');
    inner.className = 'pkc-md-rendered';
    const block = document.createElement('div');
    block.className = 'pkc-md-block';
    block.getBoundingClientRect = rectOf(100, 400, 400, 40);
    inner.append(block);
    rig.zone.append(inner);
    expect(zoneOf(block)?.spec.zone, '優先順でログが先に当たらない').toBe('[data-pkc-log-days]');
    glow = createNeonGlow(document, () => media(true));
    block.dispatchEvent(pointer('pointerover', 300, 160)); // カード 1(top 160)の上
    runFrame();
    expect(rig.zone.isConnected && glow.inZone()).toBe(true);
    expect(rig.cards[1]!.hasAttribute(NEAR_ATTR), 'ログのカードが光らない(内側の本文のゾーンに奪われた)').toBe(true);
    expect(block.hasAttribute(NEAR_ATTR), 'ログのゾーンの中で本文のブロックを光らせた(二重)').toBe(false);
  });

  it('入れ子でない所は今までどおり(本文だけ → 本文のゾーン / 情報ペインの中の欄 → 情報ペイン)', () => {
    document.body.innerHTML = '<div class="pkc-md-rendered"><div class="pkc-md-block" id="b"></div></div><div data-pkc-region="inspector"><input id="i"></div>';
    expect(zoneOf(document.getElementById('b')!)?.spec.zone).toBe('.pkc-md-rendered');
    expect(zoneOf(document.getElementById('i')!)?.spec.zone).toBe('[data-pkc-region="inspector"]');
    expect(zoneOf(document.body)).toBeNull();
  });
});

describe('🔴 画面に出ている候補だけ(IntersectionObserver)', () => {
  beforeEach(() => {
    ioInstances = [];
    vi.stubGlobal('IntersectionObserver', FakeIO);
  });

  it('候補は観測器で見張り、ゾーンを出ると観測器ごと外れる(見張りが残らない)', () => {
    const rig = makeBody();
    glow = createNeonGlow(document, () => media(true));
    rig.code.dispatchEvent(pointer('pointerover', 300, 125));
    runFrame();
    const io = ioInstances[0]!;
    expect([...io.observed].sort((a, b) => (a === rig.code ? -1 : b === rig.code ? 1 : 0))).toEqual(expect.arrayContaining([rig.code, rig.table, rig.quote]));
    expect(io.observed.has(rig.callout), '対象外の物まで見張っている').toBe(false);
    rig.zone.dispatchEvent(pointer('pointerleave', 0, 0, false));
    expect(io.disconnected).toBe(true);
    expect(io.observed.size).toBe(0);
  });

  it('🔴 「画面に出ていない」と教えられた候補は測らず・書かない。出てきたら次のコマで光る', () => {
    const rig = makeBody();
    glow = createNeonGlow(document, () => media(true));
    rig.code.dispatchEvent(pointer('pointerover', 300, 125));
    runFrame();
    const io = ioInstances[0]!;
    expect(rig.table.hasAttribute(NEAR_ATTR)).toBe(true);
    // 表が画面の外へ出た: 光が消え、次のコマでは測りもしない
    const spy = vi.spyOn(rig.table, 'getBoundingClientRect');
    io.show(rig.table, false);
    expect(rig.table.hasAttribute(NEAR_ATTR), '画面の外へ出たのに光が残った').toBe(false);
    runFrame();
    expect(rig.table.hasAttribute(NEAR_ATTR)).toBe(false);
    expect(spy, '画面に出ていない候補の矩形を測った').not.toHaveBeenCalled();
    expect(rig.code.hasAttribute(NEAR_ATTR), '画面に出ている物は光り続ける').toBe(true);
    // 戻ってきた
    io.show(rig.table, true);
    runFrame();
    expect(rig.table.hasAttribute(NEAR_ATTR), '画面に戻ったのに光らない').toBe(true);
    expect(spy).toHaveBeenCalled();
  });

  it('教えられるまでは「画面に出ている」として扱う(最初の通知が遅れても光り損ねない)', () => {
    const rig = makeBody();
    glow = createNeonGlow(document, () => media(true));
    rig.code.dispatchEvent(pointer('pointerover', 300, 125));
    runFrame();
    expect(ioInstances[0]).toBeDefined();
    expect(rig.code.hasAttribute(NEAR_ATTR)).toBe(true);
  });

  it('切り離された候補は見張りをやめる(次の測り直しで)', async () => {
    const rig = makeBody();
    glow = createNeonGlow(document, () => media(true));
    rig.code.dispatchEvent(pointer('pointerover', 300, 125));
    runFrame();
    const io = ioInstances[0]!;
    rig.quote.remove();
    await microtasks();
    runFrame();
    expect(io.observed.has(rig.quote), '外れた候補を見張り続けている').toBe(false);
  });

  it('観測器が無い環境では、全部を候補にして動く(絞らない)', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const rig = makeBody();
    glow = createNeonGlow(document, () => media(true));
    rig.code.dispatchEvent(pointer('pointerover', 300, 125));
    runFrame();
    expect(rig.code.hasAttribute(NEAR_ATTR)).toBe(true);
    expect(rig.table.hasAttribute(NEAR_ATTR)).toBe(true);
  });
});

describe('CSS(原文): 本文のブロック・入力欄・フォーカス', () => {
  const css = stripComments(readFileSync(join(__dirname, '../../src/styles/app.css'), 'utf-8'));
  /** 規則の選択子を(空白を畳んで)丸ごと比べて宣言を返す。⚠ `blocksFor` は `,` で割るので、`:is(a, b)` を含む選択子は読めない。 */
  const decls = (sel: string): string =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => m[1]!.trim().replace(/\s+/g, ' ') === sel)
      .map((m) => m[2]!)
      .join('\n');
  /** 強制色の規則(`forced-colors: active`)の中だけ / 外だけ。 */
  const forced = atBlock(css, '@media (forced-colors: active)').body;
  const outsideForced = css.replace(`@media (forced-colors: active) {${forced}}`, '');

  /** 選択子の文字列を**含む**規則の宣言(`:not(a, b)` の `,` を含む選択子リストを読むため)。 */
  const ruleHaving = (src: string, sel: string): string =>
    [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => m[1]!.replace(/\s+/g, ' ').includes(sel))
      .map((m) => m[2]!)
      .join('\n');
  /** 共通の `::before`(線を描く規則)の対象の並び。⚠ 点き方の規則(`[glow-near]::before` の `opacity`)ではなく、`content` を持つ描く規則。 */
  const drawList = (): string => {
    const at = css.indexOf(":is([data-pkc-glow-near][data-pkc-glow-near], [data-pkc-glow-out][data-pkc-glow-out])::before {\n    content:");
    expect(at, '描く規則が見つからない(空振り)').toBeGreaterThan(0);
    return css.slice(css.lastIndexOf(':is(', at - 1), at);
  };
  const TYPES = "[type='checkbox'], [type='radio'], [type='range'], [type='file'], [type='color']";
  const FOCUS_INPUT = `input:not(${TYPES}):focus-visible`;

  it('🔴 入力欄のフォーカスは `--neon` の線を全周に静止させる ── 既存の `outline` と二重にしない(outline は消す)', () => {
    const d = ruleHaving(outsideForced, FOCUS_INPUT);
    expect(d, '入力欄のフォーカスが neon の線でない').toMatch(/border-color:\s*var\(--neon\)/);
    expect(d, '全周の線(内側の影)が無い').toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--neon\)/);
    expect(d, 'outline が残っている(neon の線と二重になる)').toMatch(/outline:\s*none/);
    expect(d).not.toMatch(/outline:\s*\d/);
    // 強制色の外で、neon の規則と同じ対象に outline を引く規則は無い(輪郭を持たない型の規則は別の選択子)
    expect(ruleHaving(outsideForced, 'select:focus-visible').match(/outline:\s*\d/), 'neon の規則に outline が混ざっている').toBeNull();
    const forcedRule = ruleHaving(forced, ':is(input, textarea, select):not([data-pkc-field=\'append-input\']):focus-visible:focus-visible');
    expect(forcedRule, '強制色で outline へ戻していない').toMatch(/outline:\s*2px solid var\(--accent\)/);
    expect(forcedRule, '強制色で影を残している(二重)').toMatch(/box-shadow:\s*none/);
  });

  it('🔴 輪郭を持たない型(checkbox / radio / range / file / color)は neon の規則から除き、従来の outline のまま ── 除外は近接発光の入力欄(NEON_FIELDS)と同じ並び', () => {
    const native = ruleHaving(outsideForced, `input:is(${TYPES}):focus-visible`);
    expect(native, '除外型の焦点が outline でない(焦点が見えなくなる)').toMatch(/outline:\s*2px solid var\(--accent\)/);
    expect(native).not.toMatch(/var\(--neon\)/);
    const types = (src: string, head: string): string[] => {
      const m = src.match(new RegExp(`${head}\\(([^)]*)\\)`));
      return [...(m?.[1] ?? '').matchAll(/type=["']([a-z]+)["']/g)].map((x) => x[1]!).sort();
    };
    // ⚠ 実際の CSS の原文から読む(テスト側で組み立てた字を読むと、CSS が変わっても緑になる)
    const actual = css.match(/input:not\([^)]*\):focus-visible/)?.[0] ?? '';
    const css1 = types(actual, 'input:not');
    const ts1 = types(NEON_FIELDS.split(', textarea')[0]!, 'input:not').filter((t) => t !== 'hidden');
    expect(css1.length, '除外型が読めていない(空振り)').toBe(5);
    expect(css1, 'CSS の除外と NEON_FIELDS の除外が食い違う').toEqual(ts1);
  });

  it('🔴 textarea / select も neon の規則(3 つが 1 つの選択子リスト)', () => {
    for (const el of ['textarea:focus-visible', 'select:focus-visible']) expect(ruleHaving(outsideForced, el)).toMatch(/var\(--neon\)/);
  });

  it('🔴 追記欄の枠は `:focus-within` で neon の線 / 枠の中の打つ欄は線を重ねない(二重にしない)', () => {
    expect(decls("[data-pkc-field='append-form']:focus-within")).toMatch(/border-color:\s*var\(--neon\)/);
    expect(decls("[data-pkc-field='append-form']:focus-within")).not.toMatch(/var\(--accent\)/);
    const inner = decls("[data-pkc-field='append-input'][data-pkc-field]:focus-visible");
    expect(inner).toMatch(/outline:\s*none/);
    expect(inner, '打つ欄が自分でも neon の線を引く(枠と二重)').toMatch(/box-shadow:\s*none/);
    expect(inner).toMatch(/border-color:\s*transparent/);
  });

  it('🔴 2 ペイン整理の焦点のある側は、同じ neon の枠(内側の影)', () => {
    const d = decls("[data-pkc-region='dual-pane'][data-pkc-focused]");
    expect(d).toMatch(/border-color:\s*var\(--neon\)/);
    expect(d).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--neon\)/);
    expect(forced).toContain("[data-pkc-region='dual-pane'][data-pkc-focused]");
  });

  it('🔴 フォーカスの枠は動きを減らす・指の端末などの問い(`GLOW_QUERY` / `prefers-reduced-motion` / `hover` / `pointer`)で外れない(静止の枠は残る)', () => {
    expect(ruleHaving(outsideForced, FOCUS_INPUT).length).toBeGreaterThan(0);
    // フォーカスの規則を包む `@media` は無い(強制色の外では常に効く)
    const at = css.indexOf(FOCUS_INPUT);
    expect(at).toBeGreaterThan(0);
    const before = css.slice(Math.max(0, at - 400), at);
    expect(before.lastIndexOf('@media'), '直前に開いた @media がある').toBeLessThan(before.lastIndexOf('}'));
    for (const q of ['prefers-reduced-motion', '(hover', '(pointer']) expect(forced + css.slice(at, at + 300)).not.toContain(q);
  });

  it('🔴 フォーカスが勝つ: 入力欄の近接は `:not(:focus-visible)` / 包み(追記欄・SQL)の線は `:not(:focus-within)`', () => {
    expect(css).toContain(":is(input, textarea, select):is([data-pkc-glow-near][data-pkc-glow-near], [data-pkc-glow-out][data-pkc-glow-out]):not(:focus-visible) {");
    const list = drawList();
    expect(list).toContain("[data-pkc-field='sql-input-wrap']:not(:focus-within)");
    expect(css).toContain("[data-pkc-field='append-form']:is([data-pkc-glow-near][data-pkc-glow-near], [data-pkc-glow-out][data-pkc-glow-out]):not(:focus-within)");
  });

  it('🔴 新しい対象(コードの枠・図のカード・折りたたみ・追記欄・SQL の包み)は共通の `::before` の線に入る(ログの器・ログの折りたたみは除く)', () => {
    const list = drawList();
    for (const t of [
      '.pkc-details:not([data-pkc-log-card])',
      ".pkc-md-block[data-pkc-render-lang]:not([data-pkc-render-lang='csv'], [data-pkc-log-card])",
      ".pkc-md-block[data-pkc-md-block-kind='code']:not([data-pkc-render-lang], [data-pkc-log-card])",
      "[data-pkc-field='sql-input-wrap']",
    ])
      expect(list, `${t} が共通の線に無い`).toContain(t);
    // 追記欄の枠は疑似要素でなく背景 3 層(`position: relative` を足すと取っ手の押し所を覆う)
    expect(list).not.toContain('append-form');
    const form = decls("[data-pkc-field='append-form']:is([data-pkc-glow-near][data-pkc-glow-near], [data-pkc-glow-out][data-pkc-glow-out]):not(:focus-within)");
    expect(form).toMatch(/background-clip:\s*padding-box,\s*border-box,\s*border-box/);
    expect(decls("[data-pkc-field='append-form']"), '追記欄の枠が位置づけ(取っ手の押し所を覆う)になった').not.toMatch(/position:\s*relative/);
  });

  it('🔴 横スクロールの表は透明な 2px の枠 + 器自身の背景(内側の地 → 光の放射)。疑似要素にしない・版面は動かさない', () => {
    const table = ".pkc-md-block.pkc-md-block.pkc-md-block:is([data-pkc-md-block-kind='table'], [data-pkc-render-lang='csv']):not([data-pkc-log-card])";
    const frame = decls(table);
    expect(frame).toMatch(/border:\s*2px solid transparent/);
    expect(frame, '枠のぶん版面が動く(上下)').toMatch(/margin-block:\s*-2px/);
    expect(frame, '右へはみ出している(読む面が横スクロールする)').not.toMatch(/margin-inline-end:\s*-/);
    expect(frame).toMatch(/margin-inline-start:\s*-2px/);
    expect(decls("[data-pkc-prose]:not([data-pkc-writing='vertical']) > " + table.replace(/^/, '')), '読み幅の余白があるとき、その余白から 2px 引く').toMatch(/margin-inline-start:\s*calc\(var\(--prose-indent, 0px\) - 2px\)/);
    const glowRule = decls(`${table}:is([data-pkc-glow-near], [data-pkc-glow-out])`);
    expect(glowRule).toMatch(/background-clip:\s*padding-box,\s*border-box/);
    expect(glowRule, '内側の地(線形)→ 光(放射)の順').toMatch(/linear-gradient\(var\(--surface\), var\(--surface\)\),\s*radial-gradient/);
    expect(glowRule).not.toMatch(/::before|::after/);
  });

  it('🔴 引用は左の線だけ光る(幅 3px の疑似要素。他の辺には出ない)', () => {
    const d = decls("blockquote:not(.pkc-section-callout):is([data-pkc-glow-near][data-pkc-glow-near], [data-pkc-glow-out][data-pkc-glow-out])::before");
    expect(d).toMatch(/width:\s*3px/);
    expect(d).toMatch(/inset-inline-start:\s*-3px/);
    expect(d).toMatch(/pointer-events:\s*none/);
  });

  it('🔴 図のカード: 図 + ラベル + 保存ボタンが 1 つの角丸ヘアライン(--surface / --radius-lg / --hairline)。保存ボタンはカードの上の帯へ', () => {
    const card = ".pkc-md-block[data-pkc-render-lang]:not([data-pkc-render-lang='csv'], [data-pkc-log-card])";
    const d = decls(card);
    expect(d).toMatch(/border:\s*1px solid var\(--hairline\)/);
    expect(d).toMatch(/border-radius:\s*var\(--radius-lg\)/);
    expect(d).toMatch(/background:\s*var\(--surface\)/);
    expect(d, '幅を図に合わせて縮めている(図の焼き幅が親の幅を読むので循環する)').not.toMatch(/fit-content|max-content/);
    expect(decls(`${card} [data-pkc-mermaid-src]`), '保存ボタンがカードでなく図の器に付いたまま').toMatch(/position:\s*static/);
    expect(decls(`${card} [data-pkc-field='diagram-save']`)).toMatch(/left:\s*var\(--s3\)/);
  });

  it('🔴 印刷・強制色には光の規則も、カード・透明な枠の規則も出ない(画面だけ)', () => {
    // カード・枠の規則は @media screen の中だけ
    const screenOnly = [".pkc-md-block.pkc-md-block.pkc-md-block:is([data-pkc-md-block-kind='table']", 'padding: 28px'];
    const outside = withoutMedia(css);
    for (const t of screenOnly) expect(outside, `${t} が画面の外(印刷)にもある`).not.toContain(t);
    expect(withoutMedia(css), '画面の外にも光の規則がある').not.toContain('[data-pkc-glow-near]');
    expect(outside).not.toContain('border: 2px solid transparent');
  });
});

/**
 * 🔴 **点き方・消え方(#2096)**── 素通りは光らせず余韻も残さない / 光った後に離れた物は余韻の印(`OUT_ATTR`)と最後の局所座標を残し、
 * `NEON_LEAVE_DURATION_MS` 後に消す / 片付けのタイマーは高々 1 本・0 件で止まる / 付けない環境・破棄・画面の外は余韻なしで即座に消す。
 * 時刻は `performance.now` を、タイマーは差し替え口(`NeonTimers`)を手で進める。
 */
describe('🔴 点き方・消え方(#2096)', () => {
  let clock = 0;
  let nextId = 1;
  let timers: { id: number; fn: () => void; at: number }[] = [];
  const fake: NeonTimers = {
    set: (fn, ms) => {
      const id = nextId++;
      timers.push({ id, fn, at: clock + ms });
      return id;
    },
    clear: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
  };
  /** 時刻を進め、期限の来たタイマーを鳴らす。 */
  const advance = (ms: number): void => {
    clock += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      timers = timers.filter((t) => t !== due);
      due.fn();
    }
  };
  const state = (el: HTMLElement): string => `${el.hasAttribute(NEAR_ATTR) ? 'near' : ''}${el.hasAttribute(OUT_ATTR) ? 'out' : ''}` || 'none';
  beforeEach(() => {
    clock = 1000;
    timers = [];
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
  });
  /** 3 枚とも光らせて(ポインタ (300, 110))、溜めの時間を過ごす。 */
  const litAll = (rig: Rig, m = media(true)): ReturnType<typeof media> => {
    glow = createNeonGlow(document, () => m, fake);
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 300, 110));
    runFrame();
    expect(rig.cards.slice(0, 3).map(state), '検査の前提: 先頭の 3 枚が光る').toEqual(['near', 'near', 'near']);
    return m;
  };
  const away = (rig: Rig): void => {
    rig.zone.dispatchEvent(pointer('pointermove', 300, 600, false));
    runFrame();
  };

  it('時間の正本は 45 / 220 / 260ms', () => {
    expect([NEON_ENTER_DELAY_MS, NEON_ENTER_DURATION_MS, NEON_LEAVE_DURATION_MS]).toEqual([45, 220, 260]);
  });

  it('🔴 素通り(溜めの間に離れた): 余韻の印も付けず、局所座標も即座に消す。タイマーも張らない', () => {
    const rig = makeLog();
    litAll(rig);
    advance(NEON_ENTER_DELAY_MS - 1);
    away(rig);
    expect(rig.cards.map(state), '素通りなのに余韻が出た(チカつく)').toEqual(['none', 'none', 'none']);
    expect(rig.cards[0]!.style.getPropertyValue('--gx'), '素通りなのに座標が残った').toBe('');
    expect(timers.length, '素通りなのにタイマーを張った').toBe(0);
    expect(glow!.fading()).toBe(0);
  });

  it('🔴 光った後に離れた: 余韻の印 + 最後の局所座標を残し、NEON_LEAVE_DURATION_MS 後に全部消える。タイマーは 3 枚でも 1 本', () => {
    const rig = makeLog();
    litAll(rig);
    advance(NEON_ENTER_DELAY_MS);
    away(rig);
    expect(rig.cards.map(state)).toEqual(['out', 'out', 'out']);
    expect(rig.cards[0]!.style.getPropertyValue('--gx'), '余韻なのに座標を消した(光の中心が画面の外へ飛ぶ)').toBe('200px');
    expect(rig.cards[0]!.style.getPropertyValue('--gy')).toBe('10px');
    expect(glow!.fading()).toBe(3);
    expect(timers.length, '片付けのタイマーが 1 本でない').toBe(1);
    advance(NEON_LEAVE_DURATION_MS - 1);
    expect(rig.cards.map(state), '期限の前に消えた').toEqual(['out', 'out', 'out']);
    advance(1);
    expect(rig.cards.map(state), '期限が来ても余韻の印が残った').toEqual(['none', 'none', 'none']);
    expect(rig.cards.map((c) => c.style.getPropertyValue('--gx') + c.style.getPropertyValue('--gy')), '座標が残った').toEqual(['', '', '']);
    expect(timers.length, 'タイマーが残った(常駐)').toBe(0);
    expect(glow!.fading()).toBe(0);
    expect(frames.length, '余韻の後に rAF が残った').toBe(0);
  });

  it('🔴 ゾーンから出た(pointerleave)ときも余韻を残す。ゾーンのリスナーは外れ、余韻の後は何も残らない', () => {
    const rig = makeLog();
    litAll(rig);
    advance(100);
    rig.zone.dispatchEvent(pointer('pointerleave', 0, 0, false));
    expect(glow!.inZone()).toBe(false);
    expect(rig.cards.map(state)).toEqual(['out', 'out', 'out']);
    advance(NEON_LEAVE_DURATION_MS);
    expect(rig.cards.map(state)).toEqual(['none', 'none', 'none']);
    expect(timers.length).toBe(0);
  });

  it('🔴 余韻の途中で再び近づくと、余韻の印が外れて近い印へ戻り、古い期限が来ても消えない。すぐ離れても余韻を残す', () => {
    const rig = makeLog();
    litAll(rig);
    advance(NEON_ENTER_DELAY_MS);
    away(rig);
    advance(100);
    rig.zone.dispatchEvent(pointer('pointermove', 300, 110, false));
    runFrame();
    expect(rig.cards.map(state), '戻らない').toEqual(['near', 'near', 'near']);
    expect(glow!.fading()).toBe(0);
    expect(timers.length, '余韻が 0 件なのにタイマーが残った').toBe(0);
    advance(NEON_LEAVE_DURATION_MS * 2);
    expect(rig.cards.map(state), '古い期限で消えた').toEqual(['near', 'near', 'near']);
    expect(rig.cards[0]!.style.getPropertyValue('--gx')).toBe('200px');
    // 戻った直後に離れる(溜めは済んでいる扱い)── ブツ切れにせず余韻
    rig.zone.dispatchEvent(pointer('pointermove', 300, 600, false));
    runFrame();
    expect(rig.cards.map(state), '戻った物が素通り扱いで即座に消えた').toEqual(['out', 'out', 'out']);
  });

  it('🔴 戻った物の余韻の期限は新しい離脱から数える(古い期限で途中で切れない)', () => {
    const rig = makeLog(1);
    glow = createNeonGlow(document, () => media(true), fake);
    rig.cards[0]!.dispatchEvent(pointer('pointerover', 300, 110));
    runFrame();
    advance(NEON_ENTER_DELAY_MS);
    away(rig); // 期限 = +260
    advance(200);
    rig.zone.dispatchEvent(pointer('pointermove', 300, 110, false));
    runFrame();
    away(rig); // 新しい期限 = いま +260
    advance(100); // 古い期限(+60)は過ぎた
    expect(state(rig.cards[0]!), '古い期限で切れた').toBe('out');
    advance(NEON_LEAVE_DURATION_MS - 100);
    expect(state(rig.cards[0]!)).toBe('none');
  });

  it.each([
    ['環境が付けない側へ(動きを減らす設定)', (m: ReturnType<typeof media>) => m.set(false)],
    ['スマホ用画面', () => glow!.setPhone(true)],
    ['破棄(destroy)', () => glow!.destroy()],
  ] as const)('🔴 %s: 光っている物も余韻の途中の物も、余韻なしで即座に全部消え、タイマーも 0', (_n, act) => {
    const rig = makeLog(5);
    const m = litAll(rig);
    advance(NEON_ENTER_DELAY_MS);
    // 0 は余韻へ、3・4 は光らせる(0・1・2 → 3・4)
    rig.zone.dispatchEvent(pointer('pointermove', 300, 480, false));
    runFrame();
    expect(rig.cards.map(state), '検査の前提').toEqual(['out', 'out', 'out', 'near', 'near']);
    act(m);
    expect(rig.cards.map(state), '余韻を残した').toEqual(['none', 'none', 'none', 'none', 'none']);
    expect(rig.cards.map((c) => c.style.getPropertyValue('--gx')).join('')).toBe('');
    expect(timers.length, 'タイマーが残った').toBe(0);
    expect(glow!.fading()).toBe(0);
  });

  it('🔴 ゾーンを出て余韻の途中に環境が付けない側へ変わっても、余韻は即座に消える(ゾーンの外でも)', () => {
    const rig = makeLog();
    const m = litAll(rig);
    advance(NEON_ENTER_DELAY_MS);
    rig.zone.dispatchEvent(pointer('pointerleave', 0, 0, false));
    expect(rig.cards.map(state)).toEqual(['out', 'out', 'out']);
    m.set(false);
    expect(rig.cards.map(state)).toEqual(['none', 'none', 'none']);
    expect(timers.length).toBe(0);
  });

  it('🔴 画面の外へ出た物(IntersectionObserver)は余韻なしで即座に消える ── 余韻の途中の物も', () => {
    ioInstances = [];
    vi.stubGlobal('IntersectionObserver', FakeIO);
    const rig = makeBody();
    glow = createNeonGlow(document, () => media(true), fake);
    rig.code.dispatchEvent(pointer('pointerover', 300, 125));
    runFrame();
    expect(rig.table.hasAttribute(NEAR_ATTR)).toBe(true);
    advance(NEON_ENTER_DELAY_MS);
    const io = ioInstances[0]!;
    io.show(rig.table, false);
    expect(state(rig.table), '画面の外へ出たのに余韻を残した').toBe('none');
    expect(rig.table.style.getPropertyValue('--gx')).toBe('');
    // 余韻の途中の物も
    rig.zone.dispatchEvent(pointer('pointerleave', 0, 0, false));
    expect(state(rig.code)).toBe('out');
    glow.destroy();
    expect(state(rig.code)).toBe('none');
  });

  it('🔴 片付け(タイマー)の自分の書き込みは汚れにしない ── 余韻が消えた後の次のコマで全カードを測り直さない', async () => {
    const rig = makeLog(5);
    litAll(rig);
    await microtasks();
    advance(NEON_ENTER_DELAY_MS);
    away(rig); // 0・1・2 が余韻
    await microtasks();
    const base = rig.measured();
    advance(NEON_LEAVE_DURATION_MS); // 片付けが印と style を消す
    expect(rig.cards.map(state).slice(0, 3)).toEqual(['none', 'none', 'none']);
    await microtasks(); // 片付けの記録が観測器へ届く(捨てていなければ汚れになる)
    rig.zone.dispatchEvent(pointer('pointermove', 300, 601, false));
    runFrame();
    expect(rig.measured(), '片付けのたびに全部測り直している(自分の片付けを汚れと数えた)').toBe(base);
  });

  it('🔴 片付けの直前に届いていた他の誰かの変更は捨てない(汚れとして次のコマで測り直す)', async () => {
    const rig = makeLog(3);
    litAll(rig);
    await microtasks();
    advance(NEON_ENTER_DELAY_MS);
    rig.zone.dispatchEvent(pointer('pointermove', 300, 330, false)); // 0・1 が余韻、2 は光ったまま
    runFrame();
    await microtasks();
    const base = rig.measured();
    const added = addCard(rig, 400); // 他の誰かの変更(子の追加)── 記録は同期で観測器に溜まる
    advance(NEON_LEAVE_DURATION_MS);
    rig.zone.dispatchEvent(pointer('pointermove', 300, 331, false));
    runFrame();
    expect(rig.measured(), '他の変更を片付けの記録と一緒に捨てた').toBeGreaterThan(base);
    expect(added.hasAttribute(NEAR_ATTR), '足したカードが光らない').toBe(true);
  });
});

describe('🔴 CSS(原文): 点き方・消え方(#2096)', () => {
  const raw = readFileSync(join(__dirname, '../../src/styles/app.css'), 'utf-8');
  const css = stripComments(raw);
  const neon = css.slice(css.indexOf('@property --neon-alpha'));
  const first = nthNoneBlock(css, 1);
  const third = nthNoneBlock(css, 3);
  /** 塊の中の規則(選択子, 宣言)。⚠ `@starting-style` の中の規則も含む(内側だけを拾う)。 */
  const rules = (src: string): [string, string][] => [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1]!.replace(/\s+/g, ' ').trim(), m[2]!]);
  const ENTER = `${NEON_ENTER_DURATION_MS}ms ease-out ${NEON_ENTER_DELAY_MS}ms`;
  const LEAVE = `${NEON_LEAVE_DURATION_MS}ms ease-out 0ms`;

  it('🔴 `--neon-alpha` は登録した数(`inherits: false` ── 子孫へ継承させない)・初期値 0。`@media` の外の独立した塊で、`:root` に書かない', () => {
    const m = css.match(/@property --neon-alpha\s*\{([^{}]*)\}/);
    expect(m, '@property が無い / 入れ子になっている').not.toBeNull();
    expect(m![1]).toMatch(/syntax:\s*'<number>'/);
    expect(m![1], '子孫へ継承する(全子孫の style を計算し直す)').toMatch(/inherits:\s*false/);
    expect(m![1]).toMatch(/initial-value:\s*0\s*;/);
    expect(withoutMedia(css), '@property が @media の中にある').toContain('@property --neon-alpha');
    expect(neon, ':root へ書いている').not.toMatch(/:root/);
    expect(neon.match(/--neon-alpha\s*:\s*[^;]+;/g)?.length, '`--neon-alpha` を書く規則が近い / 余韻の 2 つでない').toBe(2);
  });

  it('🔴 疑似要素: 近い印は 45ms 溜めて 220ms で 1 へ / 余韻の印は 260ms で 0 へ(`opacity` だけ)', () => {
    const r = rules(first);
    const near = r.filter(([sel, d]) => /\[data-pkc-glow-near\]\[data-pkc-glow-near\]::before,/.test(sel) && /transition:/.test(d));
    const out = r.filter(([sel, d]) => /\[data-pkc-glow-out\]\[data-pkc-glow-out\]::before,/.test(sel) && /transition:/.test(d));
    expect(near.length, '近い印の点き方の規則が無い').toBe(1);
    expect(out.length, '余韻の規則が無い').toBe(1);
    expect(near[0]![1]).toMatch(/opacity:\s*1;/);
    expect(near[0]![1]).toContain(`transition: opacity ${ENTER};`);
    expect(out[0]![1]).toMatch(/opacity:\s*0;/);
    expect(out[0]![1]).toContain(`transition: opacity ${LEAVE};`);
    for (const [sel] of [...near, ...out]) {
      expect(sel, '::after(にじみ)が入っていない').toContain('::after');
      expect(sel, '引用の左の線が入っていない').toContain('blockquote:not(.pkc-section-callout)');
      expect(sel, 'バーのボタンが入っていない').toContain("[data-pkc-region='rail'] button");
    }
    // ⚠ `opacity` 以外(色・座標)を補間しない ── 合成だけ
    expect(near[0]![1]).not.toMatch(/transition:[^;]*(background|--gx|--gy|all)/);
  });

  it('🔴 疑似要素が作られた最初のコマは `@starting-style` で 0 から(入れ子にせず、画面 + 強制色なしの塊の直下)', () => {
    const at = first.indexOf('@starting-style');
    expect(at, '@starting-style が無い').toBeGreaterThan(0);
    const { body } = atBlock(first.slice(at), '@starting-style');
    const r = rules(body);
    expect(r.length, '@starting-style の中が 1 規則でない').toBe(1);
    expect(r[0]![0]).toMatch(/\[data-pkc-glow-near\]\[data-pkc-glow-near\]::before,/);
    expect(r[0]![0]).toMatch(/::after$/);
    expect(r[0]![0]).toContain('blockquote:not(.pkc-section-callout)');
    expect(r[0]![1]).toMatch(/opacity:\s*0;/);
    // 描く規則(`content` を持つ)の中に `{` を入れ子にしていない
    expect(neon, 'CSS Nesting(宣言の中の @starting-style)').not.toMatch(/content:[^{}]*@starting-style/);
  });

  it('🔴 疑似要素の描く規則は `--neon-alpha` を使わない(引用の線は `--neon-alpha` の無い物で、掛けると 0 で見えなくなる)', () => {
    for (const [sel, d] of rules(neon)) if (/::(before|after)$/.test(sel) && /content:/.test(d)) expect(`${sel} ${d}`, '疑似要素の描く規則が `--neon-alpha` を読んでいる').not.toContain('--neon-alpha');
  });

  it('🔴 背景で描く物(ログの器・表・追記欄・入力欄): 近い印は 45ms 溜めて 220ms で `--neon-alpha: 1` / 余韻は 260ms で 0。光の色は `--neon-alpha` で掛ける', () => {
    const r = rules(third);
    const near = r.filter(([sel, d]) => sel.endsWith('[data-pkc-glow-near]') && /--neon-alpha:\s*1;/.test(d));
    const out = r.filter(([sel, d]) => sel.endsWith('[data-pkc-glow-out]') && /--neon-alpha:\s*0;/.test(d));
    expect(near.length).toBe(1);
    expect(out.length).toBe(1);
    expect(near[0]![1]).toContain(`transition: --neon-alpha ${ENTER};`);
    expect(out[0]![1]).toContain(`transition: --neon-alpha ${LEAVE};`);
    for (const [sel] of [...near, ...out]) {
      for (const t of ['[data-pkc-log-days] > :is(.pkc-md-block, .pkc-details)[data-pkc-log-card]', "[data-pkc-render-lang='csv']", "[data-pkc-field='append-form']:not(:focus-within)", ':is(input, textarea, select):not(:focus-visible)'])
        expect(sel, `${t} が入っていない(フォーカスのある物を外していない)`).toContain(t);
    }
    // 背景の光の色は濃さを掛ける(4 か所: ログの器の `--ng` / 表 / 追記欄 / 入力欄)── 掛けないと余韻の間に色が残ったまま、期限でブツっと消える
    const grads = [...neon.matchAll(/radial-gradient\(circle var\(--neon-r\) at var\(--gx, -500px\) var\(--gy, -500px\), ([^;]*)/g)].map((m) => m[1]!);
    const bg = grads.filter((g) => g.includes('--neon-alpha'));
    expect(bg.length, '濃さを掛けた背景の光が 4 か所でない').toBe(4);
    for (const g of bg) expect(g, '芯の色に濃さを掛けていない').toMatch(/color-mix\(in srgb, var\(--neon-core\) calc\(\d+% \* var\(--neon-alpha\)\), transparent\)/);
  });

  it('🔴 余韻の印の間も、背景・疑似要素の描く規則が当たる(近い印と同じ規則が両方の印を受ける)', () => {
    const sels = rules(neon).map(([sel]) => sel);
    for (const want of [
      "[data-pkc-log-card='solo']:is([data-pkc-glow-near], [data-pkc-glow-out])",
      "[data-pkc-render-lang='csv']):not([data-pkc-log-card]):is([data-pkc-glow-near], [data-pkc-glow-out])",
      "[data-pkc-field='append-form']:is([data-pkc-glow-near][data-pkc-glow-near], [data-pkc-glow-out][data-pkc-glow-out]):not(:focus-within)",
      ':is(input, textarea, select):is([data-pkc-glow-near][data-pkc-glow-near], [data-pkc-glow-out][data-pkc-glow-out]):not(:focus-visible)',
      'blockquote:not(.pkc-section-callout):is([data-pkc-glow-near][data-pkc-glow-near], [data-pkc-glow-out][data-pkc-glow-out])::before',
    ])
      expect(sels.some((s) => s.includes(want)), `${want} が無い`).toBe(true);
  });

  it('🔴 キーボードのフォーカスは遅らせない: フォーカスの線の規則は `transition` を持たない', () => {
    const focus = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /:focus-visible|:focus-within|\[data-pkc-focused\]/.test(m[1]!) && /var\(--neon\)/.test(m[2]!));
    expect(focus.length, 'フォーカスの線の規則が見つからない(空振り)').toBeGreaterThanOrEqual(3);
    for (const m of focus) expect(m[2], `${m[1]!.trim().slice(0, 60)}: フォーカスの線が遅れる`).not.toMatch(/transition/);
  });

  it('🔴 印刷・強制色に余韻の規則・@starting-style は出ない(画面 + 強制色なしの塊だけ)', () => {
    const outside = withoutMedia(css);
    expect(outside).not.toContain('[data-pkc-glow-out]');
    expect(outside).not.toContain('@starting-style');
    expect(atBlock(css, '@media (forced-colors: active)').body).not.toContain('glow');
  });
});
