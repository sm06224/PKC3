/** @vitest-environment happy-dom */
/**
 * 🔴 **情報ペインの「操作の帯」のボタンは、全部「何が起きるか」を持っている**(2026-08-29)。
 *
 * ## なぜ要るか
 *
 * `InspectorRenderer.render` は最後に **全ボタンの `title` を
 * `entryActionHint(action, …)` で上書きする**(表の実体は `features/entry-actions.ts` の
 * `ENTRY_ACTION_HINTS`。⚠ 2026-08-29 まで `inspector.ts` の `ACTION_TITLES` だった)── 表に鍵が無い操作は
 * **説明が空のまま**配られる。⚠ 実際 `copy-entry-ref` / `copy-plain-markdown` の
 * 2 つがそうなっていた(前者は `render` の中で説明を代入する行が在ったのに、
 * この上書きに**必ず負ける**ので一度も画面に出ていない)。
 *
 * ⚠ この面のボタンは **字が短い**(「書き出す」「素の Markdown」)ので、
 *   説明が無いと**何が起きるか読めない** ── とくに `copy-` が 2 つ並ぶ所は
 *   区別が付かない。
 *
 * 🔑 **数を実数で pin する**(空振り防止)── ボタンを増やした人がここで気づく。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { entryMenuActions } from '../../src/features/entry-actions';

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

/**
 * 🔴 **見るのは「操作の帯」だけ**(2026-08-29 の着地前レビュー R-3)。
 *
 * ⚠ 1 稿目は面の全ボタンを拾い、題名も「全部のボタンが」と書いていたが、
 *   **主張が製品について偽**だった ── 関係の相手 / 参照元 / 集まり先に出る
 *   `select-entry` のボタンは `title` を持たない(`inspector.ts:473 / :539 / :564`)。
 *   ⚠ しかも台が `relations: []` / `backlinks: null` なので、**その 3 経路を
 *   1 度も通っていなかった**(CLAUDE.md §2「弱いのではなく走っていない」)── 
 *   つまり守っていたのは「この台が出す分は持っている」だけである。
 * 🔑 **主張と観測範囲を揃える** ── あちらは**ノートの題名がそのまま字**なので、
 *   説明が無くても押した結果が読める(押す = そのノートへ行く)。
 *   説明が要るのは**動詞が短い操作の帯**のほうである。
 */
function actionButtons(root: HTMLElement): HTMLButtonElement[] {
  return [
    ...root.querySelectorAll<HTMLButtonElement>(
      '[data-pkc-field="inspector-actions"] button[data-pkc-action]',
    ),
  ];
}

/**
 * 🔴 **操作の帯に出るボタン**(等値で pin する ── W-4)。
 * ⚠ 台は**フォルダ**にしてある ── `export-folder` は種類で畳まれるので、
 *   ノートで描くとその 1 つを**一度も見ない**(未実行の経路になる)。
 */
const EXPECTED_ACTIONS: readonly string[] = [
  // 🔴 付箋(#685 段②、2026-09-04)── ⋯ と情報ペインの両方に出す
  'copy-entry-ref',
  'open-note-window',
  'adopt-external-images',
  'export-entry',
  'export-entry-html',
  'export-folder',
  'export-entry-docx',
  'export-entry-pptx',
  'export-entry-pdf',
  'copy-plain-markdown',
  'show-history',
  'delete-entry',
];

