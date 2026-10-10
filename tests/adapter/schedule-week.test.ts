/** @vitest-environment happy-dom */
/**
 * 🔴 **予定の面の「週」── 7 日を時間の目盛りに並べる**(#855 段 A-2)。
 *
 * 純関数(週の決め方・見出し・合図の綴り)は `tests/features/week-layout.test.ts`。
 * **ここが見るのは繋がり** ── ① 広い面(中央 / 別のウィンドウ)は 7 列を描く ② 左の列の「週」は
 * 描かず別のウィンドウを開く(窓が出なければ見せ方を変えず理由を出す)③ 開いた窓が合図を読んで
 * 「週」で立ち上がる。
 *
 * ⚠ 位置は CSS の変数(`--day-start` など)に焼かれる。実際の高さになるかは実ブラウザでしか言えない
 *   ── `tests/smoke/schedule.smoke.spec.ts` が見る。
 */
import { stubStamps } from '../helpers/store-stamps';
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { ScheduleRenderer } from '../../src/adapter/ui/render/schedule';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { connectViewDeepLink, type DeepLinkTarget } from '../../src/adapter/platform/deep-link';
import { openViewInWindow, type ViewWindowDeps } from '../../src/adapter/platform/view-window';
import { stubRevisionOps } from '../helpers/revision-stub';
import { taskCardsOf } from '../../src/features/schedule/task-cards';

const TODAY = new Date(2026, 7, 23); // 2026-08-23(日)

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
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
    ...over,
  };
}

function setup(
  bodies: Record<string, string>,
  opts: { wide?: boolean; services?: BinderServices } = {},
) {
  const wide = opts.wide ?? true;
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const store: Record<string, string> = { ...bodies };
  const host = document.createElement('div');
  // 🔑 広い面は中央の面(`data-pkc-view-pane`)/ 左の列は `data-pkc-browse-pane`(本物の器と同じ印)
  host.setAttribute(wide ? 'data-pkc-view-pane' : 'data-pkc-browse-pane', 'schedule');
  regions.browseHost.append(host);
  const view = new ScheduleRenderer(host, () => TODAY);
  d.onState((s) => view.render(s));
  bindActions(root, d, opts.services ?? {});
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
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: Object.keys(bodies).map((lid) => meta(lid)),
    relations: [],
  });
  const cards = Object.entries(bodies).flatMap(([lid, body]) => taskCardsOf(lid, body));
  d.dispatch({
    type: 'SET_TASK_SCAN',
    scan: { cards, totalNotes: 1, scannedNotes: 1, truncated: false },
  });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const qa = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
  const press = (sel: string): void => {
    const el = q(sel);
    if (el === null) throw new Error(`押す物が無い: ${sel}`);
    el.click();
  };
  const showWeek = (): void => press('[data-pkc-action="schedule-mode"][data-pkc-mode="week"]');
  return { root, d, q, qa, press, showWeek };
}

const lanes = (qa: (s: string) => HTMLElement[]): HTMLElement[] =>
  qa('[data-pkc-field="schedule-weekview-lane"]');
const css = (el: HTMLElement, k: string): string => el.style.getPropertyValue(k);
const textOf = (el: HTMLElement): string => el.querySelector('[data-pkc-field="text"]')?.textContent ?? '';
const WEEK = [
  '2026-08-23', '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29',
];

describe('状態', () => {
  it('見せ方に「週」を選べる / 実在しない日は捨てる(週の基準は変わらない)', () => {
    const s = reduce(initialState, { type: 'SET_SCHEDULE_MODE', mode: 'week' }).state;
    expect(s.scheduleMode).toBe('week');
    expect(reduce(s, { type: 'SET_SCHEDULE_DAY', date: '2026-02-30' }).state.scheduleDay).toBeNull();
  });
});

