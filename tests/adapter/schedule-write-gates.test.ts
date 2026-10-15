/** @vitest-environment happy-dom */
/**
 * 🔴 **予定の札を書く口の門**(#1087)── 3 つを見る。
 *
 * 1. 別のタブ・窓が編集中のノートへは、予定の札の書込(外す / 繰り返し / すべて完了 / 落とす /
 *    目盛りで動かす / 元に戻す)を撃たない。断って `EDIT_ELSEWHERE_ERROR` を出し、本文は 1 字も動かない。
 * 2. 書出し / 取込の実行中(`services.busy`)は、落として動かす書込も撃たない(落とす経路は `run()` を通らない)。
 * 3. 落とした時点の走査から行を引き直さない ── 掴んだ時点の行の中身(`GrabbedTask.rawLine`)を `openLine` にし、
 *    掴んでいる間に別のタブが行を足していれば、書換が断る(別の札を動かさない)。
 *
 * 観測点は本文(`store`)と撃った手。各門に「通る場合」の対照群を置く。
 */
import { stubStamps } from '../helpers/store-stamps';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, type DomainEvent } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { ScheduleRenderer } from '../../src/adapter/ui/render/schedule';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { installScheduleGridDrag } from '../../src/adapter/ui/render/schedule-grid-drag';
import { dropTaskCard, installScheduleDrag, repeatMoveAction } from '../../src/adapter/ui/render/schedule-drag';
import { offerMoveUndo, clearMoveOffer } from '../../src/adapter/ui/render/schedule-undo';
import { LONG_PRESS_MS } from '../../src/adapter/ui/actions/long-press';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { stubRevisionOps } from '../helpers/revision-stub';
import { taskCardsOf } from '../../src/features/schedule/task-cards';
import { EDIT_ELSEWHERE_ERROR } from '../../src/features/message/caution-events';

const TODAY = new Date(2026, 7, 23);
const HOUR = 40;
const LANE_H = HOUR * 24;
const BUSY_TEXT = '書き出し / 取り込みが実行中です。完了してから操作してください';
const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));
const LANE_SEL = '[data-pkc-field="schedule-day-lane"], [data-pkc-field="schedule-weekview-lane"]';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

type Act = Parameters<Dispatcher['dispatch']>[0];
type Grant = 'granted' | 'denied';
function rig(body: string, opts: { grant?: Grant; busy?: boolean } = {}) {
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
  const services: BinderServices = {
    busy: () => opts.busy === true,
    ...(opts.grant === undefined
      ? {}
      : {
          acquireEditLock: async () => opts.grant!,
          releaseEditLock: () => undefined,
        }),
  };
  bindActions(root, d, services);
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => store[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      store[e.lid] = e.body;
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1')], relations: [] });
  const rescan = (b: string): void =>
    d.dispatch({
      type: 'SET_TASK_SCAN',
      scan: { cards: taskCardsOf('e1', b), totalNotes: 1, scannedNotes: 1, truncated: false },
    });
  rescan(body);
  const dispatched: Act[] = [];
  const orig = d.dispatch.bind(d);
  d.dispatch = (a: Act) => {
    dispatched.push(a);
    return orig(a);
  };
  const events: DomainEvent[] = [];
  d.onEvent((e) => void events.push(e));
  const detach = installScheduleGridDrag(root, d);
  (root.querySelector('[data-pkc-action="schedule-mode"][data-pkc-mode="day"]') as HTMLElement).click();
  for (const lane of root.querySelectorAll<HTMLElement>(LANE_SEL)) {
    lane.getBoundingClientRect = () =>
      ({ top: 0, left: 0, bottom: LANE_H, right: 100, width: 100, height: LANE_H, x: 0, y: 0 }) as DOMRect;
  }
  const qa = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
  const laneSel = '[data-pkc-field="schedule-day-lane"]';
  return {
    root,
    d,
    store,
    dispatched,
    events,
    detach,
    rescan,
    lanes: () => qa(laneSel),
    laneCards: () => qa(`${laneSel} > [data-pkc-entry]`),
    qa,
    errors: () => dispatched.filter((a) => a.type === 'OP_FAILED').map((a) => (a as { error: string }).error),
    wrote: () => events.filter((e) => e.type === 'REQUEST_BODY_REWRITE').length,
  };
}

function pointer(el: Element, type: string, y: number): void {
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerType: 'mouse',
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 1,
      clientX: 0,
      clientY: y,
    }),
  );
}
const dragDown = (card: HTMLElement, lane: HTMLElement): void => {
  pointer(card, 'pointerdown', 560);
  pointer(lane, 'pointermove', 560 + HOUR);
  pointer(lane, 'pointerup', 560 + HOUR);
};
const BODY = '- [ ] 会議 @2026-08-23 14:00..15:00\n';
const MOVED = '- [ ] 会議 @2026-08-23 15:00..16:00\n';

