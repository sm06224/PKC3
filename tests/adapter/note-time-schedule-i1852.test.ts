/** @vitest-environment happy-dom */
/**
 * 🔴 **前書きの `date: 2026-10-20 14:00` の時刻が、予定表に出て、動かしても残り、元に戻せる**
 * (台帳 #1852 / 依頼 192 / 284。Gemini 回答 = 時刻も読む)。
 *
 * 規則そのもの(読み方・書き換え)は `tests/features/note-time-i1852.test.ts`。ここは配線を見る:
 * ① 走査の時刻が予定の 1 件の時刻になる(食い違う組は使わない)② 本文が入ると走査の時刻も引き直される
 * ③ 日へ落としても時刻が残り、「元に戻す」で元の字へ戻る ④ 時間の目盛りの上で動かすと日と時刻が替わる(終わりは書けない)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { noteTimeOf } from '../../src/features/schedule/task-cards';
import { dropTaskCard } from '../../src/adapter/ui/render/schedule-drag';
import { clearMoveOffer, undoScheduleMove } from '../../src/adapter/ui/render/schedule-undo';
import { scheduleItemsOf } from '../../src/adapter/ui/render/schedule-items';
import { initialState, reduce, type AppState, type UserAction } from '../../src/adapter/state/app-state';
import type { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const meta = (over: Partial<EntryMeta> = {}): EntryMeta => ({
  lid: 'a',
  title: '歯医者',
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
  ...over,
});

const ORIGINAL = '---\ndate: 2026-10-20 14:00\n---\n本文';

function rig(initialBody: string) {
  let body = initialBody;
  const dateOf = (b: string): string | null => /^date:\s*"?(\d{4}-\d{2}-\d{2})/m.exec(b)?.[1] ?? null;
  const scan = (): NonNullable<AppState['taskScan']> => {
    const nt = noteTimeOf('a', body);
    return { cards: [], totalNotes: 1, scannedNotes: 1, truncated: false, ...(nt === null ? {} : { noteTimes: [nt] }) };
  };
  let state: AppState = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta({ date: dateOf(body) })],
    relations: [],
  }).state;
  state = { ...state, taskScan: scan() };
  const listeners: Array<() => void> = [];
  const dispatcher = {
    getState: () => state,
    onState: (l: () => void) => {
      listeners.push(l);
      return () => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    dispatch: (action: UserAction) => {
      const r = reduce(state, action);
      state = r.state;
      for (const ev of r.events) {
        if (ev.type !== 'REQUEST_BODY_REWRITE') continue;
        body = applyBodyRewrite(body, ev.rewrite) ?? body;
        state = {
          ...state,
          taskScan: scan(),
          entryMetas: new Map(state.entryMetas).set('a', meta({ date: dateOf(body) })),
        };
      }
      for (const l of [...listeners]) l();
    },
  } as unknown as Dispatcher;
  const root = document.createElement('div');
  document.body.append(root);
  return { root, dispatcher, state: () => state, body: () => body };
}

beforeEach(() => {
  vi.useFakeTimers();
  clearMoveOffer();
});
afterEach(() => {
  clearMoveOffer();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('予定の 1 件の時刻(scheduleItemsOf)', () => {
  it('🔴 走査が運んだ時刻が、ノート 1 件の予定の時刻になる', () => {
    const r = rig(ORIGINAL);
    const item = scheduleItemsOf(r.state()).notes[0]!;
    expect([item.date, item.time, item.line]).toEqual(['2026-10-20', '14:00', null]);
  });

  it('対照群: 時刻の無いノートは終日。日付が食い違う組(日付だけ書き換わった)は使わない', () => {
    const plain = rig('---\ndate: 2026-10-20\n---\n本文');
    expect(scheduleItemsOf(plain.state()).notes[0]!.time).toBeNull();
    const r = rig(ORIGINAL);
    const stale = {
      ...r.state(),
      entryMetas: new Map(r.state().entryMetas).set('a', meta({ date: '2026-10-21' })),
    };
    expect(scheduleItemsOf(stale).notes[0]!.time, '古い時刻を新しい日付に付けた').toBeNull();
  });
});

describe('本文が入ると、走査の時刻も引き直される', () => {
  it('🔴 BODY_LOADED で時刻が替わる / 外れる。変わらない回は走査の参照を保つ', () => {
    const r = rig(ORIGINAL);
    r.dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    const first = r.state().taskScan;
    r.dispatcher.dispatch({ type: 'BODY_LOADED', lid: 'a', body: ORIGINAL });
    expect(r.state().taskScan, '同じ本文なのに走査を作り直した').toBe(first);
    r.dispatcher.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '---\ndate: 2026-10-20 16:45\n---\n本文' });
    expect(r.state().taskScan?.noteTimes).toEqual([{ lid: 'a', date: '2026-10-20', time: '16:45' }]);
    r.dispatcher.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '---\ndate: 2026-10-20\n---\n本文' });
    expect(r.state().taskScan?.noteTimes).toEqual([]);
  });
});

describe('日へ落とす・元に戻す', () => {
  const drop = (r: ReturnType<typeof rig>, to: string): void =>
    dropTaskCard(r.dispatcher, { lid: 'a', line: '', from: '2026-10-20', repeat: '' }, to, r.root);

  it('🔴 別の日へ落とすと日だけ替わり、時刻は残る。知らせにも時刻が出て、元に戻すと元の字へ戻る', () => {
    const r = rig(ORIGINAL);
    drop(r, '2026-10-23');
    expect(r.body()).toContain('"2026-10-23 14:00"');
    expect(r.state().notice).toBe('10/23(金) 14:00 へ動かしました');
    const undo = undoScheduleMove(r.state()) as { action: UserAction };
    expect(undo.action).toEqual({ type: 'SET_ENTRY_DATE', lid: 'a', date: '2026-10-20', time: '14:00' });
    r.dispatcher.dispatch(undo.action);
    // 戻した字は日付・時刻が元と同じ(引用符の有無だけが違う ── 前書きとして読んだ値は同じ)
    expect(noteTimeOf('a', r.body())).toEqual({ lid: 'a', date: '2026-10-20', time: '14:00' });
  });

  it('日付なしへ外すと日付ごと(時刻も)消え、元に戻すと日付も時刻も戻る', () => {
    const r = rig(ORIGINAL);
    drop(r, '');
    expect(r.body()).not.toContain('date:');
    const undo = undoScheduleMove(r.state()) as { action: UserAction };
    expect(undo.action).toEqual({ type: 'SET_ENTRY_DATE', lid: 'a', date: '2026-10-20', time: '14:00' });
    r.dispatcher.dispatch(undo.action);
    expect(noteTimeOf('a', r.body())).toEqual({ lid: 'a', date: '2026-10-20', time: '14:00' });
  });

  it('対照群: 時刻の無いノートは、これまでどおり日付だけ(知らせに時刻が出ない・戻す手の time は null)', () => {
    const r = rig('---\ndate: 2026-10-20\n---\n本文');
    drop(r, '2026-10-23');
    expect(r.state().notice).toBe('10/23(金) へ動かしました');
    const undo = undoScheduleMove(r.state()) as { action: UserAction };
    expect(undo.action).toEqual({ type: 'SET_ENTRY_DATE', lid: 'a', date: '2026-10-20', time: null });
  });
});

describe('SET_ENTRY_DATE の time', () => {
  it('time を添えると、同じ日でも書換を頼む(時刻だけ替える)。省略で同じ日なら何もしない', () => {
    const r = rig(ORIGINAL);
    const same = reduce(r.state(), { type: 'SET_ENTRY_DATE', lid: 'a', date: '2026-10-20' });
    expect(same.events, '省略 + 同じ日なのに書換を頼んだ').toEqual([]);
    const retime = reduce(r.state(), { type: 'SET_ENTRY_DATE', lid: 'a', date: '2026-10-20', time: '09:00' });
    expect(retime.events).toHaveLength(1);
    expect(retime.events[0]).toMatchObject({
      type: 'REQUEST_BODY_REWRITE',
      rewrite: { kind: 'entry-date', date: '2026-10-20', time: '09:00' },
    });
  });
});
