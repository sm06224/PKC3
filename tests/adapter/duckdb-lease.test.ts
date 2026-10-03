/**
 * 🔴 **「使うときだけ載せる」を守っているか**(#682 段①b。user 裁定 2026-09-15)。
 *
 * ⚠ user 指示は「**常駐させない。使う時だけロードして**」── だから見るのは
 * 「動くか」ではなく「**呼ばれるまで起こさないか / 使い終わったら畳むか**」である。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DuckDbLease,
  DUCKDB_LOAD_TOO_LONG,
  DUCKDB_TOO_LONG,
  type DuckDbHandle,
} from '../../src/adapter/platform/duckdb/duckdb-lease';
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
    drop: () => Promise.resolve(),
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
      drop: () => Promise.resolve(),
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
      drop: () => Promise.resolve(),
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
      drop: () => Promise.resolve(),
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

/**
 * 🔴 **書き込みで作った物を、アイドルで畳まない**(#918 段⑧)。
 *
 * ## ① 何が起きていたか(直す前)
 *
 * ⚠ 画面は「作った表は**ウィンドウを閉じると**消えます」と言う。ところが器は
 *   **30 秒使わないと畳まれる**(上の「常駐しない」)── 畳めば作った表は**黙って**消える。
 *   🔴 user は「ウィンドウを閉じていないのに表が消えた」を、英語の
 *   「Table with name … does not exist」で知ることになる。
 *
 * ## ② 何を守るか
 *
 * - 書き込みが**通った**後は、アイドルで畳まない(時計そのものを張らない)
 * - 🔑 **読むだけの回は今までどおり畳む**(常駐メモリを返す規律は変えていない)
 * - 畳まれるのは「明示の `release()` / 相手の入れ替え / 時間の門」だけで、
 *   🔴 **畳んだら `held` を必ず下ろす**(下ろし忘れると、以後ずっと畳まれない)
 */