afterEach(() => {
  clearMoveOffer();
  resetAppDialogForTest();
  document.body.innerHTML = '';
});

describe('目盛りで動かす書込(schedule-grid-drag)', () => {
  it('🔴 別のタブが編集中なら動かさず、理由を出す(本文は動かない)', async () => {
    const r = rig(BODY, { grant: 'denied' });
    dragDown(r.laneCards()[0]!, r.lanes()[0]!);
    await tick(20);
    expect(r.store['e1']).toBe(BODY);
    expect(r.wrote(), '握られているのに書換を撃った').toBe(0);
    expect(r.errors()).toContain(EDIT_ELSEWHERE_ERROR);
    r.detach();
  });
  it('対照群:握られていなければ動く', async () => {
    const r = rig(BODY, { grant: 'granted' });
    dragDown(r.laneCards()[0]!, r.lanes()[0]!);
    await tick(20);
    expect(r.store['e1']).toBe(MOVED);
    r.detach();
  });
  it('🔴 書出し / 取込の最中は動かさず、実行中だと言う', async () => {
    const r = rig(BODY, { busy: true });
    dragDown(r.laneCards()[0]!, r.lanes()[0]!);
    await tick(20);
    expect(r.store['e1']).toBe(BODY);
    expect(r.wrote()).toBe(0);
    expect(r.errors()).toContain(BUSY_TEXT);
    r.detach();
  });
  it('対照群:忙しくなければ動く', async () => {
    const r = rig(BODY, { busy: false });
    dragDown(r.laneCards()[0]!, r.lanes()[0]!);
    await tick(20);
    expect(r.store['e1']).toBe(MOVED);
    r.detach();
  });
  it('🔴 掴んでいる間に別のタブが上へ 1 行足したら、別の札を動かさず断る(掴んだ時点の行で撃つ)', async () => {
    const r = rig(BODY);
    const card = r.laneCards()[0]!;
    pointer(card, 'pointerdown', 560);
    // 別のタブが上へ足した ── 0 行目は別の予定、会議は 1 行目へ
    const inserted = '- [ ] 別の予定 @2026-08-23 14:00..15:00\n' + BODY;
    r.store['e1'] = inserted;
    r.rescan(inserted);
    pointer(r.lanes()[0]!, 'pointermove', 560 + HOUR);
    pointer(r.lanes()[0]!, 'pointerup', 560 + HOUR);
    await tick(20);
    expect(r.store['e1'], '別の札が動いた').toBe(inserted);
    r.detach();
  });
});

