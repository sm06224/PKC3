/** @vitest-environment happy-dom */
/**
 * 🔴 **情報ペインのボタンは、全部「何が起きるか」を持っている**(2026-08-29)。
 *
 * ## なぜ要るか
 *
 * `InspectorRenderer.render` は最後に **全ボタンの `title` を
 * `ACTION_TITLES[action] ?? ''` で上書きする** ── 表に鍵が無い操作は
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

/** 操作のボタンだけを見る(行や欄は `data-pkc-action` を持っていても対象外)。 */
function actionButtons(root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('[data-pkc-region="inspector"] button[data-pkc-action]')];
}

describe('情報ペインのボタンの説明(2026-08-29)', () => {
  it('🔴 全部のボタンが「何が起きるか」を持っている(空の tooltip が無い)', () => {
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
    // 空振り防止 ── 引けていないのに緑にならない
    expect(btns.length, 'ボタンを引けていない(空振り)').toBeGreaterThanOrEqual(12);
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
});
