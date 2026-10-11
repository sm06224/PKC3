/**
 * 🔴 **時間の目盛りの空いた所をドラッグして、予定を作る**(#855 段 B-2)。
 *
 * 予定の「日」「週」(`schedule-day.ts` / `schedule-week.ts`)の目盛りで、
 *
 * | 操作 | 何が起きるか |
 * |---|---|
 * | 空いた所を押して縦にドラッグ | 点線の枠(`14:00〜15:30`)が付いてくる。**15 分刻み**・最低 15 分・0:00〜24:00 |
 * | 離す | 枠の中に**入力欄**が出て、焦点が入る |
 * | 入力欄で `Enter` | `- [ ] 名前 @日付 14:00..15:30` を**今日のノートの末尾**へ足す(予定の面の「やることを足す」と同じ書き口) |
 * | 空のまま `Enter` / `Esc` / 空のまま離れる | 何も書かずに欄を消す |
 * | 空いた所をダブルクリック | 押した所から 30 分の枠で、同じ入力欄 |
 *
 * ## 作り
 *
 * - **掴みは Pointer Events 1 本**(`schedule-grid-drag.ts` と同じ作法)。**マウス**は 4px 動いたら始める。
 *   **指・ペン**は長押しで始める(縦のスクロールを奪わない)。「週」は**押した列の日**に作る(列をまたがない)。
 * - 札の上で始めたドラッグは**ここでは受けない**(札を動かす掴み = `schedule-grid-drag.ts` の仕事)。
 * - **書き口は 1 本**: `addScheduleItem`(`binder.ts`)── 予定の面の「足す」と同じ関数。開いている間の
 *   制限(編集中は今日のノートが無ければ断る等)もそこが持つ。**通ったときだけ**入力欄を消す。
 * - 🔑 **入力欄は列の直下に置く**(札の管理の外)── 描き直しは札だけを動かすので、打ちかけの字が消えない。
 *   ただし**列が別の日になった / 隠れた**(日を切り替えた・日から週へ移った)ときは、枠を畳む(別の日の列に
 *   居座らない)。🔴 **字があれば捨てずに 1 件だけ預かる**(`parked` ── 日付・時刻・字)。**その日の列が
 *   また見えたら**(同じ見せ方でも、日⇄週の別の見せ方でも)枠を字ごと戻して焦点を入れる。空なら預からない。
 * - 🔴 **預かっている間に別の所で新しく作り始めたら、断る**(理由を出す)。預かった字を黙って捨てる道も、
 *   2 件目を預かる道も作らない(いちばん単純で、打った字を静かに失わない規則)。`Enter` で書けたとき・
 *   `Esc` を押したとき・空にして `Enter` を押したときは、預かりも消える。
 * - **入力欄から焦点が外れたとき**: 空なら畳む。**字があれば残す**(打った字を失わない)── `Enter` か `Esc` まで。
 *   別の所を押しても字があれば畳まず、焦点を欄へ戻す。
 * - 🔑 **入力欄はいつも全部見える**: 15 分の枠は 10px、30 分は 20px しかないので、枠の高さに最低を置き
 *   (`app.css`)、1 時間に満たない枠は時刻の字を隠す(時刻は `title` と `aria-label` に残す)。
 * - `Enter` は**変換中なら送らない**(`isComposing` / `keyCode 229`)。
 *
 * ## 取り消し(書かずに畳む)
 *
 * ドラッグ中の `Esc`(捕捉段で止めて、開いているノートまで閉じない)/ `pointercancel` / 窓の `blur` /
 * ページが隠れた / `lostpointercapture` / マウスのボタンが離れているのに move が来た。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { addScheduleItem } from '@adapter/ui/actions/binder';
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX } from '@adapter/ui/actions/long-press';
import {
  createSlot,
  doubleClickSlot,
  formatMinutes,
  formatTimeRange,
} from '@features/schedule/day-layout';
import {
  GRID_GHOST_FIELD,
  GRID_MOUSE_SLOP_PX,
  GRID_SCROLLER_SELECTOR,
  gridEdgeSpeed,
} from './schedule-grid-drag';
import { GRID_LANE_SELECTOR } from './schedule-drag';

/** 作った枠(入力欄つき)。 */
export const GRID_CREATE_FIELD = 'schedule-create-box';
export const GRID_CREATE_INPUT_FIELD = 'schedule-create-input';
/** 作りかけの枠の右端の ×(#855)。押すと書かずに畳む(Esc と同じ ── 預かりも消える)。 */
export const GRID_CREATE_CANCEL_FIELD = 'schedule-create-cancel';