describe('日へ落とす書込(dropTaskCard)', () => {
  const DAY_BODY = '- [ ] 見積 @2026-08-23\n';
  const grabbed = { lid: 'e1', line: '0', from: '2026-08-23', repeat: '' };
  it('🔴 別のタブが編集中なら落としても書かない', async () => {
    const r = rig(DAY_BODY, { grant: 'denied' });
    dropTaskCard(r.d, grabbed, '2026-08-27', r.root);
    await tick(20);
    expect(r.store['e1']).toBe(DAY_BODY);
    expect(r.wrote()).toBe(0);
    expect(r.errors()).toContain(EDIT_ELSEWHERE_ERROR);
    r.detach();
  });
  it('対照群:握られていなければ書く', async () => {
    const r = rig(DAY_BODY, { grant: 'granted' });
    dropTaskCard(r.d, grabbed, '2026-08-27', r.root);
    await tick(20);
    expect(r.store['e1']).toBe('- [ ] 見積 @2026-08-27\n');
    r.detach();
  });
  it('🔴 ノート丸ごとの予定(SET_ENTRY_DATE)も、別のタブが編集中なら撃たない', async () => {
    const r = rig(DAY_BODY, { grant: 'denied' });
    dropTaskCard(r.d, { lid: 'e1', line: '', from: '2026-08-23', repeat: '' }, '2026-08-27', r.root);
    await tick(20);
    expect(r.dispatched.filter((a) => a.type === 'SET_ENTRY_DATE')).toHaveLength(0);
    expect(r.errors()).toContain(EDIT_ELSEWHERE_ERROR);
    r.detach();
  });
  it('対照群:ノート丸ごとの予定は握られていなければ撃つ', async () => {
    const r = rig(DAY_BODY, { grant: 'granted' });
    dropTaskCard(r.d, { lid: 'e1', line: '', from: '2026-08-23', repeat: '' }, '2026-08-27', r.root);
    await tick(20);
    expect(r.dispatched.filter((a) => a.type === 'SET_ENTRY_DATE')).toHaveLength(1);
    r.detach();
  });
  it('🔴 書出し / 取込の最中は落としても書かない(行の予定もノート丸ごとも)', async () => {
    const r = rig(DAY_BODY, { busy: true });
    dropTaskCard(r.d, grabbed, '2026-08-27', r.root);
    dropTaskCard(r.d, { lid: 'e1', line: '', from: '2026-08-23', repeat: '' }, '2026-08-27', r.root);
    await tick(20);
    expect(r.store['e1']).toBe(DAY_BODY);
    expect(r.dispatched.filter((a) => a.type === 'SET_TASK_DATE' || a.type === 'SET_ENTRY_DATE')).toHaveLength(0);
    expect(r.errors().filter((e) => e === BUSY_TEXT)).toHaveLength(2);
    r.detach();
  });
  it('対照群:忙しくなければ書く', async () => {
    const r = rig(DAY_BODY, { busy: false });
    dropTaskCard(r.d, grabbed, '2026-08-27', r.root);
    await tick(20);
    expect(r.store['e1']).toBe('- [ ] 見積 @2026-08-27\n');
    r.detach();
  });
  it('🔴 掴んだ時点の行(rawLine)を openLine にする ── 落とした時点で走査が替わっていても別の札を指さない', async () => {
    const r = rig(DAY_BODY);
    const inserted = '- [ ] 別の予定 @2026-08-23\n' + DAY_BODY;
    r.store['e1'] = inserted;
    r.rescan(inserted);
    dropTaskCard(r.d, { ...grabbed, rawLine: '- [ ] 見積 @2026-08-23' }, '2026-08-27', r.root);
    await tick(20);
    const sent = r.dispatched.find((a) => a.type === 'SET_TASK_DATE') as { openLine: string } | undefined;
    expect(sent?.openLine, '落とした時点の走査(別の予定)から引いた').toBe('- [ ] 見積 @2026-08-23');
    expect(r.store['e1'], '別の札が動いた').toBe(inserted);
    r.detach();
  });
  it('対照群:rawLine を持たない荷物は従来どおり落とした時点の走査から引く', () => {
    const r = rig(DAY_BODY);
    dropTaskCard(r.d, grabbed, '2026-08-27', r.root);
    const sent = r.dispatched.find((a) => a.type === 'SET_TASK_DATE') as { openLine: string } | undefined;
    expect(sent?.openLine).toBe('- [ ] 見積 @2026-08-23');
    r.detach();
  });
});

