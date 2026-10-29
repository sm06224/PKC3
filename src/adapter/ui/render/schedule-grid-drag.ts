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
 * | 動かしている間に `Esc` / 札の外で離す | 何も変わらない |
 *
 * ## 作り
 *
 * - **掴みは Pointer Events 1 本**(マウス・ペン・指)。⚠ 目盛りの札は HTML5 の drag を切ってある
 *   (`placeCardInGrid` ── 両方が生きていると奪い合う)。終日・一覧の札は従来の HTML5 drag のまま。
 * - **マウス**は 4px 動いたら掴む(押しただけ・ちょっと触れただけは今までどおり click)。
 *   **指・ペン**は長押しで掴む(縦のスクロールを奪わない ── `schedule-drag.ts` の頭に実測がある)。
 * - **見せるもの**は札そのものではなく、動かす先の**影**(点線の枠 + `14:15〜15:15`)。
 *   札は元の場所に残る(描き直しで掴んでいる札が消えない ── 両描き手とも札を使い回す)。
 * - 🔑 **位置は「目盛りの上端からの距離」で測る**(スクロールしても、指の下の時刻が合う)。
 *   札のどこを掴んだか(`grabOffsetMin`)を引いて、札の上端が指に付いてくる形にする。
 *   上下の縁に近づけたら目盛りを自動で送る(`autoScroll`)。
 * - **書くのは既存の口**: 単日 = `SET_TASK_DATE`(`timeEnd` つき)/ 繰り返しの回 = いつもの
 *   この回だけ / 全部 / やめる の小窓 → `MOVE_REPEAT_OCCURRENCE` か規則の行の `SET_TASK_DATE`。
 *   ⚠ 新しい書込経路は作らない(§7)。
 * - **日だけ変える落とし方**は `dropTaskCard` 1 本を呼ぶ(判定を 2 つ持たない)。
 *
 * ## 取り消し(書かずに畳む)
 *
 * `Esc`(捕捉段で止めて、開いているノートまで閉じない)/ `pointercancel` / 窓の `blur` /
 * ページが隠れた / `lostpointercapture` / マウスのボタンが離れているのに move が来た
 * (Alt-Tab・右クリックのメニュー・alert の間に離した ── `pointerup` が届かない)。
 *
 * ⚠ 「いま指の下に何が在るか」は `document.elementFromPoint` で引く(happy-dom は常に `null`
 *   なので `e.target` に落とす ── `schedule-drag.ts` と同じ作法。unit は列の要素へ直に撃つ)。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { bodyWriteBlockReason } from '@adapter/state/app-state';
import { SHOWN_LINE_LOST } from '@adapter/state/shown-line';
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX } from '@adapter/ui/actions/long-press';
import { daysBetween } from '@features/datetime/date-math';
import { isOvernightSpan } from '@features/schedule/schedule-date';
import {
  DEFAULT_SPAN_MINUTES,
  SNAP_MINUTES,
  formatMinutes,
  formatTimeRange,
  minutesFromOffset,
  minutesOf,
  moveSlot,
  pieceOf,
  resizeSlot,
} from '@features/schedule/day-layout';
import { pickRepeatMoveInApp } from './app-dialog';
import { noteSlotMoved, noteSlotOf, slotOfCard } from '@features/schedule/move-undo';
import { repeatWord } from '@features/schedule/repeat';
import { noteWhenFor } from '@features/schedule/task-cards';
import { offerMoveUndo } from './schedule-undo';
import { SCHEDULE_DROP_FAILED, gatedScheduleWrite } from './schedule-write-gate';
import {
  GRID_LANE_SELECTOR,
  dropTaskCard,
  rawLineOf,
  repeatMoveAction,
  dispatchRepeatMove,
  movedBeforeOf,
  type GrabbedTask,
} from './schedule-drag';

