/** @vitest-environment happy-dom */
/**
 * 読む面の**修飾クリック 2 つ**(#395 段③ / #495)。
 *
 * > user の物語: 長い議事録を読んでいて、この 1 行だけ直したい。
 * > いまは「編集」を押してから、もう一度その行を探して押す(2 手)。
 *
 * ## 割当(user 裁定 2026-08-27。#495)
 *
 * | 押し方 | 何が起きるか |
 * |---|---|
 * | **Ctrl(⌘)+クリック** | **その地点から編集に入る**(既定の編集 IN 導線) |
 * | **Alt+クリック** | **追記の入り先**を、押した所の節にする |
 * | 素のクリック | 読むだけ(browse-first の裁定を変えない) |
 *
 * ⚠ 見るのは「その修飾キーのときだけ効くか」と「**押せる物を奪っていないか**」。
 *   とくに `Ctrl` / `⌘` は**リンクの「新しいタブで開く」**なので、そこを奪うと
 *   ブラウザの既定を丸ごと壊す。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { appPanes } from '../../src/adapter/ui/render/pane-visibility';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';

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

beforeEach(() => {
  document.body.textContent = '';
});

/**
 * 読む面を模す。⚠ **刻印は本物と同じ属性**(`data-pkc-source-line`)──
 *   別の名前で組むと、この test だけ通って実物では 1 度も効かない。
 */
function rig(html: string, body = 'a\n\nb\n\nc\n', slugs: readonly string[] = []) {
  const root = document.createElement('div');
  document.body.append(root);
  const host = document.createElement('div');
  host.setAttribute('data-pkc-field', 'detail-body');
  host.innerHTML = html;
  root.append(host);
  /**
   * 追記の入り先の `<select>`。⚠ **本物と同じ印**(`append-box.ts` が組むもの)──
   *   別の名前で組むと、この test だけ通って実物では 1 度も効かない。
   */
  const target = document.createElement('select');
  target.setAttribute('data-pkc-field', 'append-target');
  for (const value of ['', ...slugs]) {
    const opt = document.createElement('option');
    opt.value = value;
    // ⚠ 字も本物に合わせる(`append-box.ts` は見出しの字を option の中身に出す)──
    //    断り文はその字を引く(#655 ②)ので、空のままだと test だけが別の形になる
    opt.textContent = value === '' ? '末尾' : value;
    target.append(opt);
  }
  root.append(target);
  const d = new Dispatcher(initialState);
  bindActions(root, d);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  const click = (sel: string, init: MouseEventInit = {}): void => {
    root
      .querySelector(sel)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  };
  return { root, d, click, target, state: (): AppState => d.getState() };
}

const BODY = [
  '<p data-pkc-source-line="0">a</p>',
  '<p data-pkc-source-line="2" id="mid">b</p>',
  '<p data-pkc-source-line="4"><a href="https://example.com" id="lnk">c</a></p>',
  /**
   * 🔴 **本文の中に実在する「押せる物」**(2026-08-28。着地前レビュー M4)。
   * ⚠ 直す前の fixture はリンク 1 種しか持っておらず、門から
   *   `button` / `input` / `[data-pkc-action]` を落とす変異が**素通り**していた
   *   ── 実害はチェックの印(`toggle-task`)と表の升(`edit-cell`)の
   *   `Ctrl`+クリックを奪うこと。
   * ⚠ 綴りは**製品が焼くもの**に合わせる(`markdown-render.ts` / `csv-table.ts`)。
   */
  '<p data-pkc-source-line="6">' +
    '<input type="checkbox" id="chk" data-pkc-action="toggle-task" data-pkc-task-line="6">' +
    '<button id="btn" data-pkc-action="edit-cell">升</button>' +
    '<summary id="sum">畳み</summary>' +
    '</p>',
].join('');

