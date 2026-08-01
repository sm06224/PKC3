/**
 * asset 操作の相互排他(P4b review F1)。
 *
 * これは **実証済みのデータ消失**を止めている機構だが、main.ts の中に
 * 閉じ込めていたので test から触れず、gate を無効化する mutation が
 * 269 件を素通りしていた(P6b review M22)。実体を出したのでここで pin する。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { createAssetGate } from '../../src/adapter/ui/actions/asset-gate';

const boot = (): Dispatcher => {
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  return d;
};

describe('createAssetGate', () => {
  it('実行中の 2 本目は**走らせずに**可視で断る', async () => {
    const d = boot();
    const gate = createAssetGate(d);
    const ran: string[] = [];

    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    const first = gate(async () => {
      ran.push('first');
      await blocked;
    });

    // 1 本目が await 中に 2 本目(整理 / 別の取込)が来る
    await gate(async () => {
      ran.push('second');
    });
    expect(ran).toEqual(['first']); // 2 本目の body は**実行されない**
    expect(d.getState().error).toMatch(/実行中です/);
    expect(d.getState().error).toMatch(/選び直して/); // 捨てたことが分かる文言
    expect(gate.busy).toBe(true);

    release();
    await first;
    expect(gate.busy).toBe(false);
  });

  it('直列なら通る / throw しても gate は必ず開く', async () => {
    const d = boot();
    const gate = createAssetGate(d);
    const ran: string[] = [];

    await gate(async () => void ran.push('a'));
    await expect(
      gate(async () => {
        ran.push('b');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(gate.busy).toBe(false); // finally で開く(閉じたままなら以後全拒否)
    await gate(async () => void ran.push('c'));
    expect(ran).toEqual(['a', 'b', 'c']);
  });
});
