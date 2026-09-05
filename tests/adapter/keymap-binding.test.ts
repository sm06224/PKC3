/** @vitest-environment happy-dom */
/**
 * ショートカットの保存と配線(#256。user 指示 2026-08-18)。
 *
 * 🔴 守る主張:
 * 1. 割り当て直した鍵が**実際に効き、既定は効かなくなる**(足すだけの実装を許さない)
 * 2. 割当は**この端末に残る**(壊れた保存では既定へ落ちる)
 * 3. **別のタブの書換**が、開いているタブにも効く
 * 4. **打っている最中に全域の近道が暴発しない**(1 面の行の欄を含む)
 * 5. **捕まえている最中の打鍵はアプリに届かない**(割り当てようとしてノートができない)
 * 6. 設定の一覧・ヘルプの一覧・実際に効く鍵が**同じ表から出ている**
 *    (PKC2 はヘルプを手書きにしてズレた ── 2026-08-18 の全数調査で 2 件確認)
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions, runGlobalCommand } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { buildKeymapPanel, CONTEXT_LABELS as LABEL_OF } from '../../src/adapter/ui/render/keymap-panel';
import { HelpRenderer } from '../../src/adapter/ui/render/help';
import { KEY_COMMANDS, chordLabel } from '../../src/features/keymap';
import { RowSwap } from '../../src/adapter/ui/render/row-swap';
import { appPanes, applyPaneVisibility } from '../../src/adapter/ui/render/pane-visibility';
import {
  confirmInApp,
  resetAppDialogForTest,
} from '../../src/adapter/ui/render/app-dialog';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { MarkdownClient } from '../../src/adapter/platform/render/markdown-client';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { renderMarkdownWithRanges } from '../../src/features/markdown/source-ranges';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe('割当の保存', () => {
  it('上書きしたものだけ保存する(既定は書かない)', () => {
    const st = fakeStorage();
    const s = new KeymapStore(st);
    expect(st.map.size, '何もしていないのに保存を書いている').toBe(0);
    expect(s.addBinding('create-entry', 'Alt+M')).toBeNull();
    expect(st.map.has('pkc3.keymap')).toBe(true);
    expect(s.getBindings()['create-entry']).toEqual(['Mod+N', 'Alt+M']);
    expect(s.isDefault('create-entry')).toBe(false);
  });

  it('🔴 既定へ戻すと保存ごと消える(要らない行を残さない)', () => {
    const st = fakeStorage();
    const s = new KeymapStore(st);
    s.addBinding('create-entry', 'Alt+M');
    s.resetCommand('create-entry');
    expect(s.isDefault('create-entry')).toBe(true);
    expect(st.map.size, '既定に戻したのに保存が残っている').toBe(0);
    expect(s.getBindings()['create-entry']).toEqual(['Mod+N']);
  });

  it('割当を全部外せる ── そのときは「割当なし」で、既定へ勝手に戻さない', () => {
    const s = new KeymapStore(fakeStorage());
    s.removeBinding('create-entry', 'Mod+N');
    expect(s.getBindings()['create-entry']).toEqual([]);
    s.resetCommand('create-entry');
    expect(s.getBindings()['create-entry'], '戻し道が無い').toEqual(['Mod+N']);
  });

  it('ぶつかる割当は断る(理由と相手を返す)', () => {
    const s = new KeymapStore(fakeStorage());
    const problem = s.addBinding('create-entry', 'Mod+E');
    expect(problem?.kind).toBe('conflict');
    expect(problem?.withCommandId).toBe('edit-entry');
    expect(s.getBindings()['create-entry'], '断ったのに入っている').toEqual(['Mod+N']);
  });

  it('壊れた保存では既定へ落ちる(近道が全部死なない)', () => {
    const st = fakeStorage();
    st.map.set('pkc3.keymap', '{壊れています');
    const s = new KeymapStore(st);
    expect(s.getBindings()['create-entry']).toEqual(['Mod+N']);
  });

  it('保存できない環境でも、この session では効く', () => {
    const dead = {
      getItem: () => null,
      setItem: () => {
        throw new Error('private mode');
      },
      removeItem: () => {
        throw new Error('private mode');
      },
    };
    const s = new KeymapStore(dead);
    expect(s.addBinding('create-entry', 'Alt+M')).toBeNull();
    expect(s.getBindings()['create-entry']).toEqual(['Mod+N', 'Alt+M']);
  });

  it('🔴 別のタブが書き換えたら読み直す(再読込まで効かない、を作らない)', () => {
    const st = fakeStorage();
    const s = new KeymapStore(st);
    let changed = 0;
    const offChange = s.onChange(() => {
      changed += 1;
    });
    const off = s.watchOtherTabs(window);
    expect(s.getBindings()['create-entry']).toEqual(['Mod+N']); // 1 度読ませる(cache を作る)
    st.map.set('pkc3.keymap', JSON.stringify({ 'create-entry': ['Alt+M'] }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'pkc3.keymap' }));
    expect(s.getBindings()['create-entry'], 'cache が更新されていない').toEqual(['Alt+M']);
    expect(changed, '購読者に伝わっていない').toBe(1);
    off();
    offChange();
    st.map.set('pkc3.keymap', JSON.stringify({ 'create-entry': ['Alt+P'] }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'pkc3.keymap' }));
    expect(s.getBindings()['create-entry'], '外したのに効いている').toEqual(['Alt+M']);
  });
});

describe('画面への配線', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  function mounted(store = new KeymapStore(fakeStorage())) {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const d = new Dispatcher();
    buildShell(root);
    const dispose = bindActions(root, d, {}, store);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    return { root, d, store, dispose };
  }

  const press = (
    key: string,
    init: Partial<KeyboardEventInit> & { code?: string } = {},
    target: EventTarget = document,
  ) =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );

  /**
   * 🔴 **一覧を畳んでいても `Ctrl+F` が効く**(#583)。
   *
   * ⚠ 直す前は `focus()` を撃つだけだった ── **畳んだペインは DOM から消えず、
   *   CSS で列が落ちるだけ**なので `querySelector` は**見つけてしまい**、
   *   見えない要素に焦点を入れて**何も起きなかった**(実測: 焦点は `BODY` のまま)。
   *   🔴 しかも `prevent()` が先なので、**鍵を食ったうえで無反応**である。
   * 🔑 直したあとは「**先に戻してから入れる**」── user が押したのは「探したい」で
   *   あって「畳んだままにしたい」ではない。
   *
   * ⚠ **対照群を同じ it に置く**(畳んでいないときも効く)── 置かないと、
   *   「畳みの扱いを足したのに、別の理由で効かなくなった」を次に見抜けない。
   */
  it('🔴 一覧を畳んでいても Ctrl+F で絞り込みの欄へ入る(#583)', () => {
    const { root } = mounted();
    const filter = root.querySelector<HTMLInputElement>('[data-pkc-field="entry-filter"]')!;
    expect(filter, '絞り込みの欄が無い(台の空振り)').not.toBeNull();

    // 対照群 ── 畳んでいないときは、これまでどおり効く
    press('f', { code: 'KeyF', ctrlKey: true });
    expect(document.activeElement, '畳む前から効いていない').toBe(filter);
    filter.blur();

    // 🔴 畳んでから押す
    applyPaneVisibility(root, appPanes.setHidden(['sidebar']));
    expect(appPanes.getHidden(), '畳めていない(台の空振り)').toContain('sidebar');
    press('f', { code: 'KeyF', ctrlKey: true });
    /**
     * ⚠ **この行は変異を殺しません**(正直に書く)── happy-dom は版面を組まないので、
     *   `display: none` の要素にも `focus()` が通り、`activeElement` になる。
     *   🔑 **実機で「入らない」ことを見るのは smoke** の側である
     *   (`tests/smoke/keymap.smoke.spec.ts`)。
     */
    expect(document.activeElement, '焦点が欄に入っていない').toBe(filter);
    /**
     * 🔴 **殺しているのはこちら** ── 「戻してから入れる」の**戻す側**。
     * ⚠ 見えない欄に焦点だけ入れて終わりにすると、user からは**無反応**に見える。
     */
    expect(appPanes.getHidden(), '一覧が畳まれたまま焦点だけ入れている').not.toContain('sidebar');
  });

  /**
   * 🔴 **ヘルプを読んでいる間は `Ctrl+F` をブラウザに返す**(#636。user 指示 2026-08-31)。
   *
   * ⚠ **直す前は、どの門もこれを守っていなかった** ── 上の #583 の test は
   *   `viewMode` を 1 度も触らないので(既定は `'detail'`)、**実装を丸ごと外しても全緑**。
   * ⚠ 実測(直す前):ヘルプの面でも `defaultPrevented === true` / 焦点が
   *   `entry-filter` へ移り、**本文の面とまったく同じ**だった。
   *
   * 🔑 観測点は **`dispatchEvent` の返り**である ── `preventDefault` が呼ばれたら
   *   `false` を返す。「ブラウザに返した」= **既定動作を止めなかった**ことなので、
   *   焦点の行き先ではなく**ここ**が主張の中心になる。
   * 🔑 **対照群を同じ it に置く** ── 本文の面では従来どおり止めて欄へ入る。
   *   置かないと「別の理由で止まらなくなった」を次に見抜けない。
   */
  it('🔴 ヘルプを開いている間だけ Ctrl+F をブラウザに返す(#636)', () => {
    const { root, d } = mounted();
    const filter = root.querySelector<HTMLInputElement>('[data-pkc-field="entry-filter"]')!;
    expect(filter, '絞り込みの欄が無い(台の空振り)').not.toBeNull();

    // ── 対照群: 本文の面では、これまでどおり止めて欄へ入る ──
    expect(d.getState().viewMode, '台の前提が崩れている(既定は本文の面)').toBe('detail');
    const keptDetail = press('f', { code: 'KeyF', ctrlKey: true });
    expect(keptDetail, '本文の面で既定を止めていない(奪う側が壊れた)').toBe(false);
    expect(document.activeElement, '本文の面で欄に入っていない').toBe(filter);
    filter.blur();

    // ── 🔴 ヘルプの面では譲る ──
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'help' });
    expect(d.getState().viewMode, 'ヘルプの面へ移れていない(台の空振り)').toBe('help');
    const keptHelp = press('f', { code: 'KeyF', ctrlKey: true });
    expect(keptHelp, 'ヘルプでも既定を止めている ── ブラウザの検索が出ない').toBe(true);
    expect(
      document.activeElement,
      'ヘルプなのに焦点がノートの絞り込み欄へ飛んでいる',
    ).not.toBe(filter);
  });

  /**
   * 🔴 **譲るのは鍵だけ ── パレットからは押せるまま**(#636)。
   *
   * ⚠ 門を `runGlobalCommand` の中に置くと、パレットが `dry` でその答えを読み、
   *   **「いまは押せません」と誤って断って**行を `disabled` にする。
   *   裁定は「Ctrl+F を**返す**」であって「操作を**消す**」ではない。
   */
  it('🔴 ヘルプを開いていても、パレットからは絞り込みへ移れる(#636)', () => {
    const { root, d, store } = mounted();
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'help' });
    const noop = (): void => {};
    expect(
      runGlobalCommand('focus-search', root, d, store, noop, noop, true),
      'ヘルプで押せない扱いになっている(パレットが誤って断る)',
    ).toBe(true);
  });

  it('既定の Ctrl+N でノートができる', () => {
    const { d } = mounted();
    press('n', { code: 'KeyN', ctrlKey: true });
    expect(d.getState().selectedLid, 'Ctrl+N が効いていない').toBeTruthy();
  });

  /**
   * 🔴 **`Alt+6` で 2 ペインが開く**(2026-08-19、実測で「1 度も効いていない」と判明)。
   *
   * ⚠ 近道は「押しボタンを探して押す」形なので、#241 の訂正で**帯から 2 ペインの
   *   ボタンを外した瞬間に無反応**になっていた。しかも `preventDefault` すら
   *   しないので、user から見て手がかりが 1 つも無い。
   * ⚠ **お知らせ・マニュアル・`shell.ts` のコメントは 3 つとも「効きます」**と
   *   言っており、画面と doc が揃って嘘をついていた。
   * 🔑 ボタンを持たない面は**直に投げる**(`view-detail` と同じ作法)。
   */
  it('🔴 Alt+6 で 2 ペインの面が開く(押しボタンが無くても効く)', () => {
    const { d } = mounted();
    expect(d.getState().viewMode, '前提が崩れている(最初から 2 ペイン)').not.toBe('dual');
    press('6', { code: 'Digit6', altKey: true });
    expect(d.getState().viewMode, 'Alt+6 が効いていない').toBe('dual');
  });

  /** 🔴 もう一度押すと本文へ戻る(帯のボタンと同じ規則を通っている)。 */
  it('🔴 Alt+6 をもう一度押すと本文へ戻る', () => {
    const { d } = mounted();
    press('6', { code: 'Digit6', altKey: true });
    press('6', { code: 'Digit6', altKey: true });
    expect(d.getState().viewMode, '押し直しても閉じない').toBe('detail');
  });

  /**
   * 🔴 **確認が開いている間は近道を通さない**(#299 段⑤。着地前レビュー R6)。
   *
   * ⚠ native の `confirm` は**レンダラごと止めていた**ので、鍵はそもそも動かなかった。
   *   `<dialog>` は背景を不活性にするだけなので **document の keydown は生き続ける** ──
   *   しかも `Alt+6` / `Alt+1` / `Alt+←→` は押しボタンを経由せず**直に投げる**ので、
   *   不活性は 1 ミリも効かない。
   * ⚠ 実害:削除の確認を読んでいる最中に**背後で面が変わり**、「はい」と答えた先が
   *   別の文脈になる。
   * 🔑 対照群を同じ it に置く ── 閉じたあとは効くことまで見ないと、
   *   「近道が丸ごと死んだ」変異と見分けが付かない。
   */
  it('🔴 確認が開いている間は Alt+6 が効かない(閉じれば効く)', async () => {
    resetAppDialogForTest();
    const { root, d } = mounted();
    expect(d.getState().viewMode, '前提が崩れている').not.toBe('dual');

    const answering = confirmInApp(root, '3 件を削除しますか?');
    press('6', { code: 'Digit6', altKey: true });
    expect(d.getState().viewMode, '確認を読んでいる最中に背後で面が変わった').not.toBe('dual');

    root.querySelector<HTMLElement>('[data-pkc-field="dialog-cancel"]')!.click();
    expect(await answering).toBe('cancel');

    // 🔑 対照群 ── 閉じたら効く(門が近道を永久に殺していない)
    press('6', { code: 'Digit6', altKey: true });
    expect(d.getState().viewMode, '閉じたのに近道が戻らない').toBe('dual');
  });

  it('🔴 割り当て直すと、新しい鍵が効いて古い鍵は効かない', () => {
    const store = new KeymapStore(fakeStorage());
    store.removeBinding('create-entry', 'Mod+N');
    expect(store.addBinding('create-entry', 'Alt+M')).toBeNull();
    const { d } = mounted(store);
    press('n', { code: 'KeyN', ctrlKey: true });
    expect(d.getState().selectedLid, '外した既定がまだ効いている').toBeFalsy();
    press('m', { code: 'KeyM', altKey: true });
    expect(d.getState().selectedLid, '割り当てた鍵が効いていない').toBeTruthy();
  });

  it('🔴 1 面の行を打っている最中に Ctrl+N は効かない(別のノートへ飛ばさない)', () => {
    // ⚠ 直す前は `row-source` を「打っている欄」に数えておらず、**打鍵中に飛んでいた**
    //    ── マニュアルの「Ctrl+N は編集中には効きません」が破れていた
    const { root, d } = mounted();
    const ta = document.createElement('textarea');
    ta.setAttribute('data-pkc-field', 'row-source');
    root.append(ta);
    press('n', { code: 'KeyN', ctrlKey: true }, ta);
    expect(d.getState().selectedLid, '打鍵中に作られた').toBeFalsy();
    // ⚠ 対照群: 欄の外なら効く(門が全部塞がっている、を「効かない」と読まない)
    press('n', { code: 'KeyN', ctrlKey: true });
    expect(d.getState().selectedLid).toBeTruthy();
  });

  /**
   * 🔴 **打っている欄は構造で見る**(着地前レビュー 4)。
   * ⚠ 直す前は `data-pkc-field` の名指しだったので、**実在する入力欄を 6 つ**
   * 数え落としていた ── 絞り込みに打っている最中の `Ctrl+E` で編集に入る、等。
   */
  it('🔴 名前を持たない入力欄でも、打っている最中は全域の近道が効かない', () => {
    const { root, d } = mounted();
    const input = document.createElement('input');
    input.type = 'search'; // ⚠ 名指しの表に無い欄(絞り込みと同じ型)
    root.append(input);
    press('n', { code: 'KeyN', ctrlKey: true }, input);
    expect(d.getState().selectedLid, '打鍵中の欄で作られた').toBeFalsy();
    // ⚠ 対照群: 押しボタンに焦点があるときは**効く**(キーボードだけの動線を殺さない)
    const btn = document.createElement('button');
    root.append(btn);
    press('n', { code: 'KeyN', ctrlKey: true }, btn);
    expect(d.getState().selectedLid, 'ボタン上で近道が死んでいる').toBeTruthy();
  });

  /**
   * 🔴 **打鍵中の免除は「コマンド」ではなく「和音」で決める**(着地前レビュー 2)。
   * ⚠ `open-help` は `F1` のために名乗っているが、別名の `Alt+5` は mac で `∞` を
   * 打つ鍵 ── 名乗りだけを見ると、本文に記号が入らずヘルプが開く。
   */
  it('🔴 文字を打つ和音は、名乗っていても打鍵中に効かない', () => {
    const { root, d } = mounted();
    const ta = document.createElement('textarea');
    ta.setAttribute('data-pkc-field', 'editor-body');
    root.append(ta);
    press('5', { code: 'Digit5', altKey: true }, ta);
    expect(d.getState().viewMode, 'Alt+5 が打鍵中に効いた(mac では文字が入る鍵)').toBe(
      'detail',
    );
    press('[', { code: 'BracketLeft', altKey: true }, ta);
    expect(
      root.querySelector('[data-pkc-region="shell"]')!.hasAttribute('data-pkc-hidden-panes'),
      'Alt+[ が打鍵中に効いた',
    ).toBe(false);
    // ⚠ 対照群: 文字を打たない和音(F キー / Mod つき)は名乗りどおり効く
    press('F1', { code: 'F1' }, ta);
    expect(d.getState().viewMode).toBe('help');
  });

  it('打鍵中でも効かせると名乗ったものは効く(F1 / ペインの開閉)', () => {
    const { root, d } = mounted();
    const ta = document.createElement('textarea');
    ta.setAttribute('data-pkc-field', 'editor-body');
    root.append(ta);
    press('F1', { code: 'F1' }, ta);
    expect(d.getState().viewMode).toBe('help');
  });

  it('面を開く鍵は押しボタンと同じ経路(もう一度で戻る)', () => {
    const { d } = mounted();
    press('3', { code: 'Digit3', altKey: true });
    expect(d.getState().viewMode).toBe('settings');
    press('3', { code: 'Digit3', altKey: true });
    expect(d.getState().viewMode, 'もう一度押しても戻らない').toBe('detail');
  });

  it('🔴 集中(両側を畳む)は片側だけの状態からでも両方畳む', () => {
    const { root } = mounted();
    const shell = root.querySelector<HTMLElement>('[data-pkc-region="shell"]')!;
    root
      .querySelector<HTMLElement>('[data-pkc-action="toggle-pane"][data-pkc-pane="sidebar"]')!
      .click();
    expect(shell.getAttribute('data-pkc-hidden-panes')).toBe('sidebar');
    press('\\', { code: 'Backslash', ctrlKey: true, altKey: true });
    expect(
      shell.getAttribute('data-pkc-hidden-panes'),
      '片側だけの状態から押すと入れ替わってしまう',
    ).toBe('sidebar inspector');
    press('\\', { code: 'Backslash', ctrlKey: true, altKey: true });
    expect(shell.hasAttribute('data-pkc-hidden-panes')).toBe(false);
  });

  it('絞り込みの欄へ移る(Ctrl+F)', () => {
    mounted();
    press('f', { code: 'KeyF', ctrlKey: true });
    expect(
      (document.activeElement as HTMLElement | null)?.getAttribute('data-pkc-field'),
    ).toBe('entry-filter');
  });

  it('🔴 編集の確定も割り当て直せる(観測点は phase ── 編集が実際に閉じること)', () => {
    const store = new KeymapStore(fakeStorage());
    store.removeBinding('commit-edit', 'Mod+S');
    store.removeBinding('commit-edit', 'Mod+Enter');
    expect(store.addBinding('commit-edit', 'Mod+Shift+S')).toBeNull();
    const { root, d } = mounted(store);
    // 編集に入る ── ⚠ ここまで作らないと `COMMIT_EDIT` は phase を動かさず、
    //    「dispatch が走った」だけを見る空振りの test になる(1 稿目がそうだった)
    press('n', { code: 'KeyN', ctrlKey: true });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '編集に入れていない').toBe('editing');
    const ta = document.createElement('textarea');
    ta.setAttribute('data-pkc-field', 'editor-body');
    root.append(ta);
    press('s', { code: 'KeyS', ctrlKey: true }, ta);
    expect(d.getState().phase, '外した既定がまだ確定させている').toBe('editing');
    press('s', { code: 'KeyS', ctrlKey: true, shiftKey: true }, ta);
    expect(d.getState().phase, '割り当てた鍵で確定しない').not.toBe('editing');
  });

  it('🔴 編集をやめる鍵も割り当て直せる', () => {
    const store = new KeymapStore(fakeStorage());
    const { root, d } = mounted(store);
    press('n', { code: 'KeyN', ctrlKey: true });
    d.dispatch({ type: 'START_EDIT' });
    const ta = document.createElement('textarea');
    ta.setAttribute('data-pkc-field', 'editor-body');
    root.append(ta);
    press('Escape', { code: 'Escape' }, ta);
    expect(d.getState().phase, 'Escape で編集をやめられない').not.toBe('editing');
  });
});

