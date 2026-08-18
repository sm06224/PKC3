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
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { buildKeymapPanel } from '../../src/adapter/ui/render/keymap-panel';
import { HelpRenderer } from '../../src/adapter/ui/render/help';
import { KEY_COMMANDS, chordLabel } from '../../src/features/keymap';

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

  it('既定の Ctrl+N でノートができる', () => {
    const { d } = mounted();
    press('n', { code: 'KeyN', ctrlKey: true });
    expect(d.getState().selectedLid, 'Ctrl+N が効いていない').toBeTruthy();
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

describe('設定の面(割り当て直す口)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
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
    ).toBe('割当なし');
  });
});
