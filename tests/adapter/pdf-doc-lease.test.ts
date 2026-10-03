/**
 * PDF を読む窓の「文書の貸し出し」(`public/pdf/doc-lease.js`)── **使われない間は pdf.js の worker を畳み、
 * 使い直すときは黙って開き直す**(#275 段①の残り)。
 *
 * 🔴 不可侵指示(2026-08-03)の 3 つの規律を、`worker-lease.test.ts` と同じ形で 1 つずつ見る:
 * ① 遅延起動(要るまで開かない)② ジョブのバッファ(開いている最中に来た依頼は同じ 1 回の起動を待つ)
 * ③ アイドルで kill と解放(**飛んでいる依頼がある間は畳まない** / 畳むときは待っている依頼を必ず reject)。
 *
 * ⚠ **この file の原文を読んで走らせる**(`public/` は bundle を通らないので import できない)。
 * ⚠ 時間は差し替えた時計で進める(実時間を待たない)。観測点は「`close`(= `destroy()` = worker の terminate)が
 *   何回呼ばれたか」と「`open` が何回呼ばれたか」。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Lease {
  use<T>(fn: (doc: Doc) => T | Promise<T>): Promise<T>;
  dispose(): void;
  readonly alive: boolean;
  readonly busy: number;
  readonly opened: number;
}
interface Doc {
  id: number;
}
interface Api {
  DocLease: new (opts: {
    open: () => Promise<Doc>;
    close: (doc: Doc) => void | Promise<void>;
    idleMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (h: unknown) => void;
  }) => Lease;
  IDLE_MS: number;
}

function load(): Api {
  const root: { PkcPdfDocLease?: Api } = {};
  new Function('self', readFileSync('public/pdf/doc-lease.js', 'utf-8'))(root);
  expect(root.PkcPdfDocLease, '原文が API を公開していない(空振り)').toBeDefined();
  return root.PkcPdfDocLease as Api;
}

/** 差し替えの時計(予約を持ち、`tick` で進める)。 */
function clock(): {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  tick(ms: number): void;
  pending(): number;
} {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h) => {
      timers.delete(h as number);
    },
    tick(ms) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

const IDLE = 1000;
/** 待ちの連鎖(microtask)を全部流す。 */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function make(openImpl?: () => Promise<Doc>): {
  lease: Lease;
  clk: ReturnType<typeof clock>;
  log: { opened: number; closed: number[] };
} {
  const { DocLease } = load();
  const clk = clock();
  const log = { opened: 0, closed: [] as number[] };
  const lease = new DocLease({
    open:
      openImpl ??
      (() => {
        log.opened += 1;
        return Promise.resolve({ id: log.opened });
      }),
    close: (d) => {
      log.closed.push(d.id);
    },
    idleMs: IDLE,
    setTimer: clk.setTimer,
    clearTimer: clk.clearTimer,
  });
  return { lease, clk, log };
}

describe('① 遅延起動 ── 要るまで開かない', () => {
  it('作っただけでは開かない / 最初の use で開く', async () => {
    const { lease, log } = make();
    expect(log.opened).toBe(0);
    expect(lease.alive).toBe(false);
    await lease.use((d) => d.id);
    expect(log.opened).toBe(1);
    expect(lease.alive).toBe(true);
  });

  it('既定のアイドルは 60 秒(他の計算 worker の 15〜30 秒より長い ── 頁をめくる間隔を跨ぐ)', () => {
    expect(load().IDLE_MS).toBe(60_000);
  });
});

describe('② ジョブのバッファ ── 開いている最中に来た依頼は、同じ 1 回の起動を待つ', () => {
  it('開く最中に 3 件来ても、開くのは 1 回で、3 件とも同じ文書で走る', async () => {
    let resolveOpen: (d: Doc) => void = () => undefined;
    let opens = 0;
    const { lease } = make(
      () =>
        new Promise<Doc>((r) => {
          opens += 1;
          resolveOpen = r;
        }),
    );
    const seen: number[] = [];
    const jobs = [1, 2, 3].map(() => lease.use((d) => seen.push(d.id)));
    expect(opens, '開いている最中の依頼が二重に開いている').toBe(1);
    expect(seen, '開く前に走っている').toEqual([]);
    resolveOpen({ id: 7 });
    await Promise.all(jobs);
    expect(seen, '待たされた依頼が落ちた / 別の文書で走った').toEqual([7, 7, 7]);
  });
});

