/** @vitest-environment happy-dom */
/**
 * 🔴 **予定の面の「月」と「印刷」**(#855。Gemini 裁定 = #1163 の依頼 30 の Q1 / Q2)。
 *
 * 升に出す件数の規則は `tests/features/month-cells.test.ts`。ここが見るのは繋がり:
 * ① 「月」を押すと大きな升目が出る(広い面だけ。左の列には「月」が無い)
 * ② 升に題名が 3 件まで・4 件目からは「ほか N 件」/ 押すとその日の「日」へ
 * ③ 「印刷」は見えている範囲に印を付けて印刷を呼ぶ(紙が済んだら外す)
 * 実際の紙の組み(範囲の外が落ちること)は実ブラウザでしか言えない ── `tests/smoke/schedule.smoke.spec.ts`。
 */
import { stubStamps } from '../helpers/store-stamps';
import { describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { ScheduleRenderer } from '../../src/adapter/ui/render/schedule';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';
import { taskCardsOf } from '../../src/features/schedule/task-cards';

const TODAY = new Date(2026, 7, 23); // 2026-08-23(日)

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

function setup(bodies: Record<string, string>, wide = true, services: BinderServices = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const store: Record<string, string> = { ...bodies };
  const host = document.createElement('div');
  host.setAttribute(wide ? 'data-pkc-view-pane' : 'data-pkc-browse-pane', 'schedule');
  regions.browseHost.append(host);
  const view = new ScheduleRenderer(host, () => TODAY);
  d.onState((s) => view.render(s));
  bindActions(root, d, services);
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
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: Object.keys(bodies).map((lid) => meta(lid)), relations: [] });
  const cards = Object.entries(bodies).flatMap(([lid, body]) => taskCardsOf(lid, body));
  d.dispatch({ type: 'SET_TASK_SCAN', scan: { cards, totalNotes: 1, scannedNotes: 1, truncated: false } });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const qa = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
  const press = (sel: string): void => {
    const el = q(sel);
    if (el === null) throw new Error(`押す物が無い: ${sel}`);
    el.click();
  };
  const showMonth = (): void => press('[data-pkc-action="schedule-mode"][data-pkc-mode="month"]');
  return { root, d, q, qa, press, showMonth };
}

const cell = (qa: (s: string) => HTMLElement[], day: string): HTMLElement =>
  qa('[data-pkc-field="schedule-monthview-cell"]').find((c) => c.getAttribute('data-pkc-drop-date') === day)!;

const BODY =
  '- [ ] 朝会 @2026-08-25 09:00\n- [ ] 昼会 @2026-08-25 12:00\n- [ ] 夕会 @2026-08-25 17:00\n- [ ] 夜会 @2026-08-25 20:00\n- [ ] 深夜会 @2026-08-25 23:00\n- [ ] ひとり @2026-08-26\n';

