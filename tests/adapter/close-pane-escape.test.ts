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
 * 4. 🔴 **面が在るときは、面(`close-pane`)が先**(#1042 followup 指摘 B)。
 *    ノートも面も両方在るときは、1 回目の Escape で**面だけ**が閉じてノートへ
 *    戻り、ノートは 2 回目の Escape で閉じる。⚠ 直す前は逆(`reading` が先)
 *    だった ── 面の裏でノートは見えていないので、見えていない物を先に閉じると
 *    「押しても何も変わらない」ように見え、user が読みに来ていたノートへ戻れない
 *    まま 2 回目でコレクションの画面まで落ちていた
 * 5. 面が**無い**とき(`viewMode === 'detail'`)は `reading` が先(`close-pane` は
 *    `hidden` なボタンでも「押せた」ことになるので、先に試すとノートが開いていても
 *    `deselect-entry` に出番が来ない ── #1042 C3)
 * 6. 🔴 **付箋のウィンドウでは、`deselect-entry` を撃たずに窓を閉じる**
 *    (#1042 followup 指摘 A)。`services.closeNoteWindow` が `'closed'` を
 *    返したら、`selectedLid` は触らずに終える(#685 の 2 枚目防止を壊さない)
 * 7. 打っている欄では効かせない
 * 8. 🔴 **付箋だがブラウザが閉じなかった(`'refused'`)ときも、`deselect-entry`
 *    へは進まない**(#1042 段④)。`close-pane` と同じ理由を出して
 *    ノートは開いたままにする ── `boolean` へ潰すと `'refused'` が
 *    `'not-a-window'` と見分けられず、黙って `deselect-entry` に流れていた
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
  closeNoteWindow?: () => CloseViewWindowResult,
) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const center = new CenterRouter(regions.detail);
  d.onState((st) => center.render(st));
  const services: BinderServices = { closeViewWindow, closeNoteWindow };
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
   * 🔴 **面が在るとき、面(`close-pane`)が先**(#1042 followup 指摘 B)。
   * ⚠ 直す前は逆(`reading` が先)だった ── 面の裏でノートは見えていないので、
   *   見えていないノートを先に閉じると、user から見て「押しても何も変わらない」
   *   まま 2 回目でコレクションの画面まで落ちる(読みに来ていたノートへ戻れない)。
   * 🔑 いまは 1 回目で面だけが閉じてノートへ戻り、ノートは 2 回目の Escape で閉じる。
   */
  it('🔴 ノートと面が両方在るとき、1 回目の Escape は面だけを閉じてノートへ戻る', () => {
    const m = mount();
    m.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    m.d.dispatch({ type: 'SET_VIEW_MODE', mode: 'query' });
    pressEscape();
    expect(m.d.getState().viewMode, '1 回目で面が閉じていない').toBe('detail');
    expect(m.d.getState().selectedLid, '1 回目でノートまで閉じた(1 段だけ閉じる、を破っている)').toBe(
      'a',
    );
    pressEscape();
    expect(m.d.getState().selectedLid, '2 回目でノートが閉じていない').toBeNull();
  });

  /**
   * 🔴 **面が無いときは `reading` が先**(#1042 C3。上の 4/5 を裏から見る control)。
   * `close-pane` は `hidden` なボタンでも「押せた」ことになるので、先に試すと
   * ノートが開いていても `deselect-entry` に出番が来ない。
   */
  it('🔴 面が無いとき、Escape はノートを閉じる(reading が先)', () => {
    const m = mount();
    m.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    expect(m.d.getState().viewMode, '前提: 面が出ていない').toBe('detail');
    pressEscape();
    expect(m.d.getState().selectedLid, 'ノートが閉じていない').toBeNull();
  });

  /**
   * 🔴 **選んでいるノートも面も無いとき、Escape は何も閉じず、呑まない**
   * (#1042 段③)。
   *
   * ⚠ 直す前は `close-pane` の押しボタンが `viewMode === 'detail'` でも
   *   `hidden` のまま DOM に残るので、`SHORTCUT_BUTTON` の共通経路が
   *   「押せる」と読んで `SET_VIEW_MODE 'detail'` を**同じ値で撃ち直し**、
   *   `handled: true` を返していた ── 何も変わらないのに
   *   `ke.preventDefault()` だけが起き、Escape がブラウザや後続の聞き手に
   *   渡らなくなる(無言で呑み込む)。
   * 🔑 ここで見るのは 2 つ:①状態が 1 つも動かない ②`defaultPrevented` が
   *   `false` のまま(= 呑んでいない)。
   */
  it('🔴 ノートも面も無いとき、Escape は何もせず、既定動作も止めない', () => {
    const m = mount();
    expect(m.d.getState().viewMode, '前提: 面が出ていない').toBe('detail');
    expect(m.d.getState().selectedLid, '前提: ノートを選んでいない').toBeNull();
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(m.d.getState().viewMode, '面が動いた(何も無いのに撃ち直した)').toBe('detail');
    expect(m.d.getState().selectedLid, 'ノートが動いた').toBeNull();
    expect(ev.defaultPrevented, 'Escape を呑んだ(既定動作を止めた)').toBe(false);
  });

  /**
   * 🔴 **付箋のウィンドウでは `deselect-entry` を撃たずに窓を閉じる**
   * (#1042 followup 指摘 A)。`closeNoteWindow` が `'closed'` を返す = この
   * ウィンドウは自分で開いた付箋であり、いま閉じた ── `selectedLid` は触らない
   * (付箋の窓は閉じた後で読まれないが、「触っていない」ことを直接見る)。
   */
  it('🔴 付箋のウィンドウでは、Escape が selectedLid を空にせず窓を閉じる', () => {
    let closed = 0;
    const m = mount(
      () => 'not-a-window',
      new KeymapStore(null),
      () => {
        closed++;
        return 'closed';
      },
    );
    m.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    pressEscape();
    expect(closed, 'closeNoteWindow が呼ばれていない').toBe(1);
    expect(m.d.getState().selectedLid, '付箋なのに deselect-entry が撃たれた').toBe('a');
  });

  /**
   * 🔴 **付箋だがブラウザが閉じなかった(`'refused'`)ときも、`deselect-entry`
   * へは進まない**(#1042 段④)。⚠ 直す前は `closeNoteWindow` の戻り値を
   * `boolean`(`=== 'closed'`)へ潰していたので、`'refused'` は `'not-a-window'`
   * と見分けが付かず、**黙って** `deselect-entry` が撃たれていた ── 窓は
   * 開いたままなのにノートだけ閉じ、「開いています」の放送と画面が食い違う。
   * 🔑 いまは `close-pane` と同じ理由(`CLOSE_VIEW_WINDOW_REFUSED`)を出し、
   * `selectedLid` は触らない。
   */
  it('🔴 付箋が閉じられなかった(refused)ときは、理由を出して選択を保つ', () => {
    const m = mount(
      () => 'not-a-window',
      new KeymapStore(null),
      () => 'refused',
    );
    m.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    pressEscape();
    expect(m.d.getState().selectedLid, 'refused なのに deselect-entry が撃たれた').toBe('a');
    expect(m.d.getState().error, '断り文が出ていない').toBe(CLOSE_VIEW_WINDOW_REFUSED);
  });

  /**
   * 🔴 **対照群:`closeNoteWindow` が無い(本体タブ)/ `'not-a-window'` を
   * 返す(付箋でない)ときは、今までどおり `deselect-entry` が効く**。
   */
  it("🔴 closeNoteWindow が無い、または 'not-a-window' を返すときは、今までどおりノートを閉じる", () => {
    // 無い(本体タブ):既定の mount() は closeNoteWindow を渡さない
    const m1 = mount();
    m1.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    pressEscape();
    expect(m1.d.getState().selectedLid, 'closeNoteWindow 無しでノートが閉じていない').toBeNull();

    // not-a-window(付箋ではない):呼ばれるが、閉じられなかった
    let calls = 0;
    const m2 = mount(
      () => 'not-a-window',
      new KeymapStore(null),
      () => {
        calls++;
        return 'not-a-window';
      },
    );
    m2.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    pressEscape();
    expect(calls, 'closeNoteWindow が呼ばれていない').toBe(1);
    expect(m2.d.getState().selectedLid, "'not-a-window' を返したのにノートが閉じていない").toBeNull();
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

  /**
   * 🔴 **`main.ts` が `closeNoteWindow` を binder へ渡している**(#1042 followup)。
   *
   * ⚠ `main.ts` はどの test からも実行されない(CLAUDE.md §2)ので、ここは
   *   `tests/adapter/center-pane.test.ts` の `settle` の配線 pin と**同じ作法**で
   *   字面を見る ── **弱いと自覚して使う**。
   * ⚠ **`closeViewWindow` と同じ道**(`view-window.ts` の `closeViewWindow`、
   *   `holding` だけ違う)に乗っていることも見る ── 別の閉じ方を作っていないか
   *   (CLAUDE.md §10)。
   */
  it('🔴 main.ts が closeNoteWindow を binder へ渡している(#1042 followup)', async () => {
    const { readFileSync } = await import('node:fs');
    const { codeOnly } = await import('../helpers/code-only');
    const code = codeOnly(readFileSync('src/main.ts', 'utf8'));
    expect(code.length, 'コメント落としが本体まで消した').toBeGreaterThan(1000);
    expect(code, 'closeNoteWindow の配線が落ちている(付箋で Escape が窓を閉じない)').toMatch(
      /closeNoteWindow:\s*\(\)\s*=>/,
    );
    expect(
      code,
      'closeNoteWindow が closeViewWindow(view-window.ts)と別の道で閉じている',
    ).toMatch(/closeNoteWindow:\s*\(\)\s*=>\s*closeViewWindow\(\{\s*holding:\s*\(\)\s*=>\s*heldNoteWindow/);
  });
});
