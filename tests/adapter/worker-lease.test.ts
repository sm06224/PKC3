/** @vitest-environment happy-dom */
/**
 * P8 段⑨: **ワーカーの貸し出し**(遅延起動 / バッファ / アイドル kill)。
 *
 * > user 指示 2026-08-03(不可侵)「**基本的に重い処理はワーカーにしてください /
 * > ワーカーはしばらくつかわれないなら、キルと解放し、ワーカーへのジョブ発行を
 * > バッファして、ワーカーにディスパッチします**」
 *
 * ⚠ この 3 つは**互いに壊し合う**ので、片方だけ見る test では守れない:
 *  - 遅延起動だけ見る → 起動待ちに来たジョブが落ちても緑
 *  - バッファだけ見る → 飛んでいる最中に kill しても緑(= 応答が永久に来ない)
 *  - kill だけ見る → 待っている依頼を reject し忘れても緑(= 永久 hang)
 */
import { describe, expect, it, vi } from 'vitest';
import { WorkerLease } from '../../src/adapter/platform/worker-lease';
import { JobMonitor } from '../../src/adapter/platform/job-monitor';
import { MarkdownClient } from '../../src/adapter/platform/render/markdown-client';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

/** 実物と同じ形の偽 worker。⚠ 応答は**必ず非同期**(同期だと実物と意味が変わる)。 */
class FakeWorker {
  static spawned = 0;
  static live = new Set<FakeWorker>();
  onmessage: ((ev: MessageEvent<unknown>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly seen: Array<{ id: number; payload: unknown }> = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;
  /** 手で返す(飛んでいる窓を再現するため、自動では返さない)。 */
  private readonly held: number[] = [];

  constructor() {
    FakeWorker.spawned += 1;
    FakeWorker.live.add(this);
  }

  postMessage(msg: { id: number; payload: unknown }, transfer: Transferable[] = []): void {
    this.seen.push(msg);
    this.transfers.push(transfer);
    this.held.push(msg.id);
  }

  /** 溜まっている依頼に応答する。 */
  respondAll(make: (id: number) => unknown = (id) => `r${id}`): void {
    for (const id of this.held.splice(0)) {
      this.onmessage?.({ data: { id, ok: true, result: make(id) } } as MessageEvent<unknown>);
    }
  }

  failNext(error: string): void {
    const id = this.held.shift();
    if (id !== undefined)
      this.onmessage?.({ data: { id, ok: false, error } } as MessageEvent<unknown>);
  }

  crash(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }

  terminate(): void {
    this.terminated = true;
    FakeWorker.live.delete(this);
  }
}

/** 手で進める時計(実時間を待たない)。 */
function fakeClock() {
  let next = 1;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let now = 0;
  return {
    setTimer: (fn: () => void, ms: number): unknown => {
      const h = next++;
      timers.set(h, { fn, at: now + ms });
      return h;
    },
    clearTimer: (h: unknown): void => {
      timers.delete(h as number);
    },
    advance(ms: number): void {
      now += ms;
      for (const [h, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(h);
          t.fn();
        }
      }
    },
    get armed(): number {
      return timers.size;
    },
  };
}

function makeLease(idleMs = 1000) {
  FakeWorker.spawned = 0;
  FakeWorker.live.clear();
  const clock = fakeClock();
  let last: FakeWorker | null = null;
  const lease = new WorkerLease({
    spawn: () => {
      last = new FakeWorker();
      return last as unknown as Worker;
    },
    idleMs,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    name: 'test worker',
  });
  return { lease, clock, worker: () => last!, };
}

describe('遅延起動(要るまで作らない)', () => {
  it('🔴 作っただけでは worker を起こさない', async () => {
    const { lease } = makeLease();
    // ⚠ **同期で見るだけでは空振りする**(変異試験で判明)── `queueMicrotask` で
    // 先回り起動する実装が生き残った。tick を跨いでも起きていないことを見る
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeWorker.spawned, '使っていないのに起動している').toBe(0);
    expect(lease.alive).toBe(false);
  });

  it('最初の依頼で起きる', async () => {
    const { lease, worker } = makeLease();
    const p = lease.run('a');
    expect(FakeWorker.spawned).toBe(1);
    worker().respondAll(() => 'ok');
    await expect(p).resolves.toBe('ok');
  });
});

describe('🔴 ジョブのバッファ(起動待ちに来たものを落とさない)', () => {
  it('🔴 起動と同じ tick に来た依頼が**全部**届く', async () => {
    // ⚠ ここが空だと「1 件目だけ通って 2 件目以降が永久に返らない」になる
    const { lease, worker } = makeLease();
    const ps = [lease.run('a'), lease.run('b'), lease.run('c')];
    expect(FakeWorker.spawned, '依頼のたびに起動している').toBe(1);
    expect(worker().seen.map((m) => m.payload)).toEqual(['a', 'b', 'c']);
    worker().respondAll((id) => `r${id}`);
    await expect(Promise.all(ps)).resolves.toEqual(['r1', 'r2', 'r3']);
  });

  it('起動が失敗しても待っている依頼を必ず落とす(永久 hang を作らない)', async () => {
    const clock = fakeClock();
    const lease = new WorkerLease({
      spawn: () => {
        throw new Error('boom');
      },
      idleMs: 1000,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      name: 'broken',
    });
    await expect(lease.run('a')).rejects.toThrow(/spawn failed/);
  });

  it('transfer をそのまま渡す(ゼロコピー)', async () => {
    const { lease, worker } = makeLease();
    const buf = new ArrayBuffer(8);
    const p = lease.run('a', [buf]);
    expect(worker().transfers[0]).toEqual([buf]);
    worker().respondAll();
    await p;
  });

  /**
   * 🔴 **worker が生きている状態の transfer**(P8 段⑲)。
   *
   * `run()` には経路が 2 本ある ── worker が居なければ buffer に積んで `flush()`
   * が送り、居れば**その場で** `postMessage` する。上の test が通るのは
   * **1 件目(buffer 経路)だけ**で、直接ディスパッチ経路は無検査だった。
   * 実運用(`asset-client.ts` の `run(job, [job.bytes])`)は 2 件目以降ぜんぶ
   * こちらを通るので、ここが落ちると**添付 20 件のうち 19 件が丸ごとコピー**になる
   * ── user 指示 2026-07-27「ゼロコピー」の当の違反で、画面には何も出ない。
   */
  it('🔴 worker が生きているときも transfer を渡す(2 件目以降が copy に落ちない)', async () => {
    const { lease, worker } = makeLease();
    const first = lease.run('a');
    worker().respondAll();
    await first;
    expect(lease.alive, 'worker が生きていない(この経路を測れていない)').toBe(true);

    const buf = new ArrayBuffer(8);
    const p = lease.run('b', [buf]);
    // ⚠ **溜めていない**ことも見る(溜まっていたら 1 件目と同じ経路になる)
    expect(worker().seen.map((m) => m.payload), '直接ディスパッチしていない').toEqual(['a', 'b']);
    expect(worker().transfers[1], '2 件目の transfer が落ちている').toEqual([buf]);
    worker().respondAll();
    await p;
  });
});

describe('🔴 アイドルで kill と解放', () => {
  it('🔴 応答が返って一定時間たつと terminate される', async () => {
    const { lease, clock, worker } = makeLease(1000);
    const p = lease.run('a');
    const w = worker();
    w.respondAll();
    await p;
    expect(lease.alive).toBe(true);
    clock.advance(999);
    expect(lease.alive, '早すぎる kill').toBe(true);
    clock.advance(2);
    expect(w.terminated, 'アイドルでも終了していない').toBe(true);
    expect(lease.alive).toBe(false);
  });

  it('🔴 **他がまだ飛んでいる間は殺さない**(1 件返っただけで畳まない)', async () => {
    // 🔴 ここが本丸。⚠ 当初は「1 件だけ投げて時計を進める」で見ていたが、
    // その形では**予約がそもそも張られない**ので空振りだった(変異試験で判明)。
    // 予約が張られるのは**応答が返った時**なので、
    // 「2 件投げて 1 件だけ返す」= 予約が張られ、かつ 1 件が飛んでいる状態を作る
    const { lease, clock, worker } = makeLease(1000);
    const first = lease.run('a');
    const second = lease.run('b');
    const w = worker();
    // 1 件目だけ返す(2 件目はまだ飛んでいる)
    w.onmessage?.({ data: { id: 1, ok: true, result: 'r1' } } as MessageEvent<unknown>);
    await expect(first).resolves.toBe('r1');
    clock.advance(5000); // アイドル時間を大幅に超える
    expect(w.terminated, '飛んでいるジョブごと殺した').toBe(false);
    expect(lease.alive).toBe(true);
    w.respondAll(() => 'r2');
    await expect(second).resolves.toBe('r2');
    // 全部返ってから初めて畳まれる
    clock.advance(1001);
    expect(w.terminated).toBe(true);
  });

  it('kill されたあと、次の依頼で黙って作り直す', async () => {
    const { lease, clock, worker } = makeLease(1000);
    const p1 = lease.run('a');
    worker().respondAll();
    await p1;
    clock.advance(1001);
    expect(lease.alive).toBe(false);

    const p2 = lease.run('b');
    expect(FakeWorker.spawned, '作り直していない').toBe(2);
    worker().respondAll(() => 'second');
    await expect(p2).resolves.toBe('second');
  });

  it('⚠ アイドル予約は投函で畳む(タイマーを積み残さない)', async () => {
    const { lease, clock, worker } = makeLease(1000);
    const p1 = lease.run('a');
    worker().respondAll();
    await p1;
    expect(clock.armed).toBe(1);
    const p2 = lease.run('b');
    expect(clock.armed, 'アイドル予約が残ったまま次を投げている').toBe(0);
    worker().respondAll();
    await p2;
    expect(clock.armed).toBe(1);
  });
});

describe('🔴 落ちたとき・畳むとき(永久 hang を作らない)', () => {
  it('worker が落ちたら待っている依頼を全部 reject し、次で作り直す', async () => {
    const { lease, worker } = makeLease();
    const p = lease.run('a');
    const first = worker();
    first.crash('load failed');
    await expect(p).rejects.toThrow(/load failed/);
    expect(first.terminated, '落ちた worker を捨てていない').toBe(true);

    const p2 = lease.run('b');
    expect(FakeWorker.spawned).toBe(2);
    worker().respondAll(() => 'ok');
    await expect(p2).resolves.toBe('ok');
  });

  it('🔴 dispose すると待っている依頼が reject される', async () => {
    const { lease, worker } = makeLease();
    const p = lease.run('a');
    const w = worker();
    lease.dispose();
    await expect(p).rejects.toThrow(/disposed/);
    expect(w.terminated).toBe(true);
    await expect(lease.run('b')).rejects.toThrow(/disposed/);
  });

  it('worker が返したエラーはその依頼だけ落とす(他は生きている)', async () => {
    const { lease, worker } = makeLease();
    const bad = lease.run('a');
    const good = lease.run('b');
    const w = worker();
    w.failNext('計算に失敗');
    await expect(bad).rejects.toThrow(/計算に失敗/);
    w.respondAll(() => 'ok');
    await expect(good).resolves.toBe('ok');
  });

  it('未知の id の応答は無視する(古い worker の残響で壊れない)', async () => {
    const { lease, worker } = makeLease();
    const p = lease.run('a');
    const w = worker();
    w.onmessage?.({ data: { id: 9999, ok: true, result: 'x' } } as MessageEvent<unknown>);
    w.respondAll(() => 'ok');
    await expect(p).resolves.toBe('ok');
  });

  it('busy が待ち + 飛んでいる件数を返す(アイドル判定の土台)', async () => {
    const { lease, worker } = makeLease();
    expect(lease.busy).toBe(0);
    const p1 = lease.run('a');
    const p2 = lease.run('b');
    expect(lease.busy).toBe(2);
    worker().respondAll();
    await Promise.all([p1, p2]);
    expect(lease.busy).toBe(0);
  });
});

describe('使う側から見た振る舞い(MarkdownClient)', () => {
  /** 打鍵の畳み込みは時計で決まるので、時計を握って測る。 */
  function follower(onHtml: (h: string) => void, onError?: (e: unknown) => void) {
    FakeWorker.spawned = 0;
    let w: FakeWorker | null = null;
    const clock = fakeClock();
    let t = 0;
    const client = new MarkdownClient({
      spawn: () => {
        w = new FakeWorker();
        return w as unknown as Worker;
      },
      idleMs: 100_000,
    });
    const f = client.follower(onHtml, onError, {
      quietMs: 500,
      maxWaitMs: 3000,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: () => t,
    });
    return {
      client,
      f,
      worker: () => w!,
      /** 時間を進める(時計と `now` を一緒に動かす ── ずれると意味が変わる)。 */
      advance(ms: number) {
        t += ms;
        clock.advance(ms);
      },
    };
  }

  it('🔴 打鍵ごとには投げない。**止まってから**投げる', () => {
    // > user 指示「1 打鍵ではなく、3 秒周期で差分反映してください」
    const h = follower(() => undefined);
    h.f.push('a');
    h.advance(100);
    h.f.push('ab');
    h.advance(100);
    h.f.push('abc');
    // ⚠ ここまでで 1 度も投げていない(= 打鍵中の仕事はゼロ)
    expect(FakeWorker.spawned, '打鍵のたびに起動している').toBe(0);
    h.advance(500);
    expect(h.worker().seen).toHaveLength(1);
    expect((h.worker().seen[0]!.payload as { text: string }).text).toBe('abc');
    h.client.dispose();
  });

  it('🔴 打ち続けても**上限で必ず反映される**(置いていかれない)', () => {
    // ⚠ 静穏だけだと、打ち続けている間ずっと出ない ── user の言う「3 秒周期」は
    // ここの上限として効く
    const h = follower(() => undefined);
    for (let i = 0; i < 20; i++) {
      h.f.push('x'.repeat(i + 1));
      h.advance(200); // 静穏(500ms)には届かない間隔で打ち続ける
    }
    expect(h.worker().seen.length, '打ち続けている間 1 度も反映されていない').toBeGreaterThan(0);
    // ⚠ 3 秒に 1 回の桁 ── 4 秒ぶん打って 2 回を超えない
    expect(h.worker().seen.length).toBeLessThanOrEqual(2);
    h.client.dispose();
  });

  it('🔴 飛ばすのは 1 件だけで、最新が勝つ', () => {
    const got: string[] = [];
    const h = follower((html) => got.push(html));
    h.f.push('a');
    h.advance(600);
    expect(h.worker().seen).toHaveLength(1);
    // 飛んでいる間に 2 回打つ
    h.f.push('ab');
    h.advance(600);
    h.f.push('abc');
    h.advance(600);
    expect(h.worker().seen, '飛んでいる間に追加で投げた').toHaveLength(1);
    h.worker().respondAll(() => '<p>a</p>');
    return Promise.resolve().then(() => {
      // 🔴 途中の結果は**載せない**(打った文字が消えて見える)
      expect(got, '古い結果を載せた').toEqual([]);
      expect((h.worker().seen[1]!.payload as { text: string }).text).toBe('abc');
      h.worker().respondAll(() => '<p>abc</p>');
      return Promise.resolve().then(() => {
        expect(got).toEqual(['<p>abc</p>']);
        h.client.dispose();
      });
    });
  });

  it('flush はすぐ出す(編集に入った直後に待たせない)', () => {
    const h = follower(() => undefined);
    h.f.push('a');
    h.f.flush();
    expect(h.worker().seen).toHaveLength(1);
    h.client.dispose();
  });

  it('ワーカーが無い環境では、その場で同じ関数を回す(白紙にしない)', async () => {
    // happy-dom は `Worker` を持たない ── 既定はここへ落ちる
    const client = new MarkdownClient();
    expect(client.offloaded, 'この環境では worker は使えないはず').toBe(false);
    const html = await client.render('# 見出し');
    expect(html).toBe(renderMarkdown('# 見出し'));
    expect(html).toContain('<h1');
  });

  it('⚠ 失敗は呼び側へ伝える(白紙で終わらせない)', async () => {
    const client = new MarkdownClient({
      spawn: () => {
        throw new Error('load failed');
      },
    });
    const onErr = vi.fn();
    const follow = client.follower(() => undefined, onErr, { quietMs: 0, maxWaitMs: 0 });
    follow.push('a');
    await new Promise((r) => setTimeout(r, 5));
    expect(onErr).toHaveBeenCalled();
  });
});

/**
 * P8 段⑰: 🔴 **落ちた依頼を可視化へ通す**(レビュー M)。
 *
 * 🔴 直す前は黙って reject していたので、worker が落ちたとき設定のジョブ表の
 * 「待ち / 実行中」が**永久に減らないまま**残り、失敗の件数もどこにも出なかった
 * ── 可視化が嘘をつくと、user も次に見る人も切り分けができない。
 */
describe('落ちたときの可視化(P8 段⑰)', () => {
  it('🔴 worker が落ちたら、待っていた件数ぶん `fail` が記録される', async () => {
    const monitor = new JobMonitor();
    FakeWorker.live.clear();
    const lease = new WorkerLease({
      spawn: () => new FakeWorker() as unknown as Worker,
      monitor,
      name: 'x',
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    const a = lease.run({ n: 1 }).catch(() => 'ng');
    const b = lease.run({ n: 2 }).catch(() => 'ng');
    await Promise.resolve();
    const w = [...FakeWorker.live][0]!;
    w.onerror?.(new ErrorEvent('error', { message: '落ちた' }));
    expect(await a).toBe('ng');
    expect(await b).toBe('ng');

    const lane = monitor.stats().find((l) => l.lane === 'x')!;
    expect(lane.failed, '落ちた件数が可視化に出ていない').toBe(2);
    // 🔴 ここが本丸 ── 表の「待ち / 実行中」が残り続けない
    expect(lane.queued + lane.running, '落ちたのに待ち/実行中が残っている').toBe(0);
    lease.dispose();
  });

  it('🔴 dispose でも同じ(畳んだのに実行中が残らない)', async () => {
    const monitor = new JobMonitor();
    const lease = new WorkerLease({
      spawn: () => new FakeWorker() as unknown as Worker,
      monitor,
      name: 'y',
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    const p = lease.run({ n: 1 }).catch(() => 'ng');
    await Promise.resolve();
    lease.dispose();
    expect(await p).toBe('ng');
    const lane = monitor.stats().find((l) => l.lane === 'y')!;
    expect(lane.queued + lane.running, '畳んだのに待ち/実行中が残っている').toBe(0);
  });
});
