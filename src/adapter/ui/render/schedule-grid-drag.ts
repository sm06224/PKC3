/**
 * 🔴 **時間の目盛りの上で、札を動かして時刻を変える**(#855 段 B-1)。
 *
 * 予定の「日」「週」(`schedule-day.ts` / `schedule-week.ts`)の目盛りに居る札は、
 *
 * | 操作 | 何が変わるか |
 * |---|---|
 * | 札を上下に動かす | 始まりの時刻(**15 分刻み**)。**長さは保つ**。「週」で隣の日の列へ動かすと日も変わる |
 * | 札の下の縁を引く | 終わりの時刻だけ(15 分刻み・最低 15 分・24:00 まで)。終わりの無い札には終わりが付く |
 * | 目盛りの外(小さな月の升・一覧の見出し)で離す | 日だけ変わる(`dropTaskCard` ── 今までと同じ) |
 * | `Esc` / 札の外で離す | 何も変わらない |
 *
 * ## 作り
 *
 * - **掴みは Pointer Events 1 本**(マウス・ペン・指)。⚠ 目盛りの札は HTML5 の drag を切ってある
 *   (`placeCardInGrid` ── 両方が生きていると奪い合う)。終日・一覧の札は従来の HTML5 drag のまま。
 * - **マウス**は 4px 動いたら掴む(押しただけ・ちょっと触れただけは今までどおり click)。
 *   **指・ペン**は長押しで掴む(縦のスクロールを奪わない ── `schedule-drag.ts` の頭に実測がある)。
 * - **見せるもの**は札そのものではなく、動かす先の**影**(点線の枠 + `14:15〜15:15`)。
 *   札は元の場所に残る(描き直しで掴んでいる札が消えない ── 両描き手とも札を使い回す)。
 * - **書くのは既存の口**: 単日 = `SET_TASK_DATE`(`timeEnd` つき)/ 繰り返しの回 = いつもの
 *   この回だけ / 全部 / やめる の小窓 → `MOVE_REPEAT_OCCURRENCE` か規則の行の `SET_TASK_DATE`。
 *   ⚠ 新しい書込経路は作らない(§7)。
 * - **日だけ変える落とし方**は `dropTaskCard` 1 本を呼ぶ(判定を 2 つ持たない)。
 *
 * ⚠ 「いま指の下に何が在るか」は `document.elementFromPoint` で引く(happy-dom は常に `null`
 *   なので `e.target` に落とす ── `schedule-drag.ts` と同じ作法。unit は列の要素へ直に撃つ)。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX } from '@adapter/ui/actions/long-press';
import { daysBetween } from '@features/datetime/date-math';
import {
  deltaMinutes,
  formatMinutes,
  formatTimeRange,
  minutesFromOffset,
  moveSlot,
  pieceOf,
  resizeSlot,
} from '@features/schedule/day-layout';
import { pickRepeatMoveInApp } from './app-dialog';
import {
  GRID_LANE_SELECTOR,
  dropTaskCard,
  repeatMoveAction,
  type GrabbedTask,
} from './schedule-drag';

/** マウスが「掴んだ」と数える動き(px)。これ未満は click のまま。 */
export const GRID_MOUSE_SLOP_PX = 4;

/** 掴ませない部品(チェックの印 / 外す ✕)。⚠ 属性の綴りを `schedule-drag.ts` と揃える。 */
const NO_GRAB_SELECTOR = 'input[type="checkbox"], [data-pkc-field="task-unschedule"]';
const RESIZE_SELECTOR = '[data-pkc-field="task-resize"]';
/** 影(動かす先の枠)。 */
export const GRID_GHOST_FIELD = 'schedule-drag-ghost';

interface Grab {
  readonly mode: 'move' | 'resize';
  readonly card: HTMLElement;
  readonly task: GrabbedTask;
  /** 掴んだ列(影の置き場の初期値 / 縁を引く間の基準)。 */
  readonly lane: HTMLElement;
  readonly laneHeight: number;
  /** 掴んだ札の日。 */
  readonly from: string;
  readonly time: string;
  readonly timeEnd: string | null;
  /** 目盛りに描いている幅(終わりの無い札は 30 分)。 */
  readonly startMin: number;
  readonly endMin: number;
  readonly pointerId: number;
  readonly pointerType: string;
  readonly startX: number;
  readonly startY: number;
  active: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  ghost: HTMLElement | null;
  result: Result | null;
}

