/** @vitest-environment happy-dom */
/**
 * #1635 の残り 3 項(Gemini 裁定 = #1163 の依頼 36「2-B / 3-A / 4-A」)。
 *
 * - 項 2: 予定の欄の日付を押すと、本文に日付を入れるときと同じ近道つきの選び方が開く
 * - 項 3: 左の一覧の「更新」は、今日の更新だけ「今日」と出る(昨日より前は `月/日` のまま)
 * - 項 4: 並び順に「作成が新しい順」が在り、作った時刻で並ぶ
 *
 * ⚠ 日付は「今日」を test の中で作る(固定の日付だと、日をまたいだ日に落ちる)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { DualFilerRenderer } from '../../src/adapter/ui/render/dual-filer';
import { ScheduleRenderer } from '../../src/adapter/ui/render/schedule';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { formatListUpdated, listDayStamp } from '../../src/features/datetime/stored-date';
import { sortOrder, ENTRY_SORTS } from '../../src/features/filter/entry-sort';

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
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
    ...over,
  };
}

/** sqlite の `datetime('now')` と同じ形(UTC)。 */
const utc = (d: Date): string => d.toISOString().replace('T', ' ').slice(0, 19);
const NOW = new Date();
const TODAY_AT = utc(NOW);
const OLD = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 3, 12, 0, 0);
const pad = (n: number): string => String(n).padStart(2, '0');

beforeEach(() => {
  document.body.textContent = '';
});

describe('項 3: 一覧の更新に「今日」', () => {
  const stamp = listDayStamp(NOW);

  it('今日の更新は「今日」、昨日より前は 月/日 のまま', () => {
    expect(formatListUpdated(TODAY_AT, stamp)).toBe('今日');
    const yesterday = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1, 12, 0, 0);
    expect(formatListUpdated(utc(yesterday), stamp), '昨日まで「今日」と出ている').toBe(
      `${pad(yesterday.getMonth() + 1)}/${pad(yesterday.getDate())}`,
    );
  });

  it('日付だけの値でも「今日」と読める / 空は空のまま', () => {
    const d = `${NOW.getFullYear()}-${pad(NOW.getMonth() + 1)}-${pad(NOW.getDate())}`;
    expect(formatListUpdated(d, stamp)).toBe('今日');
    expect(formatListUpdated(null, stamp)).toBe('');
  });

  it('去年の同じ月日を「今日」と読まない', () => {
    const last = `${NOW.getFullYear() - 1}-${pad(NOW.getMonth() + 1)}-${pad(NOW.getDate())}`;
    expect(formatListUpdated(last, stamp)).toBe(
      `${NOW.getFullYear() - 1}/${pad(NOW.getMonth() + 1)}/${pad(NOW.getDate())}`,
    );
  });

  const METAS = [
    meta('a', { entryOrder: 1, updatedAt: TODAY_AT }),
    meta('b', { entryOrder: 2, updatedAt: utc(OLD) }),
  ];
  const booted = (): AppState =>
    reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: METAS,
      relations: [] as Relation[],
    }).state;

  it('🔴 平らな一覧の更新の列に出る(今日の行だけ)/ 行に指を置くと日付が読める', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
    browse.render(booted(), 'filer');
    const cell = (lid: string) =>
      root.querySelector<HTMLElement>(
        `tbody [data-pkc-entry="${lid}"] [data-pkc-field="updated"]`,
      )!;
    expect(cell('a').textContent).toBe('今日');
    expect(cell('b').textContent, '今日でない行が「今日」と出た').not.toBe('今日');
    expect(cell('a').title, '「今日」でも日付が読めること').toMatch(/^更新 \d{4}\/\d{2}\/\d{2}$/);
  });

  it('🔴 2 ペインの更新の列にも出る(対称の反対側)', () => {
    const region = document.createElement('div');
    document.body.append(region);
    const r = new DualFilerRenderer(region);
    r.render(booted());
    const cell = (lid: string) =>
      region.querySelector<HTMLElement>(
        `[data-pkc-region="dual-pane"][data-pkc-side="left"] tbody [data-pkc-entry="${lid}"] [data-pkc-field="dual-updated"]`,
      )!;
    expect(cell('a').textContent).toBe('今日');
    expect(cell('b').textContent).not.toBe('今日');
    expect(cell('a').title).toMatch(/^更新 \d{4}\/\d{2}\/\d{2}$/);
  });
});

