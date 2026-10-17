/**
 * 🔴 **選んだファイルがまだ開けていないとき、「実行」はこの PKC の DB へ走らせない**(#1087)。
 * ⚠ 欄にはファイルの名前が出ているのに、中身はこの PKC の DB から返る ── 気づけない外し方。
 */
import { describe, expect, it } from 'vitest';
import {
  initialState,
  reduce,
  SQL_GUEST_OPENING_TEXT,
  type AppState,
} from '../../src/adapter/state/app-state';

const base = (over: Partial<AppState['sqlPage']>): AppState => ({
  ...initialState,
  sqlPage: { ...initialState.sqlPage, sql: 'SELECT 1', ...over },
});

describe('RUN_SQL と選んだファイル', () => {
  it('開いている最中は走らせず、待つよう言う(running を立てない・命令を出さない)', () => {
    const { state, events } = reduce(base({ guestChosen: 'att1', guestPending: 'att1' }), { type: 'RUN_SQL' });
    expect(events).toEqual([]);
    expect(state.sqlPage.running).toBe(false);
    expect(state.sqlPage.error).toBe(SQL_GUEST_OPENING_TEXT);
    expect(SQL_GUEST_OPENING_TEXT).toBe('選んだファイルをまだ開いています。開き終わってから実行してください');
  });

  it('開けなかった回は、開けなかった理由(guestError)をそのまま残して走らせない', () => {
    const s = base({ guestChosen: 'att1', guestError: 'ファイルが壊れています' });
    const { state, events } = reduce(s, { type: 'RUN_SQL' });
    expect(events).toEqual([]);
    expect(state.sqlPage.running).toBe(false);
    expect(state.sqlPage.guestError).toBe('ファイルが壊れています');
    expect(state.sqlPage.error).toBe('');
  });

  it('開き終わったら、待つよう言った断りは降ろす(嘘を残さない)', () => {
    const waiting = reduce(base({ guestChosen: 'att1', guestPending: 'att1' }), { type: 'RUN_SQL' }).state;
    const { state } = reduce(waiting, {
      type: 'SQL_GUEST_OPENED', lid: 'att1', name: 'a.csv', tables: [], bytes: 1, truncated: false,
    } as never);
    expect(state.sqlPage.guest).not.toBeNull();
    expect(state.sqlPage.error).toBe('');
  });

  it('⚠ 対照群: 何も選んでいなければ今までどおり走る', () => {
    const { state, events } = reduce(base({}), { type: 'RUN_SQL' });
    expect(state.sqlPage.running).toBe(true);
    expect(events.some((e) => e.type === 'REQUEST_SQL_RUN')).toBe(true);
  });

  it('⚠ 対照群: 開けている相手が居れば走る', () => {
    const s = base({
      guestChosen: 'att1',
      guest: { lid: 'att1', name: 'a.csv', tables: [], bytes: 1, truncated: false } as never,
    });
    const { state } = reduce(s, { type: 'RUN_SQL' });
    expect(state.sqlPage.running).toBe(true);
  });
});
