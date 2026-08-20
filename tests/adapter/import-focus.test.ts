/**
 * user 報告(2026-08-05)「**開いたら何も起きずに終わる**」の pin。
 * 調査 doc: `docs/development/user-reports-2026-08-05.md` §1-6
 *
 * 🔴 **直す前も全 test 緑だった。** launch まわりの test は
 * `tests/adapter/launch-queue.test.ts` / `bootstrap-wiring.test.ts` の 2 本だけで、
 * どちらも「**受け口が張られたか**」しか見ておらず、**着地点**を見ていなかった。
 *
 * ここで守るのは 2 つ:
 *   ① 取り込んだノートが**画面に出る**(末尾に足すだけで終わらない)
 *   ② 取込の再読込で**いま読んでいたノートを閉じない**
 */
import { describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '@adapter/state/dispatcher';
import { initialState, reduce, type AppState } from '@adapter/state/app-state';
import { selectWhenPresent } from '@adapter/state/select-when-present';
import type { EntryMeta } from '@core/model/entry-meta';

const meta = (lid: string, order: number): EntryMeta => ({
  lid,
  title: `題 ${lid}`,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: order,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

const booted = (cid: string, lids: string[]): Parameters<typeof reduce>[1] => ({
  type: 'SYS_BOOTED',
  cid,
  metas: lids.map((l, i) => meta(l, i + 1)),
  relations: [],
});

/** reduce を素で回す(effect 層を通さない ── 見たいのは state と events)。 */
function run(state: AppState, actions: Parameters<typeof reduce>[1][]): {
  state: AppState;
  events: unknown[];
} {
  let s = state;
  let events: unknown[] = [];
  for (const a of actions) {
    const r = reduce(s, a);
    s = r.state;
    events = r.events;
  }
  return { state: s, events };
}

describe('取込の再読込で、いま読んでいたノートを閉じない', () => {
  it('🔴 同じ container の再読込では選択が残る(+ 本文を取り直す)', () => {
    const a = run(initialState, [
      booted('c1', ['n1', 'n2']),
      { type: 'SELECT_ENTRY', lid: 'n1' },
      { type: 'BODY_LOADED', lid: 'n1', body: '本文' },
    ]);
    expect(a.state.selectedLid).toBe('n1');
    expect(a.state.openBody?.body).toBe('本文');

    // 取込 → 再読込(同じ container に n3 が増えた)
    const b = run(a.state, [booted('c1', ['n1', 'n2', 'n3'])]);
    expect(b.state.selectedLid, '読んでいたノートが閉じた').toBe('n1');
    // ⚠ 本文は**捨てて取り直す** ── 再読込で中身が変わっている可能性がある
    expect(b.state.openBody, '古い本文を持ち越している').toBeNull();
    expect(b.events, '本文を取り直していない').toEqual([{ type: 'REQUEST_BODY', lid: 'n1' }]);
  });

  it('🔴 別 container へ切り替えたら選択は捨てる(lid の偶然衝突で他人を開かない)', () => {
    // ⚠ ここを緩めると、別 container の同名 lid を開いて**上書き**しうる(review F)
    const a = run(initialState, [
      booted('c1', ['n1']),
      { type: 'SELECT_ENTRY', lid: 'n1' },
    ]);
    const b = run(a.state, [booted('c2', ['n1'])]);
    expect(b.state.selectedLid, '別 container なのに選択を持ち越した').toBeNull();
    expect(b.events).toEqual([]);
  });

  it('選んでいたノートが消えていたら選択は捨てる', () => {
    const a = run(initialState, [
      booted('c1', ['n1', 'n2']),
      { type: 'SELECT_ENTRY', lid: 'n2' },
    ]);
    const b = run(a.state, [booted('c1', ['n1'])]); // n2 が消えた
    expect(b.state.selectedLid).toBeNull();
    expect(b.events).toEqual([]);
  });
});

describe('取り込んだノートを画面に出す', () => {
  const mkDispatcher = (): Dispatcher => new Dispatcher(initialState);

  it('🔴 既に一覧に居れば、その場で選ぶ', () => {
    const d = mkDispatcher();
    d.dispatch(booted('c1', ['n1', 'n2']));
    selectWhenPresent(d, 'n2');
    expect(d.getState().selectedLid).toBe('n2');
  });

  it('🔴 まだ来ていなければ、来た時点で選ぶ(黙って終わらない)', () => {
    // ⚠ ここが本題 ── `reload()` は phase が ready でないとき**早く返る**ので、
    //    素朴に dispatch すると reducer の `entryMetas.has` に弾かれて何も起きない
    const d = mkDispatcher();
    d.dispatch(booted('c1', ['n1']));
    selectWhenPresent(d, 'n9');
    expect(d.getState().selectedLid, 'まだ居ないのに選んだ').toBeNull();

    d.dispatch(booted('c1', ['n1', 'n9'])); // 取込後の再読込が届いた
    expect(d.getState().selectedLid, '来たのに選ばれない').toBe('n9');
  });

  it('🔴 来ないまま boot が済んだら購読を切る(listener を残さない)', () => {
    const d = mkDispatcher();
    const off = vi.fn();
    const spy = vi.spyOn(d, 'onState').mockImplementation((fn) => {
      // 本物と同じ意味論(登録して解除関数を返す)を保ったまま、解除を観測する
      const real = Dispatcher.prototype.onState.call(d, fn);
      return () => {
        off();
        real();
      };
    });
    try {
      // ⚠ 初期状態は phase が ready ではない ── まさに `reload()` が早く返る場面
      selectWhenPresent(d, 'n9');
      expect(spy, '購読していない(その場で諦めた)').toHaveBeenCalled();
      expect(off).not.toHaveBeenCalled();
      d.dispatch(booted('c1', ['n1'])); // ready になったが n9 は居ない
      expect(off, 'boot が済んだのに購読が残っている').toHaveBeenCalled();
      expect(d.getState().selectedLid).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
