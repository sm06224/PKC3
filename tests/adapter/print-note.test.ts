/**
 * 🔴 **紙に出す(= PDF)**(#187、2026-08-23)。
 *
 * ⚠ ここが見るのは **`window.print()` を呼ぶ条件**である ── 紙の組み方
 * (`@media print`)は `tests/adapter/print-css.test.ts` と
 * `tests/smoke/print.smoke.spec.ts` が見ている(**2 か所で数えない**)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AppState, Dispatchable } from '../../src/adapter/state/app-state';
import { printNote, type PrintNoteDeps } from '../../src/adapter/platform/print-note';

/** 必要な field だけ持つ state(器ごと組まない ── 判定はこの 5 つで決まる)。 */
function stateOf(over: Partial<AppState>): AppState {
  return {
    phase: 'ready',
    viewMode: 'detail',
    selectedLid: 'a',
    openBody: { lid: 'a', body: '本文', baseline: '本文' },
    entryMetas: new Map([['a', {}], ['other', {}]]),
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

  /**
   * 🔴 **刷るために動かした画面は、刷り終えたら元へ戻す**(依頼 71-3)。
   * 一覧の行の「PDF で書き出す」は別のノートを選び直す ── 戻さないと見ていたノートが外れる。
   */
  it('🔴 別のノートを見ていたら、刷った後に元のノートへ戻す', async () => {
    const h = harness({ selectedLid: 'other', openBody: { lid: 'other', body: 'x' } as never });
    const p = printNote(h.deps, 'a');
    h.push({ selectedLid: 'a', openBody: { lid: 'a', body: '本文' } as never });
    expect(await p).toBe('printed');
    expect(h.sent.at(-1), '刷った後に元のノートへ戻していない').toEqual({ type: 'SELECT_ENTRY', lid: 'other' });
  });

  it('🔴 別の面を見ていたら、刷った後にその面へ戻す(選択は戻す前に、面は最後に)', async () => {
    const h = harness({ viewMode: 'query', selectedLid: 'other', openBody: { lid: 'other', body: 'x' } as never });
    const p = printNote(h.deps, 'a');
    h.push({ viewMode: 'detail', selectedLid: 'a', openBody: { lid: 'a', body: '本文' } as never });
    await p;
    const after = h.sent.slice(h.sent.findIndex((a) => a.type === 'SELECT_ENTRY') + 1);
    expect(after, '選択と面の両方を戻していない').toEqual([
      { type: 'SELECT_ENTRY', lid: 'other' },
      { type: 'SET_VIEW_MODE', mode: 'query' },
    ]);
  });

  it('⚠ 動かしていなければ、刷った後に何も撃たない(対照群)', async () => {
    const h = harness({});
    await printNote(h.deps, 'a');
    expect(h.sent, '動かしていないのに画面を触った').toEqual([]);
  });

  it('⚠ 刷っている間に別の場所へ移っていたら、勝手に戻さない', async () => {
    const h = harness({ selectedLid: 'other', openBody: { lid: 'other', body: 'x' } as never });
    const deps = {
      ...h.deps,
      // 印刷の画面を開いている間に、user が別のノート(a 以外)へ移った
      print: () => h.push({ selectedLid: 'third', openBody: { lid: 'third', body: 'y' } as never }),
    };
    const p = printNote(deps, 'a');
    h.push({ selectedLid: 'a', openBody: { lid: 'a', body: '本文' } as never });
    await p;
    expect(
      h.sent.filter((a) => a.type === 'SELECT_ENTRY' && (a as { lid: string }).lid === 'other'),
      '移った先を元のノートで上書きした',
    ).toEqual([]);
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
    ).toHaveLength(1);    // 🔑 押したボタンの名前で言う(画面に「印刷」というボタンは無い。#1087)
    const err = h.sent.find((a) => a.type === 'OP_FAILED') as { error: string } | undefined;
    expect(err?.error).toContain('PDF で書き出せませんでした');
  });

  it('🔴 本文が来ずに諦めたときも、動かした画面を元へ戻す(戻してから知らせる。#1087)', async () => {
    const h = harness({ viewMode: 'query', selectedLid: 'other', openBody: null as never });
    let fire: (() => void) | null = null;
    const deps = { ...h.deps, setTimer: (cb: () => void) => ((fire = cb), 0) };
    const p = printNote(deps, 'a');
    // 刷るために選び直した後の画面(本文はまだ来ない)
    h.push({ viewMode: 'detail', selectedLid: 'a', openBody: null as never });
    fire!();
    expect(await p).toBe('timeout');
    const tail = h.sent.slice(h.sent.findIndex((a) => a.type === 'SELECT_ENTRY') + 1);
    expect(tail.map((a) => a.type), '戻していない / 知らせの後に戻して 1 行を消した').toEqual([
      'SELECT_ENTRY',
      'SET_VIEW_MODE',
      'OP_FAILED',
    ]);
    expect(tail[0]).toEqual({ type: 'SELECT_ENTRY', lid: 'other' });
  });

  it('🔴 待っている間の 2 回目は受けない(戻した後の画面を刷らない。#1087)', async () => {
    const h = harness({ selectedLid: 'other', openBody: { lid: 'other', body: 'x' } as never });
    const p1 = printNote(h.deps, 'a');
    expect(await printNote(h.deps, 'a'), '2 回目を受けた').toBe('busy');
    h.push({ selectedLid: 'a', openBody: { lid: 'a', body: '本文' } as never });
    expect(await p1).toBe('printed');
    await flush();
    expect(h.prints(), '2 回刷った').toBe(1);
    // 対照群:終わった後はまた受ける
    expect(await printNote(h.deps, 'a')).toBe('printed');
  });

  it('🔴 編集中は刷らない(見えている 1 画面ぶんしか紙に出ない)', async () => {
    const h = harness({ phase: 'editing' });
    expect(await printNote(h.deps, 'a')).toBe('not-ready');
    expect(h.prints()).toBe(0);
    expect(h.sent.map((a) => a.type), '理由を出していない').toContain('OP_FAILED');    const err = h.sent.find((a) => a.type === 'OP_FAILED') as { error: string } | undefined;
    expect(err?.error).toContain('PDF で書き出してください');
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

  it('🔴 刷る前に図の用意(prepare)を待つ ── 用意が終わるまで print を呼ばない(#1087)', async () => {
    const h = harness({});
    let release: () => void = () => {};
    const order: string[] = [];
    h.deps.prepare = () =>
      new Promise<void>((resolve) => {
        order.push('prepare-start');
        release = () => {
          order.push('prepare-done');
          resolve();
        };
      });
    const base = h.deps.print;
    h.deps.print = () => {
      order.push('print');
      base();
    };
    const p = printNote(h.deps, 'a');
    await flush();
    expect(order, '用意の途中で刷った').toEqual(['prepare-start']);
    expect(h.prints()).toBe(0);
    release();
    expect(await p).toBe('printed');
    expect(order).toEqual(['prepare-start', 'prepare-done', 'print']);
  });

  it('🔴 章の埋め込みが読み込み中のあいだは刷らない ── 読み込み後に刷る(#1087)', async () => {
    const h = harness({});
    let loading = true;
    const fires: (() => void)[] = [];
    h.deps.embedsLoading = () => loading;
    h.deps.setTimer = (cb) => {
      fires.push(cb);
      return fires.length;
    };
    const p = printNote(h.deps, 'a');
    await flush();
    expect(h.prints(), '読み込み中なのに刷った').toBe(0);
    expect(fires.length, '待ちの時計を張っていない').toBeGreaterThan(0);
    // 時計が進んでも、まだ読み込み中なら刷らない
    fires.shift()!();
    await flush();
    expect(h.prints(), '時計が進んだだけで刷った').toBe(0);
    loading = false;
    while (fires.length > 0) fires.shift()!();
    await flush();
    expect(await p).toBe('printed');
    expect(h.prints(), '読み込みが終わったのに刷っていない').toBe(1);
  });

  it('章の埋め込みが読み込み終わらなくても、上限(5 秒)で打ち切って刷る / 読み込み中でなければ待たない', async () => {
    const stuck = harness({});
    stuck.deps.embedsLoading = () => true;
    const waits: number[] = [];
    stuck.deps.setTimer = (cb, ms) => {
      waits.push(ms);
      cb();
      return 1;
    };
    expect(await printNote(stuck.deps, 'a')).toBe('printed');
    expect(stuck.prints()).toBe(1);
    const total = waits.reduce((a, b) => a + b, 0);
    expect(total, '上限に届く前に諦めた').toBeGreaterThanOrEqual(5000);
    expect(total, '上限を超えて待った').toBeLessThanOrEqual(5100);

    const idle = harness({});
    idle.deps.embedsLoading = () => false;
    let timers = 0;
    idle.deps.setTimer = () => {
      timers += 1;
      return 1;
    };
    expect(await printNote(idle.deps, 'a')).toBe('printed');
    expect(timers, '読み込み中でないのに待った').toBe(0);
  });

  it('用意が失敗しても刷る / 上限を過ぎたら待たずに刷る(固まらない)', async () => {
    const failing = harness({});
    failing.deps.prepare = () => Promise.reject(new Error('x'));
    expect(await printNote(failing.deps, 'a')).toBe('printed');
    expect(failing.prints()).toBe(1);

    const stuck = harness({});
    stuck.deps.prepare = () => new Promise<void>(() => {});
    let fire: (() => void) | null = null;
    let ms = 0;
    stuck.deps.setTimer = (cb, t) => {
      fire = cb;
      ms = t;
      return 1;
    };
    const p = printNote(stuck.deps, 'a');
    await flush();
    expect(stuck.prints(), '上限の前に刷った').toBe(0);
    expect(ms).toBe(10000);
    fire!();
    expect(await p).toBe('printed');
    expect(stuck.prints()).toBe(1);
  });

  it('🔴 画面専用の操作子（Back to Top、読書進捗バー、見出しアンカー）が紙では display: none になる (#1129)', () => {
    const css = readFileSync('src/styles/app.css', 'utf8');
    const printSection = css.slice(css.indexOf('@media print'));
    expect(printSection).toContain('.pkc-back-to-top-container');
    expect(printSection).toContain('.pkc-reading-progress');
    expect(printSection).toContain('.pkc-heading-anchor');
  });
});

