/** @vitest-environment happy-dom */
/**
 * 予定の面の描き直しの門(#1087)── **字が変わらない保存では組み直さない**。
 *
 * 保存の ack は `entryMetas` を必ず新しい Map に差し替える(`updatedAt` が動く)。参照で比べると
 * 毎回 `scheduleItemsOf` と DOM の組み直しが走る(3,000 件で約 39 ms)ので、門は
 * **この面が読む列だけの指紋**(`ScheduleRenderer.metaSignature`)で比べる。
 *
 * 🔑 観測点: 面の注記(`schedule-note`)に目印の字を書き、**組み直しが走れば上書きされる**ことを使う
 * (組み直す側は必ず注記を書き直す ── 対照群の test が、書き直しが実際に起きることを見る)。
 * ⚠ 指紋の列を 1 つずつ外す変異で、対応する test が落ちること(`it` の題名 = 列)。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { ScheduleRenderer } from '../../src/adapter/ui/render/schedule';
import { taskCardsOf } from '../../src/features/schedule/task-cards';

const TODAY = new Date(2026, 7, 23);
const MARK = 'ここは組み直されていない';

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

function setup(narrow: boolean) {
  const host = document.createElement('div');
  if (narrow) host.setAttribute('data-pkc-browse-pane', 'schedule');
  document.body.append(host);
  const view = new ScheduleRenderer(host, () => TODAY);
  const metas = new Map<string, EntryMeta>([
    ['e1', meta('e1')],
    ['e2', meta('e2', { date: '2026-08-25' })],
    ['e3', meta('e3')],
  ]);
  const cards = taskCardsOf('e1', '- [ ] 牛乳 @2026-08-24\n');
  const state = {
    ...initialState,
    entryMetas: metas,
    order: ['e1', 'e2', 'e3'],
    taskScan: { cards, totalNotes: 1, scannedNotes: 1, truncated: false },
  } as AppState;
  view.render(state);
  const note = host.querySelector<HTMLElement>('[data-pkc-field="schedule-note"]')!;
  expect(note).not.toBeNull();
  /** 注記に目印を書く。組み直されれば消える。 */
  const arm = (): void => {
    note.textContent = MARK;
  };
  const rebuilt = (): boolean => note.textContent !== MARK;
  /** 1 件だけ差し替えた新しい Map で描く(= 保存の ack と同じ形)。 */
  const renderWith = (lid: string, over: Partial<EntryMeta>, extra: Partial<AppState> = {}): void => {
    const next = new Map(state.entryMetas);
    next.set(lid, { ...next.get(lid)!, ...over });
    Object.assign(state, { entryMetas: next }, extra);
    view.render({ ...state });
  };
  const renderAll = (entryMetas: Map<string, EntryMeta>, order: string[]): void => {
    Object.assign(state, { entryMetas, order });
    view.render({ ...state });
  };
  return { state, arm, rebuilt, renderWith, renderAll };
}

describe.each([
  ['左の列(狭い面)', true],
  ['中央(広い面)', false],
])('予定の面の門 — %s', (_name, narrow) => {
  it('対照群: 目印は組み直しで消える(同じ参照の再描画では消えない)', () => {
    const t = setup(narrow);
    t.arm();
    t.renderWith('e1', {});
    // 参照だけ新しい・中身は同じ → 組み直さない
    expect(t.rebuilt()).toBe(false);
    t.renderWith('e1', { title: '別の題' });
    expect(t.rebuilt()).toBe(true);
  });

  it('updatedAt だけ変わる保存の ack では組み直さない', () => {
    const t = setup(narrow);
    t.arm();
    t.renderWith('e1', { updatedAt: '2026-10-13T00:00:00Z' });
    expect(t.rebuilt()).toBe(false);
  });

  it('予定の面が読まない列(createdAt / status / entryOrder / bodyChars)でも組み直さない', () => {
    const t = setup(narrow);
    t.arm();
    t.renderWith('e1', { createdAt: '2025-01-01T00:00:00Z', status: 'done', entryOrder: 99, bodyChars: 12345 });
    expect(t.rebuilt()).toBe(false);
  });

  it('title が変わると組み直す', () => {
    const t = setup(narrow);
    t.arm();
    t.renderWith('e2', { title: '名前を変えた' });
    expect(t.rebuilt()).toBe(true);
  });

  it('date が変わると組み直す', () => {
    const t = setup(narrow);
    t.arm();
    t.renderWith('e2', { date: '2026-08-26' });
    expect(t.rebuilt()).toBe(true);
  });

  it('archived が変わると組み直す', () => {
    const t = setup(narrow);
    t.arm();
    t.renderWith('e2', { archived: true });
    expect(t.rebuilt()).toBe(true);
  });

  it('archetype が変わると組み直す(種類の絞りが読む)', () => {
    const t = setup(narrow);
    t.state.kindFilter = new Set(['text']);
    t.renderWith('e3', {}); // 絞りを入れた版を一度描いて基準にする
    t.arm();
    t.renderWith('e2', { archetype: 'todo' });
    expect(t.rebuilt()).toBe(true);
  });

  it('lid だけが入れ替わる(題名・日付などは同じ)と組み直す', () => {
    const t = setup(narrow);
    t.arm();
    const next = new Map(t.state.entryMetas);
    const e3 = next.get('e3')!;
    next.delete('e3');
    next.set('e4', { ...e3, lid: 'e4' });
    // ⚠ order は同じ参照のまま渡す(order の門に救わせない)
    t.renderAll(next, t.state.order as string[]);
    expect(t.rebuilt()).toBe(true);
  });

  it('並び(state.order)だけが変わっても組み直す(ノート丸ごとの予定の並びが読む)', () => {
    const t = setup(narrow);
    t.arm();
    t.renderAll(new Map(t.state.entryMetas), ['e3', 'e2', 'e1']);
    expect(t.rebuilt()).toBe(true);
  });
});
