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
 *
 * ## 🔴 段 C で塊が 8 つに増えた(2026-09-21)
 *
 * ⚠ `export-entry`(バックアップ)は `when` を持たないので、**フォルダを選んでいても
 *   常に出る** ── つまりフォルダでは `export-entry` と `export-folder` が
 *   **同じ字「バックアップ」で同時に**出る(名前を短くした段 C で顕在化した衝突)。
 *   見出しで区別するには**別の塊**にするしかないが、**並び順は変えられない**
 *   (`export-folder` の位置は動かさない)ので、`export` の塊が
 *   `export-folder` を挟んで**2 つに分かれる**(`copy/open/take-in/export/
 *   this-folder/export/this-one/remove` の 8 つ)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { blocksFor, stripComments, withoutMedia } from '../helpers/css-blocks';
import {
  ENTRY_ACTION_WIDTH_ATTR,
  ENTRY_MENU_ACTIONS,
  entryActionWidthTier,
} from '../../src/features/entry-actions';

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

/** フォルダ + 元ファイル在りで組む ── `export-folder` / `write-back-file` の両方を描く。 */
function renderFolderWithLink(): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  const inspector = new InspectorRenderer(buildShell(root).inspector);
  let s = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('n1', '議事録', 'folder')],
    relations: [],
  }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state;
  s = reduce(s, { type: 'FILE_LINKED', lid: 'n1', name: 'memo.md' }).state;
  inspector.render(s);
  return root;
}

