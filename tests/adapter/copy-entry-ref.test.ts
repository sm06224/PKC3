/** @vitest-environment happy-dom */
/**
 * 🔴 **ノートの参照をコピーする口**(#427 段①)。
 *
 * ## なぜ要ったか
 *
 * マニュアルは `[題名](entry:<lid>)` と案内しているのに、⚠ **`<lid>` を知る手段が
 * 画面に 1 つも無かった** ── 情報ペインは id を出さず、`copy-` の action 7 つの
 * うちノート自身の参照を出すものが 1 つも無い。つまり **PKC3 の中で新しく
 * リンクを張る道が無く**、本文の `entry:` はほぼ全部 PKC2 からの取り込みだった。
 *
 * 守る主張:
 * 1. **押す口が画面に在る**(API を直に呼ぶ test は、ボタンが消えても通る)
 * 2. **貼れる 1 行が載っている**(裸の `entry:` ではない)
 * 3. 🔴 **選んでいるノートのものが載る**(選び直したら入れ替わる)
 * 4. **押すとクリップボードへ渡る**(配線)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';

function meta(lid: string, order: number, title: string): EntryMeta {
  return {
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const METAS = [meta('n1', 1, '先週の議事録'), meta('n2', 2, '会議 [第 2 回]')];

const booted = (): AppState =>
  reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] }).state;

beforeEach(() => {
  document.body.textContent = '';
});

function rig() {
  const root = document.createElement('div');
  document.body.append(root);
  const inspector = new InspectorRenderer(buildShell(root).inspector);
  const btn = (): HTMLElement | null =>
    root.querySelector('[data-pkc-action="copy-entry-ref"]');
  return { root, inspector, btn };
}

describe('ノートの参照をコピー(#427 段①)', () => {
  it('🔴 押す口が画面に在る', () => {
    const r = rig();
    r.inspector.render(reduce(booted(), { type: 'SELECT_ENTRY', lid: 'n1' }).state);
    expect(r.btn(), '押す口が無い(貼れる形を手に入れる道が無い)').not.toBeNull();
  });

  it('🔴 貼れる 1 行が載っている(裸の entry: ではない)', () => {
    const r = rig();
    r.inspector.render(reduce(booted(), { type: 'SELECT_ENTRY', lid: 'n1' }).state);
    expect(r.btn()?.getAttribute('data-pkc-entry-ref')).toBe('[先週の議事録](entry:n1)');
  });

  /**
   * 🔴 **選んでいるノートのものが載る**。⚠ 押した時に組み立てると、押してから
   * 選択が移った場合に**別のノートの参照**が入る(`view-asset` が同じ理由で
   * 「押した要素から運ぶ」形にしてある)。
   */
  it('🔴 選び直すと、載っている参照も入れ替わる', () => {
    const r = rig();
    let s = reduce(booted(), { type: 'SELECT_ENTRY', lid: 'n1' }).state;
    r.inspector.render(s);
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'n2' }).state;
    r.inspector.render(s);
    // ⚠ 題名の `]` は escape されている(リンクが切れない)
    expect(r.btn()?.getAttribute('data-pkc-entry-ref'), '前のノートの参照が残っている').toBe(
      '[会議 \\[第 2 回\\]](entry:n2)',
    );
  });

  /**
   * 🔴 **配線**(押すとクリップボードへ渡る)── 面の test も binder の test も、
   * 「A と B が合意していること」は見られない(CLAUDE.md §7)。実物を繋ぐ。
   */
  it('🔴 押すと、貼れる 1 行がクリップボードへ渡る', () => {
    const r = rig();
    const d = new Dispatcher();
    const copied: string[] = [];
    bindActions(r.root, d, { copyText: (t: string) => copied.push(t) });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    r.inspector.render(d.getState());
    r.btn()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(copied, '押しても何も渡っていない').toEqual(['[先週の議事録](entry:n1)']);
  });

  /**
   * 🔴 **押した手応えを出す**(#427 段①を書いていて気づいた)。
   *
   * ⚠ 直す前は**参照のコピー 2 つだけ合図が無かった** ── 本文のコピー
   *   (`copy-md-block` / `copy-source`)は光るのに、参照は**無音**で、
   *   user から見て押せたのか分からない。⚠ しかも `flashCopied` は
   *   「合図の形を 2 つ作らない」ために共用してあるのに、**呼び忘れ**で外れていた。
   */
  it('🔴 押すと光る(無音で終わらない)', () => {
    const r = rig();
    const d = new Dispatcher();
    bindActions(r.root, d, { copyText: () => {} });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    r.inspector.render(d.getState());
    const b = r.btn()!;
    expect(b.getAttribute('data-pkc-flash'), '押す前から光っている').toBeNull();
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(b.getAttribute('data-pkc-flash'), '押しても無音(押せたか分からない)').toBe('true');
  });

  /**
   * 🔴 **右クリックのメニューから押しても写る**(2026-08-29。#582 の全数調査)。
   *
   * ⚠ 直す前は `closest('[data-pkc-entry-ref]')` **だけ**を見ていた ── メニューの
   *   ボタンは `data-pkc-action` しか持たず、器は **root 直下**に出るので
   *   `[data-pkc-entry-ref]` の**中に居ない**。つまり `ref === undefined` で
   *   `return` = **押しても何も起きず、理由も出ない**(無言の dead click)。
   *   ⚠ これは右クリックのメニューの**先頭の 1 行**である
   *   (`ENTRY_MENU_ACTIONS[0]` = 「参照をコピー」)。
   * 🔑 台は**実際のメニューと同じ形**にする ── `data-pkc-action` だけを持つ
   *   ボタンを **root 直下**に置く。⚠ 行の中に置くと `closest('[data-pkc-entry]')` が
   *   当たってしまい、**直す前の実装でも通る**(= 何も守らない台になる)。
   */
  it('🔴 右クリックのメニューから押しても、選んでいるノートの参照が写る', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const copied: string[] = [];
    const said: string[] = [];
    /**
     * ⚠ **本物と同じ意味論にする**(2026-08-29。CLAUDE.md §3)── `main.ts` の
     *   `copyText` は clipboard へ書いたあと **`done` を状態の行に出す**。
     * 🔴 押した側で `showStatus` を撃っても**勝てない**(clipboard の `.then` が
     *   12ms 後に上書きする ── 実測)ので、字は**この口から**渡っているかを見る。
     */
    bindActions(root, d, {
      copyText: (t: string, done?: string) => {
        copied.push(t);
        said.push(done ?? 'コピーしました');
      },
      showStatus: (t: string) => said.push(t),
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    // ⚠ メニューのボタンが持っているのは `data-pkc-action` **だけ**である
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'copy-entry-ref');
    root.append(b);
    expect(b.closest('[data-pkc-entry-ref]'), '台が実際のメニューと違う').toBeNull();
    expect(b.closest('[data-pkc-entry]'), '台が実際のメニューと違う').toBeNull();
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(copied, '押しても何も渡っていない(無言の dead click)').toEqual([
      '[会議 \\[第 2 回\\]](entry:n2)',
    ]);
    /**
     * 🔴 **`data-pkc-entry-ref` は 2 つの別物を指している**(2026-08-29 の着地前レビュー W-3)。
     *
     * | 出す側 | 中身 |
     * |---|---|
     * | `inspector.ts` | **貼れる 1 行** `[題名](entry:n1)` |
     * | `markdown-render.ts` | **生の href** `entry:n1#frag` |
     *
     * ⚠ いまは本文のリンクを右クリックしても PKC のメニューは出ない
     *   (`binder.ts` が `a[href]` で先に返し、ブラウザの既定を譲る)ので届かない。
     *   🔑 ただし #426 段② が本文のリンクでも受ける日、`carried` は**生の href を掴む** ──
     *   そのとき本文に貼られるのは `entry:n1#h-2` という**リンクにならない字**である。
     * ⚠ 等値の assert では**その日を検出できない**(値が変わるだけ)ので、**形**を見る。
     */
    expect(
      copied[0],
      '貼れる 1 行ではない(生の href を掴んでいる ── 本文に貼ってもリンクにならない)',
    ).toMatch(/^\[.*\]\(entry:/);
    /**
     * 🔴 **光るだけでは届かない** ── メニューは押した瞬間に畳まれるので、
     *   `data-pkc-flash` を付ける相手が消える。**状態の行に出す**まで見る。
     */
    /**
     * 🔴 **既定の汎用文で終わらせない**(2026-08-29 の動線レビュー 欠陥 2)。
     * ⚠ 「コピーしました」だけだと、隣の「素の Markdown」と**押した後の答えが同じ**に
     *   なる ── 2 つを見分けさせるのが目的なのに、見分けが付かない。
     */
    expect(said, 'メニューから押すと、成功しても画面に何も残らない').toEqual([
      'ノートへのリンクをコピーしました(本文に貼れます)',
    ]);
  });

  /**
   * 🔴 **写す物が無いなら、理由を言う**(#513 と同じ作法)。
   * ⚠ 直す前は `return` だけ ── 押しても無言だった。
   */
  it('🔴 ノートを選んでいなければ、黙らずに理由を出す', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const copied: string[] = [];
    bindActions(root, d, { copyText: (t: string) => copied.push(t) });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
    const errs: string[] = [];
    d.onState((st) => {
      if (st.error !== null) errs.push(st.error);
    });
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'copy-entry-ref');
    root.append(b);
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(copied, '選んでいないのに何かを写した').toEqual([]);
    expect(errs.join('\n'), '押しても無言(dead click)').toContain('ノートを選んで');
  });

  /**
   * 🔴 **対称の反対側**(CLAUDE.md「片側を直したら、反対側を必ず疑う」)。
   * ⚠ 添付の「参照をコピー」も**同じ呼び忘れ**で無音だった ── 直したなら
   *   こちらも pin しないと、次に触った人が黙って落とす(変異試験 R10 が
   *   SURVIVED で教えた)。
   */
  it('🔴 添付の「参照をコピー」も、押すと光る(対称の反対側)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'copy-asset-ref');
    b.setAttribute('data-pkc-asset-ref', '![絵](asset:k1)');
    root.append(b);
    const copied: string[] = [];
    bindActions(root, new Dispatcher(), { copyText: (t: string) => copied.push(t) });
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(copied, '添付の参照が渡っていない').toEqual(['![絵](asset:k1)']);
    expect(b.getAttribute('data-pkc-flash'), '押しても無音').toBe('true');
  });
});
