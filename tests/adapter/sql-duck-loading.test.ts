/**
 * 🔴 **DuckDB の「時間がかかります」は、表を読み込む回にだけ出す**(#682 の最後の 1 件)の状態の側。
 * 画面側は `sql-pane.test.ts`、合図を出す側(読み込むときだけ呼ぶ)は `duckdb-runner.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';

const running = (token: number, duckLoading = false): AppState => ({
  ...initialState,
  sqlPage: { ...initialState.sqlPage, running: true, runToken: token, duckLoading },
});

describe('🔴 SQL_DUCK_LOADING(#682)', () => {
  it('走っている回の合図で立つ', () => {
    const { state } = reduce(running(3), { type: 'SQL_DUCK_LOADING', token: 3 });
    expect(state.sqlPage.duckLoading).toBe(true);
  });

  it('⚠ 古い回の合図は捨てる(いまの回に「時間がかかります」を出さない)', () => {
    const { state } = reduce(running(3), { type: 'SQL_DUCK_LOADING', token: 2 });
    expect(state.sqlPage.duckLoading).toBe(false);
  });

  it('⚠ 走っていない間の合図は捨てる(終わった画面に残さない)', () => {
    const idle: AppState = { ...initialState, sqlPage: { ...initialState.sqlPage, runToken: 3 } };
    const { state } = reduce(idle, { type: 'SQL_DUCK_LOADING', token: 3 });
    expect(state.sqlPage.duckLoading).toBe(false);
  });

  it('答えが出たら降ろす', () => {
    const { state } = reduce(running(3, true), {
      type: 'SET_SQL_RESULT', token: 3, sql: 'SELECT 1', columns: ['a'], rows: [[1]], truncated: false, ms: 1,
    });
    expect(state.sqlPage.running).toBe(false);
    expect(state.sqlPage.duckLoading).toBe(false);
  });

  it('落ちたら降ろす', () => {
    const { state } = reduce(running(3, true), { type: 'SQL_RUN_FAILED', token: 3, sql: 'x', error: 'e' });
    expect(state.sqlPage.duckLoading).toBe(false);
  });

  it('次の回を始めるときに降ろす(持ち越さない)', () => {
    const base = running(3, true);
    const idle: AppState = { ...base, sqlPage: { ...base.sqlPage, running: false, sql: 'SELECT 1' } };
    const { state } = reduce(idle, { type: 'RUN_SQL' });
    expect(state.sqlPage.running).toBe(true);
    expect(state.sqlPage.duckLoading).toBe(false);
  });
});
