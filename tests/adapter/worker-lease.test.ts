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
  it('🔴 打鍵に追従するとき、飛ばすのは 1 件だけで最新が勝つ', async () => {
    const { MarkdownClient } = await import(
      '../../src/adapter/platform/render/markdown-client'
    );
    FakeWorker.spawned = 0;
    let w: FakeWorker | null = null;
    const client = new MarkdownClient({
      spawn: () => {
        w = new FakeWorker();
        return w as unknown as Worker;
      },
      idleMs: 100_000,
    });
    const got: string[] = [];
    const follow = client.follower((html) => got.push(html));
    follow.push('a');
    follow.push('ab');
    follow.push('abc');
    // ⚠ 飛んでいるのは 1 件だけ ── 3 件同時に投げていない
    expect(w!.seen).toHaveLength(1);
    expect((w!.seen[0]!.payload as { text: string }).text).toBe('a');
    w!.respondAll(() => '<p>a</p>');
    await new Promise((r) => setTimeout(r, 0));
    // 🔴 途中の結果は**載せない**(打った文字が消えて見える)
    expect(got, '古い結果を載せた').toEqual([]);
    // 畳まれた最新(abc)が飛んでいる
    expect((w!.seen[1]!.payload as { text: string }).text).toBe('abc');
    w!.respondAll(() => '<p>abc</p>');
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual(['<p>abc</p>']);
    client.dispose();
  });

  it('ワーカーが無い環境では、その場で同じ関数を回す(白紙にしない)', async () => {
    const [{ MarkdownClient }, { renderMarkdown }] = await Promise.all([
      import('../../src/adapter/platform/render/markdown-client'),
      import('../../src/features/markdown/markdown-render'),
    ]);
    // happy-dom は `Worker` を持たない ── 既定はここへ落ちる
    const client = new MarkdownClient();
    expect(client.offloaded, 'この環境では worker は使えないはず').toBe(false);
    const html = await client.render('# 見出し');
    expect(html).toBe(renderMarkdown('# 見出し'));
    expect(html).toContain('<h1');
  });

  it('⚠ 失敗は呼び側へ伝える(白紙で終わらせない)', async () => {
    const { MarkdownClient } = await import(
      '../../src/adapter/platform/render/markdown-client'
    );
    const client = new MarkdownClient({
      spawn: () => {
        throw new Error('load failed');
      },
    });
    const onErr = vi.fn();
    const follow = client.follower(() => undefined, onErr);
    follow.push('a');
    await new Promise((r) => setTimeout(r, 0));
    expect(onErr).toHaveBeenCalled();
  });
});