describe('広い面の「週」', () => {
  it('🔴 7 つの列が出て、それぞれが自分の日を落とし先に持つ(日曜始まり)', () => {
    const { q, qa, showWeek } = setup({ e1: '- [ ] 打合せ @2026-08-25 14:00\n' });
    expect(q('[data-pkc-region="schedule-weekview"]')!.hidden, '押す前に週が出ている').toBe(true);
    showWeek();
    expect(q('[data-pkc-region="schedule-weekview"]')!.hidden).toBe(false);
    expect(lanes(qa).map((l) => l.getAttribute('data-pkc-drop-date'))).toEqual(WEEK);
    // 見出し・終日の升も落とし先(落とすとその日になる)
    expect(
      qa('[data-pkc-field="schedule-weekview-heads"] > button').map((b) => b.getAttribute('data-pkc-drop-date')),
    ).toEqual(WEEK);
    expect(
      qa('[data-pkc-field="schedule-weekview-allday-cell"]').map((b) => b.getAttribute('data-pkc-drop-date')),
    ).toEqual(WEEK);
    expect(q('[data-pkc-field="schedule-weekview-label"]')!.textContent).toBe('8月23日〜8月29日');
    // 今日(日曜)の見出しだけに印
    expect(
      qa('[data-pkc-field="schedule-weekview-heads"] > button').map((b) => b.hasAttribute('data-pkc-today')),
    ).toEqual([true, false, false, false, false, false, false]);
    // 日ごとの束・「日」の目盛りは出ない
    expect(qa('[data-pkc-region="schedule-group"]')).toHaveLength(0);
    expect(q('[data-pkc-region="schedule-day"]')!.hidden).toBe(true);
  });

  it('🔴 火曜 14:00..15:00 の予定は火曜の列にだけあり、位置は 840 分から 60 分', () => {
    const { qa, showWeek } = setup({ e1: '- [ ] 会議 @2026-08-25 14:00..15:00\n' });
    showWeek();
    const all = qa('[data-pkc-field="schedule-weekview-lane"] > [data-pkc-entry]');
    expect(all).toHaveLength(1);
    const card = all[0]!;
    expect(lanes(qa)[2]!.contains(card), '火曜の列に居ない').toBe(true);
    expect(lanes(qa)[2]!.getAttribute('data-pkc-drop-date')).toBe('2026-08-25');
    expect(css(card, '--day-start')).toBe('840');
    expect(css(card, '--day-span')).toBe('60');
    expect(css(card, '--day-cols')).toBe('1');
    expect(textOf(card)).toBe('会議');
  });

  it('🔴 重なる予定は同じ日の中だけで横に並ぶ(別の日の予定とは並ばない)', () => {
    const { qa, showWeek } = setup({
      e1: [
        '- [ ] A @2026-08-25 10:00..11:00',
        '- [ ] B @2026-08-25 10:30..11:30',
        '- [ ] C @2026-08-26 10:00..11:00',
      ].join('\n'),
    });
    showWeek();
    const pos = (lane: number) =>
      Object.fromEntries(
        [...lanes(qa)[lane]!.querySelectorAll<HTMLElement>(':scope > [data-pkc-entry]')].map((c) => [
          textOf(c),
          `${css(c, '--day-col')}/${css(c, '--day-cols')}`,
        ]),
      );
    expect(pos(2)).toEqual({ A: '0/2', B: '1/2' });
    expect(pos(3)).toEqual({ C: '0/1' });
  });

  it('🔴 期間の予定は、含まれる日の終日の升それぞれに別の札で出る', () => {
    const { qa, showWeek } = setup({ e1: '- [ ] 出張 @2026-08-24..2026-08-26\n' });
    showWeek();
    const cells = qa('[data-pkc-field="schedule-weekview-allday-cell"]');
    const filled = cells.map((c) => c.querySelectorAll(':scope > [data-pkc-entry]').length);
    expect(filled).toEqual([0, 1, 1, 1, 0, 0, 0]);
    // 同じ予定でも日が違えば別の札(DOM を共有しない)
    const els = qa('[data-pkc-field="schedule-weekview-allday-cell"] > [data-pkc-entry]');
    expect(new Set(els).size).toBe(3);
  });

  it('🔴 見出しを押すと、その日の「日」へ移る', () => {
    const { q, qa, press, d } = setup({ e1: '- [ ] 会議 @2026-08-25 14:00\n' });
    press('[data-pkc-action="schedule-mode"][data-pkc-mode="week"]');
    qa('[data-pkc-field="schedule-weekview-heads"] > button')[3]!.click();
    expect(d.getState().scheduleMode).toBe('day');
    expect(d.getState().scheduleDay).toBe('2026-08-26');
    expect(q('[data-pkc-region="schedule-day"]')!.hidden).toBe(false);
    expect(q('[data-pkc-region="schedule-weekview"]')!.hidden).toBe(true);
    expect(q('[data-pkc-field="schedule-day-label"]')!.textContent).toBe('8月26日(水)');
  });

  it('見出しが今日なら、今日に追従する状態(scheduleDay = null)の「日」へ', () => {
    const { qa, press, d } = setup({});
    press('[data-pkc-action="schedule-mode"][data-pkc-mode="week"]');
    qa('[data-pkc-field="schedule-weekview-heads"] > button')[0]!.click();
    expect(d.getState().scheduleMode).toBe('day');
    expect(d.getState().scheduleDay).toBeNull();
  });

  it('🔴 ‹ › で週が動き、今日を含む週へ戻ると scheduleDay は null / 今週は今週のとき押せない', () => {
    const { q, press, d } = setup({});
    press('[data-pkc-action="schedule-mode"][data-pkc-mode="week"]');
    const today = q<HTMLButtonElement>('[data-pkc-field="schedule-weekview-today"]')!;
    expect(today.disabled, '今週なのに押せる').toBe(true);
    press('[data-pkc-field="schedule-weekview-next"]');
    expect(d.getState().scheduleDay).toBe('2026-08-30');
    expect(q('[data-pkc-field="schedule-weekview-label"]')!.textContent).toBe('8月30日〜9月5日');
    expect(today.disabled, '他の週なのに今週が押せない').toBe(false);
    // 次の週では今日の印は出ない
    expect(q('[data-pkc-field="schedule-weekview-heads"] > [data-pkc-today]')).toBeNull();
    press('[data-pkc-field="schedule-weekview-prev"]');
    // 今日を含む週へ戻った ── 実日付を残さず今日に追従する状態へ
    expect(d.getState().scheduleDay).toBeNull();
    expect(q('[data-pkc-field="schedule-weekview-label"]')!.textContent).toBe('8月23日〜8月29日');
    press('[data-pkc-field="schedule-weekview-prev"]');
    expect(q('[data-pkc-field="schedule-weekview-label"]')!.textContent).toBe('8月16日〜8月22日');
    press('[data-pkc-field="schedule-weekview-today"]');
    expect(d.getState().scheduleDay).toBeNull();
    expect(q('[data-pkc-field="schedule-weekview-label"]')!.textContent).toBe('8月23日〜8月29日');
  });

  it('🔴 小さな月の日を押すと、その日が scheduleDay になり週が追従する', () => {
    const { q, press, d } = setup({});
    press('[data-pkc-action="schedule-mode"][data-pkc-mode="week"]');
    press('[data-pkc-field="schedule-week"] > button[data-pkc-drop-date="2026-08-13"]');
    expect(d.getState().scheduleDay).toBe('2026-08-13');
    expect(d.getState().scheduleMode).toBe('week');
    expect(q('[data-pkc-field="schedule-weekview-label"]')!.textContent).toBe('8月9日〜8月15日');
  });

  it('「予定を足す」の日付: 今日を含む週は今日のまま / 他の週へ動くと、その週の最初の日', () => {
    const { q, press } = setup({});
    const date = q<HTMLInputElement>('[data-pkc-field="schedule-quick-date"]')!;
    press('[data-pkc-action="schedule-mode"][data-pkc-mode="week"]');
    expect(date.value).toBe('2026-08-23');
    press('[data-pkc-field="schedule-weekview-next"]');
    expect(date.value).toBe('2026-08-30');
    // user が欄を直したら、週が変わるまで奪わない
    date.value = '2026-09-02';
    press('[data-pkc-field="schedule-weekview-next"]');
    expect(date.value).toBe('2026-09-06');
  });

  it('「一覧」へ戻ると週は隠れ、日ごとの束が戻る', () => {
    const { q, qa, press } = setup({ e1: '- [ ] 会議 @2026-08-25 14:00\n' });
    press('[data-pkc-action="schedule-mode"][data-pkc-mode="week"]');
    press('[data-pkc-action="schedule-mode"][data-pkc-mode="list"]');
    expect(q('[data-pkc-region="schedule-weekview"]')!.hidden).toBe(true);
    expect(qa('[data-pkc-region="schedule-group"]')).toHaveLength(1);
  });

  it('押している見せ方は「週」だけが true', () => {
    const { qa, showWeek } = setup({});
    showWeek();
    expect(
      qa('[data-pkc-action="schedule-mode"]').map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
    ).toEqual([['一覧', 'false'], ['日', 'false'], ['週', 'true']]);
  });
});

