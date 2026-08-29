/** @vitest-environment happy-dom */
/**
 * 🔴 **本文の上でも右クリックを受ける**(#426 段② / #522)。
 *
 * ## なぜ要るか
 *
 * 段①(#477)は**行の上だけ**で受けていたので、本文を右クリックしても何も出なかった。
 * user 指示 2026-08-28(#522):
 *
 * > **段組表示を表示変更導線をセンターペインもしくはショートカット、
 * > コンテキストメニューに用意したいくらいには気に入った**
 *
 * ## 🔴 段① が置いた除外の門は、**ここで初めて効き始める**
 *
 * 段① の test はこう予告していた ── 「段② で本文の上でも受けるようになったら、
 * この test は**自動的に除外の門を見るようになる**」。
 * ⚠ つまりリンク・図・入力欄・選択範囲で**既定を残す**ことは、
 * いままで「行の判定がどのみち先に返す」に救われていた。**もう救われない。**
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { BODY_MENU_ACTIONS } from '../../src/features/entry-actions';

const MENU = '[data-pkc-region="context-menu"]';

/** 右クリック event(happy-dom に `MouseEvent` の座標つき実体は在る)。 */
function rightClick(el: Element): MouseEvent {
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
  el.dispatchEvent(e);
  return e;
}

function setup(over: Partial<BinderServices> = {}) {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  root.innerHTML =
    '<div data-pkc-region="detail">' +
    '<div data-pkc-field="detail-body">' +
    '<p data-pkc-field="para">ふつうの段落</p>' +
    '<a href="https://example.com/x">そと</a>' +
    '<img alt="ず" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />' +
    '</div>' +
    /**
     * 🔴 **設定・ヘルプ・集計の面は、同じ `detail` の器の中に居る**
     *   (`center.ts` の `pane()` が `data-pkc-view-pane` で並べる)。
     * ⚠ 実物の DOM を読むまで、この器を組み忘れていた ── 面で切る実装だと
     *   **設定画面を右クリックしても段組みのメニューが出る**。
     */
    '<div data-pkc-view-pane="settings"><p data-pkc-field="settei">設定の中身</p></div>' +
    '</div>' +
    '<div data-pkc-region="entry-list"><li data-pkc-entry="n1">行</li></div>' +
    '<div data-pkc-region="jinou">地の上</div>';
  document.body.append(root);
  const said: string[] = [];
  const dispatcher = new Dispatcher();
  /**
   * ⚠ **起動まで進める**(`new Dispatcher()` は `initializing`)── 行の右クリックは
   *   `selectEntryOrExplain` を通るので、ノートが居ないと**断られてメニューが出ない**。
   * 🔑 2026-08-29 に同じ形を踏んだ(台が一度も `ready` にならず、見たつもりの test が
   *   別の側を見ていた)ので、ここでも先に起動させる。
   */
  dispatcher.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [
      {
        lid: 'n1',
        title: '行',
        archetype: 'text',
        created_at: null,
        updated_at: null,
        entry_order: 1,
        status: null,
        date: null,
        archived: 0,
      } as never,
    ],
    relations: [],
  });
  bindActions(root, dispatcher, { showStatus: (t) => said.push(t), ...over });
  return {
    root,
    said,
    para: root.querySelector('[data-pkc-field="para"]')!,
    link: root.querySelector('a')!,
    img: root.querySelector('img')!,
    jinou: root.querySelector('[data-pkc-region="jinou"]')!,
    settei: root.querySelector('[data-pkc-field="settei"]')!,
    menu: () => root.querySelector(MENU),
  };
}

