/** @vitest-environment happy-dom */
/**
 * 🔴 **予定の札を、指でも掴んで動かせるようにする**(#855 決1)。
 * 実体は `src/adapter/ui/render/schedule-drag.ts`。
 *
 * ## ここが見るもの / 見ないもの
 *
 * ⚠ **見ない**:「いま指の下に本当に何が在るか」の判定(`elementFromPoint`)は
 *   happy-dom で常に `null` を返す(実測 ── `node_modules/happy-dom/.../
 *   Document.js` の `elementFromPoint(_x, _y) { return null; }`)ので、
 *   ここは**フォールバック(`e.target`)側**だけを通る。**本物の判定は smoke**
 *   (`tests/smoke/schedule.smoke.spec.ts` の「指」test)。
 * 🔴 **見る**:①マウスを受けない(既存の HTML5 drag と競合しない)
 *   ②長押しが確定するまでは掴まない(短いタップは click が素通る / 確定前に
 *   動いたらスクロールへ譲る)③印 / 外す ✕ の上からは掴まない
 *   ④離した先が落とし先でなければ何もしない ⑤繰り返しは断る
 *   ⑥`pointercancel` は光りを消すだけ ⑦ノート丸ごとの予定は
 *   `SET_ENTRY_DATE`、行の予定は `SET_TASK_DATE`(= `dropTaskCard` 1 本を通る)
 *   ⑧2 本目の指では掴み直さない。
 *
 * ⚠ **`binder.ts` の HTML5 drag(マウス)は変えていない** ── その回帰は
 *   `tests/adapter/schedule-view.test.ts`(`dragTo` ヘルパ)が既に見ている。
 * ⚠ **`LONG_PRESS_MS` / `LONG_PRESS_SLOP_PX` は `long-press.ts` と同じ値**
 *   (`schedule-drag.ts` がそこから import している)── 時計は
 *   `long-press.test.ts` と同じく `vi.useFakeTimers()` で進める。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { installScheduleDrag } from '../../src/adapter/ui/render/schedule-drag';
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX } from '../../src/adapter/ui/actions/long-press';
import type { UserAction } from '../../src/adapter/state/app-state';

let root: HTMLElement;
let group27: HTMLElement; // 落とし先(2026-08-27)
let card: HTMLElement; // 掴む札(2026-08-23 の束に居る、行 0)
let checkbox: HTMLInputElement | null;
let unschedule: HTMLButtonElement;
let dispatcher: Dispatcher;
let dispatched: UserAction[];
let detach: () => void;

/**
 * ⚠ 実 UI の DOM 構造だけを、手で最小限に組む(`ScheduleRenderer` は使わない ──
 * ここが見るのは配線であって束ね方ではない)。
 * 🔑 **`schedule-cards` の直下**に置く ── `TASK_CARD_SELECTOR` は
 * `binder.ts` の HTML5 dragstart が使う綴りと同じ `[data-pkc-region="schedule-cards"]
 * > [data-pkc-entry]` なので、ここを外すと「掴めない」を誤検出したまま緑になる。
 */
function mountGroup(date: string, ...cardEls: HTMLElement[]): HTMLElement {
  const group = document.createElement('section');
  group.setAttribute('data-pkc-region', 'schedule-group');
  group.setAttribute('data-pkc-drop-date', date);
  const cardsHost = document.createElement('div');
  cardsHost.setAttribute('data-pkc-region', 'schedule-cards');
  cardsHost.append(...cardEls);
  group.append(cardsHost);
  return group;
}

function makeTaskCard(lid: string, opts: { whole?: boolean; repeat?: string } = {}): HTMLElement {
  const el = document.createElement('article');
  el.setAttribute('data-pkc-entry', lid);
  if (opts.whole === true) el.setAttribute('data-pkc-whole-note', '');
  if (opts.repeat !== undefined) el.setAttribute('data-pkc-task-repeat', opts.repeat);
  const text = document.createElement('span');
  text.setAttribute('data-pkc-field', 'text');
  text.textContent = '見積を送る';
  el.append(text);
  if (opts.whole !== true) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.setAttribute('data-pkc-task-line', '0');
    el.append(box);
    checkbox = box;
  } else {
    checkbox = null;
  }
  const off = document.createElement('button');
  off.setAttribute('data-pkc-field', 'task-unschedule');
  el.append(off);
  unschedule = off;
  return el;
}

/** 台を作り直す(`beforeEach` 以外の形が要る test だけが呼ぶ)。 */
function rebuild(groups: HTMLElement[]): void {
  detach();
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);
  root.append(...groups);
  dispatched = [];
  detach = installScheduleDrag(root, dispatcher);
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);

  card = makeTaskCard('e1');
  const group23 = mountGroup('2026-08-23', card);
  group27 = mountGroup('2026-08-27');

  root.append(group23, group27);

  dispatcher = new Dispatcher();
  dispatched = [];
  const origDispatch = dispatcher.dispatch.bind(dispatcher);
  dispatcher.dispatch = (a: UserAction) => {
    dispatched.push(a);
    return origDispatch(a);
  };
  detach = installScheduleDrag(root, dispatcher);
});

