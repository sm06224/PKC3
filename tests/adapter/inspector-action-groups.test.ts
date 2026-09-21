/** @vitest-environment happy-dom */
/**
 * 🔴 **右の列の操作は、塊に分かれている**(#1029 段 B)。
 *
 * ## なぜ要るか
 *
 * user 指摘 2026-09-21:「**ボタンの横のサイズが一定ではない / 名前にもリズムがない /
 * 視覚的にもでこぼこで統一感がなく、ストレス**」。
 * 実測すると、この面は **17 個のボタンが 17 通りの幅**(名前の幅 3〜28 桁)で 1 本の帯に
 * 流れていた ── 右端がどこも揃わないので、押す物を探すたびに全部読み直すことになる。
 *
 * 🔑 段 B で入れたのは **「間」だけ**である(並びも名前も 1 つも変えていない)。
 *   だから守るのは 2 つ:**塊が在ること**と、**塊の外にボタンが漏れていないこと**。
 *
 * ⚠ **「塊が 1 つ以上在る」では足りない** ── 塊を 1 つにまとめても真になるので、
 *   直す前(1 本の帯)と見分けが付かない。**塊の名前を等値で pin する**。
 * ⚠ CSS 側も見る ── DOM に塊が在っても、間が 1px のままなら**画面では何も変わらない**
 *   (CLAUDE.md §1「検査が別の理由で成立している」)。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { blocksFor, stripComments, withoutMedia } from '../helpers/css-blocks';

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

beforeEach(() => {
  document.body.textContent = '';
});

/** ⚠ 台は**フォルダ**にする ── `export-folder` はノートでは畳まれ、経路を 1 度も通らない。 */
function renderInspector(): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  const inspector = new InspectorRenderer(buildShell(root).inspector);
  const s = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('n1', '議事録', 'folder')],
    relations: [],
  }).state;
  inspector.render(reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state);
  return root;
}

describe('右の列の操作は塊に分かれている(#1029 段 B)', () => {
  it('🔴 塊の名前は等値 ── 1 つにまとめ直したら落ちる', () => {
    const root = renderInspector();
    const groups = [
      ...root.querySelectorAll<HTMLElement>('[data-pkc-field="inspector-action-group"]'),
    ].map((g) => g.getAttribute('data-pkc-group'));
    expect(groups).toEqual(['copy', 'open', 'take-in', 'export', 'this-one', 'remove']);
  });

  it('🔴 操作のボタンは 1 つ残らず塊の中に在る(帯へ直に足したら落ちる)', () => {
    const root = renderInspector();
    const bar = root.querySelector<HTMLElement>('[data-pkc-field="inspector-actions"]');
    expect(bar, '操作の帯が描けていない(空振り)').not.toBeNull();
    const all = [...bar!.querySelectorAll<HTMLButtonElement>('button[data-pkc-action]')];
    // ⚠ 空振り防止 ── 0 個だと「全部が塊の中」は 0 対 0 で成立する
    expect(all.length, '操作のボタンを 1 つも描けていない(空振り)').toBeGreaterThan(5);
    const loose = all
      .filter((b) => b.closest('[data-pkc-field="inspector-action-group"]') === null)
      .map((b) => b.getAttribute('data-pkc-action'));
    expect(loose, '塊の外に出ているボタンが在る ── 足すときは group() の後に置く').toEqual([]);
  });

  it('🔴 塊の間は、塊の中より広い(CSS。DOM だけ分けても画面は変わらない)', () => {
    const css = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));
    const bar = blocksFor(
      css,
      "[data-pkc-region='inspector'] [data-pkc-field='inspector-actions']",
    );
    expect(bar.length, '操作の帯の規則が読めていない(空振り)').toBe(1);
    const gap = /gap:\s*([^;]+);/.exec(bar[0]!)?.[1]?.trim();
    // ⚠ 2 つ書いてあること自体を見る(縦 1px / 横は間)── 1 つだと塊の間が詰まる
    expect(gap, '帯の gap が「縦 横」の 2 値でない ── 塊の間が空かない').toMatch(
      /^1px\s+var\(--s[3-6]\)$/,
    );

    const group = blocksFor(
      css,
      "[data-pkc-region='inspector'] [data-pkc-field='inspector-action-group']",
    );
    expect(group.length, '塊の規則が読めていない(空振り)').toBe(1);
    expect(group[0], '塊が折り返せない ── 狭い列で塊ごと溢れる').toContain('flex-wrap: wrap');
    expect(group[0], '塊の中の間が 1px でない').toMatch(/gap:\s*1px;/);
  });

  /**
   * 🔴 **間は「器」に持たせる。ボタン 1 個ずつに持たせない**(2026-09-21、実ブラウザが捕まえた)。
   *
   * ⚠ 1 稿目は 4 つのボタン**それぞれ**に `margin-top` を付けた ── `margin-top` は
   *   **行の境目ではなく、その要素 1 個**を押し下げるので、境目が行の途中に来る幅
   *   (実測 1440px 以上)で**「集計」だけが 8px 下へぶら下がった**。
   *   左の列の高さを数える既存の検査(#475)が、その浮きを **3 段目**として数えて落ちた。
   * 🔑 だから守るのは「間が在る」ではなく「**行いっぱいの器に間が在る**」である ──
   *   `flex: 1 0 100%` が無いと、同じ壊れ方が戻る。
   */
  it('🔴 左の列の切れ目は、行いっぱいの器が持つ(ボタン個体に間を付けない)', () => {
    const css = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));
    const group = blocksFor(
      css,
      "[data-pkc-region='collection-bar'] [data-pkc-field='collection-app-group']",
    );
    expect(group.length, 'アプリ全体の操作の器が読めていない(空振り)').toBe(1);
    expect(group[0], '切れ目を間で出していない').toContain('margin-top: var(--s3)');
    expect(group[0], '器が行いっぱいでない ── 行の途中から始まると 1 個だけ浮く').toContain(
      'flex: 1 0 100%',
    );

    const btn = blocksFor(css, "[data-pkc-field='app-settings']").join('\n');
    expect(btn, '線が戻っている ── 切れ目は間で出す(地は無彩色)').not.toContain('border-top');
    expect(btn, 'ボタン個体に間が付いている ── 行の途中で 1 個だけ浮く').not.toContain(
      'margin-top',
    );
  });
});
