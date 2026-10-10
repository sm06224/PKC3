/** @vitest-environment happy-dom */
/**
 * 🔴 **予定の面の「日」── 1 日を時間の目盛りに並べる**(#855 段 A-1)。
 *
 * 置き場所の計算(重なり・30 分・24:00 での切り)は `tests/features/day-layout.test.ts`。
 * **ここが見るのは繋がり** ── ボタンを押すと見せ方が変わり、札が計算どおりの場所に置かれ、
 * 掴んで目盛りへ落とすと本文の日付が変わるか。
 *
 * ⚠ 位置は CSS の変数(`--day-start` など)に焼かれる。実際の高さ(40px)になるかは
 *   実ブラウザでしか言えない ── `tests/smoke/schedule.smoke.spec.ts` が見る。
 */
import { stubStamps } from '../helpers/store-stamps';
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { ScheduleRenderer } from '../../src/adapter/ui/render/schedule';
import { bindActions } from '../../src/adapter/ui/actions/binder';
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

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

function setup(bodies: Record<string, string>, dates: Record<string, string> = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const store: Record<string, string> = { ...bodies };
  const host = document.createElement('div');
  host.setAttribute('data-pkc-browse-pane', 'schedule');
  regions.browseHost.append(host);
  const view = new ScheduleRenderer(host, () => TODAY);
  d.onState((s) => view.render(s));
  bindActions(root, d);
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
    metas: [...new Set([...Object.keys(bodies), ...Object.keys(dates)])].map((lid) =>
      meta(lid, dates[lid] === undefined ? {} : { date: dates[lid]! }),
    ),
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
  const showDay = (): void => press('[data-pkc-action="schedule-mode"][data-pkc-mode="day"]');
  return { root, d, q, qa, store, press, showDay };
}

const lane = '[data-pkc-field="schedule-day-lane"] > [data-pkc-entry]';
const allDay = '[data-pkc-field="schedule-day-allday"] [data-pkc-region="schedule-cards"] > [data-pkc-entry]';
const css = (el: HTMLElement, k: string): string => el.style.getPropertyValue(k);
const textOf = (el: HTMLElement): string => el.querySelector('[data-pkc-field="text"]')?.textContent ?? '';

describe('状態(SET_SCHEDULE_MODE / SET_SCHEDULE_DAY)', () => {
  it('既定は一覧 / 今日', () => {
    expect(initialState.scheduleMode).toBe('list');
    expect(initialState.scheduleDay).toBeNull();
  });

  it('見せ方を切り替える', () => {
    const day = reduce(initialState, { type: 'SET_SCHEDULE_MODE', mode: 'day' }).state;
    expect(day.scheduleMode).toBe('day');
    expect(reduce(day, { type: 'SET_SCHEDULE_MODE', mode: 'list' }).state.scheduleMode).toBe('list');
  });

  it('日を選ぶと、小さな月もその月へ動く / null で今日(今月)へ戻る', () => {
    const s = reduce(initialState, { type: 'SET_SCHEDULE_DAY', date: '2026-11-03' }).state;
    expect(s.scheduleDay).toBe('2026-11-03');
    expect(s.calendarMonth).toEqual({ year: 2026, month: 11 });
    const back = reduce(s, { type: 'SET_SCHEDULE_DAY', date: null }).state;
    expect(back.scheduleDay).toBeNull();
    expect(back.calendarMonth).toBeNull();
  });

  it('実在しない日は黙って捨てる(別の日へ寄せない)', () => {
    const s = reduce(initialState, { type: 'SET_SCHEDULE_DAY', date: '2026-02-30' }).state;
    expect(s.scheduleDay).toBeNull();
    expect(s.calendarMonth).toBeNull();
  });
});