/**
 * 🔴 **配線した経路の数だけ「割り当て直したら効く」を持つ**(着地前レビュー 3)。
 *
 * ⚠ 直す前、割り当て直しを通す test は global と editor の 2 経路だけで、
 * **row / live / append は直書きへ戻す変異が全部生き延びた**
 * (既存の test は既定の鍵しか押さないので、keymap を外しても緑)。
 * CLAUDE.md §7「同じ値を複数の描画経路へ渡すものは、経路ごとに pin する」。
 */
describe('経路ごとの割り当て直し', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('🔴 行の欄(row)', () => {
    const store = new KeymapStore(fakeStorage());
    for (const chord of ['Tab', 'Shift+Tab', 'Mod+Enter', 'Mod+S']) {
      store.removeBinding('row-commit', chord);
    }
    /**
     * ⚠ **どこにも割り当てられていない鍵**を使う(この it が見たいのは
     *   「割り当て直しが効くか」であって、鍵そのものではない)。
     * ⚠ 2026-08-26 に `Mod+Shift+K` から移した ── `insert-entry-link`(#427 段②)が
     *   その鍵を取ったので、**この行が本物の衝突として落ちた**(検査は正しく働いた)。
     * 🔑 だから**製品が取りそうにない**鍵にする ── 既定に採る理由が無い組み合わせ。
     */
    expect(store.addBinding('row-commit', 'Mod+Alt+F9')).toBeNull();
    const host = document.createElement('div');
    document.body.append(host);
    const swap = new RowSwap(host, { commit: () => {}, onInserted: () => {} }, store);
    const text = '最初の段落。';
    const { html, ranges } = renderMarkdownWithRanges(text);
    expect(swap.update(text, html, ranges).ok, '前提: 塊が組めていない').toBe(true);
    host.querySelector('p')!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true }));
    const ta = host.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]');
    expect(ta, '前提: 行が開いていない').not.toBeNull();
    const key = (init: KeyboardEventInit & { code: string }) =>
      ta!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

    key({ key: 'Tab', code: 'Tab' });
    expect(
      host.querySelector('[data-pkc-field="row-source"]'),
      '外した既定(Tab)でまだ閉じる',
    ).not.toBeNull();
    key({ key: 'F9', code: 'F9', ctrlKey: true, altKey: true });
    expect(
      host.querySelector('[data-pkc-field="row-source"]'),
      '割り当てた鍵で閉じない',
    ).toBeNull();
  });

  it('🔴 1 面そのもの(live)', async () => {
    /**
     * ⚠ 1 稿目は `store.match()` を呼ぶだけで、**`detail.ts` の handler を 1 度も
     * 通っていなかった**(変異試験 R2 が生き延びて判明。CLAUDE.md §2「弱いのではなく
     * 走っていない」)。ここは**面を実際に組んで打鍵する**。
     */
    localStorage.setItem('pkc3.editor-mode', 'live');
    const store = new KeymapStore(fakeStorage());
    store.removeBinding('edit-all', 'Mod+A');
    expect(store.addBinding('edit-all', 'Mod+Shift+A')).toBeNull();
    const root = document.createElement('div');
    document.body.append(root);
    const detail = new DetailRenderer(
      buildShell(root).detail,
      null,
      new MarkdownClient(),
      null,
      undefined,
      store,
    );
    let st = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        {
          lid: 'a',
          title: 't',
          archetype: 'text',
          entryOrder: 1,
          createdAt: null,
          updatedAt: null,
          status: null,
          date: null,
          archived: false,
          bodyChars: null,
        },
      ],
      relations: [],
    }).state;
    st = reduce(st, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    st = reduce(st, { type: 'BODY_LOADED', lid: 'a', body: '最初の段落。' }).state;
    st = reduce(st, { type: 'START_EDIT' }).state;
    detail.render(st);
    await new Promise((r) => setTimeout(r, 0));
    const live = root.querySelector('[data-pkc-region="editor-live"]')!;
    expect(live.querySelectorAll('p'), '前提: 1 面が組めていない').toHaveLength(1);

    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(
      live.querySelector('[data-pkc-field="row-source"]'),
      '外した既定(Ctrl+A)でまだ全文編集に入る',
    ).toBeNull();
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'A',
        code: 'KeyA',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(
      live.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')?.value,
      '割り当てた鍵で全文編集に入らない',
    ).toBe('最初の段落。');
    localStorage.removeItem('pkc3.editor-mode');
  });

  it('🔴 継ぎ足しの欄(append)', () => {
    const store = new KeymapStore(fakeStorage());
    store.removeBinding('append-send', 'Mod+Enter');
    expect(store.addBinding('append-send', 'Mod+Shift+Enter')).toBeNull();
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const d = new Dispatcher();
    buildShell(root);
    bindActions(root, d, {}, store);
    const ta = document.createElement('textarea');
    ta.setAttribute('data-pkc-field', 'append-input');
    root.append(ta);
    /**
     * ⚠ 観測点は **`defaultPrevented`**(= binder が受けて止めた事実)。
     * 継ぎ足しの中身までは見ない ── ここで守るのは「**割当を見て分岐している**」ことで、
     * 送った結果は `append-box` の test が持つ。
     * 🔑 対照群として**外した既定**も撃つ ── 「全部止めている」実装なら差が出ない。
     */
    const press2 = (init: KeyboardEventInit & { code: string }) => {
      const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      ta.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    expect(press2({ key: 'Enter', code: 'Enter', ctrlKey: true }), '外した既定がまだ受けている').toBe(
      false,
    );
    expect(
      press2({ key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: true }),
      '割り当てた鍵を受けていない',
    ).toBe(true);
  });
});

