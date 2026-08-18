/**
 * asset 操作の相互排他(P4b review F1)。
 *
 * これは **実証済みのデータ消失**を止めている機構だが、main.ts の中に
 * 閉じ込めていたので test から触れず、gate を無効化する mutation が
 * 269 件を素通りしていた(P6b review M22)。実体を出したのでここで pin する。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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

/**
 * 🔴 **asset を書く経路が、1 つ残らず gate の内側に居る**(#250 で足した)。
 *
 * ⚠ 機構(`createAssetGate`)は上で pin されているが、**呼び忘れ**は誰も見て
 * いなかった ── 実際 #250 の貼付は、最初 gate の**外**に書いていた
 * (「bytes は在るが参照が無い」窓を、添付より**長く**持つ経路である)。
 * ⚠ `main.ts` は**どの test からも実行されない**(原文を読む test しか無い)ので、
 * ここは原文 pin で妥協する ── 弱いと自覚して使う(CLAUDE.md §2)。
 */
describe('asset を書く経路は gate の内側(原文 pin)', () => {
  it('🔴 gate の外で asset を書いていない', () => {
    const lines = readFileSync('src/main.ts', 'utf-8').split('\n');
    /** asset の bytes / meta を書く口。⚠ **増えたらここに足す**。 */
    const WRITERS = [
      'storeAsset(',
      'attachFiles(dispatcher',
      'attachOne(dispatcher',
      'runExplicitPurge(',
    ];
    /**
     * その行を**囲んでいる**ブロックの開き行を、内側から順に返す。
     *
     * ⚠ 「近くに `withAssetGate` の字が在るか」では**駄目**だった ── 隣の
     * サービス(`attachFiles: … withAssetGate(…)`)に満たされて、gate の外へ
     * 出す変異が **SURVIVED** した(CLAUDE.md §1「範囲が広すぎて別のものに
     * 満たされる」)。囲んでいる行だけを見る。
     */
    const enclosers = (at: number): string[] => {
      const out: string[] = [];
      let depth = 0;
      for (let i = at - 1; i >= 0; i -= 1) {
        const line = lines[i]!;
        for (let c = line.length - 1; c >= 0; c -= 1) {
          const ch = line[c];
          if (ch === '}') depth += 1;
          else if (ch === '{') {
            if (depth === 0) out.push(line);
            else depth -= 1;
          }
        }
      }
      return out;
    };
    const sites: string[] = [];
    const naked: string[] = [];
    lines.forEach((line, i) => {
      if (!WRITERS.some((w) => line.includes(w))) return;
      const label = `${i + 1}: ${line.trim().slice(0, 60)}`;
      sites.push(label);
      // 自分の行に書いてある形(`… => void withAssetGate(() => attachFiles(…))`)も許す
      if (line.includes('withAssetGate')) return;
      if (!enclosers(i).some((l) => l.includes('withAssetGate'))) naked.push(label);
    });
    // 空振り防止 ── 口の名前が変わって 0 件になったら「全部通った」と言わない
    expect(sites.length, '書く口が 1 つも見つからない(名前が変わった?)').toBeGreaterThanOrEqual(4);
    expect(naked, 'gate の外で asset を書いている').toEqual([]);
  });
});