type Result =
  | { readonly kind: 'slot'; readonly date: string; readonly startMin: number; readonly endMin: number }
  | { readonly kind: 'date'; readonly date: string }
  | { readonly kind: 'resize'; readonly endMin: number };

/**
 * root へ 1 度だけ配線する(`installScheduleDrag` と同じ作法)。
 * @returns 外す関数。アプリ本体では外さない(同寿命)が、test は外せる必要がある。
 */
export function installScheduleGridDrag(root: HTMLElement, dispatcher: Dispatcher): () => void {
  const doc = root.ownerDocument;
  let grab: Grab | null = null;
  let swallowClick = false;
  /** `Esc` で取り消した後、マウスを離すまで(離したときの click を飲む)。 */
  let escapedUntilUp = false;
  let dropMark: HTMLElement | null = null;

  const clearDrop = (): void => {
    dropMark?.removeAttribute('data-pkc-dropping');
    dropMark = null;
  };
  const markDrop = (el: HTMLElement): void => {
    if (dropMark === el) return;
    clearDrop();
    dropMark = el;
    el.setAttribute('data-pkc-dropping', '');
  };
  const dateTargetOf = (el: Element | null): { el: HTMLElement; date: string } | null => {
    const found = el?.closest<HTMLElement>('[data-pkc-drop-date]') ?? null;
    if (found === null || !root.contains(found)) return null;
    return { el: found, date: found.getAttribute('data-pkc-drop-date') ?? '' };
  };
  const underPointer = (e: PointerEvent): Element | null => {
    if (typeof doc.elementFromPoint === 'function') {
      const hit = doc.elementFromPoint(e.clientX, e.clientY);
      if (hit !== null) return hit;
    }
    return e.target as Element | null;
  };

  /**
   * 離した直後の click を 1 回飲む。⚠ 次の 1 手で畳む ── click は離した直後に同じ周で届くので、
   * 届かなかった(離した先が別の物だった)とき、**後から来る無関係な click**(小窓の行・キーボードの
   * Enter)を飲まない。
   */
  const armSwallow = (): void => {
    swallowClick = true;
    setTimeout(() => {
      swallowClick = false;
    }, 0);
  };

  const hideGhost = (g: Grab): void => {
    g.ghost?.remove();
    g.ghost = null;
  };
  const showGhost = (g: Grab, lane: HTMLElement, startMin: number, endMin: number): void => {
    let ghost = g.ghost;
    if (ghost === null) {
      ghost = doc.createElement('div');
      ghost.setAttribute('data-pkc-field', GRID_GHOST_FIELD);
      ghost.setAttribute('aria-hidden', 'true');
      g.ghost = ghost;
    }
    if (ghost.parentElement !== lane) lane.append(ghost);
    ghost.style.setProperty('--day-start', String(startMin));
    ghost.style.setProperty('--day-span', String(endMin - startMin));
    const label = formatTimeRange(startMin, endMin);
    if (ghost.textContent !== label) ghost.textContent = label;
  };

  const finish = (): void => {
    if (grab === null) return;
    if (grab.timer !== null) clearTimeout(grab.timer);
    hideGhost(grab);
    grab.card.removeAttribute('data-pkc-dragging');
    clearDrop();
    grab = null;
  };

  const activate = (g: Grab): void => {
    g.active = true;
    g.card.setAttribute('data-pkc-dragging', '');
    if (g.pointerType !== 'mouse') {
      try {
        g.card.setPointerCapture(g.pointerId);
      } catch {
        // 捕まえられない環境でも、下の pointermove/pointerup は document から届く
      }
      // 🔑 指に返事をする(`long-press.ts` と同じ)
      (navigator as unknown as { vibrate?: (ms: number) => boolean }).vibrate?.(10);
    }
  };

  const laneHeightOf = (lane: HTMLElement, fallback: number): number => {
    const h = lane.getBoundingClientRect().height;
    return h > 0 ? h : fallback;
  };

  const onPointerDown = (e: PointerEvent): void => {
    swallowClick = false;
    escapedUntilUp = false;
    if (e.button !== 0 || grab !== null) return;
    const target = e.target as Element | null;
    if (target?.closest(NO_GRAB_SELECTOR) != null) return;
    const card = target?.closest<HTMLElement>('[data-pkc-entry]') ?? null;
    if (card === null || !root.contains(card)) return;
    const lane = card.parentElement;
    if (lane === null || !lane.matches(GRID_LANE_SELECTOR)) return;
    const lid = card.getAttribute('data-pkc-entry');
    const line = card.querySelector('[data-pkc-task-line]')?.getAttribute('data-pkc-task-line') ?? null;
    const time = card.getAttribute('data-pkc-task-time');
    if (lid === null || line === null || time === null) return;
    const timeEnd = card.getAttribute('data-pkc-task-time-end');
    const piece = pieceOf('', time, timeEnd);
    if (piece === null) return;
    const from = dateTargetOf(lane)?.date ?? '';
    const g: Grab = {
      mode: target?.closest(RESIZE_SELECTOR) != null ? 'resize' : 'move',
      card,
      task: { lid, line, from, repeat: card.getAttribute('data-pkc-task-repeat') ?? '' },
      lane,
      laneHeight: lane.getBoundingClientRect().height,
      from,
      time,
      timeEnd,
      startMin: piece.startMin,
      endMin: piece.endMin,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      timer: null,
      ghost: null,
      result: null,
    };
    grab = g;
    // 指・ペンは長押しで掴む(縦スクロールを奪わない)。マウスは動いたら掴む(move 側)
    if (g.pointerType !== 'mouse') {
      g.timer = setTimeout(() => {
        g.timer = null;
        if (grab === g) activate(g);
      }, LONG_PRESS_MS);
    }
  };

  /** いまの指の位置から「どこへ置くか」を決めて、影と光りを合わせる。 */
  const preview = (g: Grab, e: PointerEvent): void => {
    const under = underPointer(e);
    if (g.mode === 'resize') {
      const h = laneHeightOf(g.lane, g.laneHeight);
      const y = e.clientY - g.lane.getBoundingClientRect().top;
      const endMin = resizeSlot(g.startMin, minutesFromOffset(y, h));
      showGhost(g, g.lane, g.startMin, endMin);
      g.result = { kind: 'resize', endMin };
      return;
    }
    const lane = under?.closest<HTMLElement>(GRID_LANE_SELECTOR) ?? null;
    if (lane !== null && root.contains(lane)) {
      const h = laneHeightOf(lane, g.laneHeight);
      const slot = moveSlot(g.startMin, g.endMin, deltaMinutes(e.clientY - g.startY, h));
      const date = dateTargetOf(lane)?.date ?? g.from;
      clearDrop();
      showGhost(g, lane, slot.startMin, slot.endMin);
      g.result = { kind: 'slot', date, ...slot };
      return;
    }
    // 目盛りの外 ── 日だけ変える落とし先(小さな月の升・一覧の見出し)
    hideGhost(g);
    const drop = dateTargetOf(under);
    // ⚠ 自分が居る面全体(「日」の外枠)は落とし先にしない ── 光らせても何も変わらない
    if (drop === null || drop.el.contains(g.card)) {
      clearDrop();
      g.result = null;
      return;
    }
    markDrop(drop.el);
    g.result = { kind: 'date', date: drop.date };
  };

  const onPointerMove = (e: PointerEvent): void => {
    const g = grab;
    if (g === null || e.pointerId !== g.pointerId) return;
    if (!g.active) {
      const moved = Math.hypot(e.clientX - g.startX, e.clientY - g.startY);
      if (g.pointerType === 'mouse') {
        if (moved < GRID_MOUSE_SLOP_PX) return;
        activate(g);
      } else {
        // 確定する前に動いたらスクロールに譲る(取り消すだけ ── まだ preventDefault していない)
        if (moved > LONG_PRESS_SLOP_PX) finish();
        return;
      }
    }
    e.preventDefault();
    preview(g, e);
  };

  const onPointerUp = (e: PointerEvent): void => {
    const g = grab;
    if (g === null) {
      if (escapedUntilUp) {
        escapedUntilUp = false;
        armSwallow();
      }
      return;
    }
    if (e.pointerId !== g.pointerId) return;
    if (!g.active) {
      finish(); // ただの click / タップ ── 素通りさせる
      return;
    }
    // 離した位置で決め直す(最後の move が届いていない環境でも、離した先で書く)
    preview(g, e);
    const result = g.result;
    finish();
    armSwallow();
    if (result !== null) commit(g, result);
  };

  const onPointerCancel = (e: PointerEvent): void => {
    if (grab === null || e.pointerId !== grab.pointerId) return;
    finish(); // 途中で切れたら影を消すだけ(本文はまだ書いていない)
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || grab === null) return;
    const wasActive = grab.active;
    finish();
    // 押したまま Esc ── 離したときの click で札が開かないようにする
    if (wasActive) escapedUntilUp = true;
  };

  const onClick = (e: MouseEvent): void => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  };

  /** 確定した置き場を、既存の口で書く。 */
  const commit = (g: Grab, r: Result): void => {
    if (r.kind === 'date') {
      dropTaskCard(dispatcher, g.task, r.date, root);
      return;
    }
    const line = Number(g.task.line);
    if (!Number.isInteger(line)) return;
    const date = r.kind === 'slot' ? r.date : g.from;
    const startMin = r.kind === 'slot' ? r.startMin : g.startMin;
    const endMin = r.endMin;
    // 動いていなければ書かない(同じ場所で離した / 刻みの内側で戻した)
    if (r.kind === 'slot' && date === g.from && startMin === g.startMin) return;
    if (r.kind === 'resize' && endMin === g.endMin) return;
    // 始まり: 動かしたときだけ作り直す(縁を引くときは書かれた字をそのまま返す)
    const time = r.kind === 'slot' ? formatMinutes(startMin) : g.time;
    // 終わり: 縁を引いたら必ず付く / 動かしたとき、元に終わりが無ければ付けない(点のまま)
    const timeEnd = r.kind === 'resize' || g.timeEnd !== null ? formatMinutes(endMin) : null;
    if (g.task.repeat === '') {
      dispatcher.dispatch({ type: 'SET_TASK_DATE', lid: g.task.lid, line, date, time, timeEnd });
      return;
    }
    // 繰り返しの回 ── 1 回か全部かを聞いてから書く(日だけ動かす落とし方と同じ小窓)
    if (g.from === '') return;
    const days = daysBetween(g.from, date);
    if (days === null) return;
    const label = timeEnd === null ? time : `${time}〜${timeEnd}`;
    void pickRepeatMoveInApp(root, days, label).then((pick) => {
      const action = repeatMoveAction(dispatcher.getState(), g.task, line, g.from, date, days, pick, {
        time,
        timeEnd,
      });
      if (action !== null) dispatcher.dispatch(action);
    });
  };

  /** 掴んでいる間は素の `touchmove` も止める(`schedule-drag.ts` の実測と同じ理由)。 */
  const onTouchMove = (e: TouchEvent): void => {
    if (grab?.active === true) e.preventDefault();
  };

  doc.addEventListener('pointerdown', onPointerDown);
  doc.addEventListener('pointermove', onPointerMove);
  doc.addEventListener('pointerup', onPointerUp);
  doc.addEventListener('pointercancel', onPointerCancel);
  doc.addEventListener('keydown', onKeyDown);
  doc.addEventListener('touchmove', onTouchMove, { passive: false });
  doc.addEventListener('click', onClick, true);
  return () => {
    finish();
    doc.removeEventListener('pointerdown', onPointerDown);
    doc.removeEventListener('pointermove', onPointerMove);
    doc.removeEventListener('pointerup', onPointerUp);
    doc.removeEventListener('pointercancel', onPointerCancel);
    doc.removeEventListener('keydown', onKeyDown);
    doc.removeEventListener('touchmove', onTouchMove);
    doc.removeEventListener('click', onClick, true);
  };
}
