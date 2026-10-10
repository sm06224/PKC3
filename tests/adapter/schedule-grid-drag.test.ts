/** @vitest-environment happy-dom */
/**
 * 🔴 **時間の目盛りで札を動かして時刻を変える**(#855 段 B-1)。実体は
 * `src/adapter/ui/render/schedule-grid-drag.ts`。計算そのものは `tests/features/day-layout.test.ts`。
 *
 * ## ここが見るもの / 見ないもの
 *
 * 🔴 **見る**: 繋がり ── 掴んで動かした 1 手が、保存された**本文の字**まで届くか。
 * ⚠ 観測点は本文にする(「影が出た」で止めると、書かないのに緑になる)。
 *
 * ⚠ **見ない**:「いま指の下に実際に何が在るか」(`document.elementFromPoint`)は happy-dom で
 *   常に `null` を返す ── ここは**列の要素へ直に撃つ**(`e.target` へ落ちる側)。
 *   本物の判定・実際の 1 時間の高さ(40px)は `tests/smoke/schedule.smoke.spec.ts` が見る。
 * ⚠ happy-dom は幅も高さも持たない ── 列の `getBoundingClientRect` を**24 時間 = 960px**
 *   (1 時間 40px。実機と同じ)に差し替える。
 */
import { stubStamps } from '../helpers/store-stamps';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { reduce, initialState, type UserAction } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { ScheduleRenderer } from '../../src/adapter/ui/render/schedule';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { installScheduleGridDrag } from '../../src/adapter/ui/render/schedule-grid-drag';
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX } from '../../src/adapter/ui/actions/long-press';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { stubRevisionOps } from '../helpers/revision-stub';
import { taskCardsOf } from '../../src/features/schedule/task-cards';
import { openDialog } from './dialog-helper';

const TODAY = new Date(2026, 7, 23); // 2026-08-23(日)
const HOUR = 40; // 1 時間 40px
const LANE_H = HOUR * 24;
const minPx = (min: number): number => (min / 60) * HOUR;

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: Number(lid.slice(1)) || 0,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

const LANE_SEL = '[data-pkc-field="schedule-day-lane"], [data-pkc-field="schedule-weekview-lane"]';