describe('本文の右クリック(#426 段② / #522)', () => {
  it('🔴 本文の上で右クリックすると、メニューが出る', () => {
    const s = setup();
    expect(s.menu(), '押す前から出ている').toBeNull();
    const e = rightClick(s.para);
    expect(s.menu(), '本文で右クリックしても出ない').not.toBeNull();
    // ⚠ 既定を奪っている(奪わないとブラウザのメニューが重なる)
    expect(e.defaultPrevented, '既定を奪っていない').toBe(true);
  });

  it('🔴 出るのは**本文用の一覧**(行の一覧ではない)', () => {
    const s = setup();
    rightClick(s.para);
    const acts = [...s.menu()!.querySelectorAll('button[data-pkc-action]')].map((b) =>
      b.getAttribute('data-pkc-action'),
    );
    expect(acts).toEqual(BODY_MENU_ACTIONS.map((a) => a.action));
    /**
     * 🔴 **「削除」を出さない。**
     * ⚠ 本文を押したのに削除が出ると、消えるのは**選んでいるノート**である ──
     *   押した物と効く先が食い違う。
     */
    expect(acts, '本文のメニューに削除が出ている').not.toContain('delete-entry');
  });

  it('🔴 押すと段組みが実際に回る(配線が繋がっている)', () => {
    const s = setup();
    rightClick(s.para);
    const before = document.documentElement.getAttribute('data-pkc-read-columns');
    s.menu()!.querySelector<HTMLElement>('[data-pkc-action="cycle-read-columns"]')!.click();
    // ⚠ **メニューの外**で確かめる ── 器の属性と、画面に出た字
    expect(
      document.documentElement.getAttribute('data-pkc-read-columns'),
      '押しても段数が変わらない',
    ).not.toBe(before);
    expect(s.said.join(''), '何段になったか言っていない').toContain('段組み');
  });

  it('🔴 **リンクの上では出さない**(「リンクをコピー」を消さない)', () => {
    // ⚠ この門は段① から在ったが、行の判定に救われて**一度も効いていなかった**
    const s = setup();
    const e = rightClick(s.link);
    expect(s.menu(), 'リンクの上で自前のメニューを出した').toBeNull();
    expect(e.defaultPrevented, 'リンクの上で既定を奪った').toBe(false);
  });

  it('🔴 **図の上では出さない**(「画像を保存」を消さない)', () => {
    const s = setup();
    const e = rightClick(s.img);
    expect(s.menu(), '図の上で自前のメニューを出した').toBeNull();
    expect(e.defaultPrevented, '図の上で既定を奪った').toBe(false);
  });

  it('⚠ 本文の面の外(地)では、これまでどおり出さない', () => {
    const s = setup();
    const e = rightClick(s.jinou);
    expect(s.menu(), '地の上で出した(奪って何も出さない場所を増やした)').toBeNull();
    expect(e.defaultPrevented).toBe(false);
  });

  it('🔴 **設定の面では出さない** ── 同じ器の中に同居している', () => {
    /**
     * 🔴 **実物の DOM を読んで見つけた**(2026-08-29、着地前)。
     * ⚠ `[data-pkc-region="detail"]` は**中央の器**で、その中に設定 / フラグ /
     *   ヘルプ / 集計 / 2 ペインの面が同居している。面で切ると、
     *   **設定画面を右クリックしても段組みのメニューが出る**。
     * 🔑 見るのは**本文そのもの**(`detail-body`)。
     */
    const s = setup();
    const e = rightClick(s.settei);
    expect(s.menu(), '設定の面で段組みのメニューを出した').toBeNull();
    expect(e.defaultPrevented, '設定の面で既定を奪った').toBe(false);
  });

  it('⚠ 行の上は、これまでどおり**行の一覧**が出る(段① を壊していない)', () => {
    const s = setup();
    rightClick(s.root.querySelector('[data-pkc-entry]')!);
    const acts = [...(s.menu()?.querySelectorAll('button[data-pkc-action]') ?? [])].map((b) =>
      b.getAttribute('data-pkc-action'),
    );
    expect(acts, '行の右クリックが本文の一覧に変わった').toContain('delete-entry');
  });
});
