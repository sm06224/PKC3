/** @vitest-environment happy-dom */
/**
 * 選択の戻る・進む(#190 / 台帳 #180 の B-4)。
 *
 * 🔴 守る主張:
 * 1. 純関数の意味論 ── 同じものは積まない / 新しい選択で「進む」を捨てる / 上限
 * 2. **積むのは reducer の外側 1 か所** ── 選択を動かす case が増えても自動で乗る
 * 3. 戻る・進むで動いた回は**積まない**(積むと戻れなくなる)
 * 4. 消えたノートは履歴から落ちる(存在しない先へ飛ぶ dead click を作らない)
 * 5. 編集中は動かない(reducer の規則を binder に写していない)
 * 6. 画面: ボタンが**押せないときは殺されている** / `Alt+←→` と `F1` が効く
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import {
  EMPTY_HISTORY,
  HISTORY_MAX,
  canGoBack,
  canGoForward,
  current,
  goBack,
  goForward,
  pruneHistory,
  pushSelection,
} from '../../src/features/nav/selection-history';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { SidebarRenderer } from '../../src/adapter/ui/render/sidebar';
import { bindActions } from '../../src/adapter/ui/actions/binder';

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    ...over,
  };
}

describe('履歴の意味論(純関数)', () => {
  it('同じものを続けて選んでも積まない', () => {
    const h = pushSelection(pushSelection(EMPTY_HISTORY, 'a'), 'a');
    expect(h.past).toEqual(['a']);
  });

  it('🔴 新しく選ぶと「進む」側を捨てる(枝を作らない)', () => {
    let h = pushSelection(pushSelection(EMPTY_HISTORY, 'a'), 'b');
    h = goBack(h);
    expect(canGoForward(h)).toBe(true);
    h = pushSelection(h, 'c');
    expect(canGoForward(h), '新しい選択のあとに「進む」が残っている').toBe(false);
    expect(current(h)).toBe('c');
  });

  it('戻る・進むが往復する', () => {
    let h = pushSelection(pushSelection(EMPTY_HISTORY, 'a'), 'b');
    h = goBack(h);
    expect(current(h)).toBe('a');
    h = goForward(h);
    expect(current(h)).toBe('b');
  });

  it('戻れない・進めないときは同じものを返す(呼び側が「動かない」と分かる)', () => {
    const one = pushSelection(EMPTY_HISTORY, 'a');
    expect(canGoBack(one)).toBe(false);
    expect(goBack(one)).toBe(one);
    expect(goForward(one)).toBe(one);
  });

  it('🔴 上限を超えたら古いほうから捨てる(長いセッションで無限に伸びない)', () => {
    let h = EMPTY_HISTORY;
    for (let i = 0; i < HISTORY_MAX + 10; i += 1) h = pushSelection(h, `l${i}`);
    expect(h.past).toHaveLength(HISTORY_MAX);
    expect(h.past[0]).toBe(`l${10}`);
  });

  it('消えた lid は落ち、連続した重複も畳む', () => {
    let h = EMPTY_HISTORY;
    for (const lid of ['a', 'b', 'a']) h = pushSelection(h, lid);
    const pruned = pruneHistory(h, (l) => l !== 'b');
    expect(pruned.past, '間の 1 件が消えて a a が並んだ').toEqual(['a']);
  });
});

/** 配線 ── state の側。 */
describe('履歴の配線(reducer)', () => {
  function booted(lids: string[]) {
    const d = new Dispatcher();
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: lids.map((l) => meta(l)),
      relations: [],
    });
    return d;
  }

  it('🔴 選ぶたびに積まれ、戻ると 1 つ前が選ばれる', () => {
    const d = booted(['n1', 'n2', 'n3']);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n3' });
    expect(d.getState().selectionHistory.past).toEqual(['n1', 'n2', 'n3']);
    d.dispatch({ type: 'NAV_HISTORY', dir: 'back' });
    expect(d.getState().selectedLid).toBe('n2');
    d.dispatch({ type: 'NAV_HISTORY', dir: 'back' });
    expect(d.getState().selectedLid).toBe('n1');
    d.dispatch({ type: 'NAV_HISTORY', dir: 'forward' });
    expect(d.getState().selectedLid).toBe('n2');
  });

  it('🔴 戻るで動いた回は積まない(積むと戻れなくなる)', () => {
    const d = booted(['n1', 'n2']);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    d.dispatch({ type: 'NAV_HISTORY', dir: 'back' });
    expect(d.getState().selectionHistory.past, '戻った先が積み直されている').toEqual(['n1']);
    expect(d.getState().selectionHistory.future).toEqual(['n2']);
  });

  it('🔴 戻ると本文を取り直す(選択だけ動いて中央が古いまま、を作らない)', () => {
    const d = booted(['n1', 'n2']);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    const seen: string[] = [];
    d.onEvent((e) => {
      if (e.type === 'REQUEST_BODY') seen.push(e.lid);
    });
    d.dispatch({ type: 'NAV_HISTORY', dir: 'back' });
    expect(seen, '戻ったのに本文を要求していない').toEqual(['n1']);
  });

  it('🔴 作成でも履歴に積まれる(選択を動かす case は 1 か所で拾う)', () => {
    const d = booted(['n1']);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'CREATE_ENTRY', lid: 'n9', archetype: 'text', title: '新しいノート' });
    expect(d.getState().selectedLid).toBe('n9');
    expect(
      d.getState().selectionHistory.past,
      '作成の選択が履歴に乗っていない(case ごとに書く設計に戻っている)',
    ).toEqual(['n1', 'n9']);
  });

  it('🔴 消えたノートは履歴から落ちる(存在しない先へ戻らない)', () => {
    const d = booted(['n1', 'n2', 'n3']);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n3' });
    d.dispatch({ type: 'DELETE_ENTRY', lid: 'n2' });
    expect(d.getState().selectionHistory.past).not.toContain('n2');
    d.dispatch({ type: 'NAV_HISTORY', dir: 'back' });
    expect(d.getState().selectedLid, '消えたノートへ戻ってしまった').not.toBe('n2');
    expect(d.getState().entryMetas.has(d.getState().selectedLid ?? '')).toBe(true);
  });

  it('編集中は戻らない(規則は reducer 1 か所)', () => {
    const d = booted(['n1', 'n2']);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: 'a' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n2', body: 'b' });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase).toBe('editing');
    const before = d.getState().selectionHistory;
    d.dispatch({ type: 'NAV_HISTORY', dir: 'back' });
    expect(d.getState().selectedLid, '編集中に選択が動いた').toBe('n2');
    expect(d.getState().selectionHistory, '断られたのに履歴だけ進んだ').toBe(before);
  });
});