describe('🔴 書き込みで作った物は、アイドルで畳まない(#918 段⑧)', () => {
  it('🔴 書き込みが通った後は、畳む時計を張らない ── 読むだけを挟んでも張らない', async () => {
    const h = handle();
    const t = fakeTimers();
    const lease = new DuckDbLease({ open: () => Promise.resolve(h), ...t });
    await lease.run({ sql: 'create table t (a int)', hold: true });
    expect(t.armed, '作った表があるのに、畳む時計が張られている').toBe(0);
    // 🔑 その後の読むだけの回も張らない(作った表を持ったまま)
    await lease.run({ sql: 'select * from t' });
    expect(t.armed, '読むだけの回が、作った表ごと畳む時計を張っている').toBe(0);
    t.fire();
    await Promise.resolve();
    expect(h.terminated, '作った表ごと畳んだ').toBe(0);
    expect(lease.awake).toBe(true);
  });

  it('⚠ 対照群 ── 書き込みでない回は、今までどおり畳む', async () => {
    const h = handle();
    const t = fakeTimers();
    const lease = new DuckDbLease({ open: () => Promise.resolve(h), ...t });
    await lease.run({ sql: 'select 1' });
    expect(t.armed).toBe(1);
    // `hold: false` を明示しても同じ
    await lease.run({ sql: 'select 2', hold: false });
    expect(t.armed).toBe(1);
    t.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.terminated).toBe(1);
  });

  it('🔴 先に張ってあった時計も、書き込みが通れば外れる', async () => {
    const h = handle();
    const t = fakeTimers();
    const lease = new DuckDbLease({ open: () => Promise.resolve(h), ...t });
    await lease.run({ sql: 'select 1' });
    expect(t.armed, '前提:読むだけの回で時計が張られている').toBe(1);
    await lease.run({ sql: 'create table t (a int)', hold: true });
    expect(t.armed, '張ってあった時計が残っている(作った表ごと畳まれる)').toBe(0);
  });

  it('🔴 落ちた書き込みは「作った」と数えない ── 時計は張る', async () => {
    const h = handle();
    h.query = () => Promise.reject(new Error('Catalog Error'));
    const t = fakeTimers();
    const lease = new DuckDbLease({ open: () => Promise.resolve(h), ...t });
    await expect(lease.run({ sql: 'insert into nope values (1)', hold: true })).rejects.toThrow('Catalog Error');
    expect(t.armed, '何も作っていないのに、器を持ち続けている').toBe(1);
  });

  it('🔴 明示の release() は畳み、held も下ろす(以後の読むだけは、また畳まれる)', async () => {
    const t = fakeTimers();
    const lease = new DuckDbLease({ open: () => Promise.resolve(handle()), ...t });
    await lease.run({ sql: 'create table t (a int)', hold: true });
    await lease.release();
    expect(lease.awake, '明示の release が効いていない').toBe(false);
    await lease.run({ sql: 'select 1' });
    expect(t.armed, 'held を下ろし忘れている(以後ずっと畳まれない)').toBe(1);
  });

  it('🔴 相手を替えると器ごと作り直し、held も下ろす', async () => {
    const first = handle();
    const second = handle();
    const hs = [first, second];
    const t = fakeTimers();
    const lease = new DuckDbLease({ open: () => Promise.resolve(hs.shift() as DuckDbHandle), ...t });
    const load = vi.fn(() => Promise.resolve());
    await lease.run({ sql: 'create table t (a int)', hold: true, data: { key: 'a', load } });
    expect(t.armed).toBe(0);
    await lease.run({ sql: 'select 1', data: { key: 'b', load } });
    // 🔑 前の器(作った表ごと)は畳まれ、新しい器は読むだけなので畳む時計が張られる
    expect(first.terminated, '相手を替えたのに前の器が残っている').toBe(1);
    expect(t.armed, '新しい器にまで held が引き継がれている').toBe(1);
  });

  it('🔴 時間の門で畳まれたら、held も下ろす', async () => {
    const t = fakeTimers();
    let stuckNext = false;
    const h: DuckDbHandle & { terminated: number } = {
      terminated: 0,
      put: () => Promise.resolve(),
      drop: () => Promise.resolve(),
      query: () => (stuckNext ? new Promise<DuckDbRaw>(() => undefined) : Promise.resolve(ANSWER)),
      terminate: () => {
        h.terminated += 1;
        return Promise.resolve();
      },
    };
    const lease = new DuckDbLease({ open: () => Promise.resolve(h), ...t });
    await lease.run({ sql: 'create table t (a int)', hold: true });
    stuckNext = true;
    const flying = lease.run({ sql: 'select long', maxMs: 10 });
    await new Promise((r) => setTimeout(r, 0));
    t.fire();
    await expect(flying).rejects.toThrow(DUCKDB_TOO_LONG);
    expect(lease.awake, '時間の門で畳んだ器を持ち続けている').toBe(false);
    // 🔑 起こし直した後の読むだけは、また畳まれる
    stuckNext = false;
    await lease.run({ sql: 'select 1' });
    expect(t.armed, '畳んだのに held が残っている').toBe(1);
  });

  it('🔴 同時に飛んでいた別の問い合わせが畳んだ器には、held を立てない(古い器の書き込みが新しい器を縛らない)', async () => {
    /**
     * ⚠ 面は 1 度に 1 本しか走らせないので実機では起きにくいが、`DuckDbJob.maxMs` の注釈が
     *   「同時に飛んでいる別の問い合わせも道連れになる」と書いている形である。
     * 🔑 書き込み A が飛んでいる間に、B が時間の門で器を畳む → A が返る。
     *   このとき `held` を立てると、**起こし直した新しい器**が以後ずっと畳まれない。
     */
    let settleA!: (v: DuckDbRaw) => void;
    const mk = (): DuckDbHandle & { terminated: number } => {
      const h: DuckDbHandle & { terminated: number } = {
        terminated: 0,
        put: () => Promise.resolve(),
        drop: () => Promise.resolve(),
        query: (sql: string) =>
          sql === 'A'
            ? new Promise<DuckDbRaw>((res) => {
                settleA = res;
              })
            : sql === 'B'
              ? new Promise<DuckDbRaw>(() => undefined)
              : Promise.resolve(ANSWER),
        terminate: () => {
          h.terminated += 1;
          return Promise.resolve();
        },
      };
      return h;
    };
    const hs = [mk(), mk()];
    const t = fakeTimers();
    const lease = new DuckDbLease({ open: () => Promise.resolve(hs.shift() as DuckDbHandle), ...t });
    const a = lease.run({ sql: 'A', hold: true });
    const b = lease.run({ sql: 'B', maxMs: 10 });
    const bFailed = expect(b).rejects.toThrow(DUCKDB_TOO_LONG);
    await new Promise((r) => setTimeout(r, 0));
    t.fire();
    await bFailed;
    settleA(ANSWER);
    await a;
    // 起こし直した新しい器へ、読むだけの回
    await lease.run({ sql: 'select 1' });
    expect(t.armed, '畳まれた器の書き込みが、新しい器を畳めなくしている').toBe(1);
  });
});