describe('指で掴む経路(installScheduleDrag)は掴んだ時点の行を荷物に載せる', () => {
  it('🔴 長押しで掴んだあと走査が替わっても、落とした書換の openLine は掴んだ時点の行', () => {
    vi.useFakeTimers();
    try {
      const DAY_BODY = '- [ ] 見積 @2026-08-23\n';
      const r = rig(DAY_BODY);
      const detach = installScheduleDrag(r.root, r.d);
      const group = document.createElement('section');
      group.setAttribute('data-pkc-drop-date', '2026-08-23');
      const cards = document.createElement('div');
      cards.setAttribute('data-pkc-region', 'schedule-cards');
      const card = document.createElement('article');
      card.setAttribute('data-pkc-entry', 'e1');
      const box = document.createElement('input');
      box.setAttribute('data-pkc-task-line', '0');
      card.append(box);
      cards.append(card);
      group.append(cards);
      const to = document.createElement('section');
      to.setAttribute('data-pkc-drop-date', '2026-08-27');
      r.root.append(group, to);
      const fire = (el: Element, type: string): void => {
        el.dispatchEvent(
          new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', button: 0, pointerId: 7 }),
        );
      };
      fire(card, 'pointerdown');
      vi.advanceTimersByTime(LONG_PRESS_MS);
      r.rescan('- [ ] 別の予定 @2026-08-23\n' + DAY_BODY); // 掴んでいる間に別のタブが上へ足した
      fire(to, 'pointermove');
      fire(to, 'pointerup');
      const sent = r.dispatched.find((a) => a.type === 'SET_TASK_DATE') as { openLine: string } | undefined;
      expect(sent?.openLine).toBe('- [ ] 見積 @2026-08-23');
      detach();
      r.detach();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('繰り返しの回の「全部 / 1 回だけ」(repeatMoveAction)', () => {
  const REP = '- [ ] 会議 @2026-08-23 毎週\n';
  it('🔴 rawLine があればそれを openLine にする(走査の同じ行が別の札になっていても)', () => {
    const r = rig(REP);
    const inserted = '- [ ] 別 @2026-08-23 毎週\n' + REP;
    r.rescan(inserted);
    const g = { lid: 'e1', line: '0', from: '2026-08-23', repeat: 'week', rawLine: '- [ ] 会議 @2026-08-23 毎週' };
    const one = repeatMoveAction(r.d.getState(), g, 0, '2026-08-23', '2026-08-25', 2, 'one') as { openLine: string };
    expect(one.openLine).toBe('- [ ] 会議 @2026-08-23 毎週');
    const all = repeatMoveAction(r.d.getState(), g, 0, '2026-08-23', '2026-08-25', 2, 'all') as { openLine: string };
    expect(all.openLine).toBe('- [ ] 会議 @2026-08-23 毎週');
    // 対照群:持たなければ走査から(別の札の行)
    const bare = { lid: g.lid, line: g.line, from: g.from, repeat: g.repeat };
    const legacy = repeatMoveAction(r.d.getState(), bare, 0, '2026-08-23', '2026-08-25', 2, 'one') as { openLine: string };
    expect(legacy.openLine).toBe('- [ ] 別 @2026-08-23 毎週');
    r.detach();
  });
});

describe('binder の予定の札の書込', () => {
  const press = async (r: ReturnType<typeof rig>, el: HTMLElement): Promise<void> => {
    r.root.append(el.closest('article') ?? el);
    el.click();
    await tick(20);
  };
  const repeatBtn = (): HTMLElement => {
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'set-task-repeat');
    b.setAttribute('data-pkc-entry', 'e1');
    b.setAttribute('data-pkc-task-line', '0');
    b.setAttribute('data-pkc-repeat', 'week');
    return b;
  };
  const SB = '- [ ] 見積 @2026-08-23\n';
  /** 札(`data-pkc-entry` + 行番号の印)の中の「予定から外す」。 */
  const unscheduleBtn = (): HTMLElement => {
    const card = document.createElement('article');
    card.setAttribute('data-pkc-entry', 'e1');
    const box = document.createElement('input');
    box.setAttribute('data-pkc-task-line', '0');
    const off = document.createElement('button');
    off.setAttribute('data-pkc-action', 'unschedule-task');
    card.append(box, off);
    document.body.append(card);
    return off;
  };

  it('🔴 unschedule-task: 別のタブが編集中なら外さない / 対照群:握られていなければ外す', async () => {
    const denied = rig(SB, { grant: 'denied' });
    await press(denied, unscheduleBtn());
    expect(denied.store['e1']).toBe(SB);
    expect(denied.wrote()).toBe(0);
    expect(denied.errors()).toContain(EDIT_ELSEWHERE_ERROR);
    const ok = rig(SB, { grant: 'granted' });
    await press(ok, unscheduleBtn());
    expect(ok.wrote(), '通る場合は書く').toBe(1);
  });
  it('🔴 set-task-repeat: 別のタブが編集中なら変えない / 対照群:握られていなければ変える', async () => {
    const denied = rig(SB, { grant: 'denied' });
    await press(denied, repeatBtn());
    expect(denied.store['e1']).toBe(SB);
    expect(denied.wrote()).toBe(0);
    expect(denied.errors()).toContain(EDIT_ELSEWHERE_ERROR);
    const ok = rig(SB, { grant: 'granted' });
    await press(ok, repeatBtn());
    expect(ok.wrote()).toBe(1);
  });
  it('🔴 schedule-undo-move: 別のタブが編集中なら戻さない / 対照群:握られていなければ戻す', async () => {
    const mk = async (grant: Grant) => {
      const r = rig(SB, { grant });
      const now = taskCardsOf('e1', SB)[0]!;
      const after = { date: now.date, time: now.time, timeEnd: now.timeEnd, until: now.until, text: '見積' };
      offerMoveUndo(r.root, r.d, {
        target: { kind: 'task', lid: 'e1', line: 0 },
        before: { ...after, date: '2026-08-20' },
        after,
        verb: 'moved',
      });
      const b = document.createElement('button');
      b.setAttribute('data-pkc-action', 'schedule-undo-move');
      await press(r, b);
      return r;
    };
    const denied = await mk('denied');
    expect(denied.wrote()).toBe(0);
    expect(denied.errors()).toContain(EDIT_ELSEWHERE_ERROR);
    const ok = await mk('granted');
    expect(ok.wrote()).toBe(1);
  });
});

describe('本文の面の書込(task-run / pick-color)', () => {
  const BODYT = '# t\n- [ ] a\n- [ ] b\n';
  function bodyRig(grant: Grant, text: string = BODYT) {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher({
      ...initialState,
      cid: 'c1',
      phase: 'ready',
      selectedLid: 'e1',
      entryMetas: new Map([['e1', meta('e1')]]),
      openBody: { lid: 'e1', body: text, baseline: text, persisted: text, diskAhead: false },
    });
    const events: DomainEvent[] = [];
    d.onEvent((e) => void events.push(e));
    const errors: string[] = [];
    const orig = d.dispatch.bind(d);
    d.dispatch = (a: Act) => {
      if (a.type === 'OP_FAILED') errors.push(a.error);
      return orig(a);
    };
    bindActions(root, d, { acquireEditLock: async () => grant, releaseEditLock: () => undefined });
    return { root, events, errors };
  }
  const wrote = (e: DomainEvent[]): number => e.filter((x) => x.type === 'REQUEST_BODY_REWRITE').length;

  it('🔴 task-run-done: 別のタブが編集中ならそろえない / 対照群:握られていなければそろえる', async () => {
    for (const [grant, n] of [['denied', 0], ['granted', 1]] as const) {
      const r = bodyRig(grant);
      const b = document.createElement('button');
      b.setAttribute('data-pkc-action', 'task-run-done');
      b.setAttribute('data-pkc-menu-lid', 'e1');
      b.setAttribute('data-pkc-menu-task-lines', '1,2');
      r.root.append(b);
      b.click();
      await tick(20);
      expect(wrote(r.events), grant).toBe(n);
      if (grant === 'denied') expect(r.errors).toContain(EDIT_ELSEWHERE_ERROR);
    }
  });
  it('🔴 pick-color: 別のタブが編集中なら色を書かない / 対照群:握られていなければ書く', async () => {
    for (const [grant, n] of [['denied', 0], ['granted', 1]] as const) {
      const r = bodyRig(grant, '# t\n色 #3b82f6\n');
      const b = document.createElement('span');
      b.setAttribute('data-pkc-action', 'pick-color');
      b.setAttribute('data-pkc-color-line', '1');
      b.setAttribute('data-pkc-color-nth', '0');
      b.setAttribute('data-pkc-color-value', '#3b82f6');
      r.root.append(b);
      b.click();
      const input = document.querySelector<HTMLInputElement>('input[data-pkc-field="color-pick"]')!;
      input.value = '#ef4444';
      input.dispatchEvent(new Event('change'));
      await tick(20);
      expect(wrote(r.events), grant).toBe(n);
      if (grant === 'denied') expect(r.errors).toContain(EDIT_ELSEWHERE_ERROR);
    }
  });
});
