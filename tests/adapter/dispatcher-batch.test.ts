import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';

// 状態が変わる安価な action として OP_FAILED / OP_NOTICE を使う
const fail = (error: string) => ({ type: 'OP_FAILED', error }) as const;

describe('Dispatcher.batch', () => {
  it('batch の中の state 変化は、最後に最終 state で 1 回だけ通知される(getState は中でも最新)', () => {
    const d = new Dispatcher();
    const seen: (string | null)[] = [];
    d.onState((s) => seen.push(s.error));
    d.batch(() => {
      d.dispatch(fail('a'));
      expect(d.getState().error, '中では最新の state が見える').toBe('a');
      d.dispatch(fail('b'));
      d.dispatch(fail('c'));
      expect(seen, '中ではまだ通知しない').toEqual([]);
    });
    expect(seen).toEqual(['c']);
  });

  it('対照群: batch の外では 1 件ごとに通知される', () => {
    const d = new Dispatcher();
    let n = 0;
    d.onState(() => (n += 1));
    d.dispatch(fail('a'));
    d.dispatch(fail('b'));
    expect(n).toBe(2);
  });

  it('入れ子は最も外側の終了で 1 回だけ通知する', () => {
    const d = new Dispatcher();
    let n = 0;
    d.onState(() => (n += 1));
    d.batch(() => {
      d.dispatch(fail('a'));
      d.batch(() => {
        d.dispatch(fail('b'));
      });
      expect(n, '内側の終了では通知しない').toBe(0);
      d.dispatch(fail('c'));
    });
    expect(n).toBe(1);
    expect(d.getState().error).toBe('c');
  });

  it('fn が throw しても、finally で 1 回通知してから再 throw する(深さも戻る)', () => {
    const d = new Dispatcher();
    let n = 0;
    d.onState(() => (n += 1));
    expect(() =>
      d.batch(() => {
        d.dispatch(fail('a'));
        d.dispatch(fail('b'));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(n).toBe(1);
    // 深さが戻っている ── 次の dispatch はすぐ通知される
    d.dispatch(fail('z'));
    expect(n).toBe(2);
  });

  it('state が変わらなければ通知しない', () => {
    const d = new Dispatcher();
    let n = 0;
    d.onState(() => (n += 1));
    d.batch(() => {});
    expect(n).toBe(0);
  });

  it('event listener は batch 中も 1 件ずつ即発火する(state の通知は最後)', () => {
    const d = new Dispatcher();
    const m = (lid: string, order: number) => ({
      lid,
      title: lid,
      archetype: 'text' as const,
      createdAt: null,
      updatedAt: null,
      entryOrder: order,
      status: null,
      date: null,
      archived: false,
      bodyChars: null,
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [m('a', 1), m('b', 2)], relations: [] });
    const log: string[] = [];
    d.onEvent((e) => log.push(`ev:${e.type}`));
    d.onState(() => log.push('state'));
    d.batch(() => {
      d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
      expect(log.filter((l) => l.startsWith('ev:')).length, '中でも event は即発火').toBeGreaterThan(0);
      d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' });
      expect(log.filter((l) => l === 'state'), '中では state を通知しない').toHaveLength(0);
    });
    expect(log.filter((l) => l.startsWith('ev:')).length, 'event は 1 件ずつ(2 回ぶん)').toBeGreaterThanOrEqual(2);
    expect(log.filter((l) => l === 'state')).toHaveLength(1);
    expect(log[log.length - 1]).toBe('state');
  });

  it('戻り値を返す', () => {
    const d = new Dispatcher();
    expect(d.batch(() => 42)).toBe(42);
  });
});