describe('左の列の「週」', () => {
  it('🔴 7 列を描かず、別のウィンドウを週で開く(見せ方は一覧のまま)', () => {
    const calls: Array<[string, string | null]> = [];
    const { q, qa, showWeek, d } = setup(
      { e1: '- [ ] 会議 @2026-08-25 14:00\n' },
      {
        wide: false,
        services: { openScheduleWindow: (mode, day) => void calls.push([mode, day]) },
      },
    );
    showWeek();
    expect(calls).toEqual([['week', null]]);
    expect(d.getState().scheduleMode, '左の列の見せ方が変わった').toBe('list');
    expect(q('[data-pkc-region="schedule-weekview"]')!.hidden).toBe(true);
    expect(lanes(qa).flatMap((l) => [...l.children])).toHaveLength(0);
    expect(qa('[data-pkc-region="schedule-group"]'), '一覧が消えた').toHaveLength(1);
  });

  it('見ている日を連れて行く / 「週」ボタンの title が別のウィンドウで開くと言う', () => {
    const calls: Array<[string, string | null]> = [];
    const { qa, showWeek, d } = setup(
      {},
      { wide: false, services: { openScheduleWindow: (m, day) => void calls.push([m, day]) } },
    );
    d.dispatch({ type: 'SET_SCHEDULE_DAY', date: '2026-09-02' });
    showWeek();
    expect(calls).toEqual([['week', '2026-09-02']]);
    const btn = qa('[data-pkc-action="schedule-mode"][data-pkc-mode="week"]')[0]!;
    expect(btn.title).toContain('別のウィンドウ');
  });

  it('広い面の「週」ボタンは別のウィンドウを開かない(対照群)', () => {
    const calls: unknown[] = [];
    const { showWeek, d } = setup({}, { services: { openScheduleWindow: () => void calls.push(1) } });
    showWeek();
    expect(calls).toEqual([]);
    expect(d.getState().scheduleMode).toBe('week');
  });

  it('窓を開く口が無い配線では、黙らず理由を出す', () => {
    const { showWeek, d } = setup({}, { wide: false });
    showWeek();
    expect(d.getState().scheduleMode).toBe('list');
    expect(d.getState().error).toContain('開けませんでした');
  });

  it('🔴 state が週でも左の列は一覧として描く(別窓の左の列に 7 列を詰めない)', () => {
    const { q, qa, d } = setup({ e1: '- [ ] 会議 @2026-08-25 14:00\n' }, { wide: false });
    d.dispatch({ type: 'SET_SCHEDULE_MODE', mode: 'week' });
    expect(q('[data-pkc-region="schedule-weekview"]')!.hidden).toBe(true);
    expect(qa('[data-pkc-region="schedule-group"]')).toHaveLength(1);
    expect(
      qa('[data-pkc-action="schedule-mode"]').map((b) => b.getAttribute('aria-pressed')),
    ).toEqual(['true', 'false', 'false']);
  });
});

