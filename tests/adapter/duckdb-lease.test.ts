/**
 * 🔴 **「使うときだけ載せる」を守っているか**(#682 段①b。user 裁定 2026-09-15)。
 *
 * ⚠ user 指示は「**常駐させない。使う時だけロードして**」── だから見るのは
 * 「動くか」ではなく「**呼ばれるまで起こさないか / 使い終わったら畳むか**」である。
 */
import { describe, expect, it, vi } from 'vitest';
import { DuckDbLease, DUCKDB_TOO_LONG, type DuckDbHandle } from '../../src/adapter/platform/duckdb/duckdb-lease';
import type { DuckDbRaw } from '../../src/features/query/duckdb-rows';

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

/** 答えの形は実物と同じ(列 / 型 / 行)。⚠ 甘い stub にすると型の食い違いが隠れる。 */
const ANSWER: DuckDbRaw = { columns: ['n'], types: ['Int32'], rows: [[1]] };

function handle(): DuckDbHandle & { terminated: number; asked: string[]; put: ReturnType<typeof vi.fn> } {
  const h = {
    terminated: 0,
    asked: [] as string[],
    put: vi.fn(() => Promise.resolve()),
    query: (sql: string) => {
      h.asked.push(sql);
      return Promise.resolve(ANSWER);
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
    // ⚠ `| null` を持たせない ── TS はコールバックの中の代入を追わないので、
    //   後で呼ぶとき `never` へ狭まって「呼べない」になる。
    let settle!: (h: DuckDbHandle) => void;
    const h = handle();
    const open = vi.fn(
      () =>
        new Promise<DuckDbHandle>((res) => {
          settle = res;
        }),
    );
    const lease = new DuckDbLease({ open, ...fakeTimers() });
    const a = lease.run({ sql: 'select 1' });
    const b = lease.run({ sql: 'select 2' });
    const c = lease.run({ sql: 'select 3' });
    expect(open, '起こしている間にもう一度起こしている').toHaveBeenCalledTimes(1);
    settle(h);
    await Promise.all([a, b, c]);
    // ⚠ 3 本とも届いている(溜めた分を捨てていない)
    expect(h.asked).toEqual(['select 1', 'select 2', 'select 3']);
  });

  it('🔴 使い終わってしばらくすると畳む', async () => {
    const h = handle();
    const t = fakeTimers();
    const lease = new DuckDbLease({ open: () => Promise.resolve(h), ...t });
    await lease.run({ sql: 'select 1' });
    expect(lease.awake, '打った直後は起きている(前提)').toBe(true);
    expect(t.armed, '畳む時計が張られていない').toBe(1);
    t.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.terminated, '時計が鳴ったのに畳んでいない').toBe(1);
    expect(lease.awake).toBe(false);
  });

  it('🔴 飛んでいる問い合わせがある間は畳まない', async () => {
    let settle!: (v: DuckDbRaw) => void;
    const h: DuckDbHandle & { terminated: number } = {
      terminated: 0,
      put: () => Promise.resolve(),
      query: () =>
        new Promise<DuckDbRaw>((res) => {
          settle = res;
        }),
      terminate: () => {
        h.terminated += 1;
        return Promise.resolve();
      },
    };
    const t = fakeTimers();
    const lease = new DuckDbLease({ open: () => Promise.resolve(h), ...t });
    const flying = lease.run({ sql: 'select 1' });
    await Promise.resolve();
    await Promise.resolve();
    await lease.release();
    expect(h.terminated, '飛んでいる最中に畳んだ ── 答えが消える').toBe(0);
    settle(ANSWER);
    await flying;
    // ⚠ 返ってきてから初めて時計が張られる
    expect(t.armed).toBe(1);
  });

  it('🔑 畳んだあとに打つと、起こし直す(片道にしない)', async () => {
    const open = vi.fn(() => Promise.resolve(handle()));
    const t = fakeTimers();
    const lease = new DuckDbLease({ open, ...t });
    await lease.run({ sql: 'select 1' });
    await lease.release();
    expect(lease.awake).toBe(false);
    await lease.run({ sql: 'select 2' });
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
    await expect(lease.run({ sql: 'select 1' })).rejects.toThrow('取れなかった');
    // ⚠ ここで `opening` を残すと、電波が戻っても**永久に同じ失敗**を返す
    await expect(lease.run({ sql: 'select 2' })).resolves.toEqual(ANSWER);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('⚠ 畳む側が例外を投げても、状態は「畳んだ」に揃う', async () => {
    const h: DuckDbHandle = {
      put: () => Promise.resolve(),
      query: () => Promise.resolve(ANSWER),
      terminate: () => Promise.reject(new Error('畳めない')),
    };
    const lease = new DuckDbLease({ open: () => Promise.resolve(h), ...fakeTimers() });
    await lease.run({ sql: 'select 1' });
    await expect(lease.release()).resolves.toBeUndefined();
    // 🔑 参照は捨ててあるので、次は起こし直す ── 状態と例外を食い違わせない
    expect(lease.awake).toBe(false);
  });
});


