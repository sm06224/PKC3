/**
 * 🔴 **横に並べて留めたノートの state**(#505 段②)。
 *
 * ⚠ ここで見るのは**実物の reducer を実物の action で動かした結果**である ──
 * 期待値を「規則の別の綴り」で組まない(CLAUDE.md 2026-08-22)。
 * 観測点は「**留めた枠に本文が出るか**」「**外したら消えるか**」
 * 「**主の枠を直したら留めた枠も追いつくか**」の 3 つで、どれも user が見る形である。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { SPLIT_PINNED_MAX } from '../../src/features/split-frames';

/** 起動まで進めた dispatcher。⚠ `new Dispatcher()` は `initializing` である。 */
function booted(n = 3): Dispatcher {
  const d = new Dispatcher();
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: Array.from({ length: n }, (_, i) => ({
      lid: `n${i + 1}`,
      title: `ノート ${i + 1}`,
      archetype: 'text',
      created_at: null,
      updated_at: null,
      entry_order: i + 1,
      status: null,
      date: null,
      archived: 0,
    })) as never,
    relations: [],
  });
  return d;
}

/** その dispatch で出た event の型を並べる。 */
function eventsOf(d: Dispatcher, action: Parameters<Dispatcher['dispatch']>[0]): string[] {
  const seen: string[] = [];
  const off = d.onEvent((e) => seen.push(e.type));
  d.dispatch(action);
  off();
  return seen;
}

describe('留める', () => {
  it('🔴 留めると並びに入り、本文を読みに行く', () => {
    const d = booted();
    const evs = eventsOf(d, { type: 'PIN_SPLIT_ENTRY', lid: 'n2' });
    expect(d.getState().splitLids).toEqual(['n2']);
    expect(evs).toContain('REQUEST_SPLIT_BODY');
  });

  it('🔴 本文が届くと、留めた枠に出る本文になる', () => {
    const d = booted();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'n2' });
    d.dispatch({ type: 'SPLIT_BODY_LOADED', lid: 'n2', body: '# 資料\n本文\n' });
    expect(d.getState().splitBodies.get('n2')).toBe('# 資料\n本文\n');
  });

  it('⚠ 留めていないものの本文が遅れて届いても、拾わない(追い越し)', () => {
    const d = booted();
    d.dispatch({ type: 'SPLIT_BODY_LOADED', lid: 'n2', body: 'あとから' });
    expect(d.getState().splitBodies.has('n2')).toBe(false);
  });

  it('⚠ 既に本文が在るなら読み直さない', () => {
    const d = booted();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'n2' });
    d.dispatch({ type: 'SPLIT_BODY_LOADED', lid: 'n2', body: 'x' });
    d.dispatch({ type: 'UNPIN_SPLIT_ENTRY', lid: 'n2' });
    // ⚠ 外すと本文も落ちるので、留め直したら**読みに行く**のが正しい
    const evs = eventsOf(d, { type: 'PIN_SPLIT_ENTRY', lid: 'n2' });
    expect(evs).toContain('REQUEST_SPLIT_BODY');
  });

  it('🔴 フォルダは断る ── 理由を言う(黙って何も起きないのが dead click)', () => {
    const d = new Dispatcher();
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        {
          lid: 'f1',
          title: '箱',
          archetype: 'folder',
          created_at: null,
          updated_at: null,
          entry_order: 1,
          status: null,
          date: null,
          archived: 0,
        },
      ] as never,
      relations: [],
    });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'f1' });
    expect(d.getState().splitLids).toEqual([]);
    expect(d.getState().notice).toContain('フォルダ');
  });

  it('居ないノートは留まらない(消えた lid を指す枠を作らない)', () => {
    const d = booted();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'zzz' });
    expect(d.getState().splitLids).toEqual([]);
    expect(d.getState().notice).toBeNull();
  });

  it('🔴 満杯なら足さず、理由を言う(古い物を黙って落とさない)', () => {
    const d = booted(SPLIT_PINNED_MAX + 2);
    for (let i = 0; i < SPLIT_PINNED_MAX; i += 1)
      d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: `n${i + 1}` });
    // ⚠ 前提: 満杯であること(空振りで通っていない)
    expect(d.getState().splitLids).toHaveLength(SPLIT_PINNED_MAX);
    const first = d.getState().splitLids[0];
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: `n${SPLIT_PINNED_MAX + 1}` });
    expect(d.getState().splitLids).toHaveLength(SPLIT_PINNED_MAX);
    expect(d.getState().splitLids[0]).toBe(first);
    expect(d.getState().notice).toContain(String(SPLIT_PINNED_MAX));
  });
});

