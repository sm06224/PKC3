/** @vitest-environment happy-dom */
/**
 * 🔴 **飛んでいる書込が着地するのを待てる**(`connectStoreEffects().settled()`)。
 *
 * 直したバグ(2026-08-17 実測): 書込は effect 層の **1 本の chain に直列化**される
 * のに、書き出しの読み(`getBody`)は**その外**から worker を直に叩くので、
 * 並んでいる書込を**追い越す**。実ブラウザで保存の 90ms 後に Word を押すと
 * **11/12 が保存前の本文**を書き出した(800ms 待つ対照群は 0/12)。
 *
 * ⚠ ここが見るのは**待てること**だけ。「書き出しが実際に待つか」は
 * `tests/adapter/export-entry-guard.test.ts` が出口ごとに見る(CLAUDE.md §7)。
 */
import { describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const meta = (lid: string): EntryMeta => ({
  lid,
  title: 't',
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
});

/**
 * 待ち行列を**一巡させる**。
 * ⚠ `await Promise.resolve()` を数回では足りない ── promise の鎖は微小タスクを
 * 何段も進むので、**「まだ返っていない」の観測点が早すぎる**と、待っていない実装でも
 * 緑になる(変異試験 S4 が実際に生き延びた)。macrotask を挟んで全部流す。
 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/** 手で開けられる門(= 書込が「まだ着いていない」状態を作る)。 */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

/** 1 件のノートを編集して保存する(= PERSIST_ENTRY を 1 つ積む)。 */
function commit(d: Dispatcher, lid: string, body: string): void {
  d.dispatch({ type: 'SELECT_ENTRY', lid });
  d.dispatch({ type: 'BODY_LOADED', lid, body: '' });
  d.dispatch({ type: 'START_EDIT' });
  d.dispatch({ type: 'UPDATE_OPEN_BODY', body });
  d.dispatch({ type: 'COMMIT_EDIT' });
}

function setup(persist: (body: string) => Promise<void>) {
  const d = new Dispatcher();
  const written: string[] = [];
  const effects = connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '',
    persistEntry: async (e) => {
      await persist(e.body);
      written.push(e.body);
      return stubStamps();
    },
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  return { d, effects, written };
}

describe('書込の着地を待つ(settled)', () => {
  it('🔴 飛んでいる書込が終わるまで返らない', async () => {
    const g = gate();
    const { d, effects, written } = setup(() => g.wait);
    commit(d, 'n1', '新しい本文');

    let done = false;
    const p = effects.settled().then(() => {
      done = true;
    });
    // ⚠ 待ち行列を一巡させても、門が閉じている間は返らない
    await flush();
    expect(done, '書込が終わっていないのに返った').toBe(false);
    expect(written).toHaveLength(0);

    g.open();
    await p;
    expect(done).toBe(true);
    expect(written).toEqual(['新しい本文']);
  });

  /**
   * ⚠ **待っている間に積まれた仕事も待つ** ── chain の tail は `enqueue` が
   * 差し替えるので、1 度 await しただけでは「待ち始めた時点の分」しか見ない。
   */
  it('🔴 待っている間に積まれた書込も待つ', async () => {
    const first = gate();
    const second = gate();
    let n = 0;
    const { d, effects, written } = setup(() => (n++ === 0 ? first.wait : second.wait));
    commit(d, 'n1', '1 本目');

    let done = false;
    const p = effects.settled().then(() => {
      done = true;
    });
    // 1 本目が飛んでいる最中に 2 本目を積む
    commit(d, 'n1', '2 本目');
    first.open();
    await flush();
    expect(done, '2 本目を置き去りにして返った').toBe(false);

    second.open();
    await p;
    expect(written).toEqual(['1 本目', '2 本目']);
  });

  it('⚠ 何も飛んでいなければ、すぐ返る(待ちっぱなしにしない)', async () => {
    const { effects } = setup(async () => {});
    await expect(effects.settled()).resolves.toBeUndefined();
  });

  it('⚠ 書込が失敗しても返る(chain は `then(op, op)` なので死なない)', async () => {
    const { d, effects } = setup(async () => {
      throw new Error('disk full');
    });
    commit(d, 'n1', 'x');
    await expect(effects.settled()).resolves.toBeUndefined();
  });
});