describe('設定の面(割り当て直す口)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('🔴 どのコマンドも、自分が名乗った文脈の見出しの下に出る', () => {
    /**
     * 🔴 **見出しが嘘をつくと、安全の主張が真逆になる**(2026-08-18 の着地前
     * レビュー 1)。`CONTEXT_ORDER` に文脈を足し忘れると `primaryContext` の
     * 既定で **`global`(「画面のどこでも」)へ落ちる** ── フォルダの 4 つの鍵は
     * 「行に焦点があるときだけ」が売りなのに、設定画面が
     * **「画面のどこでも Delete」**と名乗っていた(本文の編集中に Delete で
     * ノートが消えると読む)。
     * ⚠ 型(`Record<KeyContext, string>`)はラベルが**在ること**は強制するが、
     *   **使われること**は誰も強制しない ── 足したラベルは 1 度も描かれない
     *   死んだ文字列だった。だから**全数**を機械で突き合わせる。
     */
    const store = new KeymapStore(fakeStorage());
    const panel = buildKeymapPanel(store, document);
    document.body.append(panel.root);
    // 見出し → その下に並ぶコマンド、を DOM の並びから復元する
    const headingOf = new Map<string, string>();
    let head = '';
    for (const el of panel.root.querySelectorAll(
      '[data-pkc-field="keymap-group"],[data-pkc-field="keymap-row"]',
    )) {
      if (el.getAttribute('data-pkc-field') === 'keymap-group') head = el.textContent ?? '';
      else headingOf.set(el.getAttribute('data-pkc-command') ?? '', head);
    }
    expect(headingOf.size, '1 行も描けていない(空振り)').toBe(KEY_COMMANDS.length);
    // 全数: 名乗った文脈の**どれか**の見出しの下に居ること(既定へ落ちていない)
    const seen = new Set(headingOf.values());
    for (const cmd of KEY_COMMANDS) {
      const label = headingOf.get(cmd.id) ?? '';
      expect(label, `${cmd.id} の見出しが無い`).not.toBe('');
      expect(
        cmd.contexts.some((c) => LABEL_OF[c] === label),
        `${cmd.id} は ${cmd.contexts.join('/')} を名乗るのに「${label}」の下に出ている`,
      ).toBe(true);
    }
    // 空振り防止 ── 文脈が 1 種類しか描かれていないなら上の全数は意味を持たない
    expect(seen.size, '見出しが 1 種類しか出ていない').toBeGreaterThan(1);
    panel.dispose();
  });

  it('一覧はコマンド表から出る(手書きしない)', () => {
    const store = new KeymapStore(fakeStorage());
    const panel = buildKeymapPanel(store, document);
    document.body.append(panel.root);
    const rows = panel.root.querySelectorAll('[data-pkc-field="keymap-row"]');
    expect(rows.length, 'コマンド表と行数が違う').toBe(KEY_COMMANDS.length);
    const first = panel.root.querySelector('[data-pkc-field="keymap-row"][data-pkc-command="create-entry"]');
    expect(first?.textContent).toContain(chordLabel('Mod+N', false).replace('Ctrl', 'Ctrl'));
    panel.dispose();
  });

  it('🔴 押してから打った鍵が割当になる', () => {
    const store = new KeymapStore(fakeStorage());
    const panel = buildKeymapPanel(store, document);
    document.body.append(panel.root);
    panel.root
      .querySelector<HTMLButtonElement>('[data-pkc-field="keymap-assign"][data-pkc-command="create-entry"]')!
      .click();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', altKey: true, bubbles: true, cancelable: true }),
    );
    expect(store.getBindings()['create-entry']).toEqual(['Mod+N', 'Alt+M']);
    panel.dispose();
  });

  it('🔴 捕まえている最中の打鍵はアプリに届かない(割当のつもりでノートができない)', () => {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const d = new Dispatcher();
    buildShell(root);
    const store = new KeymapStore(fakeStorage());
    bindActions(root, d, {}, store);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    const panel = buildKeymapPanel(store, document);
    root.append(panel.root);
    panel.root
      .querySelector<HTMLButtonElement>('[data-pkc-field="keymap-assign"][data-pkc-command="edit-entry"]')!
      .click();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(d.getState().selectedLid, '割り当てようとしただけでノートができた').toBeFalsy();
    // ⚠ ぶつかる相手なので割当にもならない ── 断り文が出る
    expect(store.getBindings()['edit-entry']).toEqual(['Mod+E']);
    const note = panel.root.querySelector(
      '[data-pkc-field="keymap-row"][data-pkc-command="edit-entry"] [data-pkc-field="settings-note"]',
    );
    expect(note?.textContent).toContain('ノートを作る');
    panel.dispose();
  });

  it('🔴 捕まえている間はブラウザの既定も止める(保存ダイアログを開かせない)', () => {
    // ⚠ MUT-6: `preventDefault()` を消しても、state を見る test は 1 本も落ちなかった
    const store = new KeymapStore(fakeStorage());
    const panel = buildKeymapPanel(store, document);
    document.body.append(panel.root);
    panel.root
      .querySelector<HTMLButtonElement>('[data-pkc-field="keymap-assign"][data-pkc-command="create-entry"]')!
      .click();
    const ev = new KeyboardEvent('keydown', {
      key: 's',
      code: 'KeyS',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented, 'ブラウザの保存ダイアログが開く').toBe(true);
    panel.dispose();
  });

  it('🔴 既定と同じ並びに戻したら、上書きは保存から消える', () => {
    // ⚠ MUT-7: この分岐は「外して足し直す」筋でしか通らず、test が 1 本も無かった
    const st = fakeStorage();
    const store = new KeymapStore(st);
    store.removeBinding('create-entry', 'Mod+N');
    expect(st.map.size, '外した時点で上書きが在るはず').toBe(1);
    expect(store.addBinding('create-entry', 'Mod+N')).toBeNull();
    expect(store.isDefault('create-entry'), '既定と同じ並びなのに上書き扱いのまま').toBe(true);
    expect(st.map.size, '既定と同じ並びの上書きが保存に残っている').toBe(0);
  });

  it('🔴 面から焦点が外れたら捕獲をやめる(次の打鍵を勝手に食わない)', () => {
    // ⚠ 着地前レビュー 1: 直す前は面が hidden になっても捕獲が生きており、
    //    次に押した鍵が**画面に何も出ないまま**別のコマンドに割り当たった
    const store = new KeymapStore(fakeStorage());
    const panel = buildKeymapPanel(store, document);
    document.body.append(panel.root);
    const assign = panel.root.querySelector<HTMLButtonElement>(
      '[data-pkc-field="keymap-assign"][data-pkc-command="edit-entry"]',
    )!;
    assign.click();
    assign.dispatchEvent(new FocusEvent('blur'));
    /**
     * ⚠ **ぶつからない和音**で試す(1 稿目は `Ctrl+B` を使い、`format-bold` と
     * 衝突して断られるので**捕まえ続けていても結果が同じ**だった ── 変異試験 R9 が
     * 生き延びて判明した偽陽性)。
     */
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'y',
        code: 'KeyY',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(store.getBindings()['edit-entry'], '面を離れたのに捕まえ続けている').toEqual(['Mod+E']);
    panel.dispose();
  });

  it('Esc はやめる合図(割当にしない)', () => {
    const store = new KeymapStore(fakeStorage());
    const panel = buildKeymapPanel(store, document);
    document.body.append(panel.root);
    const assign = panel.root.querySelector<HTMLButtonElement>(
      '[data-pkc-field="keymap-assign"][data-pkc-command="create-entry"]',
    )!;
    assign.click();
    expect(assign.textContent).toBe('キー待ち…');
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(store.getBindings()['create-entry']).toEqual(['Mod+N']);
    expect(assign.textContent, 'やめたのに待ち続けている').toBe('割り当て');
    panel.dispose();
  });

  it('🔴 「既定に戻す」は既定のままなら押せない(何も起きないボタンを出さない)', () => {
    // ⚠ 変異試験 M14 が生き延びて判明 ── `disabled` を固定しても誰も落ちなかった。
    //    押せるのに何も起きないボタンは、user から見ると**壊れている**
    const store = new KeymapStore(fakeStorage());
    const panel = buildKeymapPanel(store, document);
    document.body.append(panel.root);
    const reset = () =>
      panel.root.querySelector<HTMLButtonElement>(
        '[data-pkc-field="keymap-reset"][data-pkc-command="create-entry"]',
      )!;
    expect(reset().disabled, '既定のままなのに押せる').toBe(true);
    store.addBinding('create-entry', 'Alt+M');
    expect(reset().disabled, '変えたのに押せない').toBe(false);
    reset().click();
    expect(store.getBindings()['create-entry']).toEqual(['Mod+N']);
    expect(reset().disabled, '戻したのに押せるまま').toBe(true);
    panel.dispose();
  });

  it('× で 1 つ外せる / すべて既定に戻せる', () => {
    const store = new KeymapStore(fakeStorage());
    const panel = buildKeymapPanel(store, document);
    document.body.append(panel.root);
    panel.root
      .querySelector<HTMLButtonElement>(
        '[data-pkc-field="keymap-drop"][data-pkc-command="open-help"][data-pkc-chord="F1"]',
      )!
      .click();
    expect(store.getBindings()['open-help']).toEqual(['Alt+5', 'Mod+Shift+Slash']);
    panel.root.querySelector<HTMLButtonElement>('[data-pkc-field="keymap-reset-all"]')!.click();
    expect(store.getBindings()['open-help']).toEqual(['F1', 'Alt+5', 'Mod+Shift+Slash']);
    panel.dispose();
  });

  it('🔴 捕まえる listener は dispose で外れる(面を作り直しても二重に効かない)', () => {
    const store = new KeymapStore(fakeStorage());
    const panel = buildKeymapPanel(store, document);
    document.body.append(panel.root);
    panel.root
      .querySelector<HTMLButtonElement>('[data-pkc-field="keymap-assign"][data-pkc-command="create-entry"]')!
      .click();
    panel.dispose();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', altKey: true, bubbles: true, cancelable: true }),
    );
    expect(store.getBindings()['create-entry'], '外したはずの listener が拾った').toEqual(['Mod+N']);
  });
});

