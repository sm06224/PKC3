/**
 * 🔴 選択同期の写しの係(#2066 段 5-B)── 定常の手間ゼロ・世代・付け外し・一括解除。
 * worker は偽物(呼ばれた op を数える)。実物の worker は `storage-worker-sync-selective-view.test.ts`。
 */
import { describe, expect, it } from 'vitest';
import { SyncScopeKeeper, SELECTIVE_CLEAR_CONFIRM, type SyncScopeDeps } from '../../src/adapter/ui/actions/sync-scope';
import type { SyncScopeView } from '../../src/features/sync/selective-view';

type Raw = {
  selective: { mode: 'all' | 'selective'; related: 'off' | '1hop' | 'recursive'; directLids: string[] };
  notes: Array<{ lid: string; archetype: string; parentLid: string | null }>;
  relations: Array<{ from: string; to: string; kind: string }>;
  bodyRefs: Record<string, string[]>;
};

function fake(opts: { on?: boolean; raw?: Raw; confirm?: boolean } = {}) {
  let on = opts.on ?? true;
  let raw: Raw = opts.raw ?? { selective: { mode: 'all', related: '1hop', directLids: [] }, notes: [], relations: [], bodyRefs: {} };
  const calls: Array<Record<string, unknown>> = [];
  const published: Array<SyncScopeView | null> = [];
  const problems: string[] = [];
  const confirms: string[] = [];
  const timers: Array<() => void> = [];
  let current: SyncScopeView | null = null;
  const gates: Array<() => void> = [];
  let hold = false;
  const deps: SyncScopeDeps = {
    cid: 'c1',
    enabled: () => on,
    request: (async (req: Record<string, unknown>) => {
      calls.push(req);
      if (hold) await new Promise<void>((r) => gates.push(r));
      if (req.op === 'syncSetSelectiveScope') {
        const s = raw.selective;
        const set = new Set(s.directLids);
        for (const l of (req.add as string[] | undefined) ?? []) set.add(l);
        for (const l of (req.remove as string[] | undefined) ?? []) set.delete(l);
        raw = { ...raw, selective: { mode: (req.mode as 'all') ?? s.mode, related: (req.related as '1hop') ?? s.related, directLids: [...set].sort() } };
        return raw.selective;
      }
      return structuredClone(raw);
    }) as SyncScopeDeps['request'],
    publish: (v) => {
      published.push(v);
      current = v;
    },
    current: () => current,
    confirm: async (m) => {
      confirms.push(m);
      return opts.confirm ?? true;
    },
    reportProblem: (t) => void problems.push(t),
    later: (fn) => {
      timers.push(fn);
      return () => {
        const i = timers.indexOf(fn);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  };
  return {
    keeper: new SyncScopeKeeper(deps),
    calls,
    published,
    problems,
    confirms,
    timers,
    setOn: (v: boolean) => void (on = v),
    setRaw: (r: Raw) => void (raw = r),
    hold: (v: boolean) => void (hold = v),
    release: () => gates.splice(0).forEach((g) => g()),
    current: () => current,
  };
}

const selRaw = (direct: string[]): Raw => ({
  selective: { mode: 'selective', related: 'off', directLids: direct },
  notes: [
    { lid: 'F', archetype: 'folder', parentLid: null },
    { lid: 'n', archetype: 'text', parentLid: 'F' },
    { lid: 'p', archetype: 'text', parentLid: null },
  ],
  relations: [],
  bodyRefs: {},
});

describe('SyncScopeKeeper', () => {
  it('🔴 同期が切: worker に何も聞かず、写しを null にする', async () => {
    const f = fake({ on: false });
    await f.keeper.refresh();
    expect(f.calls).toEqual([]);
    expect(f.published).toEqual([null]);
    // 付け外しも何もしない
    expect(await f.keeper.setDirect('F', true)).toBe(false);
    expect(f.calls.filter((c) => c.op === 'syncSetSelectiveScope')).toEqual([]);
  });

  it('🔴 ワークスペース全体: エントリが動いても読み直さない(束ねの待ちも作らない)', async () => {
    const f = fake();
    await f.keeper.refresh();
    expect(f.calls).toEqual([{ op: 'syncSelectiveView', cid: 'c1' }]);
    expect(f.current()?.mode).toBe('all');
    f.keeper.onEntriesChanged();
    f.keeper.onEntriesChanged();
    expect(f.timers.length, 'ワークスペース全体なのに待ちを作った').toBe(0);
  });

  it('選択同期: エントリが動いたら束ねて 1 回だけ読み直す(対照群: 全体のときは 0 回)', async () => {
    const f = fake({ raw: selRaw(['F']) });
    await f.keeper.refresh();
    f.keeper.onEntriesChanged();
    f.keeper.onEntriesChanged();
    f.keeper.onEntriesChanged();
    expect(f.timers.length).toBe(1);
    f.timers[0]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(f.calls.filter((c) => c.op === 'syncSelectiveView').length).toBe(2);
  });

  it('🔴 フォルダを同期対象にすると配下が即時に descendant、外すと即時に戻る(双方向)', async () => {
    const f = fake({ raw: selRaw([]) });
    await f.keeper.refresh();
    expect(f.current()?.reasons.get('n')).toBeUndefined();
    await f.keeper.setDirect('F', true);
    expect(f.current()?.reasons.get('F')).toBe('direct');
    expect(f.current()?.reasons.get('n')).toBe('descendant');
    expect(f.current()?.reasons.get('p')).toBeUndefined();
    await f.keeper.setDirect('F', false);
    expect(f.current()?.reasons.size).toBe(0);
  });

  it('🔴 世代: 古い読みが後から届いても新しい写しを巻き戻さない', async () => {
    const f = fake({ raw: selRaw(['F']) });
    f.hold(true);
    const first = f.keeper.refresh();
    await new Promise((r) => setTimeout(r, 0));
    f.setRaw(selRaw(['p']));
    const second = f.keeper.refresh();
    await new Promise((r) => setTimeout(r, 0));
    f.release();
    await Promise.all([first, second]);
    expect(f.published.length, '古い読みの結果を出した').toBe(1);
    expect([...(f.current()?.directLids ?? [])]).toEqual(['p']);
  });

  it('読んでいる間に切にされたら写しを出さない(null)', async () => {
    const f = fake({ raw: selRaw(['F']) });
    f.hold(true);
    const p = f.keeper.refresh();
    await new Promise((r) => setTimeout(r, 0));
    f.setOn(false);
    f.release();
    await p;
    expect(f.published).toEqual([null]);
  });

  it('一括解除: 確認を出し、やめたら書かない / 受けたら直接指定を全部外す(ノートは消さない旨を言う)', async () => {
    const f = fake({ raw: selRaw(['F', 'p']), confirm: false });
    await f.keeper.refresh();
    expect(await f.keeper.clearAll()).toBe(false);
    expect(f.confirms).toEqual([SELECTIVE_CLEAR_CONFIRM]);
    expect(SELECTIVE_CLEAR_CONFIRM).toContain('ノート自体は消えません');
    expect(f.calls.some((c) => c.op === 'syncSetSelectiveScope')).toBe(false);
    const g = fake({ raw: selRaw(['F', 'p']) });
    await g.keeper.refresh();
    expect(await g.keeper.clearAll()).toBe(true);
    expect(g.calls.find((c) => c.op === 'syncSetSelectiveScope')).toEqual({ op: 'syncSetSelectiveScope', cid: 'c1', remove: ['F', 'p'] });
    expect(g.current()?.directLids.size).toBe(0);
    // 直接指定が無いときは確認も出さない
    expect(await g.keeper.clearAll()).toBe(false);
  });

  it('書けなかったら知らせて、正本を読み直す', async () => {
    const f = fake({ raw: selRaw([]) });
    await f.keeper.refresh();
    const k = f.keeper as unknown as { deps: SyncScopeDeps };
    const orig = k.deps.request;
    k.deps.request = (async (req: { op: string }) => {
      if (req.op === 'syncSetSelectiveScope') throw new Error('壊れた');
      return orig(req as never);
    }) as SyncScopeDeps['request'];
    expect(await f.keeper.setMode('all')).toBe(false);
    expect(f.problems[0]).toContain('同期対象の設定を保存できませんでした');
    expect(f.published.length).toBe(2);
  });
});