describe('#495 Ctrl(⌘)+クリックで、その行から編集に入る', () => {
  it('🔴 Ctrl+クリックで編集に入り、押した行を持っていく', () => {
    const r = rig(BODY);
    r.click('#mid', { ctrlKey: true });
    expect(r.state().phase, '編集に入っていない').toBe('editing');
    expect(r.state().editOpenAt, '押した行を持っていっていない').toBe(2);
  });

  it('🔑 ⌘+クリックでも入る(mac だけ効かない近道を作らない)', () => {
    const r = rig(BODY);
    r.click('#mid', { metaKey: true });
    expect(r.state().phase).toBe('editing');
    expect(r.state().editOpenAt).toBe(2);
  });

  it('🔴 素のクリックでは入らない(browse-first の裁定を変えない)', () => {
    const r = rig(BODY);
    r.click('#mid');
    expect(r.state().phase).toBe('ready');
  });

  /**
   * ⚠ `Ctrl+Alt` は **AltGr**。⚠ `Alt` 単独は**追記の入り先**(下の describe)
   *   なので、ここで編集に入ってしまうと**2 つの動線が同時に走る**。
   */
  it('🔴 Ctrl+Alt(AltGr)では入らない ── 記号が打てない配列の人を壊さない', () => {
    const r = rig(BODY);
    r.click('#mid', { altKey: true, ctrlKey: true });
    expect(r.state().phase).toBe('ready');
  });

  it('⚠ Ctrl+Shift でも入らない(選択の作法を奪わない)', () => {
    const r = rig(BODY);
    r.click('#mid', { ctrlKey: true, shiftKey: true });
    expect(r.state().phase).toBe('ready');
  });

  /**
   * 🔴 **いちばん大事な門** ── `Ctrl+クリック` は多くの環境で
   *   「**新しいタブで開く**」である。ここを奪うと、本文のリンクが
   *   その場に持っていた意味を丸ごと失う。
   */
  it('🔴 リンクの上では奪わない(新しいタブで開く、を殺さない)', () => {
    const r = rig(BODY);
    r.click('#lnk', { ctrlKey: true });
    expect(r.state().phase, 'リンクのクリックを奪った').toBe('ready');
  });

  /**
   * 🔴 **本文の中の「押せる物」も奪わない**(着地前レビュー M4 / E)。
   * ⚠ リンクだけを見ていると、`button` / `input` / `[data-pkc-action]` /
   *   `summary` を門から落とす変異が素通りする ── 実害はチェックの印と
   *   表の升の `Ctrl`+クリックを奪うことである。
   */
  it('🔴 チェックの印・升のボタン・畳みの見出しの上でも奪わない', () => {
    for (const id of ['#chk', '#btn', '#sum']) {
      const r = rig(BODY);
      r.click(id, { ctrlKey: true });
      expect(r.state().phase, `${id} のクリックを奪った`).toBe('ready');
    }
    // 対照群 ── ただの段落なら入る(門が固まっているのではない)
    const r = rig(BODY);
    r.click('#mid', { ctrlKey: true });
    expect(r.state().phase).toBe('editing');
  });

  /**
   * 🔴 **既定を止める**(着地前レビュー M8)。⚠ 止めないと、`Ctrl`+クリックの
   * ブラウザ既定(新しいタブ / 選択)がこちらの動線と**同時に走る**。
   */
  it('🔴 受けたときは既定を止める(2 つが同時に走らない)', () => {
    const r = rig(BODY);
    const el = r.root.querySelector('#mid')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented, '既定を止めていない').toBe(true);
    // 対照群 ── 受けなかったときは止めない(押せる物の既定を奪わない)
    const ev2 = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    r.root.querySelector('#lnk')!.dispatchEvent(ev2);
    expect(ev2.defaultPrevented, 'リンクの既定まで止めた').toBe(false);
  });

  /**
   * 🔴 **何も起きないなら、ブラウザの既定も奪わない**(着地前レビュー M7 を
   * 検算して確定させた形)。
   *
   * ⚠ `phase` が `ready` でないとき、`START_EDIT` は reducer が捨て、入り先は
   *   `appendModeOf` が止める ── **状態は動かない**。⚠ そこで `preventDefault`
   *   だけ走ると、**字を選ぶ / 新しいタブで開くが消えるのに、代わりに何も
   *   起きない**(CLAUDE.md §10「奪ったのに代わりが無い」)。
   * 🔑 だから門は `bodySourceLineAt` の中に置き、**受けなかったことを
   *   `defaultPrevented` で見る**(状態を見るだけでは、この差が出ない)。
   */
  it('🔴 ready でない間は、既定を奪わない(奪って何も起きないを作らない)', () => {
    const r = rig(BODY);
    r.d.dispatch({ type: 'START_EDIT' });
    expect(r.state().phase, '前提: editing になっていない').toBe('editing');
    const el = r.root.querySelector('#mid')!;
    for (const mods of [{ ctrlKey: true }, { altKey: true }]) {
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true, ...mods });
      el.dispatchEvent(ev);
      expect(
        ev.defaultPrevented,
        `何も起きないのに既定を奪った: ${JSON.stringify(mods)}`,
      ).toBe(false);
    }
    // 対照群 ── 編集をやめれば受けて、そのときは止める
    r.d.dispatch({ type: 'CANCEL_EDIT' });
    const ok = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    el.dispatchEvent(ok);
    expect(ok.defaultPrevented, '対照群: 受けたのに止めていない').toBe(true);
  });

  it('🔴 刻印が無い所では何もしない ── 当てずっぽうで別の行を開かない', () => {
    const r = rig('<hr id="rule">');
    r.click('#rule', { ctrlKey: true });
    expect(r.state().phase).toBe('ready');
  });

  it('⚠ 本文の外(一覧など)では効かない', () => {
    const r = rig(BODY);
    const outside = document.createElement('p');
    outside.setAttribute('data-pkc-source-line', '0');
    outside.id = 'out';
    r.root.append(outside);
    r.click('#out', { ctrlKey: true });
    expect(r.state().phase).toBe('ready');
  });

  it('🔴 普通に「編集」を押したときは、前に押した行が開かない', () => {
    const r = rig(BODY);
    r.click('#mid', { ctrlKey: true });
    expect(r.state().editOpenAt).toBe(2);
    r.d.dispatch({ type: 'CANCEL_EDIT' });
    r.d.dispatch({ type: 'START_EDIT' });
    expect(r.state().editOpenAt, '前に押した行が残っている').toBeNull();
  });
});

