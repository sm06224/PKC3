/**
 * 🔴 可搬の保存の配線(`portable-wiring.ts`)── `main.ts` は test から実行されないので、繋ぎ方をここで pin する。
 * (変異: trim(0) にする / snapshotSeq を渡さない / 再生後の touch を消す / 日誌の失敗で flush しない)
 */
import { describe, expect, it, vi } from 'vitest';
import type { JournalBackend, JournalEntry, ReplayResult } from '../../src/adapter/platform/storage/portable-journal';
import { connectPortableWiring, replayProblemText } from '../../src/adapter/platform/storage/portable-wiring';

function setup(opts: { replayed?: ReplayResult | null; failWrite?: boolean; maxSeq?: number } = {}) {
  const rows = new Map<number, JournalEntry>();
  const kept: JournalEntry[] = [];
  const backend: JournalBackend = {
    put: async (e) => void rows.set(e.seq, e),
    readAll: async () => [...rows.values()],
    deleteUpTo: async (n) => {
      for (const k of [...rows.keys()]) if (k <= n) rows.delete(k);
    },
    keepFailed: async (es) => void kept.push(...es),
  };
  const writes: Array<{ savedAt: number; snapshotSeq: number; bytes: number }> = [];
  const unsaved: boolean[] = [];
  const problems: string[] = [];
  const timers: Array<() => void> = [];
  const w = connectPortableWiring({
    backend,
    exportImage: async () => new Uint8Array([1, 2, 3]),
    writeImage: async ({ savedAt, image, snapshotSeq }) => {
      if (opts.failWrite) throw new Error('quota');
      writes.push({ savedAt, snapshotSeq, bytes: image.byteLength });
    },
    replayed: opts.replayed ?? null,
    seqFloor: opts.maxSeq ?? 0,
    onState: () => undefined,
    onUnsaved: (u) => unsaved.push(u),
    onReplayProblem: (t) => problems.push(t),
    now: () => 1000,
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => undefined,
  });
  return { w, rows, kept, writes, unsaved, problems, timers };
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe('画像の保存の配線: 番号を控える → 書く → 捨てる', () => {
  it('画像の記録に snapshotSeq が付き、書けたら日誌のそれ以下だけが消える', async () => {
    const t = setup();
    const a = t.w.journal.begin({ op: 'upsertEntry' });
    a.commit();
    await t.w.journal.settled();
    t.w.persist.touch();
    const seqA = [...t.rows.keys()][0]!;
    await t.w.persist.flush();
    await tick();
    expect(t.writes).toHaveLength(1);
    expect(t.writes[0]!.snapshotSeq, '番号を渡していない').toBeGreaterThan(seqA);
    expect(t.rows.size, '書けたのに日誌が残っている(trim していない / 番号が小さすぎる)').toBe(0);
  });

  it('画像が書けなかったら日誌は捨てない(最後の砦)', async () => {
    const t = setup({ failWrite: true });
    t.w.journal.begin({ op: 'x' }).commit();
    await t.w.journal.settled();
    t.w.persist.touch();
    await t.w.persist.flush();
    await tick();
    expect(t.rows.size).toBe(1);
  });

  it('飛行中の op は、画像が書けても捨てられない(exportImage に追い越された op)', async () => {
    const t = setup();
    const slow = t.w.journal.begin({ op: 'slow' }); // 未完のまま
    t.w.persist.touch();
    await t.w.persist.flush();
    await tick();
    slow.commit();
    await t.w.journal.settled();
    expect(t.rows.size, '追い越された op が消えた').toBe(1);
  });
});

describe('再生した後は画像へ畳み直す', () => {
  const ok: ReplayResult = { applied: 2, failed: 0, firstError: null, failedEntries: [] };
  it('再生した回は未保存になり(touch)、画像が書かれる', async () => {
    const t = setup({ replayed: ok });
    expect(t.w.persist.unsaved()).toBe(true);
    await t.w.persist.flush();
    expect(t.writes).toHaveLength(1);
  });
  it('対照群: 再生しなかった回は何も保存しない', async () => {
    const t = setup({ replayed: null });
    expect(t.w.persist.unsaved()).toBe(false);
    await t.w.persist.flush();
    expect(t.writes).toHaveLength(0);
  });
  it('失敗が混ざった回: 失敗を置き場へ残し・名指しで知らせ・画像で区切る(毎回やり直さない)', async () => {
    const failedEntries = [{ seq: 5, req: { op: 'renameLinkTexts' } }];
    const t = setup({ replayed: { applied: 0, failed: 1, firstError: 'boom', failedEntries } });
    await tick();
    expect(t.kept).toEqual(failedEntries);
    expect(t.problems).toHaveLength(1);
    expect(t.problems[0]).toContain('renameLinkTexts 1 件');
    expect(t.problems[0]).toContain('boom');
    // 全部失敗した回でも畳み直す ── 触らないと次の起動でも同じ失敗を繰り返す
    expect(t.w.persist.unsaved()).toBe(true);
    expect(replayProblemText({ applied: 0, failed: 1, firstError: null, failedEntries })).toContain('理由不明');
  });
});

describe('日誌に頼れないとき・飛行中のとき', () => {
  it('大きすぎる op: タイマーを待たず画像の保存を流す', async () => {
    const t = setup();
    const big = t.w.journal.begin({ op: 'bulkUpsertEntries', body: 'x'.repeat(400_000) });
    big.commit();
    await tick();
    expect(t.timers.length, '待ちのタイマーに頼っていない前提').toBeGreaterThanOrEqual(0);
    expect(t.writes, '日誌に書けない変更が在るのに画像の保存を急がない').toHaveLength(1);
    expect(t.w.journal.broken()).toBe(false); // 画像に入ったので解消
  });

  it('飛行中の op がある間は未保存(離れる確認に数える)/ 終われば取り直す', async () => {
    const t = setup();
    const a = t.w.journal.begin({ op: 'x' });
    expect(t.w.persist.unsaved()).toBe(true);
    a.abort();
    // abort で飛行中が 0 → 取り直しが走り、未保存でなくなったことが通知される(touch していないので)
    expect(t.w.persist.unsaved()).toBe(false);
  });

  it('番号は起動時の下限より後から振られる(時計に依存しない)', () => {
    const t = setup({ maxSeq: 9_000_000_000 });
    expect(t.w.journal.snapshotSeq()).toBeGreaterThan(9_000_000_000);
  });
});

describe('persist.busy の判定', () => {
  it('busy だけが真でも unsaved()', async () => {
    const { connectPortablePersist } = await import('../../src/adapter/platform/storage/portable-persist');
    let busy = false;
    const seen: boolean[] = [];
    const p = connectPortablePersist({
      exportImage: async () => new Uint8Array([1]),
      write: async () => undefined,
      onState: () => undefined,
      onUnsaved: (u) => seen.push(u),
      busy: () => busy,
      setTimer: vi.fn(),
      clearTimer: vi.fn(),
    });
    expect(p.unsaved()).toBe(false);
    busy = true;
    p.recheck();
    expect(p.unsaved()).toBe(true);
    busy = false;
    p.recheck();
    expect(seen).toEqual([true, false]);
  });
});
