/** @vitest-environment happy-dom */
/**
 * 🔴 **付箋の窓は、追記欄が出た状態で開き、カーソルがそこに在る**
 *   (#690 ② A′ / I4、user 裁定 2026-09-04「全部推薦で」)。
 *
 * ## 物語
 *
 * 本体の窓で「閲覧メインだから」と追記欄を畳んでいる人が、付箋を開く。
 * 付箋の売りは「隅に置いて追記欄にどんどん書き足せる」なのに、直す前は
 * **端末の記録(`pkc3.panes`)が付箋にもそのまま効いて**、本文の下に 8px の帯だけが
 * 出ていた ── 追記したくて開いた窓に、打つ欄が無い。開いても焦点は本文に在り、
 * 書き始めるには毎回 1 度打つ欄を押す必要があった。
 *
 * ## 何を守るか
 *
 * - ②: 端末の記録が「畳む」でも、付箋では追記欄が出る(`sessionOnly`)
 * - ②: 付箋で帯を押せば畳める(dead click を作らない)が、**端末の記録へは書かない**
 * - ②: 対照群 ── 本体の窓では今までどおり畳まれる
 * - I4: 本文が届いたら打つ欄へ焦点が入る(**1 回だけ**。奪い返さない)
 * - I4: 対照群 ── 頼まなければ焦点は動かない
 *
 * ⚠ `main.ts` の配線(`enterNoteWindow`)は test から実行されない ── 判断は
 *   `PaneVisibilityStore.sessionOnly` と `AppendBoxRenderer.focusInputOnceReady` に
 *   置いてあり、ここはその 2 つを見る。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { AppendBoxRenderer } from '../../src/adapter/ui/render/append-box';
import {
  PaneVisibilityStore,
  appPanes,
  applyPaneVisibility,
} from '../../src/adapter/ui/render/pane-visibility';
import { buildShell } from '../../src/adapter/ui/render/shell';

const KEY = 'pkc3.panes';

/** 端末の記録の代わり。⚠ **書込を数える** ── 「書かない」を主張するため。 */
function memStorage(seed: string | null) {
  const m = new Map<string, string>();
  if (seed !== null) m.set(KEY, seed);
  const writes: string[] = [];
  const store: Pick<Storage, 'getItem' | 'setItem'> = {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v);
      writes.push(v);
    },
  };
  return { store, writes, m };
}

describe('付箋の窓では追記欄を必ず出す(#690 ② A′)', () => {
  it('🔴 端末の記録が「追記欄を畳む」でも、付箋では出る', () => {
    const { store } = memStorage('append');
    const panes = new PaneVisibilityStore(store);
    expect(panes.getHidden(), '前提が崩れた(記録が畳んでいない)').toEqual(['append']);
    expect(panes.sessionOnly('append'), '切り離した直後も畳まれたまま').toEqual([]);
    expect(panes.getHidden(), '読み直すと記録の畳みが戻ってくる').toEqual([]);
  });

  /** ⚠ **対照群** ── 同じ記録を、本体の窓(切り離さない)が読むと畳まれたまま。 */
  it('⚠ 本体の窓では今までどおり畳まれる', () => {
    const { store } = memStorage('append');
    expect(new PaneVisibilityStore(store).getHidden()).toEqual(['append']);
  });

  /**
   * 🔴 **付箋で畳んでも、端末の記録へ書かない**(閉じると忘れる)。
   * ⚠ 帯は効く(dead click を作らない)── 記憶の側は動く。
   * 🔑 2 回押す ── 1 回目は記録と同じ値(`append`)へ戻るので、書いても見分けが付かない。
   *   2 回目は `''` になるので、書いていれば記録が変わる。
   */
  it('🔴 付箋で帯を押すと畳める・戻せるが、記録は 1 度も書かない', () => {
    const { store, writes, m } = memStorage('append');
    const panes = new PaneVisibilityStore(store);
    panes.sessionOnly('append');
    expect(panes.toggle('append'), '帯を押しても畳まれない(dead click)').toEqual(['append']);
    expect(panes.getHidden()).toEqual(['append']);
    expect(panes.toggle('append'), 'もう一度押しても戻らない').toEqual([]);
    expect(writes, '付箋の畳みが端末の記録へ書かれた').toEqual([]);
    expect(m.get(KEY), '端末の記録が付箋の操作で変わった').toBe('append');
  });

  /** ⚠ 出すのは追記欄だけ ── 列の畳み(左右)は付箋でもそのまま。 */
  it('⚠ 追記欄以外の畳みは、そのまま引き継ぐ', () => {
    const { store } = memStorage('sidebar append');
    expect(new PaneVisibilityStore(store).sessionOnly('append')).toEqual(['sidebar']);
  });

  /**
   * ⚠ 切り離した後は**記録を読まない** ── 読み続けると、本体の窓で畳み直した瞬間に
   *   付箋の追記欄も消える(`getHidden` は「読むたびに保存を見る」作りである)。
   */
  it('⚠ 切り離した後に本体が記録を書き換えても、付箋には効かない', () => {
    const { store, m } = memStorage(null);
    const panes = new PaneVisibilityStore(store);
    panes.sessionOnly('append');
    m.set(KEY, 'append');
    expect(panes.getHidden(), '本体の畳みが付箋へ漏れた').toEqual([]);
  });

  /**
   * 🔴 **実物の帯で見る**(`shell` + `binder` + 共有の 1 個)── 帯を押したら画面が変わり、
   *   `localStorage` は動かない。⚠ 共有の `appPanes` を切り離すので、この it は最後に置く
   *   (以後この file の中では記録を読まない)。
   */
  it('🔴 実物の帯:押すたびに器の印が入れ替わり、localStorage は動かない', () => {
    document.body.innerHTML = '';
    localStorage.clear();
    localStorage.setItem(KEY, 'append');
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    buildShell(root);
    bindActions(root, new Dispatcher());
    const shell = root.querySelector<HTMLElement>('[data-pkc-region="shell"]')!;
    const grip = root.querySelector<HTMLButtonElement>(
      '[data-pkc-action="toggle-pane"][data-pkc-pane="append"]',
    )!;
    // 起動時の復元(本体の窓と同じ)── ここでは畳まれている
    applyPaneVisibility(root, appPanes.getHidden());
    expect(shell.getAttribute('data-pkc-hidden-panes'), '前提が崩れた(記録が効いていない)').toBe(
      'append',
    );
    // 付箋の旗が立った瞬間(`main.ts` の `enterNoteWindow`)
    applyPaneVisibility(root, appPanes.sessionOnly('append'));
    expect(shell.hasAttribute('data-pkc-hidden-panes'), '付箋なのに追記欄が畳まれたまま').toBe(false);
    grip.click();
    expect(shell.getAttribute('data-pkc-hidden-panes'), '帯を押しても畳まれない(dead click)').toBe(
      'append',
    );
    grip.click();
    expect(shell.hasAttribute('data-pkc-hidden-panes'), '帯をもう一度押しても戻らない').toBe(false);
    expect(localStorage.getItem(KEY), '付箋の畳みが端末の記録へ書かれた').toBe('append');
  });
});

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: 1,
  };
}