describe('外す(双方向)', () => {
  it('🔴 外すと並びからも本文からも消える', () => {
    const d = booted();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'n2' });
    d.dispatch({ type: 'SPLIT_BODY_LOADED', lid: 'n2', body: 'x' });
    // ⚠ 前提: 出ていたこと
    expect(d.getState().splitBodies.has('n2')).toBe(true);
    d.dispatch({ type: 'UNPIN_SPLIT_ENTRY', lid: 'n2' });
    expect(d.getState().splitLids).toEqual([]);
    expect(d.getState().splitBodies.has('n2')).toBe(false);
  });
});

describe('主の枠で直したら、留めた枠も追いつく', () => {
  it('🔴 同じノートを留めていると、保存が届いたとき本文が入れ替わる', () => {
    const d = booted();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'SPLIT_BODY_LOADED', lid: 'n1', body: '古い\n' });
    d.dispatch({ type: 'BODY_PERSISTED', lid: 'n1', body: '新しい\n' });
    expect(d.getState().splitBodies.get('n1')).toBe('新しい\n');
  });

  it('🔴 別の窓が書いたときも追いつく(編集中でなくても)', () => {
    const d = booted();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'SPLIT_BODY_LOADED', lid: 'n1', body: '古い\n' });
    // ⚠ 前提: いま編集中ではないこと(この経路が早期 return する側)
    expect(d.getState().phase).toBe('ready');
    d.dispatch({ type: 'REMOTE_BODY_CHANGED', lid: 'n1', body: '別窓\n' });
    expect(d.getState().splitBodies.get('n1')).toBe('別窓\n');
  });

  it('⚠ 留めていないノートの書込では、留めの入れ物を作り直さない', () => {
    const d = booted();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'n2' });
    d.dispatch({ type: 'SPLIT_BODY_LOADED', lid: 'n2', body: 'x' });
    const before = d.getState().splitBodies;
    d.dispatch({ type: 'BODY_PERSISTED', lid: 'n3', body: 'よそ' });
    expect(d.getState().splitBodies).toBe(before);
  });
});

describe('消したノートを留めたままにしない', () => {
  it('🔴 消すと留めからも本文からも落ちる(#535 ② と同じ穴を開けない)', () => {
    const d = booted();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'n2' });
    d.dispatch({ type: 'SPLIT_BODY_LOADED', lid: 'n2', body: 'x' });
    expect(d.getState().splitLids).toEqual(['n2']);
    d.dispatch({ type: 'DELETE_ENTRIES', lids: ['n2'] });
    expect(d.getState().splitLids).toEqual([]);
    expect(d.getState().splitBodies.has('n2')).toBe(false);
  });
});

describe('前回の並びを戻す', () => {
  it('🔴 戻すと、その全部を読みに行く', () => {
    const d = booted();
    const evs = eventsOf(d, { type: 'SPLIT_RESTORED', lids: ['n2', 'n3'] });
    expect(d.getState().splitLids).toEqual(['n2', 'n3']);
    expect(evs.filter((e) => e === 'REQUEST_SPLIT_BODY')).toHaveLength(2);
  });

  it('⚠ 知らない lid も一旦は残す(起動順で metas が空のことがある)', () => {
    const d = new Dispatcher();
    d.dispatch({ type: 'SPLIT_RESTORED', lids: ['gone'] });
    expect(d.getState().splitLids).toEqual(['gone']);
  });
});
