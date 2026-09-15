/**
 * 🔴 **「使うときだけ載せる」を守っているか**(#682 段①b。user 裁定 2026-09-15)。
 *
 * ⚠ user 指示は「**常駐させない。使う時だけロードして**」── だから見るのは
 * 「動くか」ではなく「**呼ばれるまで起こさないか / 使い終わったら畳むか**」である。
 */
import { describe, expect, it, vi } from 'vitest';
import { DuckDbLease, type DuckDbHandle } from '../../src/adapter/platform/duckdb/duckdb-lease';

/** 手で進められる時計。⚠ 実時間を待たない(30 秒の既定を待つ test は書けない)。 */
function fakeTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    setTimer: (fn: () => void) => {
      const id = next;
      next += 1;
      pending.set(id, fn);
      return id;
    },
    clearTimer: (h: unknown) => {
      pending.delete(h as number);
    },
    /** 張ってある時計を全部撃つ。 */
    fire: () => {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    get armed(): number {
      return pending.size;
    },
  };
}

function handle(): DuckDbHandle & { terminated: number; asked: string[] } {
  const h = {
    terminated: 0,
    asked: [] as string[],
    query: (sql: string) => {
      h.asked.push(sql);
      return Promise.resolve({ rows: 1 });
    },
    terminate: () => {
      h.terminated += 1;
      return Promise.resolve();
    },
  };
  return h;
}

describe('🔴 DuckDB は常駐しない(#682)', () => {
  it('🔑 呼ばれるまで起こさない ── 作っただけでは 0 回', () => {
    const open = vi.fn(() => Promise.resolve(handle()));
    const t = fakeTimers();
    const lease = new DuckDbLease({ open, ...t });
    // ⚠ ここが「遅延起動」の本体 ── 作った時点で起こしていたら、常駐と同じである
    expect(open).toHaveBeenCalledTimes(0);
    expect(lease.awake).toBe(false);
    expect(t.armed, '打ってもいないのに畳む時計が張ってある').toBe(0);
  });

  it('🔑 起こしている間に来た分を落とさない(open は 1 回だけ)', async () => {
    let settle: ((h: DuckDbHandle) => void) | null = null;
    const h = handle();
    const open = vi.fn(
      () =>
        new Promise<DuckDbHandle>((res) => {
          settle = res;
        }),
    );
    const lease = new DuckDbLease({ open, ...fakeTimers() });
    const a = lease.run('select 1');
    const b = lease.run('select 2');
    const c = lease.run('select 3');
    expect(open, '起こしている間にもう一度起こしている').toHaveBeenCalledTimes(1);
    settle?.(h);
    await Promise.all([a, b, c]);
    // ⚠ 3 本とも届いている(溜めた分を捨てていない)
    expect(h.asked).toEqual(['select 1', 'select 2', 'select 3']);
  });

  it('🔴 使い終わってしばらくすると畳む', async () => {
    const h = handle();
    const t = fakeTimers();
    const lease = new DuckDbLease({ open: () => Promise.resolve(h), ...t });
    await lease.run('select 1');
    expect(lease.awake, '打った直後は起きている(前提)').toBe(true);
    expect(t.armed, '畳む時計が張られていない').toBe(1);
    t.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.terminated, '時計が鳴ったのに畳んでいない').toBe(1);
    expect(lease.awake).toBe(false);
  });

  it('🔴 飛んでいる問い合わせがある間は畳まない', async () => {
    let settle: ((v: unknown) => void) | null = null;
    const h: DuckDbHandle & { terminated: number } = {
      terminated: 0,
      query: () =>
        new Promise((res) => {
          settle = res;
        }),
      terminate: () => {
        h.terminated += 1;
        return Promise.resolve();
      },
    };
    const t = fakeTimers();
    const lease = new DuckDbLease({ open: () => Promise.resolve(h), ...t });
    const flying = lease.run('select 1');
    await Promise.resolve();
    await Promise.resolve();
    await lease.release();
    expect(h.terminated, '飛んでいる最中に畳んだ ── 答えが消える').toBe(0);
    settle?.({ rows: 1 });
    await flying;
    // ⚠ 返ってきてから初めて時計が張られる
    expect(t.armed).toBe(1);
  });

  it('🔑 畳んだあとに打つと、起こし直す(片道にしない)', async () => {
    const open = vi.fn(() => Promise.resolve(handle()));
    const t = fakeTimers();
    const lease = new DuckDbLease({ open, ...t });
    await lease.run('select 1');
    await lease.release();
    expect(lease.awake).toBe(false);
    await lease.run('select 2');
    expect(open, '畳んだら二度と起きない形になっている').toHaveBeenCalledTimes(2);
    expect(lease.awake).toBe(true);
  });

  it('🔴 起こすのに失敗しても、次で試し直せる(失敗を貼り付けない)', async () => {
    const h = handle();
    let attempt = 0;
    const open = vi.fn(() => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('取れなかった')) : Promise.resolve(h);
    });
    const lease = new DuckDbLease({ open, ...fakeTimers() });
    await expect(lease.run('select 1')).rejects.toThrow('取れなかった');
    // ⚠ ここで `opening` を残すと、電波が戻っても**永久に同じ失敗**を返す
    await expect(lease.run('select 2')).resolves.toEqual({ rows: 1 });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('⚠ 畳む側が例外を投げても、状態は「畳んだ」に揃う', async () => {
    const h: DuckDbHandle = {
      query: () => Promise.resolve({ rows: 1 }),
      terminate: () => Promise.reject(new Error('畳めない')),
    };
    const lease = new DuckDbLease({ open: () => Promise.resolve(h), ...fakeTimers() });
    await lease.run('select 1');
    await expect(lease.release()).resolves.toBeUndefined();
    // 🔑 参照は捨ててあるので、次は起こし直す ── 状態と例外を食い違わせない
    expect(lease.awake).toBe(false);
  });
});
