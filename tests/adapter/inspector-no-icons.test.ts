/** @vitest-environment happy-dom */
/**
 * 🔴 **右の列の操作ボタンは、絵を持たず字だけである**(#1029 段 D-2)。
 *
 * ## なぜ要るか
 *
 * 右の列は、絵つきのボタン(「関係を足す」「整理案を適用」「タグを足す」…)と
 * 字だけのボタンが**同じ列に混ざっていた**(設計 doc `button-rhythm-design-2026-09.md`
 * 手 4「絵の混在をやめる」)。絵の有無で**字の始まりがずれる**ので、並びの中で
 * 無地のほうが弱く見える。#1029 の裁定(2026-10-01、Gemini が A = 外す)で、
 * **右の列だけ**絵を全部外した。
 *
 * ## ⚠ 守る範囲は「右の列」だけ
 *
 * 左の列・画面下の帯・書式の帯・右クリックのメニューの絵は**別の面の決め事**
 * (D-1 で帯ごとに揃えた)なので外していない ── 対照群で**他の面の絵が残っている**
 * ことまで見る(全部の面から絵を消す変異でも緑になるのを防ぐ)。
 *
 * ## 🔑 見るのは**描いた DOM**で、属性を**全部**数える
 *
 * ⚠ 絵の器は `data-pkc-icon` を持つが、`data-pkc-symbol` / `data-pkc-chip` /
 *   `data-pkc-tone` も同じ要素に付く(`iconSpan` / `setActionIcon`)。**1 つの属性だけ**
 *   見ると、別の属性だけで描く絵を数え落とす。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell, paintCaptureBar } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';

const meta = (lid: string, title: string, archetype: EntryMeta['archetype']): EntryMeta => ({
  lid,
  title,
  archetype,
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

/** 絵の器が持つ属性の**全部**(`icons.ts` の `iconSpan` / `setIcon` / `setActionIcon`)。 */
const ICON_ATTRS = ['data-pkc-icon', 'data-pkc-symbol', 'data-pkc-chip', 'data-pkc-tone'] as const;
const ICON_SELECTOR = ICON_ATTRS.map((a) => `[${a}]`).join(',');

beforeEach(() => {
  document.body.textContent = '';
});

function mount(): { root: HTMLElement; inspector: InspectorRenderer } {
  const root = document.createElement('div');
  document.body.append(root);
  return { root, inspector: new InspectorRenderer(buildShell(root).inspector) };
}

/** ノート + タグ + 関係 + 元ファイル在り ── 右の列のボタンを**できるだけ全部**描く台。 */
function noteState(): AppState {
  let s = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('n1', '議事録', 'text'), meta('n2', '資料', 'text')],
    relations: [
      { id: 'r1', fromLid: 'n1', toLid: 'n2', kind: 'semantic', createdAt: null, updatedAt: null },
    ],
  }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state;
  s = reduce(s, { type: 'BODY_LOADED', lid: 'n1', body: '---\ntags: [買物]\n---\n本文\n' }).state;
  s = reduce(s, { type: 'FILE_LINKED', lid: 'n1', name: 'memo.md' }).state;
  return s;
}

function folderState(): AppState {
  let s = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('f1', 'フォルダ', 'folder')],
    relations: [],
  }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'f1' }).state;
  return s;
}

/** 右の列の押しボタンを、描いた物から全部拾う(action を持つ物 = 押せる物)。 */
const buttonsOf = (root: HTMLElement): HTMLButtonElement[] => [
  ...root.querySelectorAll<HTMLButtonElement>(
    '[data-pkc-region="inspector"] button[data-pkc-action]',
  ),
];

describe('右の列の操作ボタンは絵を持たない(#1029 段 D-2)', () => {
  it('🔴 ノートを選んだ右の列に、絵の属性を持つ要素が 1 つも無い(操作 / タグ / 関係)', () => {
    const { root, inspector } = mount();
    inspector.render(noteState());
    const actions = buttonsOf(root).map((b) => b.getAttribute('data-pkc-action'));
    // ⚠ 空振り防止 ── 台が描けていないと「0 件」は 0 対 0 で成立する。
    //   この台が描く 3 種(タグを外す / 関係を消す / 関係を足す)を名指しで見る
    for (const a of ['untag-entry', 'remove-relation', 'add-relation', 'add-tag']) {
      expect(actions, `台が ${a} を描けていない(空振り)`).toContain(a);
    }
    expect(buttonsOf(root).length, '操作のボタンが少なすぎる(空振り)').toBeGreaterThan(10);
    const withIcon = [...root.querySelectorAll('[data-pkc-region="inspector"] *')]
      .filter((el) => ICON_ATTRS.some((a) => el.hasAttribute(a)))
      .map((el) => `${el.tagName}:${ICON_ATTRS.filter((a) => el.hasAttribute(a)).join('+')}`);
    expect(withIcon, '右の列に絵の属性が在る(字だけにする)').toEqual([]);
  });

  it('🔴 フォルダを選んだ右の列にも無い(フォルダの操作 = this-folder)', () => {
    const { root, inspector } = mount();
    inspector.render(folderState());
    expect(
      buttonsOf(root).map((b) => b.getAttribute('data-pkc-action')),
      '台がフォルダの操作を描けていない(空振り)',
    ).toContain('export-folder');
    expect(root.querySelectorAll(`[data-pkc-region="inspector"] :is(${ICON_SELECTOR})`)).toHaveLength(0);
  });

  it('🔴 何も選んでいない右の列(コレクション + 整理案を適用)にも無い', () => {
    const { root, inspector } = mount();
    inspector.render(initialState);
    expect(
      buttonsOf(root).map((b) => b.getAttribute('data-pkc-action')),
      '台がコレクションの操作を描けていない(空振り)',
    ).toContain('toggle-plan-apply');
    expect(root.querySelectorAll(`[data-pkc-region="inspector"] :is(${ICON_SELECTOR})`)).toHaveLength(0);
  });

  it('🔴 字は 1 つも変わっていない ── 名前つきのボタンは、丸ごとの textContent が名前だけ(絵の字が前に付かない)', () => {
    const { root, inspector } = mount();
    inspector.render(noteState());
    // ⚠ 名前の器(`data-pkc-field="label"`)を持つのは `iconButton` で組んだ物だけ
    //   (日付の設定のような素の `button` は持たない)── 持つ物だけを見る
    const named = buttonsOf(root).filter((b) => b.querySelector('[data-pkc-field="label"]') !== null);
    expect(named.length, '名前つきのボタンが少なすぎる(空振り)').toBeGreaterThan(10);
    for (const b of named) {
      const label = b.querySelector('[data-pkc-field="label"]')!.textContent;
      expect(label, `${b.getAttribute('data-pkc-action')} の名前が空`).toBeTruthy();
      expect(b.textContent, `${b.getAttribute('data-pkc-action')} に名前以外の字が混じる`).toBe(
        label,
      );
    }
  });

  it('⚠ 対照群 ── 他の面(画面下の収録の帯)の絵は残っている(絵を全面から消した変異で緑にならない)', () => {
    const { root } = mount();
    paintCaptureBar(root, '録音しています 00:12');
    const bar = root.querySelector('[data-pkc-region="capture-bar"]');
    expect(bar, '収録の帯が描けていない').not.toBeNull();
    expect(
      bar!.querySelectorAll('[data-pkc-icon][data-pkc-symbol]').length,
      '他の面の絵まで消えている(右の列だけが範囲)',
    ).toBeGreaterThan(0);
  });
});