/** マウスが「掴んだ」と数える動き(px)。これ未満は click のまま。 */
export const GRID_MOUSE_SLOP_PX = 4;
/** 目盛りの上下の縁から、この距離(px)に入ったら自動で送る。 */
export const GRID_EDGE_PX = 32;
/** 自動で送る最大の速さ(1 コマあたり px)。縁に近いほど速い。 */
const EDGE_MAX_SPEED = 16;

/** 掴ませない部品(チェックの印 / 外す ✕)。⚠ 属性の綴りを `schedule-drag.ts` と揃える。 */
const NO_GRAB_SELECTOR =
  'input[type="checkbox"], [data-pkc-field="task-unschedule"], [data-pkc-field="task-menu"]';
const RESIZE_SELECTOR = '[data-pkc-field="task-resize"]';
export const GRID_SCROLLER_SELECTOR =
  '[data-pkc-field="schedule-day-scroll"], [data-pkc-field="schedule-weekview-scroll"]';
/** 影(動かす先の枠)。 */
export const GRID_GHOST_FIELD = 'schedule-drag-ghost';

interface Point {
  readonly x: number;
  readonly y: number;
  readonly target: Element | null;
}

interface Grab {
  readonly mode: 'move' | 'resize';
  readonly card: HTMLElement;
  readonly task: GrabbedTask;
  /** 掴んだ列(縁を引く間の基準 / 「同じ列か」の比べ先)。 */
  readonly lane: HTMLElement;
  readonly laneHeight: number;
  /** 掴んだ札の日。 */
  readonly from: string;
  readonly time: string;
  readonly timeEnd: string | null;
  /** 書かれている始まり(分)。⚠ 目盛りに寄せた位置ではない(23:45 を 23:30 へ引かない)。 */
  readonly startMin: number;
  /** 目盛りに描いている終わり(終わりの無い札は始まり + 30 分)。 */
  readonly endMin: number;
  /** 書かれた終わりを目盛りが使っているか(`14:00..14:00` や夜をまたぐ終わりは使わない)。 */
  readonly endAdopted: boolean;
  /** 札のどこを掴んだか(掴んだ位置 - 札の始まり。分)。 */
  readonly grabOffsetMin: number;
  readonly scroller: HTMLElement | null;
  readonly pointerId: number;
  readonly pointerType: string;
  readonly startX: number;
  readonly startY: number;
  active: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  ghost: HTMLElement | null;
  result: Result | null;
  /** 最後の指の位置(自動で送った後に影を合わせ直す)。 */
  last: Point;
}

type Result =
  | { readonly kind: 'slot'; readonly date: string; readonly startMin: number; readonly endMin: number }
  | { readonly kind: 'date'; readonly date: string }
  | { readonly kind: 'resize'; readonly endMin: number };

const raf = (fn: () => void): unknown =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16);
const cancelRaf = (id: unknown): void => {
  if (typeof cancelAnimationFrame === 'function' && typeof id === 'number') cancelAnimationFrame(id);
  else clearTimeout(id as ReturnType<typeof setTimeout>);
};

/**
 * 目盛りの縁に近いとき、自動で送る量(px。負 = 上へ)。0 = 送らない。
 * ⚠ 札を動かす掴みと、空いた所をドラッグして作る掴み(`schedule-grid-create.ts`)が**同じ 1 本**を使う。
 */
export function gridEdgeSpeed(scroller: HTMLElement | null, y: number): number {
  if (scroller === null) return 0;
  const r = scroller.getBoundingClientRect();
  if (!(r.height > 0)) return 0;
  if (y < r.top + GRID_EDGE_PX) {
    return -Math.ceil((EDGE_MAX_SPEED * Math.min(GRID_EDGE_PX, r.top + GRID_EDGE_PX - y)) / GRID_EDGE_PX);
  }
  if (y > r.bottom - GRID_EDGE_PX) {
    return Math.ceil((EDGE_MAX_SPEED * Math.min(GRID_EDGE_PX, y - (r.bottom - GRID_EDGE_PX))) / GRID_EDGE_PX);
  }
  return 0;
}

