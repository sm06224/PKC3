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
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
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
  it('🔴 文書の情報(frontmatter)が在っても、押した所の節が選ばれる', () => {
    const body = ['---', 'title: x', 'tags: a', '---', ...SECT_BODY.split('\n')].join('\n');
    const r = rig(SECT_HTML, body, SLUGS);
    r.click('#pb', { altKey: true });
    // ⚠ ずらしを落とすと「出席」(1 つ上の節)になる
    expect(r.target.value, '節が上へずれた(情報の行数を足していない)').toBe('決定事項');
  });
});
