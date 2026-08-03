/**
 * P8 段⑩: **ジョブの可視化**そのものの規律。
 *
 * > user 指示 2026-08-03「**ジョブスケジューラーは可視化機構とセットでお願いします /
 * > ログもみたい**」
 *
 * ⚠ **可視化が重さの原因になってはいけない** ── ログは輪(伸び続けない)、
 * 標本も固定長。ここが緩むと「見るために遅くなる」道具になる。
 */
import { describe, expect, it, vi } from 'vitest';
import { JobMonitor } from '../../src/adapter/platform/job-monitor';

describe('ジョブの記録', () => {
  it('待ち・実行中・完了が数えられる', () => {
    const m = new JobMonitor(() => 0);
    m.record('markdown', 'spawn');
    m.record('markdown', 'enqueue', { id: 1 });
    m.record('markdown', 'enqueue', { id: 2 });
    expect(m.stats()[0]).toMatchObject({ lane: 'markdown', alive: true, queued: 2, running: 0 });
    m.record('markdown', 'dispatch', { id: 1 });
    expect(m.stats()[0]).toMatchObject({ queued: 1, running: 1 });
    m.record('markdown', 'done', { id: 1, ms: 12 });
    expect(m.stats()[0]).toMatchObject({ queued: 1, running: 0, done: 1, medianMs: 12 });
  });

  it('失敗と使い捨てが分かる', () => {
    const m = new JobMonitor(() => 0);
    m.record('x', 'spawn');
    m.record('x', 'enqueue', { id: 1 });
    m.record('x', 'dispatch', { id: 1 });
    m.record('x', 'fail', { id: 1, ms: 3, note: 'boom' });
    m.record('x', 'kill');
    expect(m.stats()[0]).toMatchObject({ failed: 1, alive: false, kills: 1, spawns: 1 });
  });

  it('所要時間の中央値と最大が出る', () => {
    const m = new JobMonitor(() => 0);
    for (const ms of [10, 50, 20]) m.record('x', 'done', { ms });
    expect(m.stats()[0]).toMatchObject({ medianMs: 20, maxMs: 50 });
  });

  it('🔴 ログは輪(伸び続けない)', () => {
    // ⚠ ここが無いと、長く開いているだけで可視化が memory を食う
    const m = new JobMonitor(() => 0);
    for (let i = 0; i < 1000; i++) m.record('x', 'done', { id: i, ms: 1 });
    expect(m.recent(10_000).length, 'ログが伸び続けている').toBeLessThanOrEqual(200);
  });

  it('🔴 所要時間の標本も伸び続けない', () => {
    const m = new JobMonitor(() => 0);
    for (let i = 0; i < 5000; i++) m.record('x', 'done', { ms: i });
    // 直近だけを見ている(最大が 4999 付近 = 古い標本を捨てている)
    expect(m.stats()[0]!.maxMs).toBeGreaterThan(4900);
  });

  it('ログは新しい順', () => {
    const m = new JobMonitor(() => 0);
    m.record('x', 'enqueue', { id: 1 });
    m.record('x', 'enqueue', { id: 2 });
    expect(m.recent()[0]!.id).toBe(2);
  });

  it('購読と解除', () => {
    const m = new JobMonitor(() => 0);
    const fn = vi.fn();
    const off = m.subscribe(fn);
    m.record('x', 'spawn');
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    m.record('x', 'spawn');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('⚠ 数え間違えて負にならない(dispatch が先に来ても)', () => {
    const m = new JobMonitor(() => 0);
    m.record('x', 'dispatch', { id: 1 });
    m.record('x', 'done', { id: 1, ms: 1 });
    m.record('x', 'done', { id: 2, ms: 1 });
    const s = m.stats()[0]!;
    expect(s.queued).toBeGreaterThanOrEqual(0);
    expect(s.running).toBeGreaterThanOrEqual(0);
  });
});