describe('窓が塞がれたとき', () => {
  function deps(answered: boolean) {
    const opened: string[] = [];
    const panes: string[] = [];
    const fails: string[] = [];
    const d: ViewWindowDeps = {
      open: (url) => void opened.push(url),
      baseUrl: () => 'https://pkc.test/app/',
      selected: () => null,
      newToken: () => 'tok',
      waitForOpen: async () => answered,
      openInPane: (v) => {
        panes.push(v);
        return true;
      },
      fail: (m) => void fails.push(m),
      schedule: { mode: 'week', day: '2026-09-02' },
    };
    return { d, opened, panes, fails };
  }

  it('🔴 開くときの URL に週の合図が載る', async () => {
    const b = deps(true);
    expect(await openViewInWindow('schedule', b.d)).toBe('window');
    expect(b.opened).toEqual(['https://pkc.test/app/#pkc?view=schedule&w=tok&sched=week&day=2026-09-02']);
    expect(b.panes).toEqual([]);
    expect(b.fails).toEqual([]);
  });

  it('🔴 塞がれたら退避せず(見せ方を変えず)、理由だけ出す', async () => {
    const b = deps(false);
    expect(await openViewInWindow('schedule', b.d)).toBe('pane');
    expect(b.panes, '左の列へ退避した(開いていない週を開いたと言う)').toEqual([]);
    expect(b.fails).toHaveLength(1);
    expect(b.fails[0]).toContain('ブロック');
    expect(b.fails[0]).not.toContain('この画面で開きました');
  });

  it('対照群: 週の合図が無い面は、いままでどおり退避する', async () => {
    const b = deps(false);
    const { schedule: _drop, ...rest } = b.d;
    void _drop;
    await openViewInWindow('schedule', rest);
    expect(b.panes).toEqual(['schedule']);
  });
});