/**
 * root へ 1 度だけ配線する(`installScheduleDrag` と同じ作法)。
 * @returns 外す関数。アプリ本体では外さない(同寿命)が、test は外せる必要がある。
 */
export function installScheduleGridDrag(root: HTMLElement, dispatcher: Dispatcher): () => void {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  let grab: Grab | null = null;
  let swallowClick = false;
  let swallowTimer: ReturnType<typeof setTimeout> | null = null;
  /** `Esc` で取り消した後、マウスを離すまで(離したときの click を飲む)。 */
  let escapedUntilUp = false;
  let dropMark: HTMLElement | null = null;
  let scrollLoop: unknown = null;

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
  const pointOf = (e: PointerEvent): Point => ({ x: e.clientX, y: e.clientY, target: e.target as Element | null });
  const underPoint = (p: Point): Element | null => {
    if (typeof doc.elementFromPoint === 'function') {
      const hit = doc.elementFromPoint(p.x, p.y);
      if (hit !== null) return hit;
    }
    return p.target;
  };

  /**
   * 離した直後の click を 1 回飲む。⚠ 次の 1 手で畳む ── click は離した直後に同じ周で届くので、
   * 届かなかった(離した先が別の物だった)とき、**後から来る無関係な click**(小窓の行・キーボードの
   * Enter)を飲まない。
   */
  const armSwallow = (): void => {
    swallowClick = true;
    if (swallowTimer !== null) clearTimeout(swallowTimer);
    swallowTimer = setTimeout(() => {
      swallowClick = false;
      swallowTimer = null;
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

  const stopScrollLoop = (): void => {
    if (scrollLoop !== null) cancelRaf(scrollLoop);
    scrollLoop = null;
  };
  const finish = (): void => {
    stopScrollLoop();
    if (grab === null) return;
    if (grab.timer !== null) clearTimeout(grab.timer);
    hideGhost(grab);
    grab.card.removeAttribute('data-pkc-dragging');
    clearDrop();
    grab = null;
  };

  const laneHeightOf = (lane: HTMLElement, fallback: number): number => {
    const h = lane.getBoundingClientRect().height;
    return h > 0 ? h : fallback;
  };
  /** 指の下の、その列での時刻(分。0〜24:00 の内側)。⚠ 列の上端から測る(スクロールに強い)。 */
  const minuteIn = (lane: HTMLElement, y: number, fallbackH: number): number =>
    minutesFromOffset(y - lane.getBoundingClientRect().top, laneHeightOf(lane, fallbackH));

  /** 目盛りの縁に近いとき、送る量(px。負 = 上へ)。0 = 送らない。 */
  const edgeSpeed = (g: Grab): number => gridEdgeSpeed(g.scroller, g.last.y);
  const tickScroll = (): void => {
    scrollLoop = null;
    const g = grab;
    if (g === null || !g.active) return;
    const v = edgeSpeed(g);
    if (v !== 0 && g.scroller !== null) {
      g.scroller.scrollTop += v;
      // 送った後は列が指の下で動いている ── 影を合わせ直す
      preview(g, g.last);
    }
    scrollLoop = raf(tickScroll);
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
    if (scrollLoop === null) scrollLoop = raf(tickScroll);
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
    /**
     * 🔴 **ノート 1 件の予定(前書きの `date: 2026-10-20 14:00`)も時刻を動かせる**(台帳 #1852 / 依頼 192 / 284)。
     *   行番号は無い(`line` は空)── 書き換え先は前書きの `date:`。終わりの時刻は書けないので、下の縁は掴ませない。
     */
    const whole = card.hasAttribute('data-pkc-whole-note');
    if (whole && target?.closest(RESIZE_SELECTOR) != null) return;
    const line = whole
      ? ''
      : (card.querySelector('[data-pkc-task-line]')?.getAttribute('data-pkc-task-line') ?? null);
    const time = card.getAttribute('data-pkc-task-time');
    if (lid === null || line === null || time === null) return;
    const timeEnd = card.getAttribute('data-pkc-task-time-end');
    const piece = pieceOf('', time, timeEnd);
    const rawStart = minutesOf(time);
    if (piece === null || rawStart === null) return;
    const laneHeight = lane.getBoundingClientRect().height;
    const from = dateTargetOf(lane)?.date ?? '';
    // 🔴 夜をまたぐ幅は目盛りでは下端までだが、動かす幅は既定の長さで数える(下端まで掴んだ幅で数えると、下へ動かせなくなる ── 依頼 190)
    const dur =
      timeEnd !== null && isOvernightSpan(time, timeEnd) ? DEFAULT_SPAN_MINUTES : piece.endMin - piece.startMin;
    const rawEnd = timeEnd === null ? null : minutesOf(timeEnd);
    const g: Grab = {
      mode: target?.closest(RESIZE_SELECTOR) != null ? 'resize' : 'move',
      card,
      task: {
        lid,
        line,
        from,
        repeat: card.getAttribute('data-pkc-task-repeat') ?? '',
        // 🔴 掴んだ時点の行の中身(#1087)── 落とした時点の走査から引き直さない(ノート 1 件の予定には行が無い)
        ...(whole ? {} : rawLineOf(dispatcher, lid, line)),
      },
      lane,
      laneHeight,
      from,
      time,
      timeEnd,
      startMin: rawStart,
      endMin: rawStart + dur,
      endAdopted: rawEnd !== null && rawEnd > rawStart,
      grabOffsetMin: minutesFromOffset(e.clientY - lane.getBoundingClientRect().top, laneHeight) - rawStart,
      scroller: lane.closest<HTMLElement>(GRID_SCROLLER_SELECTOR),
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      timer: null,
      ghost: null,
      result: null,
      last: pointOf(e),
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
  function preview(g: Grab, p: Point): void {
    g.last = p;
    const under = underPoint(p);
    if (g.mode === 'resize') {
      const endMin = resizeSlot(g.startMin, minuteIn(g.lane, p.y, g.laneHeight));
      showGhost(g, g.lane, g.startMin, endMin);
      g.result = { kind: 'resize', endMin };
      return;
    }
    const lane = under?.closest<HTMLElement>(GRID_LANE_SELECTOR) ?? null;
    if (lane !== null && root.contains(lane)) {
      const date = dateTargetOf(lane)?.date ?? g.from;
      // 札の上端が指に付いてくる位置(掴んだ位置の分を引く)
      const wantStart = minuteIn(lane, p.y, g.laneHeight) - g.grabOffsetMin;
      const rawDelta = wantStart - g.startMin;
      // 🔴 半刻みも動いていない同じ列なら、動かしていない(15 分刻みに丸めて書き換えない)
      const still = date === g.from && Math.abs(rawDelta) < SNAP_MINUTES / 2;
      const slot = still
        ? { startMin: g.startMin, endMin: g.endMin }
        : moveSlot(g.startMin, g.endMin, rawDelta);
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
  }

  const onPointerMove = (e: PointerEvent): void => {
    const g = grab;
    if (g === null || e.pointerId !== g.pointerId) return;
    // 🔴 マウスのボタンがもう離れている ── 離した合図(pointerup)が届かなかった。書かずに畳む
    if (g.pointerType === 'mouse' && e.buttons === 0) {
      const wasActive = g.active;
      finish();
      if (wasActive) armSwallow();
      return;
    }
    g.last = pointOf(e);
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
    preview(g, g.last);
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
    preview(g, pointOf(e));
    const result = g.result;
    finish();
    armSwallow();
    if (result !== null) commit(g, result);
  };

  /** 書かずに畳む(取り消し)。動かしていたなら、離したときの click を飲む。 */
  const cancel = (): void => {
    if (grab === null) return;
    const wasActive = grab.active;
    finish();
    if (wasActive) armSwallow();
  };

  const onPointerCancel = (e: PointerEvent): void => {
    if (grab === null || e.pointerId !== grab.pointerId) return;
    finish(); // 途中で切れたら影を消すだけ(本文はまだ書いていない)
  };

  /**
   * 🔴 `Esc` は捕捉段で受ける ── 掴んでいる間の `Esc` が、binder の「開いているノートを閉じる」
   * まで届くと、取り消したつもりの user が読んでいたノートを失う。止めるのは**動かしている間だけ**
   * (掴む前・押しただけの `Esc` は今までどおり通す)。
   */
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || grab === null || !grab.active) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    finish();
    // 押したまま Esc ── 離したときの click で札が開かないようにする
    escapedUntilUp = true;
  };

  const onClick = (e: MouseEvent): void => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  };

  const onBlur = (): void => cancel();
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') cancel();
  };
  const onLostCapture = (e: Event): void => {
    const g = grab;
    if (g === null || (e as PointerEvent).pointerId !== g.pointerId) return;
    cancel();
  };

  /** 確定した置き場を、既存の口で書く。 */
  const commit = (g: Grab, r: Result): void => {
    if (r.kind === 'date') {
      dropTaskCard(dispatcher, g.task, r.date, root);
      return;
    }
    // 🔴 ノート 1 件の予定: 前書きの `date:` へ日と時刻を書く(終わりは書けないので `resize` は来ない)
    if (g.task.line === '') {
      if (r.kind !== 'slot') return;
      if (r.date === g.from && r.startMin === g.startMin) return;
      const newTime = formatMinutes(r.startMin);
      // 🔴 門を通ってから書く ── 「元に戻す」は門を通って書いた回(断られていない回)にだけ出す(`dropTaskCard` と同じ作り)
      gatedScheduleWrite(dispatcher, [g.task.lid], SCHEDULE_DROP_FAILED, () => {
        const st0 = dispatcher.getState();
        const wasDate = st0.entryMetas.get(g.task.lid)?.date ?? null;
        const refusedNote = bodyWriteBlockReason(st0, g.task.lid) !== null;
        const beforeNote = noteSlotOf(st0.taskScan, g.task.lid, wasDate);
        const noteRepeat = noteWhenFor(st0.taskScan, g.task.lid, wasDate).repeat;
        dispatcher.dispatch({ type: 'SET_ENTRY_DATE', lid: g.task.lid, date: r.date, time: newTime });
        if (!refusedNote && wasDate !== null) {
          offerMoveUndo(root, dispatcher, {
            target: { kind: 'entry', lid: g.task.lid },
            before: { ...beforeNote, time: g.time },
            after: noteSlotMoved({ ...beforeNote, time: g.time }, r.date, newTime),
            verb: 'moved',
            ...(noteRepeat === null ? {} : { ruleWord: repeatWord(noteRepeat) }),
          });
        }
      });
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
    /**
     * 終わり:
     * - 縁を引いた → 必ず付く(明示の操作)
     * - 動かした + 目盛りが使っている終わり → 長さを保って動かす
     * - 動かした + 書かれた終わりが使われていない(`14:00..14:00`)→ 幅 0 のまま動かす
     *   (目盛りの 30 分を書き込んで、書いた終わりを上書きしない)
     * - 動かした + 終わりなし → 点のまま
     */
    /**
     * 🔴 夜をまたぐ幅(`22:00..02:00`)を動かすときは、終わりも同じ分だけ動かす(#1163 の依頼 190)。
     * ⚠ 目盛りが使っていない終わり(`endAdopted` が偽)として「始まりと同じ」に潰すと、夜をまたぐ幅が消える。
     */
    const overnightEnd = (): string | null => {
      if (g.timeEnd === null || !isOvernightSpan(g.time, g.timeEnd)) return null;
      const s0 = minutesOf(g.time);
      const e0 = minutesOf(g.timeEnd);
      if (s0 === null || e0 === null) return null;
      return formatMinutes((((e0 + (startMin - s0)) % 1440) + 1440) % 1440);
    };
    const timeEnd =
      r.kind === 'resize'
        ? formatMinutes(endMin)
        : g.timeEnd === null
          ? null
          : g.endAdopted
            ? formatMinutes(endMin)
            : (overnightEnd() ?? formatMinutes(startMin));
    if (g.task.repeat === '') {
      const st = dispatcher.getState();
      // 動かす前の姿は走査が持っている札から取る(中身の指紋もそこにある)。札が走査に無い回は出さない
      const card = st.taskScan?.cards.find((c) => c.lid === g.task.lid && c.line === line);
      // 🔴 札が走査に居ない回は撃たずに断る(#1087)── 札の行の中身が書換の `openLine` になる
      if (card === undefined) {
        dispatcher.dispatch({ type: 'OP_FAILED', error: SHOWN_LINE_LOST });
        return;
      }
      // 🔴 別のタブ・窓が編集中のノートへ / 書出し中は撃たない(#1087)。「元に戻す」は書いた回にだけ出す(`dropTaskCard` と同じ作り)
      gatedScheduleWrite(dispatcher, [g.task.lid], SCHEDULE_DROP_FAILED, () => {
        const refused = bodyWriteBlockReason(dispatcher.getState(), g.task.lid) !== null;
        dispatcher.dispatch({
          type: 'SET_TASK_DATE',
          lid: g.task.lid,
          line,
          openLine: g.task.rawLine ?? card.rawLine,
          date,
          time,
          timeEnd,
        });
        // 🔴 動かしたら「元に戻す」(#855)。⚠ 断られた回・掴んだ日が取れなかった回は出さない
        if (!refused && g.from !== '') {
          const before = slotOfCard(card);
          offerMoveUndo(root, dispatcher, {
            target: { kind: 'task', lid: g.task.lid, line },
            before,
            // 🔴 時刻を付けたら `終日` は外れる(書き手 `formatLineDate` と同じ)
            after: { ...before, date, time, timeEnd, allDay: before.allDay === true && time === null },
            verb: r.kind === 'resize' ? 'changed' : 'moved',
          });
        }
      });
      return;
    }
    // 繰り返しの回 ── 1 回か全部かを聞いてから書く(日だけ動かす落とし方と同じ小窓)
    if (g.from === '') return;
    const days = daysBetween(g.from, date);
    if (days === null) return;
    const label = timeEnd === null ? time : `${time}〜${timeEnd}`;
    void pickRepeatMoveInApp(root, days, label, movedBeforeOf(dispatcher.getState(), g.task.lid, line)).then((pick) => {
      const action = repeatMoveAction(dispatcher.getState(), g.task, line, g.from, date, days, pick, {
        time,
        timeEnd,
      });
      gatedScheduleWrite(dispatcher, [g.task.lid], SCHEDULE_DROP_FAILED, () =>
        dispatchRepeatMove(dispatcher, action, pick),
      );
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
  doc.addEventListener('lostpointercapture', onLostCapture);
  doc.addEventListener('visibilitychange', onVisibility);
  win?.addEventListener('keydown', onKeyDown, true);
  win?.addEventListener('blur', onBlur);
  doc.addEventListener('touchmove', onTouchMove, { passive: false });
  doc.addEventListener('click', onClick, true);
  return () => {
    finish();
    if (swallowTimer !== null) clearTimeout(swallowTimer);
    doc.removeEventListener('pointerdown', onPointerDown);
    doc.removeEventListener('pointermove', onPointerMove);
    doc.removeEventListener('pointerup', onPointerUp);
    doc.removeEventListener('pointercancel', onPointerCancel);
    doc.removeEventListener('lostpointercapture', onLostCapture);
    doc.removeEventListener('visibilitychange', onVisibility);
    win?.removeEventListener('keydown', onKeyDown, true);
    win?.removeEventListener('blur', onBlur);
    doc.removeEventListener('touchmove', onTouchMove);
    doc.removeEventListener('click', onClick, true);
  };
}