function setup(body: string, mode: 'day' | 'week') {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const store: Record<string, string> = { e1: body };
  const host = document.createElement('div');
  host.setAttribute('data-pkc-view-pane', 'schedule');
  regions.browseHost.append(host);
  const view = new ScheduleRenderer(host, () => TODAY);
  d.onState((s) => view.render(s));
  bindActions(root, d, {});
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => store[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では添付の差し替えを使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      store[e.lid] = e.body;
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1')], relations: [] });
  const cards = taskCardsOf('e1', body);
  const scan = (): void =>
    d.dispatch({
      type: 'SET_TASK_SCAN',
      scan: { cards, totalNotes: 1, scannedNotes: 1, truncated: false },
    });
  scan();
  const dispatched: UserAction[] = [];
  const orig = d.dispatch.bind(d);
  d.dispatch = (a: UserAction) => {
    dispatched.push(a);
    return orig(a);
  };
  const detach = installScheduleGridDrag(root, d);
  (root.querySelector(`[data-pkc-action="schedule-mode"][data-pkc-mode="${mode}"]`) as HTMLElement).click();
  // 列の高さ(happy-dom は持たない)
  for (const lane of root.querySelectorAll<HTMLElement>(LANE_SEL)) {
    lane.getBoundingClientRect = () =>
      ({ top: 0, left: 0, bottom: LANE_H, right: 100, width: 100, height: LANE_H, x: 0, y: 0 }) as DOMRect;
  }
  const qa = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
  // ⚠ 隠れている側の器も DOM には居る ── 見せている見せ方の列だけを引く
  const laneSel = `[data-pkc-field="${mode === 'day' ? 'schedule-day-lane' : 'schedule-weekview-lane'}"]`;
  const lanes = (): HTMLElement[] => qa(laneSel);
  const laneCards = (): HTMLElement[] => qa(`${laneSel} > [data-pkc-entry]`);
  return { root, d, store, dispatched, detach, qa, lanes, laneCards, scan };
}

type Kind = 'mouse' | 'touch' | 'pen';
function pointer(el: Element, type: string, kind: Kind, y: number, x = 0, pointerId = 1): boolean {
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
const click = (el: Element): boolean =>
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

/** 札を掴んで、`dyPx` だけ下へ動かして離す(同じ列の上)。 */
function dragCard(card: HTMLElement, lane: HTMLElement, y0: number, dyPx: number): void {
  pointer(card, 'pointerdown', 'mouse', y0);
  pointer(lane, 'pointermove', 'mouse', y0 + dyPx);
  pointer(lane, 'pointerup', 'mouse', y0 + dyPx);
}

afterEach(() => {
  vi.useRealTimers();
  resetAppDialogForTest();
  document.body.innerHTML = '';
});

describe('札を動かすと始まりの時刻が変わる(長さは保つ)', () => {
  const BODY = '- [ ] 会議 @2026-08-23 14:00..15:00\n';

  it('🔴 「日」: 2 時間下へ動かすと 16:00..17:00 になる(本文まで届く)', async () => {
    const { laneCards, lanes, store, detach } = setup(BODY, 'day');
    const card = laneCards()[0]!;
    dragCard(card, lanes()[0]!, minPx(14 * 60), minPx(120));
    await tick(20);
    expect(store['e1']).toBe('- [ ] 会議 @2026-08-23 16:00..17:00\n');
    detach();
  });

  it('🔴 15 分刻みに丸まる ── 57px(= 85.5 分)下へ動かすと 15:30 始まり(丸めないと 15:25 になる)', async () => {
    const { laneCards, lanes, store, detach } = setup(BODY, 'day');
    dragCard(laneCards()[0]!, lanes()[0]!, 560, 57);
    await tick(20);
    expect(store['e1']).toBe('- [ ] 会議 @2026-08-23 15:30..16:30\n');
    detach();
  });

  it('🔴 長さを保つ ── 90 分の札は 90 分のまま動く', async () => {
    const { laneCards, lanes, store, detach } = setup('- [ ] 長い @2026-08-23 09:00..10:30\n', 'day');
    dragCard(laneCards()[0]!, lanes()[0]!, 360, minPx(60));
    await tick(20);
    expect(store['e1']).toBe('- [ ] 長い @2026-08-23 10:00..11:30\n');
    detach();
  });

  it('日の内側に収まる ── 下へ大きく動かしても終わりは 24:00 まで(始まりを寄せる)', async () => {
    const { laneCards, lanes, store, detach } = setup(BODY, 'day');
    dragCard(laneCards()[0]!, lanes()[0]!, 560, 2000);
    await tick(20);
    expect(store['e1']).toBe('- [ ] 会議 @2026-08-23 23:00..24:00\n');
    detach();
  });

  it('終わりの無い札は点のまま動く(幅を勝手に足さない)', async () => {
    const { laneCards, lanes, store, detach } = setup('- [ ] 電話 @2026-08-23 14:00\n', 'day');
    dragCard(laneCards()[0]!, lanes()[0]!, 560, minPx(60));
    await tick(20);
    expect(store['e1']).toBe('- [ ] 電話 @2026-08-23 15:00\n');
    detach();
  });

  it('🔴 動かしている間は、動かす先に影(点線の枠 + 時刻の字)が出る / 離すと消える。札は消えない', () => {
    const { laneCards, lanes, qa, detach } = setup(BODY, 'day');
    const card = laneCards()[0]!;
    pointer(card, 'pointerdown', 'mouse', 560);
    pointer(lanes()[0]!, 'pointermove', 'mouse', 560 + minPx(75));
    const ghost = qa('[data-pkc-field="schedule-drag-ghost"]');
    expect(ghost, '動かしているのに影が出ていない').toHaveLength(1);
    expect(ghost[0]!.textContent).toBe('15:15〜16:15');
    expect(ghost[0]!.style.getPropertyValue('--day-start')).toBe(String(15 * 60 + 15));
    expect(ghost[0]!.style.getPropertyValue('--day-span')).toBe('60');
    expect(card.hasAttribute('data-pkc-dragging'), '掴んでいる札に印が無い').toBe(true);
    pointer(lanes()[0]!, 'pointerup', 'mouse', 560 + minPx(75));
    expect(qa('[data-pkc-field="schedule-drag-ghost"]'), '離したのに影が残った').toHaveLength(0);
    expect(card.hasAttribute('data-pkc-dragging')).toBe(false);
    detach();
  });

  it('🔴 動かしている最中に描き直されても、掴んでいる札は同じ要素のまま(影も残る)', () => {
    const { laneCards, lanes, qa, scan, detach } = setup(BODY, 'day');
    const card = laneCards()[0]!;
    pointer(card, 'pointerdown', 'mouse', 560);
    pointer(lanes()[0]!, 'pointermove', 'mouse', 640);
    scan();
    scan();
    expect(laneCards()[0], '描き直しで掴んでいる札が作り直された').toBe(card);
    expect(qa('[data-pkc-field="schedule-drag-ghost"]'), '描き直しで影が消えた').toHaveLength(1);
    pointer(lanes()[0]!, 'pointerup', 'mouse', 640);
    detach();
  });
});

describe('「週」: 隣の日の列へ動かすと日も変わる', () => {
  it('🔴 8/25 の 14:00..15:00 を 8/27 の列へ・2 時間下へ → 日と時刻が一緒に変わる', async () => {
    const { laneCards, lanes, store, detach } = setup('- [ ] 会議 @2026-08-25 14:00..15:00\n', 'week');
    expect(lanes().map((l) => l.getAttribute('data-pkc-drop-date'))[2]).toBe('2026-08-25');
    const card = laneCards()[0]!;
    pointer(card, 'pointerdown', 'mouse', 560);
    const to = lanes()[4]!; // 8/27
    expect(to.getAttribute('data-pkc-drop-date')).toBe('2026-08-27');
    pointer(to, 'pointermove', 'mouse', 560 + minPx(120));
    pointer(to, 'pointerup', 'mouse', 560 + minPx(120));
    await tick(20);
    expect(store['e1']).toBe('- [ ] 会議 @2026-08-27 16:00..17:00\n');
    detach();
  });

  it('🔴 同じ列のまま動かせば日は変わらない', async () => {
    const { laneCards, lanes, store, detach } = setup('- [ ] 会議 @2026-08-25 14:00..15:00\n', 'week');
    dragCard(laneCards()[0]!, lanes()[2]!, 560, minPx(30));
    await tick(20);
    expect(store['e1']).toBe('- [ ] 会議 @2026-08-25 14:30..15:30\n');
    detach();
  });

  it('🔴 目盛りの外の落とし先(終日の升)で離すと、日だけが変わる(時刻はそのまま)', async () => {
    const { laneCards, qa, store, detach } = setup('- [ ] 会議 @2026-08-25 14:00..15:00\n', 'week');
    const card = laneCards()[0]!;
    pointer(card, 'pointerdown', 'mouse', 560);
    const cell = qa('[data-pkc-field="schedule-weekview-allday-cell"]')[5]!; // 8/28
    pointer(cell, 'pointermove', 'mouse', 100);
    expect(cell.hasAttribute('data-pkc-dropping'), '落とし先が光っていない').toBe(true);
    expect(qa('[data-pkc-field="schedule-drag-ghost"]'), '目盛りの外なのに影が出ている').toHaveLength(0);
    pointer(cell, 'pointerup', 'mouse', 100);
    expect(cell.hasAttribute('data-pkc-dropping'), '離したのに光りが残った').toBe(false);
    await tick(20);
    expect(store['e1']).toBe('- [ ] 会議 @2026-08-28 14:00..15:00\n');
    detach();
  });
});

describe('下の縁を引くと終わりの時刻だけが変わる', () => {
  const BODY = '- [ ] 会議 @2026-08-23 14:00..15:00\n';
  const handleOf = (card: HTMLElement): HTMLElement =>
    card.querySelector<HTMLElement>('[data-pkc-field="task-resize"]')!;
  const resize = (
    laneCardsFn: () => HTMLElement[],
    lane: HTMLElement,
    y0: number,
    y1: number,
  ): void => {
    const h = handleOf(laneCardsFn()[0]!);
    pointer(h, 'pointerdown', 'mouse', y0);
    pointer(lane, 'pointermove', 'mouse', y1);
    pointer(lane, 'pointerup', 'mouse', y1);
  };

  it('🔴 30 分ぶん下へ引くと 14:00..15:30(始まりは動かない)', async () => {
    const { laneCards, lanes, store, detach } = setup(BODY, 'day');
    resize(laneCards, lanes()[0]!, minPx(15 * 60) - 2, minPx(15 * 60 + 30));
    await tick(20);
    expect(store['e1']).toBe('- [ ] 会議 @2026-08-23 14:00..15:30\n');
    detach();
  });

  it('🔴 終わりの無い札の縁を引くと、終わりが書かれる', async () => {
    const { laneCards, lanes, store, detach } = setup('- [ ] 電話 @2026-08-23 14:00\n', 'day');
    resize(laneCards, lanes()[0]!, minPx(14 * 60 + 30) - 2, minPx(15 * 60 + 30));
    await tick(20);
    expect(store['e1']).toBe('- [ ] 電話 @2026-08-23 14:00..15:30\n');
    detach();
  });

  it('🔴 上へ引き過ぎても最低 15 分は残る', async () => {
    const { laneCards, lanes, store, detach } = setup(BODY, 'day');
    resize(laneCards, lanes()[0]!, minPx(15 * 60) - 2, minPx(9 * 60));
    await tick(20);
    expect(store['e1']).toBe('- [ ] 会議 @2026-08-23 14:00..14:15\n');
    detach();
  });

  it('24:00 で止まる', async () => {
    const { laneCards, lanes, store, detach } = setup('- [ ] 夜 @2026-08-23 22:00..23:00\n', 'day');
    resize(laneCards, lanes()[0]!, minPx(23 * 60) - 2, 5000);
    await tick(20);
    expect(store['e1']).toBe('- [ ] 夜 @2026-08-23 22:00..24:00\n');
    detach();
  });

  it('縁を引いている間、影は始まりを動かさない(14:00〜15:30)', () => {
    const { laneCards, lanes, qa, detach } = setup(BODY, 'day');
    pointer(handleOf(laneCards()[0]!), 'pointerdown', 'mouse', minPx(15 * 60) - 2);
    pointer(lanes()[0]!, 'pointermove', 'mouse', minPx(15 * 60 + 30));
    expect(qa('[data-pkc-field="schedule-drag-ghost"]')[0]!.textContent).toBe('14:00〜15:30');
    pointer(lanes()[0]!, 'pointerup', 'mouse', minPx(15 * 60 + 30));
    detach();
  });

  it('動かしていない縁(刻みの内側で戻した)は書かない', () => {
    const { laneCards, lanes, dispatched, detach } = setup(BODY, 'day');
    resize(laneCards, lanes()[0]!, minPx(15 * 60) - 2, minPx(15 * 60) + 3);
    expect(dispatched.filter((a) => a.type === 'SET_TASK_DATE')).toEqual([]);
    detach();
  });
});

describe('動かさなかったときは何も変えない', () => {
  const BODY = '- [ ] 会議 @2026-08-23 14:00..15:00\n';

  it('🔴 4px 未満の動きは掴まない ── ただの click は素通る(開く・チェックを壊さない)', () => {
    const { laneCards, lanes, dispatched, qa, detach } = setup(BODY, 'day');
    const card = laneCards()[0]!;
    pointer(card, 'pointerdown', 'mouse', 560);
    pointer(lanes()[0]!, 'pointermove', 'mouse', 563);
    expect(qa('[data-pkc-field="schedule-drag-ghost"]'), '3px で掴んでしまった').toHaveLength(0);
    pointer(lanes()[0]!, 'pointerup', 'mouse', 563);
    expect(click(card), 'click が飲まれた(札が開かなくなる)').toBe(true);
    expect(dispatched.filter((a) => a.type === 'SET_TASK_DATE')).toEqual([]);
    detach();
  });

  it('🔴 掴んで動かした後の click は飲む(離したら札が開いてしまわない)', () => {
    const { laneCards, lanes, detach } = setup(BODY, 'day');
    const card = laneCards()[0]!;
    dragCard(card, lanes()[0]!, 560, 80);
    expect(click(card), '動かした後の click が素通った').toBe(false);
    // 1 回きり ── 次の click は素通る
    expect(click(card)).toBe(true);
    detach();
  });

  it('🔴 チェックの印の上から掴まない', () => {
    const { laneCards, lanes, dispatched, qa, detach } = setup(BODY, 'day');
    const box = laneCards()[0]!.querySelector<HTMLElement>('input[type="checkbox"]')!;
    pointer(box, 'pointerdown', 'mouse', 560);
    pointer(lanes()[0]!, 'pointermove', 'mouse', 700);
    pointer(lanes()[0]!, 'pointerup', 'mouse', 700);
    expect(qa('[data-pkc-field="schedule-drag-ghost"]')).toHaveLength(0);
    expect(dispatched.filter((a) => a.type === 'SET_TASK_DATE')).toEqual([]);
    detach();
  });

  it('🔴 Esc で取り消す ── 影が消え、何も書かず、離したときの click も飲む', () => {
    const { laneCards, lanes, dispatched, qa, detach } = setup(BODY, 'day');
    const card = laneCards()[0]!;
    pointer(card, 'pointerdown', 'mouse', 560);
    pointer(lanes()[0]!, 'pointermove', 'mouse', 700);
    expect(qa('[data-pkc-field="schedule-drag-ghost"]')).toHaveLength(1);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(qa('[data-pkc-field="schedule-drag-ghost"]'), 'Esc で影が残った').toHaveLength(0);
    pointer(lanes()[0]!, 'pointerup', 'mouse', 700);
    expect(dispatched.filter((a) => a.type === 'SET_TASK_DATE'), 'Esc の後に書いた').toEqual([]);
    expect(click(card), 'Esc の後の click で札が開いてしまう').toBe(false);
    detach();
  });

  it('🔴 落とし先でも目盛りでもない所で離したら何も変えない', () => {
    const { laneCards, dispatched, detach } = setup(BODY, 'day');
    const card = laneCards()[0]!;
    pointer(card, 'pointerdown', 'mouse', 560);
    const nowhere = document.createElement('div');
    document.body.append(nowhere);
    pointer(nowhere, 'pointermove', 'mouse', 700);
    pointer(nowhere, 'pointerup', 'mouse', 700);
    expect(dispatched.filter((a) => a.type === 'SET_TASK_DATE')).toEqual([]);
    detach();
  });

  it('🔴 pointercancel は影を消すだけ(書かない)', () => {
    const { laneCards, lanes, dispatched, qa, detach } = setup(BODY, 'day');
    pointer(laneCards()[0]!, 'pointerdown', 'mouse', 560);
    pointer(lanes()[0]!, 'pointermove', 'mouse', 700);
    pointer(lanes()[0]!, 'pointercancel', 'mouse', 700);
    expect(qa('[data-pkc-field="schedule-drag-ghost"]')).toHaveLength(0);
    expect(dispatched.filter((a) => a.type === 'SET_TASK_DATE')).toEqual([]);
    detach();
  });
});

describe('HTML5 の drag と奪い合わない', () => {
  it('🔴 目盛りの札は draggable=false / 終日の札は draggable=true のまま', () => {
    const { laneCards, qa, scan, detach } = setup(
      '- [ ] 会議 @2026-08-23 14:00..15:00\n- [ ] 終日 @2026-08-23\n',
      'day',
    );
    scan();
    expect(laneCards()).toHaveLength(1);
    expect(laneCards()[0]!.draggable, '目盛りの札が HTML5 の drag を持ったまま').toBe(false);
    const allDay = qa('[data-pkc-field="schedule-day-allday"] [data-pkc-entry]');
    expect(allDay, '終日の札が出ていない').toHaveLength(1);
    expect(allDay[0]!.draggable, '終日の札の HTML5 drag を切ってしまった').toBe(true);
    detach();
  });

  it('「週」の目盛りの札も同じ', () => {
    const { laneCards, detach } = setup('- [ ] 会議 @2026-08-25 14:00..15:00\n', 'week');
    expect(laneCards()[0]!.draggable).toBe(false);
    detach();
  });
});

describe('繰り返しの回は「この回だけ / 全部」を聞いてから書く', () => {
  const RULE = '- [ ] 朝会 @2026-08-24 14:00..15:00 毎週\n';
  const dragRepeat = (): ReturnType<typeof setup> => {
    const s = setup(RULE, 'week');
    const card = s.laneCards()[0]!;
    expect(card.getAttribute('data-pkc-task-repeat'), '前提: 繰り返しの回の札').toBe('week');
    pointer(card, 'pointerdown', 'mouse', 560);
    pointer(s.lanes()[1]!, 'pointermove', 'mouse', 560 + minPx(120));
    pointer(s.lanes()[1]!, 'pointerup', 'mouse', 560 + minPx(120));
    return s;
  };
  const pick = async (which: 'one' | 'all'): Promise<void> => {
    // 小窓は待ち行列の中の async なので、出るまで少し待つ
    await tick(10);
    const dialog = openDialog();
    expect(dialog, '「この回だけか、全部か」の小窓が開いていない').not.toBeNull();
    const rows = [...dialog!.querySelectorAll<HTMLButtonElement>('[data-pkc-field="pick-repeat-move"]')];
    expect(rows, '選べる行が 2 つ並んでいない').toHaveLength(2);
    rows[which === 'one' ? 0 : 1]!.click();
    await tick(30);
  };

  it('🔴 聞くまでは 1 バイトも書かない / 小窓には動かす先の時刻が出る', async () => {
    const { dispatched, store, detach } = dragRepeat();
    await Promise.resolve();
    expect(dispatched.filter((a) => a.type === 'SET_TASK_DATE' || a.type === 'MOVE_REPEAT_OCCURRENCE')).toEqual([]);
    expect(store['e1']).toBe(RULE);
    const dialog = openDialog();
    expect(dialog, '小窓が出ていない(聞かずに済ませている)').not.toBeNull();
    expect(dialog!.textContent).toContain('16:00〜17:00');
    await pick('one');
    detach();
  });

  it('🔴 この回だけ: 規則はそのまま、その回の行が新しい時刻で増える', async () => {
    const { store, detach } = dragRepeat();
    await pick('one');
    expect(store['e1']).toBe(
      '- [ ] 朝会 @2026-08-24 14:00..15:00 毎週\n- [ ] 朝会 @2026-08-24 16:00..17:00 振替2026-08-24\n',
    );
    detach();
  });

  it('🔴 全部: 規則の行の時刻が変わる', async () => {
    const { store, detach } = dragRepeat();
    await pick('all');
    expect(store['e1']).toBe('- [ ] 朝会 @2026-08-24 16:00..17:00 毎週\n');
    detach();
  });

  it('🔴 やめる: 何も書かない', async () => {
    const { store, detach } = dragRepeat();
    openDialog()!.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-cancel"]')!.click();
    await tick(30);
    expect(store['e1']).toBe(RULE);
    detach();
  });

  it('🔴 隣の日の列へ動かした回: 全部 = 規則の日付も同じ差だけずれる', async () => {
    const s = setup(RULE, 'week');
    const card = s.laneCards()[0]!;
    pointer(card, 'pointerdown', 'mouse', 560);
    const to = s.lanes()[3]!; // 8/26
    pointer(to, 'pointermove', 'mouse', 560 + minPx(60));
    pointer(to, 'pointerup', 'mouse', 560 + minPx(60));
    await pick('all');
    expect(s.store['e1']).toBe('- [ ] 朝会 @2026-08-26 15:00..16:00 毎週\n');
    s.detach();
  });

  it('🔴 縁を引いた繰り返しの回: 全部 = 規則の幅が変わる', async () => {
    const s = setup(RULE, 'week');
    const h = s.laneCards()[0]!.querySelector<HTMLElement>('[data-pkc-field="task-resize"]')!;
    pointer(h, 'pointerdown', 'mouse', minPx(15 * 60) - 2);
    pointer(s.lanes()[1]!, 'pointermove', 'mouse', minPx(16 * 60));
    pointer(s.lanes()[1]!, 'pointerup', 'mouse', minPx(16 * 60));
    await pick('all');
    expect(s.store['e1']).toBe('- [ ] 朝会 @2026-08-24 14:00..16:00 毎週\n');
    s.detach();
  });
});

describe('指・ペンは長押しで掴む(縦のスクロールを奪わない)', () => {
  const BODY = '- [ ] 会議 @2026-08-23 14:00..15:00\n';

  it('🔴 長押しの前に動いたら掴まない(スクロールへ譲る)', () => {
    vi.useFakeTimers();
    const { laneCards, lanes, qa, dispatched, detach } = setup(BODY, 'day');
    pointer(laneCards()[0]!, 'pointerdown', 'touch', 560);
    const prevented = !pointer(lanes()[0]!, 'pointermove', 'touch', 560 + LONG_PRESS_SLOP_PX + 5);
    expect(prevented, 'スクロールを殺した').toBe(false);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    pointer(lanes()[0]!, 'pointermove', 'touch', 700);
    pointer(lanes()[0]!, 'pointerup', 'touch', 700);
    expect(qa('[data-pkc-field="schedule-drag-ghost"]')).toHaveLength(0);
    expect(dispatched.filter((a) => a.type === 'SET_TASK_DATE')).toEqual([]);
    detach();
  });

  it('🔴 長押しで掴んだ後は動かせる(指)', () => {
    vi.useFakeTimers();
    const { laneCards, lanes, dispatched, detach } = setup(BODY, 'day');
    pointer(laneCards()[0]!, 'pointerdown', 'touch', 560);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    pointer(lanes()[0]!, 'pointermove', 'touch', 560 + minPx(120));
    pointer(lanes()[0]!, 'pointerup', 'touch', 560 + minPx(120));
    expect(dispatched.filter((a) => a.type === 'SET_TASK_DATE')).toEqual([
      {
        type: 'SET_TASK_DATE',
        lid: 'e1',
        line: 0,
        date: '2026-08-23',
        time: '16:00',
        timeEnd: '17:00',
      },
    ]);
    detach();
  });

  it('ペンも同じ(長押しで掴む)', () => {
    vi.useFakeTimers();
    const { laneCards, lanes, dispatched, detach } = setup(BODY, 'day');
    pointer(laneCards()[0]!, 'pointerdown', 'pen', 560);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    pointer(lanes()[0]!, 'pointermove', 'pen', 560 + minPx(30));
    pointer(lanes()[0]!, 'pointerup', 'pen', 560 + minPx(30));
    expect(dispatched.filter((a) => a.type === 'SET_TASK_DATE')).toHaveLength(1);
    detach();
  });
});

describe('書き込みの口(`SET_TASK_DATE` / `MOVE_REPEAT_OCCURRENCE`)', () => {
  const booted = () => {
    const meta1 = meta('e1');
    return reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta1], relations: [] }).state;
  };

  it('🔴 timeEnd を渡したときだけ書換に載る / 渡さなければ載らない(渡していないのに null で終わりを外さない)', () => {
    const s = booted();
    const withEnd = reduce(s, {
      type: 'SET_TASK_DATE',
      lid: 'e1',
      line: 0,
      date: '2026-08-23',
      time: '16:15',
      timeEnd: '17:15',
    });
    const rw = withEnd.events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(rw && 'rewrite' in rw ? rw.rewrite : null).toMatchObject({
      kind: 'line-date',
      time: '16:15',
      timeEnd: '17:15',
    });
    const without = reduce(s, { type: 'SET_TASK_DATE', lid: 'e1', line: 0, date: '2026-08-23', time: '16:15' });
    const rw2 = without.events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(rw2 && 'rewrite' in rw2 ? 'timeEnd' in rw2.rewrite : null, '渡していないのに timeEnd が載った').toBe(false);
    const nul = reduce(s, { type: 'SET_TASK_DATE', lid: 'e1', line: 0, date: '2026-08-23', time: '16:15', timeEnd: null });
    const rw3 = nul.events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(rw3 && 'rewrite' in rw3 ? rw3.rewrite : null).toMatchObject({ timeEnd: null });
  });

  it('🔴 この回だけの時刻が書換に載る', () => {
    const s = booted();
    const r = reduce(s, {
      type: 'MOVE_REPEAT_OCCURRENCE',
      lid: 'e1',
      line: 0,
      from: '2026-08-24',
      to: '2026-08-24',
      time: '16:00',
      timeEnd: '17:00',
    });
    const rw = r.events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(rw && 'rewrite' in rw ? rw.rewrite : null).toMatchObject({
      kind: 'repeat-move',
      time: '16:00',
      timeEnd: '17:00',
    });
    const plain = reduce(s, { type: 'MOVE_REPEAT_OCCURRENCE', lid: 'e1', line: 0, from: '2026-08-24', to: '2026-08-25' });
    const rw2 = plain.events.find((e) => e.type === 'REQUEST_BODY_REWRITE');
    expect(rw2 && 'rewrite' in rw2 ? 'time' in rw2.rewrite : null, '渡していないのに time が載った').toBe(false);
  });
});
