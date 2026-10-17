/** @vitest-environment happy-dom */
/**
 * 台帳 #1852 束 E2(予定表の見え方と知らせ)の、画面に出る部分。
 *
 * - 289: 題名の無い予定は「(題名なし)」と出る
 * - 247: 隠したノートの済んだ予定は「済み(N)」ではなく「隠したノートの分」に数える
 * - 288: 予定表が出ているあいだだけ、次の 0 時に 1 回描き直す(閉じたら予約を置かない)
 * - 191: 週の始まり(日曜 / 月曜)を選べる。選ぶと「月」と小さな月の並びが変わり、保存される
 * - 286B: 「全部動かす」の確認に、以前に 1 回だけ動かした回の数が出る
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { ScheduleRenderer } from '../../src/adapter/ui/render/schedule';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { appScheduleWeekStart } from '../../src/adapter/ui/render/schedule-week-start';
import { pickRepeatMoveInApp, resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { movedBeforeOf } from '../../src/adapter/ui/render/schedule-drag';
import { taskCardsOf } from '../../src/features/schedule/task-cards';

const TODAY = new Date(2026, 7, 23); // 2026-08-23(日)

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    entryOrder: Number(lid.slice(1)) || 0,
    status: null,
    date: null,
    archived: false,
    bodyChars: 10,
    ...over,
  };
}

function stateOf(metas: EntryMeta[], bodies: Record<string, string>, over: Partial<AppState> = {}): AppState {
  const cards = Object.entries(bodies).flatMap(([lid, body]) => taskCardsOf(lid, body));
  return {
    ...initialState,
    entryMetas: new Map(metas.map((m) => [m.lid, m])),
    order: metas.map((m) => m.lid),
    taskScan: { cards, totalNotes: metas.length, scannedNotes: metas.length, truncated: false },
    ...over,
  } as AppState;
}

function mount(now: () => Date = () => TODAY): { host: HTMLElement; r: ScheduleRenderer } {
  const host = document.createElement('div');
  document.body.append(host);
  return { host, r: new ScheduleRenderer(host, now) };
}

beforeEach(() => {
  localStorage.clear();
  appScheduleWeekStart.set(0);
});

afterEach(() => {
  document.body.textContent = '';
  vi.useRealTimers();
  localStorage.clear();
});

describe('289: 題名の無い予定', () => {
  it('🔴 「(題名なし)」と出る(空の行にしない)。対照群:題名のある予定はその字', () => {
    const { host, r } = mount();
    r.render(
      stateOf([meta('e1')], { e1: '- [ ] @2026-08-23\n- [ ] 見積を出す @2026-08-23\n' }),
    );
    const texts = [...host.querySelectorAll('[data-pkc-region="schedule-cards"] [data-pkc-field="text"]')].map(
      (e) => e.textContent,
    );
    expect(texts).toContain('(題名なし)');
    expect(texts).toContain('見積を出す');
    expect(texts.filter((t) => t === '')).toHaveLength(0);
  });
});

describe('247: 隠したノートの済んだ予定は「隠したノートの分」に数える', () => {
  const metas = [
    meta('e1', { title: '見えるノート', date: '2026-08-24', status: 'done' }),
    meta('e2', { title: '隠すノート' }),
    meta('e3', { title: '残るノート' }),
  ];
  const bodies = {
    e2: '- [x] 済んだ @2026-08-24\n- [ ] 済んでいない @2026-08-25\n',
    e3: '- [ ] 別の予定 @2026-08-26\n',
  };
  const done = (host: HTMLElement): string =>
    host.querySelector('[data-pkc-field="schedule-done"]')?.closest('label')?.textContent ?? '';
  const fold = (host: HTMLElement): string =>
    host.querySelector('[data-pkc-field="schedule-fold-button"]')?.textContent ?? '';

  it('🔴 「済み(N)」から隠したノートの分を外し、合計「出すもの(N)」にはそのぶんも足す', () => {
    const { host, r } = mount();
    r.render(stateOf(metas, bodies, { scheduleHiddenNotes: ['e2'] }));
    // 済み(N) = 押して出る数 = 見えるノートの済みだけ(e1 の 1 件)
    expect(done(host)).toContain('済み(1)');
    // 合計 = 済み 1 + 隠したノート e2 の分(済んでいない 1 + 済んだ 1)= 3
    expect(fold(host)).toBe('出すもの(3)');
  });

  it('⚠ 対照群:隠していなければ、済みは e2 の分も数える(2 件)/ 合計は済みだけ', () => {
    const { host, r } = mount();
    r.render(stateOf(metas, bodies));
    expect(done(host)).toContain('済み(2)');
    expect(fold(host)).toBe('出すもの(2)');
  });

  it('「済み」を出しているときは二重に数えない(隠したノートの分 = 2 件、済みは隠れていない)', () => {
    const { host, r } = mount();
    r.render(stateOf(metas, bodies, { scheduleHiddenNotes: ['e2'], showDoneTasks: true }));
    expect(fold(host)).toBe('出すもの(2)');
  });
});

describe('288: 次の 0 時に 1 回だけ描き直す', () => {
  const todayCell = (host: HTMLElement): string =>
    host.querySelector('[data-pkc-action="schedule-pick-day"][data-pkc-today]')?.textContent ?? '';

  it('🔴 出しっぱなしでも、0 時を過ぎると「今日」の印が次の日へ動く', () => {
    vi.useFakeTimers();
    let cur = new Date(2026, 7, 23, 23, 59, 0);
    const { host, r } = mount(() => cur);
    r.render(stateOf([meta('e1')], { e1: '- [ ] a @2026-08-23\n' }));
    expect(todayCell(host)).toBe('23');
    cur = new Date(2026, 7, 24, 0, 0, 5);
    vi.advanceTimersByTime(65_000);
    expect(todayCell(host), '日が変わったのに「今日」が前の日のまま').toBe('24');
  });

  it('⚠ 予約は 1 回だけ置く(描き直すたびに積まない)/ 隠れている面には置かない', () => {
    vi.useFakeTimers();
    const { host, r } = mount(() => new Date(2026, 7, 23, 10, 0, 0));
    const st = stateOf([meta('e1')], { e1: '- [ ] a @2026-08-23\n' });
    r.render(st);
    r.render({ ...st, selectedLid: 'e1' });
    r.render({ ...st, selectedLid: null });
    expect(vi.getTimerCount(), '描くたびに予約が積まれている').toBe(1);
    host.hidden = true;
    r.render({ ...st, selectedLid: 'e1' });
    expect(vi.getTimerCount(), '隠れている面に予約が残っている').toBe(0);
  });
});

describe('191: 週の始まり', () => {
  const weekHead = (host: HTMLElement): string =>
    [...(host.querySelector('[data-pkc-region="schedule"] > div > [data-pkc-field="schedule-week"]')?.children ?? [])]
      .map((c) => c.textContent)
      .join('');

  it('🔴 既定は日曜始まり。月曜始まりを選ぶと、小さな月の見出しが月から始まる(土日の印は土日のまま)', () => {
    const { host, r } = mount();
    const st = stateOf([meta('e1')], {});
    r.render(st);
    expect(weekHead(host)).toBe('日月火水木金土');
    appScheduleWeekStart.set(1);
    // 保存を変えるだけで、いま出ている面が描き直される(状態は動かさない)
    expect(weekHead(host)).toBe('月火水木金土日');
    const marked = [
      ...host.querySelectorAll('[data-pkc-field="schedule-week"]:first-of-type > [data-pkc-weekend]'),
    ].map((e) => e.textContent);
    expect(marked).toEqual(['土', '日']);
    expect((host.querySelector('[data-pkc-field="schedule-week-start"]') as HTMLSelectElement).value).toBe('1');
  });

  it('🔴 選び方の口(select)を変えると保存され、面が描き直される / 読めない値は日曜始まりへ戻る', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    buildShell(root);
    const host = document.createElement('div');
    root.append(host);
    const view = new ScheduleRenderer(host, () => TODAY);
    d.onState((s) => view.render(s));
    bindActions(root, d, {});
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1')], relations: [] });
    const sel = host.querySelector<HTMLSelectElement>('[data-pkc-field="schedule-week-start"]')!;
    expect([...sel.options].map((o) => o.textContent)).toEqual(['日曜始まり', '月曜始まり']);
    sel.value = '1';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(localStorage.getItem('pkc3.schedule-week-start')).toBe('1');
    expect(weekHead(host)).toBe('月火水木金土日');
    sel.value = '0';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(localStorage.getItem('pkc3.schedule-week-start')).toBe('0');
    expect(weekHead(host)).toBe('日月火水木金土');
  });

  it('「月」の見出しと升の並びも変わる(広い面)/ 日付そのものは変わらない', () => {
    const { host, r } = mount();
    const st = stateOf([meta('e1')], { e1: '- [ ] a @2026-08-23\n' }, { scheduleMode: 'month' });
    r.render(st);
    const head = (): string =>
      [...(host.querySelector('[data-pkc-field="schedule-monthview-weekdays"]')?.children ?? [])]
        .map((c) => c.textContent)
        .join('');
    const firstRow = (): (string | null)[] =>
      [...(host.querySelector('[data-pkc-field="schedule-monthview-week"]')?.children ?? [])].map(
        (c) => c.querySelector('[data-pkc-field="schedule-monthview-num"]')?.textContent ?? null,
      );
    expect(head()).toBe('日月火水木金土');
    // 2026 年 8 月 1 日は土曜 ── 日曜始まりでは最後の列、月曜始まりでも最後から 2 つ目
    expect(firstRow().indexOf('1')).toBe(6);
    appScheduleWeekStart.set(1);
    expect(head()).toBe('月火水木金土日');
    expect(firstRow().indexOf('1')).toBe(5);
    // 予定の日付は動かない(23 日の札は 1 枚のまま)
    const day23 = host.querySelector('[data-pkc-field="schedule-monthview-cell"][data-pkc-drop-date="2026-08-23"]');
    expect(day23?.querySelectorAll('article')).toHaveLength(1);
  });
});

describe('286B: 「全部動かす」の確認', () => {
  beforeEach(() => resetAppDialogForTest());
  afterEach(() => resetAppDialogForTest());

  it('🔴 以前に 1 回だけ動かした回があれば、そのまま残ることを先に言う(件数つき)', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    void pickRepeatMoveInApp(host, 1, null, 2);
    await Promise.resolve();
    await new Promise((res) => setTimeout(res, 0));
    const note = document.querySelector('[data-pkc-field="pick-repeat-move-note"]')?.textContent ?? '';
    expect(note).toContain('以前に 1 回だけ動かした回(2 件)は、「全部動かす」でもそのまま残ります');
  });

  it('⚠ 対照群:動かした回が無ければ言わない', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    void pickRepeatMoveInApp(host, 1, null, 0);
    await Promise.resolve();
    await new Promise((res) => setTimeout(res, 0));
    const note = document.querySelector('[data-pkc-field="pick-repeat-move-note"]')?.textContent ?? '';
    expect(note).not.toContain('そのまま残ります');
    expect(note).toContain('次の回からはどうしますか');
  });

  it('数える材料:札から、同じ規則の振替の行だけを引く(札が走査に居なければ 0)', () => {
    const body = [
      '- [ ] 会議 @2026-08-03 毎週',
      '- [ ] 会議 @2026-08-12 振替2026-08-10',
    ].join('\n');
    const st = stateOf([meta('e1')], { e1: body });
    const rule = st.taskScan!.cards.find((c) => c.repeat !== null)!;
    expect(movedBeforeOf(st, 'e1', rule.line!)).toBe(1);
    expect(movedBeforeOf(st, 'e1', 99)).toBe(0);
    expect(movedBeforeOf({ ...st, taskScan: null }, 'e1', rule.line!)).toBe(0);
  });
});