describe('開いた窓の起動(deep-link)', () => {
  function boot(hash: string, withSchedule = true) {
    const log: string[] = [];
    const target: DeepLinkTarget & { hash: string } = {
      hash,
      clearHash: () => {},
      dropToken: () => {},
      dropSchedule: () => {
        log.push('dropSchedule');
      },
      setEntry: () => {},
      restoreHash: () => {},
    };
    connectViewDeepLink({
      openView: (m) => log.push(`open:${m}`),
      ...(withSchedule ? { scheduleView: (m: 'week', day: string | null) => log.push(`sched:${m}:${day}`) } : {}),
      fail: (m) => log.push(`fail:${m}`),
      onViewChange: () => () => {},
      onSelectedEntry: () => () => {},
      target,
    });
    return log;
  }

  it('🔴 面を開いた「後」に週を当て、すぐアドレスから外す', () => {
    expect(boot('#pkc?view=schedule&w=tok&sched=week&day=2026-09-02')).toEqual([
      'open:schedule',
      'sched:week:2026-09-02',
      'dropSchedule',
    ]);
    expect(boot('#pkc?view=schedule&sched=week')).toEqual([
      'open:schedule',
      'sched:week:null',
      'dropSchedule',
    ]);
  });

  it('対照群: 合図が無い / 読めない / 別の面では当てない', () => {
    expect(boot('#pkc?view=schedule&w=tok')).toEqual(['open:schedule']);
    expect(boot('#pkc?view=schedule&sched=month')).toEqual(['open:schedule']);
    expect(boot('#pkc?view=calendar&sched=week')).not.toContain('sched:week:null');
  });

  it('🔴 配線した state まで届く: dispatch で週 + 日になる', () => {
    const d = new Dispatcher();
    const target: DeepLinkTarget = {
      hash: '#pkc?view=schedule&sched=week&day=2026-09-02',
      clearHash: () => {},
      dropToken: () => {},
      setEntry: () => {},
      restoreHash: () => {},
    };
    connectViewDeepLink({
      openView: () => {},
      scheduleView: (mode, day) => {
        d.dispatch({ type: 'SET_SCHEDULE_MODE', mode });
        if (day !== null) d.dispatch({ type: 'SET_SCHEDULE_DAY', date: day });
      },
      fail: () => {},
      onViewChange: () => () => {},
      onSelectedEntry: () => () => {},
      target,
    });
    expect(d.getState().scheduleMode).toBe('week');
    expect(d.getState().scheduleDay).toBe('2026-09-02');
  });
});