describe('③ アイドルで kill と解放', () => {
  it('🔴 依頼が 0 のまま idleMs 経つと畳む(close が 1 回)── 常駐が返る', async () => {
    const { lease, clk, log } = make();
    await lease.use(() => undefined);
    clk.tick(IDLE - 1);
    expect(log.closed, '時間の前に畳んでいる').toEqual([]);
    clk.tick(1);
    expect(log.closed, 'アイドルなのに畳まれない(常駐が返らない)').toEqual([1]);
    expect(lease.alive).toBe(false);
  });

  it('🔴 飛んでいる依頼がある間は畳まない(idleMs より長い 1 件を殺さない)', async () => {
    const { lease, clk, log } = make();
    let finish: () => void = () => undefined;
    const long = lease.use(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    await flush();
    clk.tick(IDLE * 10);
    expect(log.closed, '飛んでいる依頼があるのに畳んだ').toEqual([]);
    expect(lease.busy).toBe(1);
    finish();
    await long;
    // 終わってから改めて数える(終わった時点が「最後の使用」)
    clk.tick(IDLE - 1);
    expect(log.closed).toEqual([]);
    clk.tick(1);
    expect(log.closed).toEqual([1]);
  });

  it('🔴 予約の後に投函された依頼は殺さない(投函で予約を畳む)', async () => {
    const { lease, clk, log } = make();
    await lease.use(() => undefined);
    clk.tick(IDLE - 1);
    let finish: () => void = () => undefined;
    const second = lease.use(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    await flush();
    clk.tick(IDLE * 3);
    expect(log.closed, '予約が生きたまま、飛んでいる依頼を畳んだ').toEqual([]);
    finish();
    await second;
  });

  it('🔴 畳んだ後に次の依頼が来たら、黙って開き直す(2 回目の open)', async () => {
    const { lease, clk, log } = make();
    await lease.use(() => undefined);
    clk.tick(IDLE);
    expect(lease.alive).toBe(false);
    const id = await lease.use((d) => d.id);
    expect(id, '開き直した文書で走っていない').toBe(2);
    expect(log.opened).toBe(2);
    expect(lease.opened).toBe(2);
    expect(lease.alive).toBe(true);
  });

  it('使い続けている間は畳まない(依頼のたびにアイドルの数え直し)', async () => {
    const { lease, clk, log } = make();
    for (let i = 0; i < 5; i += 1) {
      await lease.use(() => undefined);
      clk.tick(IDLE - 1);
    }
    expect(log.closed, '使っているのに畳んだ').toEqual([]);
    expect(log.opened).toBe(1);
  });

  it('畳む途中で close が投げても、畳んだものとして進む(次は開き直せる)', async () => {
    const { DocLease } = load();
    const clk = clock();
    let n = 0;
    const lease = new DocLease({
      open: () => Promise.resolve({ id: (n += 1) }),
      close: () => {
        throw new Error('destroy failed');
      },
      idleMs: IDLE,
      setTimer: clk.setTimer,
      clearTimer: clk.clearTimer,
    });
    await lease.use(() => undefined);
    clk.tick(IDLE);
    expect(lease.alive).toBe(false);
    expect(await lease.use((d) => d.id)).toBe(2);
  });
});

describe('🔴 畳むとき(dispose)── 待っている依頼を必ず reject する(永久 hang を作らない)', () => {
  it('開いている最中に畳まれたら、待っていた依頼は reject され、受け取った文書は手放す', async () => {
    let resolveOpen: (d: Doc) => void = () => undefined;
    const { lease, log } = make(
      () =>
        new Promise<Doc>((r) => {
          resolveOpen = r;
        }),
    );
    const waiting = lease.use(() => 'ran');
    lease.dispose();
    resolveOpen({ id: 9 });
    await expect(waiting).rejects.toThrow('disposed');
    // 開き終えた文書は誰も使えないので、その場で畳む(worker を残さない)
    await flush();
    expect(log.closed).toEqual([9]);
  });

  it('畳んだ後の依頼は reject される / 握っていた文書は畳まれる', async () => {
    const { lease, log } = make();
    await lease.use(() => undefined);
    lease.dispose();
    expect(log.closed).toEqual([1]);
    await expect(lease.use(() => 'ran')).rejects.toThrow('disposed');
  });

  it('畳んだ後にアイドルの予約が残らない(窓を閉じた後に close を呼ばない)', async () => {
    const { lease, clk, log } = make();
    await lease.use(() => undefined);
    lease.dispose();
    expect(clk.pending()).toBe(0);
    clk.tick(IDLE * 5);
    expect(log.closed, '二重に畳んでいる').toEqual([1]);
  });

  it('開くのに失敗したら、待っていた依頼へそのまま届き、次の依頼は開き直せる', async () => {
    let fail = true;
    let n = 0;
    const { lease } = make(() => {
      n += 1;
      return fail ? Promise.reject(new Error('boom')) : Promise.resolve({ id: n });
    });
    await expect(lease.use(() => 'ran')).rejects.toThrow('boom');
    expect(lease.busy, '失敗した依頼を飛んでいると数え続けている').toBe(0);
    fail = false;
    expect(await lease.use((d) => d.id)).toBe(2);
  });
});
