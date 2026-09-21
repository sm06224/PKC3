/** @vitest-environment happy-dom */
/**
 * 🔴 **何も選んでいない = コレクションを選んでいる**(#1017 段④a)。
 *
 * `docs/development/ui-total-design-2026-09.md` §3.1 / §4.3 の裁定
 * (user 裁定 2026-09-20 6 巡目「コレクションの操作は右の列に出す」)の実体。
 *
 * ⚠ 直す前は「左の一覧から選ぶと、ここに情報が出ます。」の 1 文だけだった
 *   (#582 R2 実測:1280×800 で中身 14%)。ここを**コレクションの情報 + 操作**にする。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { COLLECTION_PANE_COMMANDS } from '../../src/adapter/ui/render/commands';

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

function makeInspector(): { root: HTMLElement; inspector: InspectorRenderer } {
  const root = document.createElement('div');
  document.body.append(root);
  return { root, inspector: new InspectorRenderer(buildShell(root).inspector) };
}

describe('右の列(何も選んでいない = コレクション。#1017 段④a / 段④b)', () => {
  it('🔴 4 つの書き出し操作 + 整理案を適用が、実際に押せる形で描かれている', () => {
    const { root, inspector } = makeInspector();
    inspector.render(initialState);

    const pane = root.querySelector('[data-pkc-field="collection-pane"]');
    expect(pane, '空のときの面が無い').not.toBeNull();
    // ⚠ **等値**で見る(定数を見るだけでは、描き忘れが素通りする ── §1)
    const actions = [...pane!.querySelectorAll('button[data-pkc-action]')].map((b) =>
      b.getAttribute('data-pkc-action'),
    );
    /**
     * 🔴 **`toggle-plan-apply` / `apply-plan` は #1017 段④b で足した**
     * (「構成をコピー」の隣へ「整理案を適用」を移した)。⚠ `COLLECTION_PANE_COMMANDS`
     * には無い ── 貼り付け欄つきの器なので一律のボタン + 説明の形に収まらない
     * (`inspector.ts` の `buildPlanApplyItem`)。
     */
    expect(actions).toEqual([
      ...COLLECTION_PANE_COMMANDS.map((c) => c.action),
      'toggle-plan-apply',
      'apply-plan',
    ]);

    // ⚠ 畳んでいないこと(user 指示 2026-08-03「主要な導線を畳まない」)
    expect(pane!.querySelectorAll('details')).toHaveLength(0);
    /**
     * ⚠ **`apply-plan` だけは `hidden` の内側**(押したときだけ出す貼り付け欄)。
     * ⚠ 主要な導線そのもの(`toggle-plan-apply`)は隠れていない。
     */
    for (const el of pane!.querySelectorAll<HTMLElement>('button[data-pkc-action]')) {
      const action = el.getAttribute('data-pkc-action');
      if (action === 'apply-plan') continue;
      expect(el.closest('[hidden]'), `${action} が隠れている`).toBeNull();
    }
    expect(
      pane!.querySelector('[data-pkc-action="apply-plan"]')?.closest('[hidden]'),
      '貼り付け欄が既定で隠れていない',
    ).not.toBeNull();
  });

  it('🔴 各ボタンの下に説明(`title`)が見える字としても出る', () => {
    const { root, inspector } = makeInspector();
    inspector.render(initialState);
    const pane = root.querySelector('[data-pkc-field="collection-pane"]')!;
    for (const { action, title } of COLLECTION_PANE_COMMANDS) {
      const btn = pane.querySelector<HTMLElement>(`[data-pkc-action="${action}"]`)!;
      // ⚠ title は消さない(ホバーする人の情報を減らさない)
      expect(btn.title, `${action} の title が消えた`).toBe(title);
      const note = pane.querySelector<HTMLElement>(`[data-pkc-field="${action}-note"]`);
      expect(note, `${action} の見える説明が無い`).not.toBeNull();
      expect(note?.hidden, `${action} の説明が隠れている`).toBe(false);
      expect(note?.textContent, `${action} の見える説明が title と食い違う`).toBe(title);
    }
  });

  it('🔴 件数は entryMetas から archetype 別に数える(worker を叩かない)', () => {
    const { root, inspector } = makeInspector();
    const s = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        meta('n1', 'ノート1', 'text'),
        meta('n2', 'ノート2', 'todo'),
        meta('f1', 'フォルダ1', 'folder'),
        meta('a1', '添付1', 'attachment'),
        meta('a2', '添付2', 'attachment'),
      ],
      relations: [],
    }).state;
    inspector.render(s);
    const info = root.querySelector('[data-pkc-field="collection-info"]');
    expect(info, 'コレクションの件数が無い').not.toBeNull();
    // ⚠ 実装の内部の綴りを写さない ── 数の意味(3 種)が別々に読めることだけを見る
    expect(info!.textContent).toContain('2');
    expect(info!.textContent).toContain('1');
    expect(info!.textContent, 'ノート件数が無い').toMatch(/ノート/);
    expect(info!.textContent, '添付件数が無い').toMatch(/添付/);
    expect(info!.textContent, 'フォルダ件数が無い').toMatch(/フォルダ/);
  });

  /**
   * 🔴 **器を捨てない**(file 冒頭の作法)── 件数が変わっても、
   *   コレクション面の器(button 等)は同じ node のまま値だけ差し替わる。
   */
  it('⚠ 件数が変わっても、器(button)は同じ node のまま', () => {
    const { root, inspector } = makeInspector();
    inspector.render(initialState);
    const before = root.querySelector('[data-pkc-action="export-html"]');
    const s = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('n1', 'ノート1', 'text')],
      relations: [],
    }).state;
    inspector.render(s);
    const after = root.querySelector('[data-pkc-action="export-html"]');
    expect(after, 'ボタンが消えた').not.toBeNull();
    expect(after === before, '器を組み直している').toBe(true);
  });

  it('ノートを 1 件選ぶと、コレクション面は消えてノートの情報になる', () => {
    const { root, inspector } = makeInspector();
    const s = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('n1', 'ノート1', 'text')],
      relations: [],
    }).state;
    inspector.render(reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state);
    expect(root.querySelector('[data-pkc-field="collection-pane"]'), 'コレクション面が残っている').toBeNull();
    expect(root.querySelector('[data-pkc-field="inspector-title"]')?.textContent).toBe('ノート1');

    // ⚠ 双方向 ── 選択を外すとコレクション面へ戻る(片道の操作にしない)
    const selected = reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state;
    inspector.render(reduce(selected, { type: 'DESELECT_ENTRY' }).state);
    expect(root.querySelector('[data-pkc-field="collection-pane"]'), 'コレクション面へ戻っていない').not.toBeNull();
  });
});