/** 配線 ── 画面の側。 */
describe('履歴の配線(画面)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function mounted() {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const sidebar = new SidebarRenderer(regions.sidebar);
    d.onState((s) => sidebar.render(s));
    bindActions(root, d);
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('n1'), meta('n2')],
      relations: [],
    });
    return { d, root };
  }

  const back = (root: HTMLElement) =>
    root.querySelector<HTMLButtonElement>('[data-pkc-action="nav-back"]');
  const fwd = (root: HTMLElement) =>
    root.querySelector<HTMLButtonElement>('[data-pkc-action="nav-forward"]');

  it('🔴 器を組んだ時点で死んでいる(描画前に押せる瞬間を作らない)', () => {
    // ⚠ 変異試験 M9 が生き延びて分かった ── renderer が起こすので、器側の初期値を
    //    生かしても**取り付け済みの画面では**症状が出ない。出るのは
    //    「器を組んだが 1 度も描画していない」瞬間で、そこは renderer が守れない。
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    expect(back(root)!.disabled, '器が押せる戻るボタンを出荷している').toBe(true);
    expect(fwd(root)!.disabled).toBe(true);
  });

  it('🔴 戻れないうちはボタンが死んでいる(dead click を作らない)', () => {
    const { d, root } = mounted();
    expect(back(root), '戻るボタンが画面に無い').not.toBeNull();
    expect(back(root)!.disabled).toBe(true);
    expect(fwd(root)!.disabled).toBe(true);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    expect(back(root)!.disabled, '1 件だけで戻れることになっている').toBe(true);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    expect(back(root)!.disabled, '2 件目を選んでも戻るが死んでいる').toBe(false);
    expect(fwd(root)!.disabled).toBe(true);
  });

  it('🔴 押すと実際に選択が戻り、進むが生き返る', () => {
    const { d, root } = mounted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    back(root)!.click();
    expect(d.getState().selectedLid).toBe('n1');
    expect(fwd(root)!.disabled, '戻ったのに進むが死んだまま').toBe(false);
    fwd(root)!.click();
    expect(d.getState().selectedLid).toBe('n2');
  });

  it('🔴 Alt+← / Alt+→ が効く(近道)', () => {
    const { d, root } = mounted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    const key = (k: string) =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: k, altKey: true, bubbles: true, cancelable: true }),
      );
    key('ArrowLeft');
    expect(d.getState().selectedLid, 'Alt+← が効かない').toBe('n1');
    key('ArrowRight');
    expect(d.getState().selectedLid, 'Alt+→ が効かない').toBe('n2');
    void root;
  });

  it('🔴 F1 でヘルプが開く', () => {
    const { d } = mounted();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F1', bubbles: true, cancelable: true }),
    );
    expect(d.getState().viewMode, 'F1 でヘルプが開かない').toBe('help');
  });

  it('修飾なしの ← は履歴を動かさない(一覧の移動と衝突させない)', () => {
    const { d } = mounted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
    );
    expect(d.getState().selectedLid).toBe('n2');
  });
});