describe('boot の配線(#256)', () => {
  /**
   * ⚠ `src/main.ts` は**原文を読む test しか無い**(CLAUDE.md §2)。
   * 配線を落としても全 test が緑のまま通るので、ここで**字面を pin する**。
   * 🔑 弱い test だと自覚して使う ── 守っているのは「呼び出しが在ること」だけである。
   */
  it('🔴 別のタブの割当変更を購読している', () => {
    const main = readFileSync('src/main.ts', 'utf-8');
    expect(main, 'watchOtherTabs の配線が落ちている').toContain('appKeymap.watchOtherTabs(window)');
  });
});

describe('近道の受け手と、打鍵中の免除(等値で pin する)', () => {
  /**
   * 🔴 **全域のコマンドは、必ずどこかで受けられている**(着地前レビュー MUT-4)。
   * ⚠ `SHORTCUT_BUTTON` から 1 行消すだけで、その近道は**無言の dead key** になる
   * ── 押しても何も起きず、test は 1 本も落ちなかった。
   * 🔑 `KNOWN_DEAD` と同じ作法(等値の表)── 足したら**ここも直さないと落ちる**。
   */
  it('🔴 global の全コマンドに受け手が在る', () => {
    const src = readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8');
    const table = src.slice(
      src.indexOf('const SHORTCUT_BUTTON'),
      src.indexOf('};', src.indexOf('const SHORTCUT_BUTTON')),
    );
    const byButton = [...table.matchAll(/'([a-z-]+)':/g)].map((m) => m[1]!);
    /**
     * ⚠ ボタンを持たない面は binder が名指しで受ける(その場所も原文で確かめる)。
     * 🔴 **`view-dual` を 2026-08-19 にここへ足した** ── #241 の訂正で帯から
     *   ボタンを外したのに表の行だけ残っており、**`Alt+6` は 1 度も効いていなかった**。
     * ⚠ **この検査は在ったのに見逃した** ── 見ていたのは「表に名前が在るか」だけで、
     *   **その選択子が画面に当たるか**を見ていなかった(§1「名前が在るかの検査は、
     *   中身が空でも通る」)。当たるかどうかは `tests/docs-parity.test.ts` が見る。
     */
    /**
     * ⚠ **`nav-back` / `nav-forward` は 2026-08-26 にここから外した** ── 特例で
     *   直に `NAV_HISTORY` を投げるのをやめ、`SHORTCUT_BUTTON` の**ボタンを押す**
     *   形へ寄せた(受け手が同じ action を投げていたので、口が 2 つ在った)。
     * 🔑 寄せた理由は「押せるか」を正しく出すため ── 履歴が無い間ボタンは
     *   `disabled` なので、操作を名前で探す面が「いまは押せません」と言える。
     */
    const special = [
      'view-detail',
      // ⚠ 2026-08-26 に足した(#425 段① ── 押しボタンは在るが、開く先が器なので特例)
      'open-palette',
      'view-dual',
      'toggle-focus-mode',
      'focus-search',
      /**
       * ⚠ 2026-08-28 に足した(#522)── 段組みは**押しボタンを持たない**
       * (常設の物を増やさない、が採った形)ので、特例で `runGlobalCommand` が受ける。
       * 🔑 だから「押せるか」は常に真である ── 器の幅で効かない段数を選んでも、
       *   **設定は残って広い画面で効く**ので、押せなくはしない(#526 の裁定と対)。
       */
      'cycle-read-columns',
      /**
       * ⚠ 2026-09-05 に足した(#633 段②)── スタックの 3 手は押しボタンを持たない
       *   (帯は載せていないと出ない)ので、`view-dual` と同じく特例で直に投げる。
       */
      'stack-push',
      'stack-open',
      'stack-clear',
    ];
    for (const id of special) {
      expect(src, `${id} の特例が消えた`).toContain(`cmd === '${id}'`);
    }
    const globals = KEY_COMMANDS.filter((c) => c.contexts.includes('global')).map((c) => c.id);
    const covered = new Set([...byButton, ...special]);
    expect(
      globals.filter((id) => !covered.has(id)),
      '受け手のいない全域コマンドが在る(押しても何も起きない近道)',
    ).toEqual([]);

    /**
     * 🔴 **逆向きも見る**(2026-08-26、#425 段①。変異試験 M9 が教えた)。
     *
     * ⚠ 上は「全域の命令に受け手が在るか」しか見ていない ── **その逆**
     *   (受け手の表に、全域でない命令が紛れていないか)は誰も見ていなかった。
     * 🔑 これは操作を名前で探す面の**前提**である:あの面は全域から開くので、
     *   `runGlobalCommand` が「押せる」と答えてよいのは**全域の命令だけ**。
     *   全域でないものが表に載ると、**その面にいないのに「押せる」と出る**。
     * ⚠ `openPaletteFor` にはその門(`contexts.includes('global')`)が在るが、
     *   **この不変条件が保たれている限り門は何も止めない**(実測で等価変異)──
     *   だから門ではなく**ここで pin する**(CLAUDE.md「これが無いと壊れる、と
     *   書く前に外して壊れるのを見る」)。
     */
    const byId = new Map(KEY_COMMANDS.map((c) => [c.id, c]));
    const notGlobal = [...byButton, ...special].filter(
      (id) => !(byId.get(id)?.contexts.includes('global') ?? false),
    );
    expect(
      notGlobal,
      '全域でない命令が受け手の表に在る(その面にいないのに「押せる」と出る)',
    ).toEqual([]);
  });

  /**
   * 🔴 **打鍵中に効くと名乗っているものを等値で pin**(MUT-5)。
   * ⚠ `whileTyping` を 1 つ外すと、その近道は**編集中に死ぬ**が、既存の test は
   * `document` へ直接 dispatch する(= 打鍵中ではない)ので 1 本も落ちなかった。
   */
  it('🔴 打鍵中でも効くコマンドの一覧が変わっていない', () => {
    const ids = KEY_COMMANDS.filter((c) => c.whileTyping === true).map((c) => c.id);
    /**
     * ⚠ **2026-08-22 に `open-settings` / `view-dual` を足した**(user 目線
     *   レビュー U-8)── わきの面(ノートを映さない面)は 4 つあるのに、
     *   名乗っていたのは `open-flags` / `open-help` の **2 つだけ**だった。
     *   マウスでは 4 つとも開くのに鍵では 2 つだけ、という非対称である
     *   (user 裁定 2026-08-08「ノートを映さない面は編集中でも開ける」は
     *   面の側でだけ守られていた)。
     * 🔑 わきの面の全数は `tests/features/keymap.test.ts` が
     *   `isAsidePane` から引いて検算する ── ここは**一覧が黙って動かないこと**
     *   だけを見る(2 つの検査で役割を分ける)。
     */
    expect(ids).toEqual([
      // ⚠ 2026-08-23 に足した(日付の道具 ── 編集中の本文へ挿す)
      'insert-date',
      // ⚠ 2026-08-26 に足した(#427 段② ── 題名で選んでリンクを本文へ挿す)
      'insert-entry-link',
      // ⚠ 2026-08-25 に足した(雛形の一覧 ── 同じく編集中の本文へ挿す)
      'insert-snippet',
      'toggle-replace',
      'open-settings',
      'open-flags',
      // ⚠ 2026-08-26 に足した(#425 段① ── **編集中こそ**操作を名前で呼びたい)
      'open-palette',
      'open-help',
      'view-dual',
      'toggle-sidebar',
      'toggle-inspector',
      // ⚠ 2026-08-30 に足した(#609 ── 畳める 3 面のうち追記欄だけ鍵が無かった)
      'toggle-append',
      'toggle-focus-mode',
      'nav-back',
      'nav-forward',
    ]);
  });
});

