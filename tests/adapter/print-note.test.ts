/**
 * 🔴 **紙に出す(= PDF)**(#187、2026-08-23)。
 *
 * ⚠ ここが見るのは **`window.print()` を呼ぶ条件**である ── 紙の組み方
 * (`@media print`)は `tests/adapter/print-css.test.ts` と
 * `tests/smoke/print.smoke.spec.ts` が見ている(**2 か所で数えない**)。
 */
import { describe, expect, it } from 'vitest';
import type { AppState, Dispatchable } from '../../src/adapter/state/app-state';
import { printNote, type PrintNoteDeps } from '../../src/adapter/platform/print-note';

/** 必要な field だけ持つ state(器ごと組まない ── 判定はこの 5 つで決まる)。 */
function stateOf(over: Partial<AppState>): AppState {
  return {
    phase: 'ready',
    viewMode: 'detail',
    selectedLid: 'a',
    openBody: { lid: 'a', body: '本文', baseline: '本文' },
    ...over,
  } as unknown as AppState;
}

function harness(initial: Partial<AppState>) {
  let s = stateOf(initial);
  const sent: Dispatchable[] = [];
  const listeners: ((x: AppState) => void)[] = [];
  let prints = 0;
  const deps: PrintNoteDeps = {
    getState: () => s,
    dispatch: (a) => {
      sent.push(a);
    },
    onState: (cb) => {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    print: () => {
      prints += 1;
    },
    // ⚠ 時計は差す ── 実時間を待つ test を書かない(無駄な待機の禁止)
    setTimer: () => 0,
    clearTimer: () => {},
  };
  return {
    deps,
    sent,
    prints: () => prints,
    listenerCount: () => listeners.length,
    /** 外の世界が state を動かす(本文が届く / 面が変わる)。 */
    push: (over: Partial<AppState>) => {
      s = stateOf({ ...initial, ...over });
      for (const cb of [...listeners]) cb(s);
    },
  };
}

/**
 * 🔴 **`print()` は `await` の後にしか来ない**(変異試験 N1 が SURVIVED で教えた、
 * 2026-08-23)。⚠ `push()` の**直後に同期で**数えると、まだ microtask が回って
 * いないので**必ず 0** ── 「刷らなかった」と「まだ刷っていない」が区別できず、
 * **別のノートの本文で刷る変異が生き延びた**。
 * 🔑 CLAUDE.md §1「`async` にした瞬間、それを呼ぶ同期の test は全部空振りになる」。
 */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('printNote(#187 ── 紙に出す口)', () => {
  it('🔴 開いているノートなら、その場で印刷を呼ぶ', async () => {
    const h = harness({});
    expect(await printNote(h.deps, 'a')).toBe('printed');
    expect(h.prints(), '印刷を呼んでいない').toBe(1);
    // ⚠ 既に条件が揃っているなら**余計な dispatch をしない**(面が跳ねる)
    expect(h.sent, '揃っているのに面を動かした').toEqual([]);
  });

  it('🔴 別の面を見ていたら、中央の面へ戻してから刷る', async () => {
    const h = harness({ viewMode: 'query' });
    const p = printNote(h.deps, 'a');
    expect(h.sent, '面を戻していない').toContainEqual({ type: 'SET_VIEW_MODE', mode: 'detail' });
    h.push({ viewMode: 'detail' });
    expect(await p).toBe('printed');
    expect(h.prints()).toBe(1);
  });

  it('🔴 別のノートを選んでいたら、そのノートを開いてから刷る', async () => {
    const h = harness({ selectedLid: 'other', openBody: { lid: 'other', body: 'x' } as never });
    const p = printNote(h.deps, 'a');
    expect(h.sent, '選び直していない').toContainEqual({ type: 'SELECT_ENTRY', lid: 'a' });
    /**
     * ⚠ **選んだだけでは刷らない** ── 本文が届く前に刷ると白紙が出る。
     * 🔴 そして**いちばん危ないのは、前のノートの本文が残っている瞬間**である
     *   (変異試験 N1 が SURVIVED で教えた)。`selectedLid` は先に動き、
     *   `openBody` は worker から遅れて届くので、**この形が実際に起きる** ──
     *   身元を見ないと **B を選んだのに A の本文が紙に出る**。
     */
    h.push({ selectedLid: 'a', openBody: { lid: 'other', body: 'x' } as never });
    await flush();
    expect(h.prints(), '前のノートの本文で刷った').toBe(0);
    h.push({ selectedLid: 'a', openBody: null as never });
    await flush();
    expect(h.prints(), '本文が届く前に刷った').toBe(0);
    h.push({ selectedLid: 'a', openBody: { lid: 'a', body: '本文' } as never });
    expect(await p).toBe('printed');
    expect(h.prints()).toBe(1);
  });

  it('🔴 本文が来なければ刷らない(白紙を配らない)', async () => {
    const h = harness({ selectedLid: 'other', openBody: null as never });
    // ⚠ `setTimer` は**即座に呼ぶ**形にして、実時間を待たずに時間切れを作る
    const deps = { ...h.deps, setTimer: (cb: () => void) => (cb(), 0) };
    expect(await printNote(deps, 'a')).toBe('timeout');
    expect(h.prints(), '本文が無いのに刷った').toBe(0);
    expect(
      h.sent.filter((a) => a.type === 'OP_FAILED'),
      '黙って諦めた(user に理由が出ていない)',
    ).toHaveLength(1);
  });

  it('🔴 編集中は刷らない(見えている 1 画面ぶんしか紙に出ない)', async () => {
    const h = harness({ phase: 'editing' });
    expect(await printNote(h.deps, 'a')).toBe('not-ready');
    expect(h.prints()).toBe(0);
    expect(h.sent.map((a) => a.type), '理由を出していない').toContain('OP_FAILED');
  });

  it('⚠ 待ちを終えたら listener を外す(state が動くたびに刷りにいかない)', async () => {
    const h = harness({ viewMode: 'query' });
    const p = printNote(h.deps, 'a');
    h.push({ viewMode: 'detail' });
    await p;
    expect(h.listenerCount(), '購読を残した').toBe(0);
    // ⚠ 外れているので、もう一度 state が動いても刷らない
    h.push({ viewMode: 'detail' });
    await flush();
    expect(h.prints(), '購読が残っていて二度刷った').toBe(1);
  });
});