/**
 * 🔴 **Alt+クリック = 追記の入り先**(#495)。
 *
 * > user 裁定 2026-08-27「センターペインの**追記位置指定は Alt+クリック**にしましょう」
 *
 * ⚠ 見るのは「`<select>` が本当に変わるか」── ここが `append-entry` の読む
 *   **唯一の正本**なので、変わっていなければ**押しても入り先は動いていない**。
 */
describe('#495 Alt+クリックで、追記の入り先を指す', () => {
  /** 見出し 2 つの本文。⚠ 行番号は下の刻印と揃える(`SECT_BODY` の行で数える)。 */
  const SECT_BODY = ['# 上の節', '', 'a', '', '## 決定事項', '', 'b', ''].join('\n');
  const SECT_HTML = [
    '<h1 data-pkc-source-line="0" id="h1">上の節</h1>',
    '<p data-pkc-source-line="2" id="pa">a</p>',
    '<h2 data-pkc-source-line="4" id="h2">決定事項</h2>',
    '<p data-pkc-source-line="6" id="pb">b</p>',
  ].join('');
  const SLUGS = ['上の節', '決定事項'];

  it('🔴 押した所の節が入り先になる(いちばん近い上の見出し)', () => {
    const r = rig(SECT_HTML, SECT_BODY, SLUGS);
    r.click('#pb', { altKey: true });
    expect(r.target.value, '入り先が変わっていない').toBe('決定事項');
    // 対照群 ── 上の節を押せば、そちらへ移る(1 つに固まっていない)
    r.click('#pa', { altKey: true });
    expect(r.target.value).toBe('上の節');
  });

  it('🔑 見出しそのものを押しても、その節が選ばれる', () => {
    const r = rig(SECT_HTML, SECT_BODY, SLUGS);
    r.click('#h2', { altKey: true });
    expect(r.target.value).toBe('決定事項');
  });

  /**
   * 🔴 **畳んだ追記欄は開き、打つ欄にカーソルが入る**(user 裁定 2026-08-30
   * 「…Alt+クリックも同じ」)。⚠ 右クリック経路と**同じ 1 本**(`pickAppendTarget`)を
   * 通ることの確認でもある ── 片方だけ直った日は、ここが赤くなる。
   */
  it('🔴 Alt+クリックでも、畳んだ追記欄が開いて打つ欄にカーソルが入る', () => {
    const r = rig(SECT_HTML, SECT_BODY, SLUGS);
    const shell = document.createElement('div');
    shell.setAttribute('data-pkc-region', 'shell');
    shell.setAttribute('data-pkc-hidden-panes', 'append');
    const input = document.createElement('textarea');
    input.setAttribute('data-pkc-field', 'append-input');
    shell.append(input);
    r.root.append(shell);
    appPanes.setHidden(['append']);
    try {
      r.click('#pb', { altKey: true });
      expect(r.target.value, '入り先が動いていない(前提が崩れている)').toBe('決定事項');
      expect(appPanes.getHidden(), '畳んだままになっている').not.toContain('append');
      expect(shell.hasAttribute('data-pkc-hidden-panes'), '画面へ写っていない').toBe(false);
      expect(document.activeElement, '打つ欄にカーソルが入っていない').toBe(input);
    } finally {
      // ⚠ 一時表示(#655 ①)も終える(`body-context-menu.test.ts` の afterEach と同じ理由)
      appPanes.unpeek();
      appPanes.setHidden([]);
    }
  });

  /**
   * 🔴 **上に見出しが無ければ入り先を変えない** ── 「末尾」へ落とすと、
   *   文書の上のほうを押したのに**いちばん下へ入る**(いちばん静かな取り違え)。
   * ⚠ **黙って何もしない**にはしない(理由を出す)。
   */
  it('🔴 上に見出しが無い所では、入り先を変えずに理由を出す', () => {
    const html = '<p data-pkc-source-line="0" id="top">まえがき</p>' + SECT_HTML;
    const r = rig(html, 'まえがき\n\n' + SECT_BODY, SLUGS);
    r.click('#pb', { altKey: true });
    expect(r.target.value).toBe('決定事項');
    r.click('#top', { altKey: true });
    expect(r.target.value, '末尾へ落ちた(押した所と関係ない場所へ入る)').toBe('決定事項');
    expect(r.state().notice ?? '', '理由が出ていない').toContain('見出しが無い');
  });

  /**
   * ⚠ **`Alt+Shift` は字の範囲を広げる操作** ── 奪うと `preventDefault` で
   * 選択が伸びない(旧 `alt-click-edit.test.ts` に在った門。書き換えで落ちていた)。
   */
  it('🔴 Alt+Shift では入り先を動かさない(範囲を広げる操作を奪わない)', () => {
    const r = rig(SECT_HTML, SECT_BODY, SLUGS);
    r.click('#pb', { altKey: true, shiftKey: true });
    expect(r.target.value, '選択を広げる操作を奪った').toBe('');
    // 対照群 ── Shift を離せば動く
    r.click('#pb', { altKey: true });
    expect(r.target.value).toBe('決定事項');
  });

  /**
   * 🔴 **一覧に無い印は選ばない**(着地前レビュー G / M3)。
   * ⚠ `<select>` に無い値を代入すると `selectedIndex = -1` → `value` は `''`
   *   (= 末尾)に落ちる。それでも「入り先を『X』にしました」と出ると、
   *   **追記は末尾へ入るのに user は X へ入ったと思う**。
   */
  it('🔴 一覧に無い節は選ばず、理由を出す(黙って末尾へ落とさない)', () => {
    // ⚠ 一覧には「上の節」しか無いのに、押すのは「決定事項」の中
    const r = rig(SECT_HTML, SECT_BODY, ['上の節']);
    r.click('#pb', { altKey: true });
    expect(r.target.value, '一覧に無い印で末尾へ落ちた').toBe('');
    expect(r.state().error ?? '', '理由が出ていない').toContain('決定事項');
    expect(r.state().notice ?? '', '選べたと知らせた').not.toContain('にしました');
  });

  /**
   * ⚠ **`ready` のときだけ**(着地前レビュー I)。`START_EDIT` は reducer が
   * 二重に守るが、**追記の入り先の側は守り手がここしか居ない**。
   */
  it('🔴 編集中は、入り先の動線も走らない', () => {
    const r = rig(SECT_HTML, SECT_BODY, SLUGS);
    r.d.dispatch({ type: 'START_EDIT' });
    expect(r.state().phase, '前提: editing になっていない').toBe('editing');
    r.click('#pb', { altKey: true });
    expect(r.target.value, '編集中に入り先が動いた').toBe('');
    // 対照群 ── 編集をやめれば動く(門が固まっているのではない)
    r.d.dispatch({ type: 'CANCEL_EDIT' });
    r.click('#pb', { altKey: true });
    expect(r.target.value).toBe('決定事項');
  });

  /**
   * 🔴 **断るときも、打つ所までは出す**(#655 ②。user 裁定 2026-09-04)。
   *
   * ⚠ 直す前は「上に見出しが無い」「一覧に無い見出し」の 2 つが**欄を開く前に返って**
   *   いたので、マニュアルの「畳んでいても開いて、打つ欄にカーソルが入ります」が
   *   その場面で嘘だった ── 見出しが 1 つも無いノートでは**毎回**そうなる。
   * 🔑 見るのは 3 つ:欄が開く / カーソルが入る / 断りの字(いまの入り先つき)。
   */
  describe('断るときも打つ所までは出す(#655 ②)', () => {
    function foldedPane(r: ReturnType<typeof rig>) {
      const shell = document.createElement('div');
      shell.setAttribute('data-pkc-region', 'shell');
      shell.setAttribute('data-pkc-hidden-panes', 'append');
      const input = document.createElement('textarea');
      input.setAttribute('data-pkc-field', 'append-input');
      shell.append(input);
      r.root.append(shell);
      appPanes.setHidden(['append']);
      return { shell, input };
    }
    afterEach(() => {
      appPanes.unpeek();
      appPanes.setHidden([]);
    });

    it('🔴 上に見出しが無い所でも、欄は開いてカーソルが入る ── いまの入り先を添える', () => {
      const html = '<p data-pkc-source-line="0" id="top">まえがき</p>' + SECT_HTML;
      const r = rig(html, 'まえがき\n\n' + SECT_BODY, SLUGS);
      const { shell, input } = foldedPane(r);
      r.click('#top', { altKey: true });
      expect(r.target.value, '入り先が動いた').toBe('');
      expect(shell.hasAttribute('data-pkc-hidden-panes'), '断ったので欄を開かなかった').toBe(false);
      expect(document.activeElement, '打つ欄にカーソルが入っていない').toBe(input);
      const notice = r.state().notice ?? '';
      expect(notice, '理由が出ていない').toContain('見出しが無い');
      expect(notice, 'いまの入り先を言っていない').toContain('いまの入り先は末尾です');
      expect(notice, '開いたことを言っていない').toContain('追記欄を開きました');
    });

    it('🔑 直前に選んだ節が在れば「末尾」とは言わない(嘘を書かない)', () => {
      const html = '<p data-pkc-source-line="0" id="top">まえがき</p>' + SECT_HTML;
      const r = rig(html, 'まえがき\n\n' + SECT_BODY, SLUGS);
      r.click('#pb', { altKey: true });
      expect(r.target.value, '前提: 入り先が選べていない').toBe('決定事項');
      r.click('#top', { altKey: true });
      expect(r.target.value, '入り先が動いた').toBe('決定事項');
      expect(r.state().notice ?? '', '選んであった節を言っていない').toContain(
        'いまの入り先は「決定事項」です',
      );
    });

    it('🔴 一覧に無い節でも、欄は開いてカーソルが入る ── 理由にいまの入り先を添える', () => {
      const r = rig(SECT_HTML, SECT_BODY, ['上の節']);
      const { shell, input } = foldedPane(r);
      r.click('#pb', { altKey: true });
      expect(r.target.value, '一覧に無い印で末尾へ落ちた').toBe('');
      expect(shell.hasAttribute('data-pkc-hidden-panes'), '断ったので欄を開かなかった').toBe(false);
      expect(document.activeElement, '打つ欄にカーソルが入っていない').toBe(input);
      const error = r.state().error ?? '';
      expect(error, '理由が出ていない').toContain('「決定事項」は追記の入り先に選べません');
      expect(error, 'いまの入り先を言っていない').toContain('いまの入り先は末尾です');
    });

    it('🔴 見出しが 1 つも無いノートでも、欄は開いてカーソルが入る', () => {
      const html = '<p data-pkc-source-line="0" id="only">見出しの無い本文</p>';
      const r = rig(html, '見出しの無い本文\n', []);
      const { shell, input } = foldedPane(r);
      r.click('#only', { altKey: true });
      expect(shell.hasAttribute('data-pkc-hidden-panes'), '欄を開かなかった').toBe(false);
      expect(document.activeElement, '打つ欄にカーソルが入っていない').toBe(input);
      expect(r.state().notice ?? '', '理由が出ていない').toContain('見出しが無い');
    });

    /**
     * 🔴 **書込中は理由を出す**(黙らない)。⚠ 「編集中」の枝は、いまの 2 つの入口
     *   (`Alt`+クリック / 右クリック)からは届かない ── 前者は `bodySourceLineAt` が
     *   `ready` でないと降り(上の「ready でない間は、既定を奪わない」)、後者は
     *   編集中に並ばない。届く「ready でない」は**書込中**だけである。
     */
    it('🔴 書き込んでいる間は「入り先を変えられません」と理由を出す(黙らない)', () => {
      const r = rig(SECT_HTML, SECT_BODY, SLUGS);
      const { shell } = foldedPane(r);
      // ⚠ この rig には効果層が無いので、追記を撃つと書込の錠が掛かったままになる
      r.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'n1', text: 'x', heading: null, target: null });
      expect(r.state().writeLock?.lid, '前提: 書込中になっていない').toBe('n1');
      r.click('#pb', { altKey: true });
      expect(r.target.value, '書込中に入り先が動いた').toBe('');
      expect(r.state().error ?? '', '書込中に黙った').toContain('入り先を変えられません');
      // ⚠ 書込中は打つ欄が無い(理由と出口の帯だけ)ので、欄を開く動作は起こさない
      expect(shell.getAttribute('data-pkc-hidden-panes'), '書込中に欄を開いた').toBe('append');
    });

    it('対照群 ── 追記欄そのものが無い種類(添付)では、断り文も出さない(既定を変えない)', () => {
      const r = rig(SECT_HTML, SECT_BODY, SLUGS);
      r.d.dispatch({
        type: 'SYS_BOOTED',
        cid: 'c1',
        metas: [{ ...meta('n1'), archetype: 'attachment' }],
        relations: [],
      });
      r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
      r.d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: SECT_BODY });
      r.click('#pb', { altKey: true });
      expect(r.state().error, '追記欄の無い面で追記の断り文を出した').toBeNull();
      expect(r.state().notice ?? '').not.toContain('入り先');
    });
  });

  it('🔴 素のクリックでは入り先は動かない', () => {
    const r = rig(SECT_HTML, SECT_BODY, SLUGS);
    r.click('#pb');
    expect(r.target.value).toBe('');
    // 対照群 ── Alt を押せば動く
    r.click('#pb', { altKey: true });
    expect(r.target.value).toBe('決定事項');
  });

  it('🔴 Ctrl+クリックは編集に入り、入り先は動かさない(2 つが同時に走らない)', () => {
    const r = rig(SECT_HTML, SECT_BODY, SLUGS);
    r.click('#pb', { ctrlKey: true });
    expect(r.state().phase).toBe('editing');
    expect(r.target.value, '編集に入りつつ入り先まで動かした').toBe('');
  });

  it('🔴 リンクの上では奪わない', () => {
    const r = rig(SECT_HTML + BODY, SECT_BODY, SLUGS);
    r.click('#lnk', { altKey: true });
    expect(r.target.value).toBe('');
  });

  /**
   * 🔴 **追記欄が画面に出ていない面では、黙って降りる**(user 目線レビュー F)。
   *
   * ⚠ `<select>` は器を 1 度だけ組むので、追記できないノート(添付・フォルダ)でも
   *   `querySelector` は**畳まれた物を掴む** ── 1 稿目はそこで
   *   「『◯◯』は追記の入り先に選べません」という、**追記欄が 1 つも見えていない
   *   画面で、追記についての断り文**を出していた。
   * ⚠ **対照群を同じ it に置く** ── 種類を戻せば動くこと(門が固まっていないこと)。
   */
  it('🔴 追記できない種類のノートでは、断り文も出さず入り先も動かさない', () => {
    const r = rig(SECT_HTML, SECT_BODY, SLUGS);
    // 添付は `APPENDABLE_ARCHETYPES` の外 ── 追記欄そのものが出ない
    r.d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [{ ...meta('n1'), archetype: 'attachment' }],
      relations: [],
    });
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    r.d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: SECT_BODY });
    r.click('#pb', { altKey: true });
    expect(r.target.value, '出ていない欄の入り先を動かした').toBe('');
    expect(r.state().error ?? '', '見えていない物についての断り文が出た').toBe('');
    expect(r.state().notice ?? '', '見えていない物についての知らせが出た').toBe('');

    // 対照群 ── 追記できる種類へ戻せば効く
    r.d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('n1')],
      relations: [],
    });
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    r.d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: SECT_BODY });
    r.click('#pb', { altKey: true });
    expect(r.target.value, '対照群: 追記できる種類でも動かない').toBe('決定事項');
  });

  /**
   * 🔴 **`Ctrl+Alt` は AltGr ── どちらの動線も起こさない**(変異試験 M4 が
   * SURVIVED で教えた)。
   *
   * ⚠ 上の「編集に入らない」だけを見る test では**足りなかった** ── `Alt` の枝から
   *   `!ctrlKey` を外す変異は、編集ではなく**入り先を動かす**ので `phase` は
   *   `ready` のまま(= 緑)になる。🔑 **2 つの出口を同じ it で見る。**
   */
  it('🔴 Ctrl+Alt(AltGr)では、編集にも入らず入り先も動かない', () => {
    const r = rig(SECT_HTML, SECT_BODY, SLUGS);
    r.click('#pb', { altKey: true, ctrlKey: true });
    expect(r.state().phase, '編集に入った').toBe('ready');
    expect(r.target.value, '入り先が動いた').toBe('');
    // 対照群 ── Alt だけなら動く(門が固まっているのではない)
    r.click('#pb', { altKey: true });
    expect(r.target.value).toBe('決定事項');
  });

  /**
   * 🔴 **原文の行へ戻してから節を引く**(変異試験 M9 が SURVIVED で教えた)。
   *
   * ⚠ 描く面は frontmatter を**剥がした側**の行を刻印しているが、見出しを数える
   *   `sectionAt` は**原文**で数える ── ずらしを落とすと、押した所より
   *   **frontmatter の行数だけ上**の節が選ばれる(user から見て「隣の節に入った」)。
   * ⚠ frontmatter を持たない fixture では**この差が出ない**ので、ここだけ持たせる。
   */
  /**
   * 🔴 **ずらしは「ちょうど」でなければならない**(着地前レビュー M1)。
   *
   * ⚠ 上の test だけでは **`+1` の変異が素通りする** ── 見出しの下が空行だと、
   *   1 行ずれても同じ見出しに着地するからである。
   * 🔑 **空行を 1 つも持たない本文**にすると、1 行のずれが**隣の節**を指す。
   */
  it('🔴 ずらしが 1 行でも狂うと、隣の節になる(空行の無い本文で見る)', () => {
    // 行: 0 `# 上` / 1 `a` / 2 `## 下` / 3 `b`
    const body = ['# 上', 'a', '## 下', 'b'].join('\n');
    const html = [
      '<h1 data-pkc-source-line="0">上</h1>',
      '<p data-pkc-source-line="1" id="pa">a</p>',
      '<h2 data-pkc-source-line="2">下</h2>',
      '<p data-pkc-source-line="3" id="pb">b</p>',
    ].join('');
    const r = rig(html, body, ['上', '下']);
    r.click('#pa', { altKey: true });
    // ⚠ `+1` なら「下」、`-1` なら解けずに理由が出る
    expect(r.target.value, 'ずらしが 1 行狂っている').toBe('上');
    r.click('#pb', { altKey: true });
    expect(r.target.value).toBe('下');
  });

  it('🔴 文書の情報(frontmatter)が在っても、押した所の節が選ばれる', () => {
    const body = ['---', 'title: x', 'tags: a', '---', ...SECT_BODY.split('\n')].join('\n');
    const r = rig(SECT_HTML, body, SLUGS);
    r.click('#pb', { altKey: true });
    // ⚠ ずらしを落とすと「上の節」(1 つ前の節)になる
    expect(r.target.value, '節が上へずれた(情報の行数を足していない)').toBe('決定事項');
  });
});