describe('広い面の「月」', () => {
  it('「月」を押すまで大きな升目は出ない / 押すと出て、日・週の器と一覧の束は隠れる', () => {
    const { q, showMonth } = setup({ e1: BODY });
    expect(q('[data-pkc-region="schedule-monthview"]')!.hidden, '押す前に月が出ている').toBe(true);
    showMonth();
    expect(q('[data-pkc-region="schedule-monthview"]')!.hidden).toBe(false);
    expect(q('[data-pkc-region="schedule-day"]')!.hidden).toBe(true);
    expect(q('[data-pkc-region="schedule-weekview"]')!.hidden).toBe(true);
    expect(q('[data-pkc-region="schedule-group"]'), '一覧の束が残っている').toBeNull();
    expect(q('[data-pkc-field="schedule-monthview-label"]')!.textContent).toBe('2026年8月');
  });

  it('🔴 8 月は 31 日ぶんの升があり、それぞれが自分の日を落とし先に持つ / 今日だけ印', () => {
    const { qa, showMonth } = setup({ e1: BODY });
    showMonth();
    const days = qa('[data-pkc-field="schedule-monthview-cell"]').map((c) => c.getAttribute('data-pkc-drop-date'));
    expect(days).toHaveLength(31);
    expect(days[0]).toBe('2026-08-01');
    expect(days[30]).toBe('2026-08-31');
    expect(
      qa('[data-pkc-field="schedule-monthview-cell"]')
        .filter((c) => c.hasAttribute('data-pkc-today'))
        .map((c) => c.getAttribute('data-pkc-drop-date')),
    ).toEqual(['2026-08-23']);
    // 月外の空き枠は落とせない
    for (const b of qa('[data-pkc-field="schedule-monthview-blank"]'))
      expect(b.hasAttribute('data-pkc-drop-date')).toBe(false);
  });

  it('🔴 1 日に 5 件 ── 題名は 3 件まで・「ほか 2 件」/ 1 件の日には「ほか」が出ない', () => {
    const { qa, showMonth } = setup({ e1: BODY });
    showMonth();
    const busy = cell(qa, '2026-08-25');
    const titles = [...busy.querySelectorAll('[data-pkc-entry] [data-pkc-field="text"]')].map((e) => e.textContent);
    expect(titles).toEqual(['朝会', '昼会', '夕会']);
    const more = busy.querySelector<HTMLElement>('[data-pkc-field="schedule-monthview-more"]')!;
    expect(more.hidden).toBe(false);
    expect(more.textContent).toBe('ほか 2 件');
    const single = cell(qa, '2026-08-26');
    expect(single.querySelectorAll('[data-pkc-entry]')).toHaveLength(1);
    expect(single.querySelector<HTMLElement>('[data-pkc-field="schedule-monthview-more"]')!.hidden).toBe(true);
  });

  it('🔴 札は一覧と同じ札: 縦線の色が付き、押すとそのノートを選ぶ口を持つ', () => {
    const { qa, showMonth } = setup({ e1: BODY });
    showMonth();
    const card = cell(qa, '2026-08-26').querySelector<HTMLElement>('[data-pkc-entry]')!;
    expect(card.getAttribute('data-pkc-action')).toBe('select-entry');
    expect(card.getAttribute('data-pkc-entry')).toBe('e1');
    expect(card.getAttribute('data-pkc-item-color')).toBe('note');
    expect(card.parentElement!.getAttribute('data-pkc-region')).toBe('schedule-cards');
  });

  it('🔴 「ほか N 件」を押すと、その日の「日」へ移る(月は離れる)', () => {
    const { d, q, qa, showMonth, press } = setup({ e1: BODY });
    showMonth();
    cell(qa, '2026-08-25').querySelector<HTMLElement>('[data-pkc-field="schedule-monthview-more"]')!.click();
    expect(d.getState().scheduleMode).toBe('day');
    expect(d.getState().scheduleDay).toBe('2026-08-25');
    expect(q('[data-pkc-region="schedule-monthview"]')!.hidden).toBe(true);
    expect(q('[data-pkc-region="schedule-day"]')!.hidden).toBe(false);
    void press;
  });

  it('日付の数字を押しても、その日の「日」へ移る / 今日の数字は「今日に追従」(空)で渡す', () => {
    const { d, qa, showMonth } = setup({ e1: BODY });
    showMonth();
    expect(cell(qa, '2026-08-23').querySelector('[data-pkc-field="schedule-monthview-num"]')!.getAttribute('data-pkc-day-to')).toBe('');
    cell(qa, '2026-08-26').querySelector<HTMLElement>('[data-pkc-field="schedule-monthview-num"]')!.click();
    expect(d.getState().scheduleMode).toBe('day');
    expect(d.getState().scheduleDay).toBe('2026-08-26');
  });

  it('‹ › で月が替わる(小さな月と同じ口)', () => {
    const { q, qa, showMonth } = setup({ e1: BODY });
    showMonth();
    q('[data-pkc-field="schedule-monthview-head"] [data-pkc-nav-step="1"]')!.click();
    expect(q('[data-pkc-field="schedule-monthview-label"]')!.textContent).toBe('2026年9月');
    expect(qa('[data-pkc-field="schedule-monthview-cell"]')).toHaveLength(30);
  });

  it('🔴 小さな月の日を押しても、「月」のままでは何も起きない道にしない ── その日の「日」へ移る', () => {
    const { d, q, showMonth } = setup({ e1: BODY });
    showMonth();
    q('[data-pkc-field="schedule-grid"] [data-pkc-drop-date="2026-08-27"]')!.click();
    expect(d.getState().scheduleMode).toBe('day');
    expect(d.getState().scheduleDay).toBe('2026-08-27');
  });

  it('🔴 左の列の「月」は、見せ方を変えずに別のウィンドウで開く(「週」と同じ作り)/ 広い面では見せ方が変わる', () => {
    const opened: [string, string | null][] = [];
    const narrow = setup({ e1: BODY }, false, { openScheduleWindow: (m, day) => void opened.push([m, day]) });
    expect(narrow.qa('[data-pkc-action="schedule-mode"]').map((b) => b.textContent)).toEqual(['一覧', '日', '週', '月']);
    narrow.press('[data-pkc-action="schedule-mode"][data-pkc-mode="month"]');
    expect(opened).toEqual([['month', null]]);
    expect(narrow.d.getState().scheduleMode, '左の列の「月」が中央の見せ方を変えた').toBe('list');
    expect(narrow.d.getState().scheduleNarrowMode).toBe('list');
    // 対照群: 広い面では窓を開かず、その場で「月」になる
    const wide = setup({ e1: BODY }, true, { openScheduleWindow: (m, day) => void opened.push([m, day]) });
    wide.showMonth();
    expect(opened, '広い面の「月」が窓を開いた').toHaveLength(1);
    expect(wide.d.getState().scheduleMode).toBe('month');
  });
});