/** 本文が届いて追記できる state(`appendModeOf` が `ready` を返す形)。 */
function ready(lid: string): AppState {
  return {
    ...initialState,
    phase: 'ready',
    viewMode: 'detail',
    selectedLid: lid,
    entryMetas: new Map([[lid, meta(lid)]]),
    openBody: { lid, body: 'x', baseline: 'x', persisted: 'x', diskAhead: false },
  };
}

/** 本文がまだ届いていない state(付箋の旗が立った直後はこちら)。 */
function waiting(lid: string): AppState {
  return { ...ready(lid), openBody: null };
}

describe('付箋を開いた直後、カーソルは追記欄に在る(#690 I4)', () => {
  let root: HTMLElement;
  let box: AppendBoxRenderer;
  let input: HTMLTextAreaElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    box = new AppendBoxRenderer(regions.append);
    input = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="append-input"]')!;
  });

  it('🔴 頼んでから本文が届くと、打つ欄に焦点が入る', () => {
    box.focusInputOnceReady();
    // ⚠ 旗が立つのは本文の到着より前 ── まだ打てないので焦点は動かない
    box.render(waiting('a'));
    expect(document.activeElement, '本文が届く前に焦点を奪った').not.toBe(input);
    box.render(ready('a'));
    expect(document.activeElement, '本文が届いても打つ欄に焦点が入らない').toBe(input);
  });

  /** ⚠ **対照群** ── 頼まなければ(本体の窓)焦点は動かない。 */
  it('⚠ 頼まなければ焦点は動かない', () => {
    box.render(waiting('a'));
    box.render(ready('a'));
    expect(document.activeElement, '頼んでいないのに打つ欄へ焦点が入った').not.toBe(input);
  });

  /** 🔴 **1 回だけ** ── user が別の所を押した後に奪い返さない。 */
  it('🔴 1 回果たしたら、次の描画で奪い返さない', () => {
    box.focusInputOnceReady();
    box.render(ready('a'));
    expect(document.activeElement, '前提が崩れた(1 回目で入っていない)').toBe(input);
    const other = document.createElement('button');
    root.append(other);
    other.focus();
    expect(document.activeElement, '前提が崩れた(別の所へ移せていない)').toBe(other);
    // 種類が同じ描画も、隠れて戻る描画も、どちらも奪わない
    box.render({ ...ready('a') });
    expect(document.activeElement, '同じ種類の描画で奪い返した').toBe(other);
    box.render(waiting('a'));
    box.render(ready('a'));
    expect(document.activeElement, '本文を開き直したら奪い返した').toBe(other);
  });

  /** ⚠ user が既にどこかで打っているなら、果たさずに忘れる。 */
  it('⚠ 別の欄で打っている最中なら奪わない(そして忘れる)', () => {
    const typing = document.createElement('textarea');
    root.append(typing);
    typing.focus();
    box.focusInputOnceReady();
    box.render(ready('a'));
    expect(document.activeElement, '打っている最中の欄から焦点を奪った').toBe(typing);
    typing.blur();
    box.render({ ...ready('a') });
    expect(document.activeElement, '忘れずに、後から奪った').not.toBe(input);
  });
});