describe('🔴 相手の差し込み(#682 段②)', () => {
  it('同じ相手なら差し直さない / 違う相手なら差し直す', async () => {
    const h = handle();
    const lease = new DuckDbLease({ open: () => Promise.resolve(h), ...fakeTimers() });
    const load = vi.fn(() => Promise.resolve());
    await lease.run({ sql: 'select 1', data: { key: 'a', load } });
    await lease.run({ sql: 'select 2', data: { key: 'a', load } });
    expect(load, '同じ相手を打鍵のたびに読み直している').toHaveBeenCalledTimes(1);
    await lease.run({ sql: 'select 3', data: { key: 'b', load } });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('🔴 畳んだら差し込んだ物も消える ── 起こし直した器へ入れ直す', async () => {
    const lease = new DuckDbLease({ open: () => Promise.resolve(handle()), ...fakeTimers() });
    const load = vi.fn(() => Promise.resolve());
    await lease.run({ sql: 'select 1', data: { key: 'a', load } });
    await lease.release();
    await lease.run({ sql: 'select 2', data: { key: 'a', load } });
    // ⚠ 入れ直さないと、起こし直した空の器へ `select` が飛ぶ(表が無い、と断られる)
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('差し込みが落ちたら「入っている」と控えない', async () => {
    const lease = new DuckDbLease({ open: () => Promise.resolve(handle()), ...fakeTimers() });
    let fail = true;
    const load = vi.fn(() => (fail ? Promise.reject(new Error('読めなかった')) : Promise.resolve()));
    await expect(lease.run({ sql: 'select 1', data: { key: 'a', load } })).rejects.toThrow('読めなかった');
    fail = false;
    await lease.run({ sql: 'select 2', data: { key: 'a', load } });
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('🔴 時間で切る(#682 段②)', () => {
  /** 返らない問い合わせ。⚠ 上流に中断の口が無いので、畳む以外に止める手が無い。 */
  function stuck(): DuckDbHandle & { terminated: number } {
    const h = {
      terminated: 0,
      put: () => Promise.resolve(),
      query: () => new Promise<DuckDbRaw>(() => undefined),
      terminate: () => {
        h.terminated += 1;
        return Promise.resolve();
      },
    };
    return h;
  }

  it('🔴 終わらない問い合わせを、ワーカーごと畳んで止める', async () => {
    const h = stuck();
    const t = fakeTimers();
    const lease = new DuckDbLease({ open: () => Promise.resolve(h), ...t });
    const flying = lease.run({ sql: 'select 1', maxMs: 10 });
    /**
     * ⚠ **起こし終わるまで待ってから撃つ** ── `run` は `open` を待ってから門を張るので、
     *   microtask を 2 つ回しただけでは**まだ張られていない**(実測で踏んだ)。
     * 🔑 だから本物の macrotask を 1 つ挟む(この時計は偽物ではない)。
     */
    await new Promise((r) => setTimeout(r, 0));
    expect(t.armed, '時間の門が張られていない').toBeGreaterThan(0);
    t.fire();
    await expect(flying).rejects.toThrow(DUCKDB_TOO_LONG);
    expect(h.terminated, '止めるには畳むしかないのに、畳んでいない').toBe(1);
    // 🔴 死んだ器へ次の問い合わせを飛ばさない ── 起こし直す
    expect(lease.awake).toBe(false);
  });

  it('時間の内に返れば、畳まない', async () => {
    const h = handle();
    const t = fakeTimers();
    const lease = new DuckDbLease({ open: () => Promise.resolve(h), ...t });
    await expect(lease.run({ sql: 'select 1', maxMs: 10_000 })).resolves.toEqual(ANSWER);
    expect(h.terminated).toBe(0);
    // ⚠ 対照群 ── 門を通った回は「畳む時計」だけが張ってある(時間の門は外れている)
    expect(t.armed).toBe(1);
  });
});