interface Press {
  readonly lane: HTMLElement;
  readonly date: string;
  /** 押した所の、列の上端からの距離(px)。⚠ 列の座標で持つ(自動で送っても動かない)。 */
  readonly startOffset: number;
  readonly scroller: HTMLElement | null;
  readonly pointerId: number;
  readonly pointerType: string;
  readonly startX: number;
  readonly startY: number;
  active: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  ghost: HTMLElement | null;
  slot: { startMin: number; endMin: number } | null;
  lastY: number;
}

const raf = (fn: () => void): unknown =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16);
const cancelRaf = (id: unknown): void => {
  if (typeof cancelAnimationFrame === 'function' && typeof id === 'number') cancelAnimationFrame(id);
  else clearTimeout(id as ReturnType<typeof setTimeout>);
};

/**
 * root へ 1 度だけ配線する(`installScheduleGridDrag` と同じ作法)。
 * @returns 外す関数。アプリ本体では外さない(同寿命)が、test は外せる必要がある。
 */
export function installScheduleGridCreate(root: HTMLElement, dispatcher: Dispatcher): () => void {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  let press: Press | null = null;
  let box: { el: HTMLElement; input: HTMLInputElement; lane: HTMLElement; date: string; startMin: number; endMin: number } | null =
    null;
  /** 日を切り替えて畳んだ枠のうち、字を打ちかけていたもの(1 件だけ)。 */
  let parked: { date: string; startMin: number; endMin: number; text: string } | null = null;
  let swallowClick = false;
  let swallowTimer: ReturnType<typeof setTimeout> | null = null;
  let escapedUntilUp = false;
  let scrollLoop: unknown = null;

  const armSwallow = (): void => {
    swallowClick = true;
    if (swallowTimer !== null) clearTimeout(swallowTimer);
    swallowTimer = setTimeout(() => {
      swallowClick = false;
      swallowTimer = null;
    }, 0);
  };
  const dateOf = (lane: HTMLElement): string =>
    lane.closest<HTMLElement>('[data-pkc-drop-date]')?.getAttribute('data-pkc-drop-date') ?? '';
  const laneHeightOf = (lane: HTMLElement): number => lane.getBoundingClientRect().height;
  const offsetIn = (lane: HTMLElement, y: number): number => y - lane.getBoundingClientRect().top;
  /** 押した所が「空いた所」か(札・入力欄・枠の上ではない)。 */
  const emptyLaneOf = (target: Element | null): HTMLElement | null => {
    if (target === null) return null;
    if (target.closest('[data-pkc-entry]') !== null) return null;
    if (target.closest(`[data-pkc-field="${GRID_CREATE_FIELD}"]`) !== null) return null;
    const lane = target.closest<HTMLElement>(GRID_LANE_SELECTOR);
    if (lane === null || !root.contains(lane)) return null;
    return lane;
  };

  // ── 入力欄 ──
  const closeBox = (): void => {
    const b = box;
    if (b === null) return;
    box = null; // ⚠ 先に外す(remove で出る blur が、もう一度ここへ戻らないように)
    b.el.remove();
  };
  const submitBox = (): void => {
    const b = box;
    if (b === null) return;
    const text = b.input.value.trim();
    if (text === '') {
      closeBox();
      return;
    }
    // 🔑 書く口は予定の面の「足す」と同じ 1 本。通ったときだけ欄を畳む(断られたら打った字を残す)
    const ok = addScheduleItem(dispatcher, {
      text,
      date: b.date,
      time: formatMinutes(b.startMin),
      timeEnd: formatMinutes(b.endMin),
    });
    if (ok) closeBox();
  };
  /** 預かりがあるとき、新しい枠を作り始めるのを断る(理由を出す)。断ったら true。 */
  const refuseWhileParked = (): boolean => {
    if (parked === null) return false;
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: `${parked.date} に、名前を打ちかけの予定があります。その日を開いて、書くか取り消すかしてから作ってください`,
    });
    return true;
  };
  const openBox = (
    lane: HTMLElement,
    date: string,
    startMin: number,
    endMin: number,
    text: string = '',
  ): void => {
    closeBox();
    parked = null;
    const el = doc.createElement('div');
    el.setAttribute('data-pkc-field', GRID_CREATE_FIELD);
    el.style.setProperty('--day-start', String(startMin));
    el.style.setProperty('--day-span', String(endMin - startMin));
    // 🔴 1 時間に満たない枠は時刻の字を隠して、入力欄を全部見せる(時刻は title / aria-label に残る)
    if (endMin - startMin < 60) el.setAttribute('data-pkc-short', '');
    el.title = formatTimeRange(startMin, endMin);
    const label = doc.createElement('span');
    label.setAttribute('data-pkc-field', 'schedule-create-label');
    label.textContent = formatTimeRange(startMin, endMin);
    const input = doc.createElement('input');
    input.type = 'text';
    input.setAttribute('data-pkc-field', GRID_CREATE_INPUT_FIELD);
    input.setAttribute('aria-label', `${formatTimeRange(startMin, endMin)} の予定の名前`);
    input.placeholder = '予定の名前';
    input.value = text;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        // 🔴 変換中の Enter は確定であって送信ではない(日本語入力)
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        e.stopPropagation();
        submitBox();
      } else if (e.key === 'Escape') {
        // 開いているノートの選択まで外さない
        e.preventDefault();
        e.stopPropagation();
        closeBox();
        parked = null;
      }
    });
    input.addEventListener('blur', () => {
      // 空なら畳む / 字があれば残す(打った字を失わない)
      if (box?.input === input && input.value.trim() === '') closeBox();
    });
    /**
     * 🔴 **マウスだけで閉じられる ×**(#855。Gemini 裁定 = #1163 のコメント 6104130726 の 9)。
     * ⚠ 閉じ方は `Esc` と同じ 1 本(`closeBox`)── 字を打っていても、押したら捨てる
     *   (押す物は「作るのをやめる」だけで、打った字を残す動きは Enter と焦点の外れが持つ)。
     *   預かり(`parked`)は枠が開いた時点で `openBox` が消している ── 開いている枠の × で消す物は無い。
     * 印は `::before`(`app.css`)、名前は `aria-label`。
     */
    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.setAttribute('data-pkc-field', GRID_CREATE_CANCEL_FIELD);
    cancelBtn.setAttribute('aria-label', '予定を作るのをやめる');
    cancelBtn.title = '作らずにやめます';
    cancelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeBox();
    });
    el.append(label, input, cancelBtn);
    lane.append(el);
    box = { el, input, lane, date, startMin, endMin };
    input.focus();
  };
  const shownLaneOf = (date: string): HTMLElement | null => {
    for (const lane of root.querySelectorAll<HTMLElement>(GRID_LANE_SELECTOR)) {
      if (lane.closest('[hidden]') === null && dateOf(lane) === date) return lane;
    }
    return null;
  };
  /**
   * 日を切り替えた・隠れたなど、枠がいまの列と合わなくなったら畳む。🔴 字があれば預かり、
   * その日の列がまた見えたら字ごと戻す。
   */
  const unsubscribe = dispatcher.onState(() => {
    const b = box;
    if (b !== null) {
      if (b.lane.isConnected && dateOf(b.lane) === b.date && b.lane.closest('[hidden]') === null) return;
      const text = b.input.value;
      closeBox();
      if (text.trim() !== '') parked = { date: b.date, startMin: b.startMin, endMin: b.endMin, text };
    }
    if (parked !== null) {
      const lane = shownLaneOf(parked.date);
      if (lane !== null) openBox(lane, parked.date, parked.startMin, parked.endMin, parked.text);
    }
  });

  // ── ドラッグ ──
  const hideGhost = (p: Press): void => {
    p.ghost?.remove();
    p.ghost = null;
  };
  const showGhost = (p: Press, slot: { startMin: number; endMin: number }): void => {
    let ghost = p.ghost;
    if (ghost === null) {
      ghost = doc.createElement('div');
      ghost.setAttribute('data-pkc-field', GRID_GHOST_FIELD);
      ghost.setAttribute('aria-hidden', 'true');
      p.ghost = ghost;
      p.lane.append(ghost);
    }
    ghost.style.setProperty('--day-start', String(slot.startMin));
    ghost.style.setProperty('--day-span', String(slot.endMin - slot.startMin));
    const label = formatTimeRange(slot.startMin, slot.endMin);
    if (ghost.textContent !== label) ghost.textContent = label;
  };
  const stopScrollLoop = (): void => {
    if (scrollLoop !== null) cancelRaf(scrollLoop);
    scrollLoop = null;
  };
  const finish = (): void => {
    stopScrollLoop();
    if (press === null) return;
    if (press.timer !== null) clearTimeout(press.timer);
    hideGhost(press);
    press = null;
  };
  function preview(p: Press, y: number): void {
    p.lastY = y;
    p.slot = createSlot(p.startOffset, offsetIn(p.lane, y), laneHeightOf(p.lane));
    showGhost(p, p.slot);
  }
  const tickScroll = (): void => {
    scrollLoop = null;
    const p = press;
    if (p === null || !p.active) return;
    const v = gridEdgeSpeed(p.scroller, p.lastY);
    if (v !== 0 && p.scroller !== null) {
      p.scroller.scrollTop += v;
      preview(p, p.lastY); // 送った後は列が指の下で動いている
    }
    scrollLoop = raf(tickScroll);
  };
  const activate = (p: Press): void => {
    p.active = true;
    if (p.pointerType !== 'mouse') {
      try {
        p.lane.setPointerCapture(p.pointerId);
      } catch {
        // 捕まえられない環境でも、document から届く
      }
      (navigator as unknown as { vibrate?: (ms: number) => boolean }).vibrate?.(10);
    }
    if (scrollLoop === null) scrollLoop = raf(tickScroll);
  };

  const onPointerDown = (e: PointerEvent): void => {
    swallowClick = false;
    escapedUntilUp = false;
    if (e.button !== 0 || press !== null) return;
    const target = e.target as Element | null;
    const lane = emptyLaneOf(target);
    if (lane === null) return;
    // 字を打ちかけの枠が開いている ── 別の所を押しても失わない(焦点を欄へ戻す)。空なら畳んで始める
    if (box !== null) {
      if (box.input.value.trim() !== '') {
        e.preventDefault();
        box.input.focus();
        return;
      }
      closeBox();
    }
    const date = dateOf(lane);
    if (date === '' || !(laneHeightOf(lane) > 0)) return;
    if (refuseWhileParked()) return;
    const p: Press = {
      lane,
      date,
      startOffset: offsetIn(lane, e.clientY),
      scroller: lane.closest<HTMLElement>(GRID_SCROLLER_SELECTOR),
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      timer: null,
      ghost: null,
      slot: null,
      lastY: e.clientY,
    };
    press = p;
    if (p.pointerType !== 'mouse') {
      p.timer = setTimeout(() => {
        p.timer = null;
        if (press === p) activate(p);
      }, LONG_PRESS_MS);
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    const p = press;
    if (p === null || e.pointerId !== p.pointerId) return;
    // 🔴 マウスのボタンがもう離れている ── 離した合図が届かなかった。書かずに畳む
    if (p.pointerType === 'mouse' && e.buttons === 0) {
      const wasActive = p.active;
      finish();
      if (wasActive) armSwallow();
      return;
    }
    p.lastY = e.clientY;
    if (!p.active) {
      const moved = Math.hypot(e.clientX - p.startX, e.clientY - p.startY);
      if (p.pointerType === 'mouse') {
        if (moved < GRID_MOUSE_SLOP_PX) return;
        activate(p);
      } else {
        // 確定する前に動いたらスクロールに譲る
        if (moved > LONG_PRESS_SLOP_PX) finish();
        return;
      }
    }
    e.preventDefault();
    preview(p, e.clientY);
  };

  const onPointerUp = (e: PointerEvent): void => {
    const p = press;
    if (p === null) {
      if (escapedUntilUp) {
        escapedUntilUp = false;
        armSwallow();
      }
      return;
    }
    if (e.pointerId !== p.pointerId) return;
    if (!p.active) {
      finish(); // ただの click / タップ
      return;
    }
    preview(p, e.clientY); // 離した位置で決め直す
    const slot = p.slot;
    const { lane, date } = p;
    finish();
    armSwallow();
    if (slot !== null) openBox(lane, date, slot.startMin, slot.endMin);
  };

  const cancel = (): void => {
    if (press === null) return;
    const wasActive = press.active;
    finish();
    if (wasActive) armSwallow();
  };
  const onPointerCancel = (e: PointerEvent): void => {
    if (press === null || e.pointerId !== press.pointerId) return;
    finish();
  };
  /** 🔴 ドラッグ中の `Esc` は捕捉段で止める(開いているノートまで閉じない)。始める前の `Esc` は通す。 */
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || press === null || !press.active) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    finish();
    escapedUntilUp = true;
  };
  const onClick = (e: MouseEvent): void => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  };
  const onDblClick = (e: MouseEvent): void => {
    const lane = emptyLaneOf(e.target as Element | null);
    if (lane === null) return;
    const date = dateOf(lane);
    if (date === '' || !(laneHeightOf(lane) > 0)) return;
    if (refuseWhileParked()) return;
    if (box !== null && box.input.value.trim() !== '') {
      box.input.focus();
      return;
    }
    const slot = doubleClickSlot(offsetIn(lane, e.clientY), laneHeightOf(lane));
    openBox(lane, date, slot.startMin, slot.endMin);
  };
  const onBlur = (): void => cancel();
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') cancel();
  };
  const onLostCapture = (e: Event): void => {
    const p = press;
    if (p === null || (e as PointerEvent).pointerId !== p.pointerId) return;
    cancel();
  };
  const onTouchMove = (e: TouchEvent): void => {
    if (press?.active === true) e.preventDefault();
  };
  /** 動かしている間に字が選ばれていかないようにする。 */
  const onSelectStart = (e: Event): void => {
    if (press?.active === true) e.preventDefault();
  };

  doc.addEventListener('pointerdown', onPointerDown);
  doc.addEventListener('pointermove', onPointerMove);
  doc.addEventListener('pointerup', onPointerUp);
  doc.addEventListener('pointercancel', onPointerCancel);
  doc.addEventListener('lostpointercapture', onLostCapture);
  doc.addEventListener('visibilitychange', onVisibility);
  doc.addEventListener('selectstart', onSelectStart);
  doc.addEventListener('dblclick', onDblClick);
  win?.addEventListener('keydown', onKeyDown, true);
  win?.addEventListener('blur', onBlur);
  doc.addEventListener('touchmove', onTouchMove, { passive: false });
  doc.addEventListener('click', onClick, true);
  return () => {
    finish();
    closeBox();
    parked = null;
    unsubscribe();
    if (swallowTimer !== null) clearTimeout(swallowTimer);
    doc.removeEventListener('pointerdown', onPointerDown);
    doc.removeEventListener('pointermove', onPointerMove);
    doc.removeEventListener('pointerup', onPointerUp);
    doc.removeEventListener('pointercancel', onPointerCancel);
    doc.removeEventListener('lostpointercapture', onLostCapture);
    doc.removeEventListener('visibilitychange', onVisibility);
    doc.removeEventListener('selectstart', onSelectStart);
    doc.removeEventListener('dblclick', onDblClick);
    win?.removeEventListener('keydown', onKeyDown, true);
    win?.removeEventListener('blur', onBlur);
    doc.removeEventListener('touchmove', onTouchMove);
    doc.removeEventListener('click', onClick, true);
  };
}