/**
 * 🔴 **器へ写す所にも時間の門を置く**(#682 段④d の着地後レビュー R5)。
 *
 * ## ① 何が起きていたか(直す前)
 *
 * 時間の門(`maxMs`)は**打つ字**にしか掛かっておらず、`data.load`(`.sqlite` を表ごとに器へ写す所)は
 * **無期限**だった。呼び側(`DuckDbRunner`)は仕事を**直列の列**で通すので、写しの途中で止まると
 * **後ろの仕事(つながり図・次の SQL)が全部永久に待つ**。`forget(stale)` は「次の仕事が走り出して初めて」
 * 効くので、列が詰まっていると届かなかった。
 */
describe('🔴 器へ写す所の時間の門(R5)', () => {
  const hangingLoad = (): Promise<void> => new Promise<void>(() => undefined);

  it('🔴 止まった写しを、ワーカーごと畳んで時間で断る(次の仕事は起こし直す)', async () => {
    const h = handle();
    const h2 = handle();
    const hs = [h, h2];
    const t = fakeTimers();
    const lease = new DuckDbLease({ open: () => Promise.resolve(hs.shift() as DuckDbHandle), ...t });
    const stuck = lease.run({
      sql: 'select 1',
      loadMaxMs: 10,
      data: { key: 'a', load: hangingLoad },
    });
    const failed = expect(stuck).rejects.toThrow(DUCKDB_LOAD_TOO_LONG);
    await new Promise((r) => setTimeout(r, 0));
    expect(t.armed, '写す所に時計が張られていない').toBeGreaterThan(0);
    t.fire();
    await failed;
    expect(h.terminated, '止めるには畳むしかないのに、畳んでいない').toBe(1);
    expect(lease.awake, '死んだ器を握ったまま').toBe(false);
    // 🔴 同じ鍵でも「入っている」と嘘をつかない ── 次は最初から写し直す
    const load = vi.fn(() => Promise.resolve());
    await lease.run({ sql: 'select 2', loadMaxMs: 10, data: { key: 'a', load } });
    expect(load, '畳んだ器へ写し直していない').toHaveBeenCalledTimes(1);
    expect(h2.asked).toEqual(['select 2']);
  });

  it('🔴 断りの字は 1 つの定数(呼び側がそれで見分ける)で、打つ字の時間切れとは別の字', () => {
    expect(DUCKDB_LOAD_TOO_LONG).toContain('写す');
    expect(DUCKDB_LOAD_TOO_LONG).not.toBe(DUCKDB_TOO_LONG);
  });

  it('対照群:時間内に写し終われば畳まない / `loadMaxMs` を渡さなければ時計を張らない(今までどおり)', async () => {
    const h = handle();
    const t = fakeTimers();
    const lease = new DuckDbLease({ open: () => Promise.resolve(h), ...t });
    const load = vi.fn(() => Promise.resolve());
    await lease.run({ sql: 'select 1', loadMaxMs: 10_000, data: { key: 'a', load } });
    expect(load).toHaveBeenCalledTimes(1);
    expect(h.terminated).toBe(0);
    // 門は外れ、畳む時計だけが張ってある
    expect(t.armed).toBe(1);
    const h2 = handle();
    const t2 = fakeTimers();
    const lease2 = new DuckDbLease({ open: () => Promise.resolve(h2), ...t2 });
    await lease2.run({ sql: 'select 1', data: { key: 'a', load: () => Promise.resolve() } });
    // 打つ字にも写す所にも門が無い回は、畳む時計だけ(1 本)
    expect(t2.armed).toBe(1);
  });

  it('🔴 写しが失敗で終わったときは、門の時計を残さない(次の回の時計と混ざらない)', async () => {
    const h = handle();
    const t = fakeTimers();
    const lease = new DuckDbLease({ open: () => Promise.resolve(h), ...t });
    await expect(
      lease.run({
        sql: 'select 1',
        loadMaxMs: 10_000,
        data: { key: 'a', load: () => Promise.reject(new Error('写せません')) },
      }),
    ).rejects.toThrow('写せません');
    // 門の時計は外れ、畳む時計だけが張ってある
    expect(t.armed, '落ちた回の門の時計が残っている').toBe(1);
  });
});