describe('項 4: 作成が新しい順', () => {
  const metas = new Map<string, EntryMeta>([
    ['old', meta('old', { createdAt: '2026-01-01 00:00:00', updatedAt: '2026-10-01 00:00:00' })],
    ['new', meta('new', { createdAt: '2026-09-01 00:00:00', updatedAt: '2026-02-01 00:00:00' })],
    ['none', meta('none', { createdAt: null, updatedAt: '2026-12-01 00:00:00' })],
  ]);
  const by = (sort: 'created' | 'updated', desc: boolean) =>
    sortOrder(['old', 'new', 'none'], (l) => metas.get(l), sort, desc, () => 0);

  it('🔴 作った時刻の新しい順(更新の順とは別)/ 作成日の無いノートは最後', () => {
    expect(by('created', true)).toEqual(['new', 'old', 'none']);
    // 対照群: 更新順なら並びが違う(作成と更新を取り違えていない)
    expect(by('updated', true)).toEqual(['none', 'old', 'new']);
    expect(by('created', false)).toEqual(['none', 'old', 'new']);
  });

  it('選べる並びに入っていて、新しい順から始まる', () => {
    expect(ENTRY_SORTS).toContain('created');
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    const opts = [
      ...root.querySelectorAll<HTMLOptionElement>('[data-pkc-field="entry-sort"] option'),
    ];
    expect(opts.find((o) => o.value === 'created')?.textContent).toBe('作成が新しい順');
    const s = reduce(initialState, { type: 'SET_ENTRY_SORT', sort: 'created' }).state;
    expect(s.entrySortDesc, '作成順が古い順から始まっている').toBe(true);
  });
});

describe('項 2: 予定の欄の日付を押すと近道つきの選び方が開く', () => {
  function setup() {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    buildShell(root);
    const host = document.createElement('div');
    root.append(host);
    const sched = new ScheduleRenderer(host, () => new Date(2026, 9, 17, 10, 0, 0));
    d.onState((s) => sched.render(s));
    bindActions(root, d, {});
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    const dateEl = () =>
      root.querySelector<HTMLInputElement>('[data-pkc-field="schedule-quick-date"]')!;
    return { root, dateEl };
  }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
  const pickDate = (): HTMLInputElement =>
    document.querySelector<HTMLInputElement>('[data-pkc-field="pick-date"]')!;
  const okBtn = (): HTMLButtonElement =>
    document.querySelector<HTMLButtonElement>('dialog [data-pkc-field="dialog-ok"]')!;
  const cancelBtn = (): HTMLButtonElement =>
    document.querySelector<HTMLButtonElement>('dialog [data-pkc-field="dialog-cancel"]')!;

  it('🔴 押すと 今日 / 明日 / 今週末 / 来週 が出て、「明日」→ 入れる で欄に入る(時刻の欄は出ない)', async () => {
    const { dateEl } = setup();
    expect(dateEl().getAttribute('data-pkc-action'), '押し口が付いていない').toBe(
      'schedule-pick-date',
    );
    dateEl().click();
    await tick();
    const shortcuts = [...document.querySelectorAll('[data-pkc-field="pick-shortcut"]')].map(
      (b) => b.textContent,
    );
    expect(shortcuts).toEqual(['今日', '明日', '今週末', '来週']);
    expect(
      document.querySelector('[data-pkc-field="pick-time"]'),
      '予定の欄に時刻は書けない',
    ).toBeNull();
    // 開いた時点の日付は、欄の値(最初は今日)
    expect(pickDate().value).not.toBe('');
    const before = dateEl().value;
    document.querySelector<HTMLElement>('[data-pkc-shortcut="tomorrow"]')!.click();
    okBtn().click();
    await tick();
    expect(dateEl().value, '「明日」を選んだのに欄が変わらない').not.toBe(before);
    expect(dateEl().value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('やめたら欄は変わらない / 日付を空にして入れると欄も空(日付なしで足す道)', async () => {
    const { dateEl } = setup();
    const before = dateEl().value;
    dateEl().click();
    await tick();
    cancelBtn().click();
    await tick();
    expect(dateEl().value, 'やめたのに欄が変わった').toBe(before);

    dateEl().click();
    await tick();
    pickDate().value = '';
    okBtn().click();
    await tick();
    expect(dateEl().value, '空にして入れたのに欄が空にならない').toBe('');

    // 空の欄から開いても、開いただけで今日が入らない
    dateEl().click();
    await tick();
    expect(pickDate().value).toBe('');
    cancelBtn().click();
    await tick();
  });
});