describe('情報ペインの操作の帯の説明(2026-08-29)', () => {
  it('🔴 操作の帯のボタンが全部「何が起きるか」を持っている(空の tooltip が無い)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const inspector = new InspectorRenderer(buildShell(root).inspector);
    const s = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      // ⚠ フォルダにする ── `export-folder` は種類で畳まれるので、
      //   ノートで描くとその 1 つを**一度も見ない**(未実行の経路になる)
      metas: [meta('n1', '議事録', 'folder')],
      relations: [],
    }).state;
    inspector.render(reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state);

    const btns = actionButtons(root);
    /**
     * 🔴 **等値で pin する**(2026-08-29 の着地前レビュー W-4)。
     * ⚠ 1 稿目は `toBeGreaterThanOrEqual(12)` で、docstring は「増やした人が気づく」と
     *   書いていたが、**床は増加も、3 つ消えたことも検出しない**。
     * ⚠ 増減したらこの数を直すこと ── 直さないと落ちる = 忘れられない。
     */
    expect(
      btns.map((b) => b.getAttribute('data-pkc-action')),
      '操作の帯のボタンが変わった(増減したらこの表を直す)',
    ).toEqual(EXPECTED_ACTIONS);
    const naked = btns
      .filter((b) => b.title.trim() === '')
      .map((b) => b.getAttribute('data-pkc-action'));
    expect(naked, '説明が空のボタンがある(何が起きるか読めない)').toEqual([]);
  });

  /**
   * 🔴 **`copy-` が 2 つ並ぶので、説明が違うことまで見る**。
   * ⚠ 「全部 1 文字以上」だけだと、**同じ字を両方に入れる**変異が生き延びる ──
   *   user が読むのは「どちらを押すか」を決めるためである。
   */
  it('🔴 「参照をコピー」と「素の Markdown」の説明が別物である', () => {
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
    const t = (a: string): string =>
      root.querySelector<HTMLElement>(`[data-pkc-action="${a}"]`)?.title ?? '';
    expect(t('copy-entry-ref'), '参照の説明が無い').not.toBe('');
    expect(t('copy-plain-markdown'), '素の Markdown の説明が無い').not.toBe('');
    expect(t('copy-entry-ref'), '2 つの説明が同じ(どちらを押すか決められない)').not.toBe(
      t('copy-plain-markdown'),
    );
  });

  /**
   * 🔴 **情報ペインと右クリックが、同じ操作に同じ説明を出す**(着地前レビュー 🔴2)。
   *
   * ⚠ この主張は **`entry-actions.ts` の test にも `inspector.ts` の test にも書けない**
   *   ── 片方は表を、もう片方は DOM を見るので、**その間の配線**は誰も通らない
   *   (CLAUDE.md §7「合意を見る場所を別に 1 つ作る」)。
   * ⚠ 1 稿目の parity は `entryMenuActions().hint` を `entryActionHint()` と比べており、
   *   **同じ関数を同じ引数で 2 回呼ぶ同語反復**だった(レビューが拾った)。
   * 🔑 ここは**実物の情報ペインが描いた `title`** と、**右クリックが配る `hint`** を突き合わせる。
   *
   * ⚠ 実害の形:情報ペインは以前 `archetype: null` を固定して渡していたので、
   *   種類で変わる説明を足した日に**右クリックだけが新しい字を出す**
   *   ── 同じボタンが面によって別のことを言う。
   */
  it('🔴 情報ペインの説明と、右クリックの説明が一致する', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const inspector = new InspectorRenderer(buildShell(root).inspector);
    const s = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      // ⚠ **フォルダにする** ── 種類で畳まれる `export-folder` を突き合わせに含める
      metas: [meta('n1', '議事録', 'folder')],
      relations: [],
    }).state;
    inspector.render(reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state);

    const hints = new Map(
      entryMenuActions({ archetype: 'folder', linkedFile: null }).map((a) => [a.action, a.hint]),
    );
    const shared = actionButtons(root).filter((b) =>
      hints.has(b.getAttribute('data-pkc-action') ?? ''),
    );
    // ⚠ 空振り防止 ── 突き合わせが 0 件でも「全部一致」は真になる
    expect(shared.length, '両方の面に在る操作が拾えていない(台の空振り)').toBeGreaterThanOrEqual(8);
    for (const b of shared) {
      const a = b.getAttribute('data-pkc-action') ?? '';
      expect(b.title, `${a} の説明が面で食い違っている`).toBe(hints.get(a));
    }
  });
});