describe('予定の面の「一覧 / 日」', () => {
  it('🔴 既定は一覧(いままでの見え方)── 日の目盛りは隠れていて、押している側が分かる', () => {
    const { q, qa } = setup({ e1: '- [ ] 打合せ @2026-08-23 14:00\n' });
    expect(q('[data-pkc-region="schedule-day"]')!.hidden, '一覧なのに目盛りが出ている').toBe(true);
    expect(qa('[data-pkc-region="schedule-group"]')).toHaveLength(1);
    const pressed = qa('[data-pkc-action="schedule-mode"]').map((b) => [
      b.textContent,
      b.getAttribute('aria-pressed'),
    ]);
    expect(pressed).toEqual([
      ['一覧', 'true'],
      ['日', 'false'],
    ]);
    // 🔑 「週」は足さない
    expect(qa('[data-pkc-action="schedule-mode"]')).toHaveLength(2);
  });

  it('🔴 「日」を押すと日ごとの束が消えて目盛りが出る / 「一覧」で元へ戻る', () => {
    const { q, qa, showDay, press } = setup({ e1: '- [ ] 打合せ @2026-08-23 14:00\n' });
    showDay();
    expect(q('[data-pkc-region="schedule-day"]')!.hidden).toBe(false);
    expect(qa('[data-pkc-region="schedule-group"]'), '日ごとの束が残っている').toHaveLength(0);
    expect(
      qa('[data-pkc-action="schedule-mode"]').map((b) => b.getAttribute('aria-pressed')),
    ).toEqual(['false', 'true']);
    press('[data-pkc-action="schedule-mode"][data-pkc-mode="list"]');
    expect(q('[data-pkc-region="schedule-day"]')!.hidden).toBe(true);
    expect(qa('[data-pkc-region="schedule-group"]')).toHaveLength(1);
  });

  it('見出しは今日の日付 + 今日', () => {
    const { q, showDay } = setup({ e1: '- [ ] 打合せ @2026-08-23 14:00\n' });
    showDay();
    expect(q('[data-pkc-field="schedule-day-label"]')!.textContent).toBe('8月23日(日) 今日');
  });

  it('🔴 14:00..15:00 の札は 14:00 から 60 分の場所に置かれる(位置は変数で焼く)', () => {
    const { qa, showDay } = setup({ e1: '- [ ] 会議 @2026-08-23 14:00..15:00\n' });
    showDay();
    const cards = qa(lane);
    expect(cards).toHaveLength(1);
    expect(css(cards[0]!, '--day-start')).toBe('840');
    expect(css(cards[0]!, '--day-span')).toBe('60');
    expect(css(cards[0]!, '--day-col')).toBe('0');
    expect(css(cards[0]!, '--day-cols')).toBe('1');
    expect(textOf(cards[0]!)).toBe('会議');
  });

  it('幅のない時刻は 30 分 / 終わりを無視しない(15:30 までなら 90 分)', () => {
    const { qa, showDay } = setup({
      e1: '- [ ] 点 @2026-08-23 09:00\n- [ ] 長い @2026-08-23 10:00..11:30\n',
    });
    showDay();
    const byText = Object.fromEntries(qa(lane).map((c) => [textOf(c), css(c, '--day-span')]));
    expect(byText).toEqual({ 点: '30', 長い: '90' });
  });

  it('🔴 重なる札は横に並び、接しているだけの札は同じ列', () => {
    const { qa, showDay } = setup({
      e1: [
        '- [ ] A @2026-08-23 10:00..11:00',
        '- [ ] B @2026-08-23 10:30..11:30',
        '- [ ] C @2026-08-23 11:30..12:00',
      ].join('\n'),
    });
    showDay();
    const pos = Object.fromEntries(
      qa(lane).map((c) => [textOf(c), `${css(c, '--day-col')}/${css(c, '--day-cols')}`]),
    );
    expect(pos).toEqual({ A: '0/2', B: '1/2', C: '0/1' });
  });

  it('🔴 終日の枠には、時刻なし・期間・ノート 1 件の予定が入り、時刻つきは入らない', () => {
    const { qa, q, showDay } = setup(
      {
        e1: [
          '- [ ] 時刻なし @2026-08-23',
          '- [ ] 出張 @2026-08-22..2026-08-24',
          '- [ ] 会議 @2026-08-23 14:00',
        ].join('\n'),
        e2: '',
      },
      { e2: '2026-08-23' },
    );
    showDay();
    expect(qa(allDay).map(textOf).sort()).toEqual(['出張', '時刻なし', 't-e2'].sort());
    expect(qa(lane).map(textOf)).toEqual(['会議']);
    expect(q('[data-pkc-field="schedule-day-allday"]')!.hidden).toBe(false);
  });

  it('終日の予定が無ければ、終日の枠は出さない', () => {
    const { q, showDay } = setup({ e1: '- [ ] 会議 @2026-08-23 14:00\n' });
    showDay();
    expect(q('[data-pkc-field="schedule-day-allday"]')!.hidden).toBe(true);
  });

  it('🔴 月の升目の日を押すと、「日」ではその日が出る / 一覧では見せ方も日も動かない', () => {
    const { q, qa, d, press, showDay } = setup({
      e1: '- [ ] 今日の用 @2026-08-23 09:00\n- [ ] 木曜の用 @2026-08-27 10:00\n',
    });
    // 一覧のとき: 何も変わらない(束へ送るだけ)
    press('button[data-pkc-action="schedule-pick-day"][data-pkc-drop-date="2026-08-27"]');
    expect(d.getState().scheduleDay).toBeNull();
    expect(d.getState().scheduleMode).toBe('list');
    showDay();
    expect(qa(lane).map(textOf)).toEqual(['今日の用']);
    press('button[data-pkc-action="schedule-pick-day"][data-pkc-drop-date="2026-08-27"]');
    expect(d.getState().scheduleDay).toBe('2026-08-27');
    expect(qa(lane).map(textOf)).toEqual(['木曜の用']);
    expect(q('[data-pkc-field="schedule-day-label"]')!.textContent).toBe('8月27日(木)');
  });

  it('‹ › で前後の日へ / 今日で戻る(いま今日なら押せない)', () => {
    const { q, qa, d, press, showDay } = setup({
      e1: '- [ ] 昨日の用 @2026-08-22 09:00\n- [ ] 明日の用 @2026-08-24 10:00\n',
    });
    showDay();
    expect(q<HTMLButtonElement>('[data-pkc-field="schedule-day-today"]')!.disabled).toBe(true);
    press('[data-pkc-field="schedule-day-next"]');
    expect(d.getState().scheduleDay).toBe('2026-08-24');
    expect(qa(lane).map(textOf)).toEqual(['明日の用']);
    expect(q('[data-pkc-field="schedule-day-label"]')!.textContent).toBe('8月24日(月) 明日');
    press('[data-pkc-field="schedule-day-today"]');
    expect(d.getState().scheduleDay).toBeNull();
    press('[data-pkc-field="schedule-day-prev"]');
    expect(qa(lane).map(textOf)).toEqual(['昨日の用']);
  });

  it('🔴 繰り返しは、窓(62 日)より先の日にも届く', () => {
    const { qa, d, showDay } = setup({ e1: '- [ ] 体操 @2026-08-23 07:00 毎週\n' });
    showDay();
    // 15 週後(105 日後)は同じ曜日 ── 既定の窓の外
    d.dispatch({ type: 'SET_SCHEDULE_DAY', date: '2026-12-06' });
    expect(qa(lane).map(textOf), '先の日に繰り返しが出ない').toEqual(['体操']);
    // 対照群: 曜日が違う日には出ない
    d.dispatch({ type: 'SET_SCHEDULE_DAY', date: '2026-12-07' });
    expect(qa(lane)).toHaveLength(0);
  });

  it('🔴 日の全体が落とし先(日付が入っている)/ 日付なしの札を目盛りへ落とすと、その日になる', async () => {
    const { q, d, store, showDay } = setup({
      e1: '- [ ] 会議 @2026-08-23 14:00\n- [ ] あとで\n',
    });
    d.dispatch({ type: 'TOGGLE_SHOW_UNDATED_TASKS' });
    showDay();
    const dayEl = q('[data-pkc-region="schedule-day"]')!;
    expect(dayEl.getAttribute('data-pkc-drop-date')).toBe('2026-08-23');
    // 日付なしの札は一覧の器に残る(「日付のない項目も出す」が「日」でも効く)
    const undated = q('[data-pkc-region="schedule-group"][data-pkc-drop-date=""] [data-pkc-entry]')!;
    expect(undated).not.toBeNull();
    const data = new Map<string, string>();
    const dt = {
      types: [] as string[],
      setData: (k: string, v: string) => {
        data.set(k, v);
        dt.types = [...data.keys()];
      },
      getData: (k: string) => data.get(k) ?? '',
      effectAllowed: '',
      dropEffect: '',
    };
    const fire = (el: HTMLElement, type: string): void => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: dt });
      el.dispatchEvent(ev);
    };
    fire(undated, 'dragstart');
    // 目盛りの空き(札ではなく地)へ落とす
    const grid = q('[data-pkc-field="schedule-day-grid"]')!;
    fire(grid, 'dragover');
    fire(grid, 'drop');
    await tick(20);
    expect(store['e1'], '落とした日が本文に書かれていない').toBe(
      '- [ ] 会議 @2026-08-23 14:00\n- [ ] あとで @2026-08-23\n',
    );
  });

  it('🔴 最初の位置は、開いたとき・日を変えたときの 1 回だけ(描き直しで奪わない)', () => {
    const { q, d, showDay } = setup({ e1: '- [ ] 会議 @2026-08-23 14:00..15:00\n' });
    const scroller = q('[data-pkc-field="schedule-day-scroll"]')!;
    // happy-dom は配置を持たない ── 見えている箱を装う
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(scroller, 'scrollHeight', { value: 960, configurable: true });
    showDay();
    // 14:00 の 1 時間前 = 13:00 → 960 * 780 / 1440
    expect(scroller.scrollTop).toBe(520);
    scroller.scrollTop = 77;
    d.dispatch({ type: 'TOGGLE_SHOW_DONE_TASKS' });
    expect(scroller.scrollTop, '無関係な描き直しで位置が戻された').toBe(77);
    // 日を変えたら、その日の最初の位置へ(予定の無い日は 8:00)
    d.dispatch({ type: 'SET_SCHEDULE_DAY', date: '2026-08-24' });
    expect(scroller.scrollTop).toBe(320);
  });
});
