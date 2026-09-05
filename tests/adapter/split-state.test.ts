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
import { connectStoreEffects, type StorePort } from '../../src/adapter/state/store-effects';
import { SPLIT_PINNED_MAX, STACK_MAX } from '../../src/features/split-frames';

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

  /**
   * 🔴 **満杯は「積める上限」(20)であって、横に出せる数(3)ではない**
   * (#633 段①。user 裁定 2026-09-02)。
   * ⚠ 直す前は同じ数だったので、**4 件目を載せようとすると断られて**いた。
   */
  it('🔴 満杯なら足さず、理由を言う(古い物を黙って落とさない)', () => {
    const d = booted(STACK_MAX + 2);
    for (let i = 0; i < STACK_MAX; i += 1)
      d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: `n${i + 1}` });
    // ⚠ 前提: 満杯であること(空振りで通っていない)
    expect(d.getState().splitLids).toHaveLength(STACK_MAX);
    const top = d.getState().splitLids[0];
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: `n${STACK_MAX + 1}` });
    expect(d.getState().splitLids).toHaveLength(STACK_MAX);
    expect(d.getState().splitLids[0], '満杯なのに並びが動いた').toBe(top);
    expect(d.getState().notice).toContain(String(STACK_MAX));
  });

  /**
   * 🔑 **横に出せる数を超えても載せられる**(#633 裁定④)── 出ないぶんは帯の札で残る。
   * ⚠ 直す前はここで「横に並べられるのは 3 件までです」と断っていた。
   */
  it('🔑 横に出せる数(3)を超えても載せられる(帯に残る)', () => {
    const d = booted(SPLIT_PINNED_MAX + 2);
    for (let i = 0; i < SPLIT_PINNED_MAX + 1; i += 1)
      d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: `n${i + 1}` });
    expect(d.getState().splitLids, '横に出せる数で断られた').toHaveLength(SPLIT_PINNED_MAX + 1);
    expect(d.getState().notice, '載せられたのに断り文を出した').toBeNull();
    // 🔑 新しく載せた物が先頭(= 本文のすぐ隣)
    expect(d.getState().splitLids[0]).toBe(`n${SPLIT_PINNED_MAX + 1}`);
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

  /**
   * 🔴 **降ろしたことを 1 行言う**(#633 段①)。直す前は無言だった ── user から見ると
   *   「札が勝手に消えた」で、なぜ消えたのかがどこにも出ない(dead click の裏返し)。
   * ⚠ 題名は**降ろす前の** `entryMetas` から引く(消した後では引けない)。
   */
  it('🔴 載せていたノートを消すと「消えたので降ろした」と題名つきで言う', () => {
    const d = booted();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'n2' });
    // ⚠ 前提: いまは何も知らせていない(前の知らせに救われない)
    expect(d.getState().notice).toBeNull();
    d.dispatch({ type: 'DELETE_ENTRIES', lids: ['n2'] });
    expect(d.getState().notice).toBe('「ノート 2」は消えたのでスタックから降ろしました');
  });

  it('⚠ 載せていないノートを消しても、スタックの話はしない(対照群)', () => {
    const d = booted();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'n2' });
    d.dispatch({ type: 'DELETE_ENTRIES', lids: ['n3'] });
    expect(d.getState().notice).toBeNull();
    expect(d.getState().splitLids).toEqual(['n2']);
  });

  /**
   * 🔴 **効果層の自己修復も同じ字で言う**(`store-effects.ts` が本文 `null` で撃つ形)。
   * ⚠ 題名が引けないとき(別タブで消され `entryMetas` からも落ちた後)は「消えたノート」。
   */
  it('🔴 本文が無くて降ろす(gone)ときも言う ── 題名が引けなければ「消えたノート」', () => {
    const d = booted();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'n2' });
    d.dispatch({ type: 'UNPIN_SPLIT_ENTRY', lid: 'n2', gone: true });
    expect(d.getState().splitLids).toEqual([]);
    expect(d.getState().notice).toBe('「ノート 2」は消えたのでスタックから降ろしました');
    // 題名が引けない形: 先に metas から消えている lid を復元で載せてから降ろす
    const e = booted();
    e.dispatch({ type: 'SPLIT_RESTORED', lids: ['ghost'] });
    expect(e.getState().splitLids, '前提: 知らない lid も復元は落とさない').toEqual(['ghost']);
    e.dispatch({ type: 'UNPIN_SPLIT_ENTRY', lid: 'ghost', gone: true });
    expect(e.getState().notice).toBe('「消えたノート」は消えたのでスタックから降ろしました');
  });

  /**
   * 🔴 **効果層が本物の `gone` を添えているか**(`store-effects.ts` の本文 `null` の枝)。
   * ⚠ 上の reducer の test だけでは、効果層が `gone` を落とす変異が生き延びる
   *   (CLAUDE.md §7「両端が相手を模した stub と話していると、綴りの食い違いが緑のまま通る」)。
   *   ここは**実物の効果層**に、本文の無い store を繋いで見る。
   */
  it('🔴 効果層: 本文が無いノートを載せると、降ろして「消えた」と言う(実物の配線)', async () => {
    const d = booted();
    const store = {
      getBody: () => Promise.resolve(null),
    } as unknown as StorePort;
    const off = connectStoreEffects(d, store);
    try {
      d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'n2' });
      // ⚠ 前提: 載った(reducer は metas に居る物を載せる)
      expect(d.getState().splitLids).toEqual(['n2']);
      for (let i = 0; i < 10 && d.getState().splitLids.length > 0; i += 1) await Promise.resolve();
      expect(d.getState().splitLids, '本文が無いのに降りていない').toEqual([]);
      expect(d.getState().notice).toBe('「ノート 2」は消えたのでスタックから降ろしました');
    } finally {
      off();
    }
  });

  it('🔴 対照群: user が × で降ろしたときは何も言わない(消えたと嘘を言わない)', () => {
    const d = booted();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'n2' });
    d.dispatch({ type: 'UNPIN_SPLIT_ENTRY', lid: 'n2' });
    expect(d.getState().splitLids).toEqual([]);
    expect(d.getState().notice).toBeNull();
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
