/** @vitest-environment happy-dom */
/**
 * 🔴 **別のウィンドウ・面(query / settings / help / 予定表・連絡先など)を
 * Escape で閉じる**(#1042 C3。裁定 2026-09-25 Q3 = A)。
 *
 * ⚠ 実体は既存の押しボタン(`center.ts` の「× 閉じる」= `close-pane`)を
 * `SHORTCUT_BUTTON` 経由でそのまま撃つ ── ここでは**キーボードの Escape が
 * 正しくその押しボタンへ届くか**だけを見る(ボタン自身の挙動は
 * `tests/adapter/center-pane.test.ts` が見ている)。
 *
 * ## 守る主張
 *
 * 1. 面を出しているとき(`viewMode !== 'detail'`)、Escape で本文へ戻る
 * 2. 別ウィンドウ(`services.closeViewWindow` が `'closed'`)は窓ごと閉じ、
 *    本文へは切り替えない(もう画面が無い)
 * 3. 閉じられなかった(`'refused'`)ときは理由を出して本文へ戻る
 * 4. **ノートを閉じる(`deselect-entry`)が先** ── ノートも面も両方在るときは
 *    1 回の Escape ではノートだけが閉じ、面はもう一度押すまで残る
 *    (既知の制約。ノートが見えていない状態で「閉じたのに何も変わらない」を
 *    避けるための順である ── `src/features/keymap.ts` の `KeyContext` docstring)
 * 5. 打っている欄では効かせない
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { CLOSE_VIEW_WINDOW_REFUSED, type CloseViewWindowResult } from '../../src/adapter/platform/view-window';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';

function meta(lid: string): EntryMeta {
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
    bodyChars: null,
  };
}

const unbinds: Array<() => void> = [];

function mount(
  closeViewWindow: () => CloseViewWindowResult = () => 'not-a-window',
  keymap: KeymapStore = new KeymapStore(null),
) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const center = new CenterRouter(regions.detail);
  d.onState((st) => center.render(st));
  const services: BinderServices = { closeViewWindow };
  unbinds.push(bindActions(root, d, services, keymap));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
  const filterInput = () => root.querySelector<HTMLInputElement>('[data-pkc-field="entry-filter"]')!;
  return { root, d, filterInput };
}

function pressEscape(el: HTMLElement = document.body): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

afterEach(() => {
  document.body.innerHTML = '';
  for (const off of unbinds) off();
  unbinds.length = 0;
});

describe('🔴 別のウィンドウ・面を Escape で閉じる(#1042 C3)', () => {
  it('🔴 面を出しているとき(query)、Escape で本文へ戻る', () => {
    const m = mount();
    m.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'query' });
    expect(m.d.getState().viewMode, '前提: query になっていない').toBe('query');
    pressEscape();
    expect(m.d.getState().viewMode, 'Escape で本文へ戻っていない').toBe('detail');
  });

  it('🔴 別ウィンドウが閉じられたら、本文へは切り替えない(もう画面が無い)', () => {
    const m = mount(() => 'closed');
    m.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'schedule' });
    pressEscape();
    // ⚠ 窓ごと閉じたので、`viewMode` は据え置き(閉じかけの画面を作り直さない)
    expect(m.d.getState().viewMode, '閉じた窓なのに面を切り替えた').toBe('schedule');
    expect(m.d.getState().error ?? '', '断りが出ていない').toBe('');
  });

  it('🔴 別ウィンドウが閉じられなかったら(refused)、理由を出して本文へ戻る', () => {
    const m = mount(() => 'refused');
    m.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'contacts' });
    pressEscape();
    expect(m.d.getState().viewMode, '本文へ戻っていない').toBe('detail');
    expect(m.d.getState().error, '断り文が出ていない').toBe(CLOSE_VIEW_WINDOW_REFUSED);
  });

  /**
   * 🔴 **ノートを閉じる(`deselect-entry`)が先**(#1042 C3 の既知の順序)。
   * ⚠ `close-pane` は `SHORTCUT_BUTTON` 経由で押しボタンを直接撃つので、
   *   ボタンが `hidden`(= 面が `detail` に戻った後)でも「押せた」ことになる ──
   *   先に試すと `deselect-entry` に一度も出番が来なくなるため、`reading` を
   *   先に試す(`binder.ts` の `onShortcut`)。結果、ノートと面が両方在るときは
   *   1 回目でノートだけが閉じ、面は 2 回目の Escape で閉じる。
   */
  it('⚠ ノートと面が両方在るとき、1 回目の Escape はノートだけを閉じる', () => {
    const m = mount();
    m.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    m.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'query' });
    pressEscape();
    expect(m.d.getState().selectedLid, '1 回目でノートが閉じていない').toBeNull();
    expect(m.d.getState().viewMode, '1 回目で面まで閉じた(1 段だけ閉じる、を破っている)').toBe(
      'query',
    );
    pressEscape();
    expect(m.d.getState().viewMode, '2 回目で面が閉じていない').toBe('detail');
  });

  it('⚠ 打っている欄では、Escape で面が閉じない', () => {
    const m = mount();
    m.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'query' });
    const input = m.filterInput();
    input.focus();
    pressEscape(input);
    expect(m.d.getState().viewMode, '打っている欄なのに面が閉じた').toBe('query');
  });

  /**
   * 🔴 **`window` ブロック自身の `!typing` ガードを、単独で確かめる**。
   *
   * ⚠ `entry-filter` を使う上の test は、実は**この一段を突いていない** ──
   *   `entry-filter` は #1042 C2 の入力欄チェックが**どの鍵でも無条件に
   *   `return` する**ので、`window` ブロックへは元から届かない(反証:上の test を
   *   `deselect-entry` の割当を外した keymap で通しても、`entry-filter` 相手では
   *   同じ結果になり、`window` 側の変異を殺せなかった ── 実測)。
   * 🔑 **`entry-filter` でも `row-rename` でも `dual-filter` でもない、素の
   *   入力欄**を使い、かつ `deselect-entry` の割当も外して、`window` ブロックの
   *   `!typing` だけを単独で突く。
   */
  it('⚠ 対照群: 素の入力欄に打っている間は、window ブロック自身が面を閉じない', () => {
    const keymap = new KeymapStore(null);
    keymap.removeBinding('deselect-entry', 'Escape');
    expect(keymap.getBindings()['deselect-entry'], '前提: 割当が外れていない').toEqual([]);
    const m = mount(() => 'not-a-window', keymap);
    m.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'query' });
    // ⚠ 一覧・フォルダ表・2 ペインのどの入力欄とも一致しない、素の欄
    const plain = document.createElement('input');
    plain.type = 'text';
    m.root.append(plain);
    plain.focus();
    pressEscape(plain);
    expect(m.d.getState().viewMode, '打っている欄なのに window ブロックが面を閉じた').toBe(
      'query',
    );
  });
});