describe('ヘルプの一覧', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('🔴 割当を変えると、ヘルプの一覧もその場で変わる(手書きの一覧がズレる型を潰す)', () => {
    const store = new KeymapStore(fakeStorage());
    const region = document.createElement('div');
    document.body.append(region);
    new HelpRenderer(region, null, [], store).render();
    const cell = () =>
      region.querySelector('[data-pkc-field="help-key-chords"][data-pkc-command="create-entry"]')
        ?.textContent ?? '';
    expect(cell()).toBe(chordLabel('Mod+N', false));
    store.removeBinding('create-entry', 'Mod+N');
    store.addBinding('create-entry', 'Alt+M');
    expect(cell(), 'ヘルプが古い割当のまま').toBe(chordLabel('Alt+M', false));
  });

  it('割当を全部外したら「割当なし」と出す(操作が消えたと読ませない)', () => {
    const store = new KeymapStore(fakeStorage());
    const region = document.createElement('div');
    document.body.append(region);
    new HelpRenderer(region, null, [], store).render();
    store.removeBinding('toggle-replace', 'Mod+H');
    expect(
      region.querySelector('[data-pkc-field="help-key-chords"][data-pkc-command="toggle-replace"]')
        ?.textContent,
    ).toBe('割り当てなし');
  });
});