describe('右の列の操作は塊に分かれている(#1029 段 B / 段 C)', () => {
  it('🔴 塊の名前は等値 ── 1 つにまとめ直したら落ちる(段 C で 8 つに増えた)', () => {
    const root = renderInspector();
    const groups = [
      ...root.querySelectorAll<HTMLElement>('[data-pkc-field="inspector-action-group"]'),
    ].map((g) => g.getAttribute('data-pkc-group'));
    /**
     * 🔴 **`export` が 2 回出る**(段 C、上の docstring)。⚠ 等値 pin なので、
     *   `export-folder` の塊を `export` へ戻したら(= 衝突が再発したら)ここが
     *   6 要素に縮んで落ちる。逆に塊をもっと割ったら 8 要素を超えて落ちる。
     */
    expect(groups).toEqual([
      'copy',
      'open',
      'take-in',
      'export',
      'this-folder',
      'export',
      'this-one',
      'remove',
    ]);
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
   * 🔑 守るのは「間が在る」ではなく「**器 1 つだけに間が在り、個々のボタンには無い**」
   *   である(ボタン個体に付けると、行の途中で 1 個だけ浮く形が戻る)。
   *
   * 🔴 **⚠ 訂正(#1054 段②-2、F9)**:「行いっぱいにする(`flex: 1 0 100%`)」は
   *   **こちら側の都合**(境目のずれを避ける安全策)だったが、その代償として
   *   **7 個のタイルが常に 2 行になる**(user 指摘「詰め込みなさい」── 250px の列に
   *   7×32px は 1 行で入る幅がある)。⚠ これは「間違いの修正」であって「動線を
   *   こちらの都合と交換した」ではない ── 個々のボタンへの `margin-top` を
   *   戻すのではなく、**器 1 つに付ける間の種類**を「強制改行の間」から
   *   「1 行に収まれば同じ行内の区切り、収まらなければ改行後の区切り」
   *   (`border-inline-start` + `padding-inline-start`)へ変えた。どちらも
   *   **器 1 つにしか付いていない**ので、元の壊れ方(個体ごとの浮き)は再発しない。
   */
  it('🔴 左の列の切れ目は器 1 つが持つ(ボタン個体に間を付けない・強制改行はしない)', () => {
    const css = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));
    const group = blocksFor(
      css,
      "[data-pkc-region='collection-bar'] [data-pkc-field='collection-app-group']",
    );
    expect(group.length, 'アプリ全体の操作の器が読めていない(空振り)').toBe(1);
    expect(group[0], '切れ目の間(器の内側の余白)を出していない').toContain(
      'padding-inline-start: var(--s3)',
    );
    expect(group[0], '切れ目の線を出していない').toContain('border-inline-start: 1px solid');
    // 🔑 F9(#1054 段②-2)── 強制改行(`flex: 1 0 100%`)は撤去した(7 個を 1 行に詰める)
    expect(group[0], '強制改行が戻っている ── 7 個が入る幅でも必ず 2 行になる').not.toContain(
      'flex: 1 0 100%',
    );

    const btn = blocksFor(css, "[data-pkc-field='app-settings']").join('\n');
    expect(btn, '線が戻っている ── 切れ目は間で出す(地は無彩色)').not.toContain('border-top');
    expect(btn, 'ボタン個体に間が付いている ── 行の途中で 1 個だけ浮く').not.toContain(
      'margin-top',
    );
  });
});

/**
 * 🔴 **右の列(情報ペイン)が描いた塊は、`ENTRY_MENU_ACTIONS` の `group` と等値**
 * (#1029 段 C 門②)。
 *
 * ## なぜ要るか
 *
 * 直す前は `inspector.ts` の中に `group('copy')` のように**塊の名前が直書き**
 * されていた。右クリック(`context-menu.ts`)は同じ塊を `ENTRY_MENU_ACTIONS` の
 * `group` フィールドから引くので、**2 つの面が別々の場所から塊を読む形**のままだと、
 * 片方だけ塊を変えた日に右の列と右クリックの見出しが食い違う(CLAUDE.md §7)。
 *
 * 🔑 だからここでは**実物の DOM**(`InspectorRenderer` が描いた
 * `[data-pkc-group]`)と、**実装の `group` フィールド**を直接突き合わせる ──
 * どちらも「同じ表を読んでいる」という同語反復ではなく、**独立した 2 つの観測**
 * (描かれた木構造 / 元の配列)を比べる。
 */
describe('情報ペインの塊は正本(entry-actions.ts)から来る(#1029 段 C)', () => {
  it('🔴 塊を持つ 1 件残らず、描かれた data-pkc-group が ENTRY_MENU_ACTIONS の group と一致する', () => {
    const root = renderFolderWithLink();
    const withGroup = ENTRY_MENU_ACTIONS.filter((a) => a.group !== undefined);
    // ⚠ 空振り防止 ── 塊を持つ物が 0 件なら、下のループは何も見ない
    expect(withGroup.length, '塊を持つ操作が 0 件(空振り)').toBeGreaterThan(10);
    for (const a of withGroup) {
      const btn = root.querySelector(`[data-pkc-action="${a.action}"]`);
      expect(btn, `${a.action} のボタンが描かれていない`).not.toBeNull();
      const groupEl = btn!.closest('[data-pkc-group]');
      expect(groupEl, `${a.action} を包む塊(data-pkc-group)が無い`).not.toBeNull();
      expect(
        groupEl!.getAttribute('data-pkc-group'),
        `${a.action} の塊が正本(entry-actions.ts の group)と食い違っている`,
      ).toBe(a.group);
    }
  });

  it('⚠ export-entry と export-folder は別の塊(バックアップの字が同じでも区別できる)', () => {
    const root = renderFolderWithLink();
    const entryGroup = root
      .querySelector('[data-pkc-action="export-entry"]')
      ?.closest('[data-pkc-group]')
      ?.getAttribute('data-pkc-group');
    const folderGroup = root
      .querySelector('[data-pkc-action="export-folder"]')
      ?.closest('[data-pkc-group]')
      ?.getAttribute('data-pkc-group');
    expect(entryGroup, 'export-entry の塊が読めていない(空振り)').not.toBeUndefined();
    expect(folderGroup, 'export-folder の塊が読めていない(空振り)').not.toBeUndefined();
    expect(folderGroup, '同じ塊に入っている(見出しでの区別ができない)').not.toBe(entryGroup);
  });

  it('🔴 export-folder だけの塊は、畳むとき塊の器ごと畳む(空の塊が余計な間を作らない)', () => {
    // ⚠ ノート(フォルダではない)で描く ── export-folder が hidden になる場面
    const root = document.createElement('div');
    document.body.append(root);
    const inspector = new InspectorRenderer(buildShell(root).inspector);
    const s = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('n1', '議事録', 'text')],
      relations: [],
    }).state;
    inspector.render(reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state);
    const folderBtn = root.querySelector('[data-pkc-action="export-folder"]');
    expect(folderBtn, 'export-folder のボタンが描かれていない(空振り)').not.toBeNull();
    expect((folderBtn as HTMLButtonElement).hidden, 'ノートなのに export-folder が出ている').toBe(
      true,
    );
    const groupEl = folderBtn!.closest('[data-pkc-group]');
    expect(groupEl, 'export-folder を包む塊が無い(空振り)').not.toBeNull();
    expect(
      (groupEl as HTMLElement).hidden,
      '塊(export-folder だけの器)が畳まれていない(余計な間が残る)',
    ).toBe(true);
  });

  it('🔴 描かれたボタンの幅の段が、正本(entryActionWidthTier)と一致する', () => {
    const root = renderFolderWithLink();
    for (const a of ENTRY_MENU_ACTIONS) {
      const btn = root.querySelector(`[data-pkc-action="${a.action}"]`);
      expect(btn, `${a.action} のボタンが描かれていない`).not.toBeNull();
      expect(
        btn!.getAttribute(ENTRY_ACTION_WIDTH_ATTR),
        `${a.action} の幅の段が正本と食い違っている`,
      ).toBe(entryActionWidthTier(a.label));
    }
  });

  it('🔑 ENTRY_MENU_ACTIONS が使う塊は 6 つ(copy/export/open/remove/this-folder/this-one)', () => {
    // ⚠ `take-in` は `ENTRY_MENU_ACTIONS` の外(`adopt-external-images`)専用なので含まれない
    const groups = new Set(
      ENTRY_MENU_ACTIONS.map((a) => a.group).filter((g): g is string => g !== undefined),
    );
    expect([...groups].sort()).toEqual(
      ['copy', 'export', 'open', 'remove', 'this-folder', 'this-one'].sort(),
    );
  });
});