afterEach(() => {
  detach();
  vi.useRealTimers();
});

type Pointer = 'touch' | 'mouse' | 'pen';
function pointer(
  el: HTMLElement,
  type: string,
  kind: Pointer,
  x: number,
  y: number,
  pointerId = 1,
): boolean {
  return el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerType: kind,
      button: 0,
      pointerId,
      clientX: x,
      clientY: y,
    }),
  );
}
function fireClick(el: HTMLElement): boolean {
  return el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}
/** 押して(pointerdown)、確定するまで時計を進める(`long-press.test.ts` と同じ作法)。 */
function pressUntilArmed(el: HTMLElement, kind: Pointer = 'touch', pointerId = 1): void {
  pointer(el, 'pointerdown', kind, 0, 0, pointerId);
  vi.advanceTimersByTime(LONG_PRESS_MS);
}

describe('installScheduleDrag(#855 決1)', () => {
  it('🔴 マウスは受けない(既存の HTML5 drag に任せる ── 口を 2 つ作らない)', () => {
    pointer(card, 'pointerdown', 'mouse', 0, 0);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    pointer(group27, 'pointermove', 'mouse', 500, 500);
    pointer(group27, 'pointerup', 'mouse', 500, 500);
    expect(dispatched, 'マウスなのに指の経路が反応した').toEqual([]);
    expect(group27.hasAttribute('data-pkc-dropping'), 'マウスなのに落とし先が光った').toBe(false);
  });

  it('🔴 短く押しただけ(確定前に離した)では掴まない ── click が素通る', () => {
    pointer(card, 'pointerdown', 'touch', 0, 0);
    vi.advanceTimersByTime(LONG_PRESS_MS - 50); // 確定(500ms)の手前
    pointer(card, 'pointerup', 'touch', 0, 0);
    expect(dispatched, '確定前なのに dispatch された').toEqual([]);
    // ⚠ 素通る = click が preventDefault されない(select-entry へ届く)
    expect(fireClick(card), 'click が飲まれた(タップしただけなのに)').toBe(true);
    // 🔑 離した後は時計が進んでも発火しない(タイマーを消している)
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(group27.hasAttribute('data-pkc-dropping'), '離した後に勝手に確定した').toBe(false);
  });

  it('🔴 確定前に動いたら「掴む」にしない(スクロールへ譲る ── 要件そのもの)', () => {
    pointer(card, 'pointerdown', 'touch', 0, 0);
    /**
     * ⚠ **`group27` の上で**動きを撃つ ── 奪い取っていれば、ここで
     *   `data-pkc-dropping` が立つはず(下の「本当に掴めば光る」test と対)。
     *   `LONG_PRESS_SLOP_PX` を超える移動は「押さえ続けている」ではなく
     *   「もう動かしている」= 一覧のスクロールである。
     */
    const canceled = !pointer(group27, 'pointermove', 'touch', 0, LONG_PRESS_SLOP_PX + 5);
    expect(canceled, '動いただけなのに preventDefault された(スクロールを殺す)').toBe(false);
    expect(group27.hasAttribute('data-pkc-dropping'), '確定前の移動で掴んでしまった').toBe(false);
    // 🔑 時計を進めても、もう確定しない(取り消し済み)
    vi.advanceTimersByTime(LONG_PRESS_MS);
    pointer(group27, 'pointermove', 'touch', 100, 100);
    pointer(group27, 'pointerup', 'touch', 100, 100);
    expect(dispatched, 'スクロールのつもりが最終的に掴まれて書かれた').toEqual([]);
  });

  it('🔴 指で押さえ続けて確定させ、日へ落とすと SET_TASK_DATE が飛ぶ(掴んでいる間だけ光る)', () => {
    pressUntilArmed(card);
    pointer(group27, 'pointermove', 'touch', 200, 200); // 確定後は方向を問わない
    expect(group27.hasAttribute('data-pkc-dropping'), '確定して動かしても光らない').toBe(true);
    pointer(group27, 'pointerup', 'touch', 200, 200);
    expect(dispatched).toEqual([
      { type: 'SET_TASK_DATE', lid: 'e1', line: 0, date: '2026-08-27', time: null, until: null },
    ]);
    // ⚠ 離したら光りは消える(次の無関係な drop に紛れない)
    expect(group27.hasAttribute('data-pkc-dropping'), '離しても光ったまま').toBe(false);
    // 🔑 動いた回は click が飲まれる(離した指の click が select-entry を撃たない)
    expect(fireClick(group27), '動いたのに click が素通った').toBe(false);
  });

  it('🔴 印(checkbox)の上からは掴まない ── 押せば普通にチェックが切り替わる', () => {
    expect(checkbox, '台の空振り(印が無い)').not.toBeNull();
    pressUntilArmed(checkbox!);
    pointer(group27, 'pointermove', 'touch', 300, 300);
    pointer(group27, 'pointerup', 'touch', 300, 300);
    expect(dispatched, '印から掴めてしまった').toEqual([]);
    expect(group27.hasAttribute('data-pkc-dropping')).toBe(false);
  });

  it('🔴 外す ✕ ボタンの上からは掴まない', () => {
    pressUntilArmed(unschedule);
    pointer(group27, 'pointermove', 'touch', 300, 300);
    pointer(group27, 'pointerup', 'touch', 300, 300);
    expect(dispatched, '✕ ボタンから掴めてしまった').toEqual([]);
  });

  it('🔴 離した先が落とし先でなければ何もしない', () => {
    pressUntilArmed(card);
    pointer(root, 'pointermove', 'touch', 300, 300); // `data-pkc-drop-date` を持たない
    pointer(root, 'pointerup', 'touch', 300, 300);
    expect(dispatched).toEqual([]);
  });

  it('🔴 `pointercancel` は光りを消すだけ(本文は書かない)', () => {
    pressUntilArmed(card);
    pointer(group27, 'pointermove', 'touch', 200, 200);
    expect(group27.hasAttribute('data-pkc-dropping')).toBe(true);
    pointer(group27, 'pointercancel', 'touch', 200, 200);
    expect(group27.hasAttribute('data-pkc-dropping'), 'キャンセルしても光ったまま').toBe(false);
    expect(dispatched, 'キャンセルなのに書いた').toEqual([]);
  });

  it('🔴 確定前の `pointercancel` は、確定を止める', () => {
    pointer(card, 'pointerdown', 'touch', 0, 0);
    pointer(card, 'pointercancel', 'touch', 0, 0);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    pointer(group27, 'pointermove', 'touch', 200, 200);
    pointer(group27, 'pointerup', 'touch', 200, 200);
    expect(dispatched, 'キャンセルしたのに後から確定して書かれた').toEqual([]);
  });

  it('🔴 繰り返しの回は動かさず、断る(規則ごとずらす/この回だけずらす、を勝手に選ばない)', () => {
    const repeating = makeTaskCard('e1', { repeat: 'week' });
    rebuild([mountGroup('2026-08-23', repeating), group27]);

    pressUntilArmed(repeating);
    pointer(group27, 'pointermove', 'touch', 200, 200);
    pointer(group27, 'pointerup', 'touch', 200, 200);
    expect(dispatched).toEqual([
      {
        type: 'OP_FAILED',
        error: '繰り返しの予定はドラッグで動かせません。本文の「@日付 毎週」を書き直してください',
      },
    ]);
  });

  it('🔴 ノート 1 件が丸ごと予定のときは SET_ENTRY_DATE(frontmatter 単位)', () => {
    const whole = makeTaskCard('e1', { whole: true });
    rebuild([mountGroup('2026-08-23', whole), group27]);

    pressUntilArmed(whole);
    pointer(group27, 'pointermove', 'touch', 200, 200);
    pointer(group27, 'pointerup', 'touch', 200, 200);
    expect(dispatched).toEqual([{ type: 'SET_ENTRY_DATE', lid: 'e1', date: '2026-08-27' }]);
  });

  it('🔴 「日付なし」へ落とすと外れる(消すのではない ── date: null)', () => {
    const undated = mountGroup('');
    root.append(undated);

    pressUntilArmed(card);
    pointer(undated, 'pointermove', 'touch', 200, 200);
    pointer(undated, 'pointerup', 'touch', 200, 200);
    expect(dispatched).toEqual([
      { type: 'SET_TASK_DATE', lid: 'e1', line: 0, date: null, time: null, until: null },
    ]);
  });

  it('🔴 2 本目の指では掴み直さない(1 本目の掴みが残る)', () => {
    const second = makeTaskCard('e2');
    root.append(mountGroup('2026-08-30', second));

    pointer(card, 'pointerdown', 'touch', 0, 0, 1);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    pointer(second, 'pointerdown', 'touch', 900, 900, 2);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    // ⚠ 2 本目(pointerId=2)を動かして離しても、何も起きない
    pointer(group27, 'pointermove', 'touch', 999, 999, 2);
    pointer(group27, 'pointerup', 'touch', 999, 999, 2);
    expect(dispatched, '2 本目の指が割り込んだ').toEqual([]);
    // 1 本目(pointerId=1)を動かして離すと、1 本目の荷物(e1)で書く
    pointer(group27, 'pointermove', 'touch', 200, 200, 1);
    pointer(group27, 'pointerup', 'touch', 200, 200, 1);
    expect(dispatched).toEqual([
      { type: 'SET_TASK_DATE', lid: 'e1', line: 0, date: '2026-08-27', time: null, until: null },
    ]);
  });

  it('外したあとは何も配線されていない(dispose)', () => {
    detach();
    pointer(card, 'pointerdown', 'touch', 0, 0);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    pointer(group27, 'pointermove', 'touch', 200, 200);
    pointer(group27, 'pointerup', 'touch', 200, 200);
    expect(dispatched, '外したのに配線が生きている').toEqual([]);
  });
});