describe('「印刷」', () => {
  function withPrint<T>(fn: (seen: { attr: string | null; ranges: string[] }[]) => T): T {
    const seen: { attr: string | null; ranges: string[] }[] = [];
    // ⚠ happy-dom に `window.print` は無い(spyOn できない)── 直に差して、終わったら外す
    const w = window as unknown as { print?: () => void };
    const before = w.print;
    w.print = vi.fn(() => {
      seen.push({
        attr: document.documentElement.getAttribute('data-pkc-print'),
        ranges: [...document.querySelectorAll('[data-pkc-print-range]')].map(
          (e) => e.getAttribute('data-pkc-region') ?? '',
        ),
      });
    });
    try {
      return fn(seen);
    } finally {
      if (before === undefined) delete w.print;
      else w.print = before;
      document.documentElement.removeAttribute('data-pkc-print');
    }
  }

  it('🔴 見せ方ごとに範囲が変わる: 一覧 → 日ごとの一覧 / 日 → 日 / 週 → 週 / 月 → 月(印刷が呼ばれた瞬間に印が付いている)', () => {
    withPrint((seen) => {
      const { q, press, showMonth } = setup({ e1: BODY });
      const printNow = (): void => {
        press('[data-pkc-action="schedule-print"]');
        window.dispatchEvent(new Event('afterprint'));
      };
      printNow();
      press('[data-pkc-action="schedule-mode"][data-pkc-mode="day"]');
      printNow();
      press('[data-pkc-action="schedule-mode"][data-pkc-mode="week"]');
      printNow();
      showMonth();
      printNow();
      expect(seen.map((s) => s.attr)).toEqual(['schedule', 'schedule', 'schedule', 'schedule']);
      expect(seen.map((s) => s.ranges)).toEqual([
        ['schedule-groups'],
        ['schedule-day'],
        ['schedule-weekview'],
        ['schedule-monthview'],
      ]);
      void q;
    });
  });

  it('🔴 紙が済んだら印を外す(外さないと、次にノートを刷ったとき予定表が出る)', () => {
    withPrint(() => {
      const { press, showMonth } = setup({ e1: BODY });
      showMonth();
      press('[data-pkc-action="schedule-print"]');
      expect(document.documentElement.getAttribute('data-pkc-print')).toBe('schedule');
      window.dispatchEvent(new Event('afterprint'));
      expect(document.documentElement.hasAttribute('data-pkc-print')).toBe(false);
      expect(document.querySelector('[data-pkc-print-range]')).toBeNull();
    });
  });

  it('ボタンは上の帯にあり、字は「印刷」', () => {
    const { q } = setup({ e1: BODY });
    const b = q('[data-pkc-field="schedule-toolbar"] [data-pkc-action="schedule-print"]')!;
    expect(b.textContent).toBe('印刷');
  });
});
