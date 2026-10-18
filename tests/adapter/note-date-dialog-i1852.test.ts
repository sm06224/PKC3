/** @vitest-environment happy-dom */
/**
 * 🔴 **ノートの日付ダイアログは、前書きの現在値(日付・時刻)で開く**(台帳 #1852 B 指摘 2)。
 *
 * 直す前は時刻欄が空で開き、`date: 2026-10-20 14:00` のノートで日付だけ変えて OK すると
 * `time: null` が撃たれ、時刻が黙って消えた。観測点は実物の binder + 実物のダイアログ + 実際に書かれる本文。
 * ① 日付だけ変えて OK → 時刻が残る ② 時刻を入れて OK → `date: … HH:MM` ③ 時刻を消して OK → 時刻が外れる
 * ④ 対照群: 時刻の無いノートは空で開き、日付だけが書かれる
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { DomainEvent } from '../../src/adapter/state/app-state';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { noteTimeOf } from '../../src/features/schedule/task-cards';

const meta = (date: string | null): never =>
  ({ lid: 'n1', title: 'n1', archetype: 'text', created_at: null, updated_at: null, entry_order: 1, status: null, date, archived: 0 }) as never;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function rig(body: string) {
  resetAppDialogForTest();
  document.body.textContent = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const events: DomainEvent[] = [];
  d.onEvent((e) => events.push(e));
  bindActions(root, d, {
    showStatus: () => {},
    acquireEditLock: vi.fn(async () => 'granted' as const),
    releaseEditLock: vi.fn(),
  });
  const date = /^date:\s*"?(\d{4}-\d{2}-\d{2})/m.exec(body)?.[1] ?? null;
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta(date)], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  const nt = noteTimeOf('n1', body);
  d.dispatch({
    type: 'SET_TASK_SCAN',
    scan: { cards: [], totalNotes: 1, scannedNotes: 1, truncated: false, ...(nt === null ? {} : { noteTimes: [nt] }) },
  });
  events.length = 0;
  const field = (n: string): HTMLInputElement => document.querySelector<HTMLInputElement>(`[data-pkc-field="${n}"]`)!;
  /** 窓を開き、`edit` で欄を触って OK を押し、撃たれた書換を本文に当てた結果を返す。 */
  const run = async (edit: (f: typeof field) => void): Promise<{ after: string; opened: { date: string; time: string } }> => {
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'set-entry-date');
    root.append(b);
    b.click();
    await flush();
    const opened = { date: field('pick-date').value, time: field('pick-time').value };
    edit(field);
    document.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-ok"]')!.click();
    await flush();
    const rw = events.find((e) => e.type === 'REQUEST_BODY_REWRITE') as
      | { rewrite: Parameters<typeof applyBodyRewrite>[1] }
      | undefined;
    return { after: rw === undefined ? body : (applyBodyRewrite(body, rw.rewrite) ?? body), opened };
  };
  return { run };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 18, 9, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
  resetAppDialogForTest();
  document.body.innerHTML = '';
});

const TIMED = '---\ndate: 2026-10-20 14:00\n---\n本文';

describe('ノートの日付ダイアログ(set-entry-date)の初期値', () => {
  it('🔴 ① 日付だけ変えて OK → 時刻は残る(現在の日付・時刻で開く)', async () => {
    const t = rig(TIMED);
    const out = await t.run((f) => {
      f('pick-date').value = '2026-10-23';
    });
    expect(out.opened).toEqual({ date: '2026-10-20', time: '14:00' });
    expect(noteTimeOf('n1', out.after)).toEqual({ lid: 'n1', date: '2026-10-23', time: '14:00' });
  });

  it('🔴 ② 時刻を入れて OK → `date: … HH:MM` が書かれる', async () => {
    const t = rig(TIMED);
    const out = await t.run((f) => {
      f('pick-time').value = '16:45';
    });
    expect(noteTimeOf('n1', out.after)).toEqual({ lid: 'n1', date: '2026-10-20', time: '16:45' });
  });

  it('🔴 ③ 時刻を消して OK → 時刻が外れる', async () => {
    const t = rig(TIMED);
    const out = await t.run((f) => {
      f('pick-time').value = '';
    });
    expect(out.after).not.toBe(TIMED);
    expect(noteTimeOf('n1', out.after)).toBeNull();
    expect(out.after).toContain('2026-10-20');
  });

  it('対照群: 時刻の無いノートは時刻が空で開き、日付だけが書かれる', async () => {
    const t = rig('---\ndate: 2026-10-20\n---\n本文');
    const out = await t.run((f) => {
      f('pick-date').value = '2026-10-21';
    });
    expect(out.opened).toEqual({ date: '2026-10-20', time: '' });
    expect(out.after).toContain('2026-10-21');
    expect(noteTimeOf('n1', out.after)).toBeNull();
  });

  it('対照群: 日付の無いノートは今日で開く', async () => {
    const t = rig('本文');
    const out = await t.run(() => {});
    expect(out.opened.date).toBe('2026-10-18');
  });
});
