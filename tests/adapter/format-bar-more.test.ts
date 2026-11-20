/** @vitest-environment happy-dom */
/**
 * 🔴 書式の帯の「その他 ▾」(#1982 段 3)── 描いた帯と binder の配線ごと確かめる。
 *
 * 守る主張:
 *  1. 直接出すボタンと、隠した元(`format-more-source`)の顔ぶれは**並びの表**どおり(1 つも落ちない・重ならない)
 *  2. 「その他 ▾」を押すと、隠した元の**同じボタン**が一覧になる(字・並び・グループ・説明が元のまま)
 *  3. 一覧の項目を押すと**既存の受け手**が動く(`format-text` は `data-pkc-format` を運ぶ)
 *  4. 本文の欄から焦点を奪わない(1 行ずつ打つ編集の行が確定して閉じない)/ 打鍵で閉じる(`Esc` は閉じる側に任せる)
 *  5. 帯の下の追記欄の場所に保存 / やめるのボタンは無い(保存は上の 1 か所)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { AppendBoxRenderer } from '../../src/adapter/ui/render/append-box';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { buildFormatBar } from '../../src/adapter/ui/render/format-bar';
import {
  FORMAT_BAR_GROUPS,
  FORMAT_BAR_MORE_GROUPS,
  barItemId,
  moreBarItems,
  visibleBarItems,
} from '../../src/features/markdown/format-bar-layout';

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

const idOf = (b: Element): string =>
  b.getAttribute('data-pkc-format') !== null
    ? `op:${b.getAttribute('data-pkc-format')}`
    : `action:${b.getAttribute('data-pkc-action')}`;

beforeEach(() => {
  document.body.textContent = '';
  localStorage.setItem('pkc3.editor-mode', 'split');
});

function editing() {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail, null, undefined, (body) =>
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body }),
  );
  const box = new AppendBoxRenderer(regions.append);
  d.onState((s) => {
    detail.render(s);
    box.render(s);
  });
  bindActions(root, d, {});
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文' });
  d.dispatch({ type: 'START_EDIT' });
  const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
  const bar = root.querySelector<HTMLElement>('[data-pkc-region="format-bar"]')!;
  const menu = (): HTMLElement | null => root.querySelector('[data-pkc-region="context-menu"]');
  const opener = bar.querySelector<HTMLElement>('[data-pkc-action="open-format-more"]')!;
  return { root, d, ta, bar, menu, opener };
}

describe('帯の並び(描いた DOM)', () => {
  it('直接出すボタンは表のグループどおり、隠した元は「その他 ▾」の表どおり', () => {
    const bar = buildFormatBar();
    const groups = [...bar.querySelectorAll('[data-pkc-field="format-group"]')].map((g) =>
      [...g.querySelectorAll('button')].map(idOf),
    );
    expect(groups).toEqual(FORMAT_BAR_GROUPS.map((g) => g.map(barItemId)));
    const source = bar.querySelector<HTMLElement>('[data-pkc-field="format-more-source"]')!;
    expect(source.hidden, '元が見えている').toBe(true);
    const more = [...source.querySelectorAll('[data-pkc-group]')].map((g) => [
      g.getAttribute('data-pkc-group'),
      [...g.querySelectorAll('button')].map(idOf),
    ]);
    expect(more).toEqual(FORMAT_BAR_MORE_GROUPS.map((g) => [g.group, g.items.map(barItemId)]));
    // 直接 + その他 の合計がボタン全数(「その他 ▾」本体と、狭い画面の「…」を除く)
    const all = [...bar.querySelectorAll('button[data-pkc-action]')].filter(
      (b) => b.getAttribute('data-pkc-action') !== 'open-format-more',
    );
    expect(all).toHaveLength(visibleBarItems().length + moreBarItems().length);
  });

  it('「その他 ▾」は 1 つで、字は「その他 ▾」・メニューを開くボタンとして名乗っている', () => {
    const bar = buildFormatBar();
    const openers = bar.querySelectorAll('button[data-pkc-action="open-format-more"]');
    expect(openers).toHaveLength(1);
    expect(openers[0]!.getAttribute('aria-haspopup')).toBe('menu');
    expect(openers[0]!.textContent).toBe('その他 ▾');
    expect(openers[0]!.closest('[data-pkc-field="format-more-source"]')).toBeNull();
  });
});

describe('「その他 ▾」を押す', () => {
  it('隠した元と同じ字・並び・グループの一覧が出る(項目の説明も元の title)', () => {
    const { bar, menu, opener } = editing();
    opener.click();
    const m = menu();
    expect(m, '一覧が出ない').not.toBeNull();
    const items = [...m!.querySelectorAll('button[data-pkc-action]')];
    const src = [...bar.querySelectorAll<HTMLElement>('[data-pkc-field="format-more-source"] button')];
    expect(items.map((b) => b.textContent)).toEqual(
      src.map((b) => b.querySelector('[data-pkc-field="label"]')?.textContent),
    );
    expect(items.map((b) => b.getAttribute('data-pkc-hint'))).toEqual(src.map((b) => (b as HTMLElement).title));
    expect(items.length, '空振り').toBeGreaterThanOrEqual(12);
    // 塊は 3 つ(挿入 | 整える | 探す)の間で空く
    expect([...m!.querySelectorAll('[data-pkc-field="context-menu-group"]')].map((g) => g.getAttribute('data-pkc-group'))).toEqual(
      ['insert', 'tidy', 'find'],
    );
  });

  it('書式の項目(数式)を押すと、本文の欄に効く(data-pkc-format を運ぶ)', () => {
    const { ta, menu, opener } = editing();
    ta.focus();
    ta.value = '式';
    ta.setSelectionRange(0, 1);
    opener.click();
    const item = menu()!.querySelector<HTMLElement>('[data-pkc-action="format-text"][data-pkc-format="math"]');
    expect(item, '数式が一覧に無い').not.toBeNull();
    item!.click();
    expect(ta.value).toContain('$$');
    expect(ta.value).toContain('式');
    expect(menu(), '選んだら一覧が閉じる').toBeNull();
  });

  it('開いても本文の欄の焦点は動かない(keepFocus)/ 次の打鍵で閉じる / Esc は閉じる側に任せて編集は終わらない', () => {
    const { d, ta, menu, opener } = editing();
    ta.focus();
    expect(document.activeElement).toBe(ta);
    opener.click();
    expect(menu()).not.toBeNull();
    expect(document.activeElement, '焦点が一覧へ移った(行が確定して閉じる原因)').toBe(ta);
    // ⚠ 修飾キーだけ・変換中のキーでは閉じない(着地前レビュー: Shift を押しただけで消えていた)
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true }));
    expect(menu(), '修飾キー / 変換中のキーで閉じた').not.toBeNull();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(menu(), '打鍵で閉じない').toBeNull();
    // Esc: 一覧は閉じるが、編集は終わらない
    opener.click();
    expect(menu()).not.toBeNull();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(menu(), 'Esc で閉じない').toBeNull();
    expect(d.getState().phase, 'Esc で編集が終わった').toBe('editing');
  });

  it('焦点が本文の欄に無いとき(ボタンへ Tab で来たとき)は、一覧の先頭へ焦点が移る', () => {
    const { menu, opener } = editing();
    opener.focus();
    opener.click();
    const first = menu()!.querySelector('button');
    expect(document.activeElement).toBe(first);
  });

  it('1 行ずつ打つ編集のとき「番号を振り直す」は灰色(aria-disabled)で項目にも写る', () => {
    localStorage.removeItem('pkc3.editor-mode');
    const { menu, opener } = editing();
    opener.click();
    const item = menu()?.querySelector('[data-pkc-action="renumber-lists"]');
    expect(item, '項目が無い').not.toBeNull();
    expect(item!.getAttribute('aria-disabled')).toBe('true');
    expect(menu()!.querySelector('[data-pkc-action="sort-tasks"]')!.hasAttribute('aria-disabled')).toBe(false);
  });
});

describe('保存は上の 1 か所', () => {
  it('追記欄の場所には保存 / やめるのボタンが無く、上の帯の 2 つだけがある', () => {
    const { root } = editing();
    const lock = root.querySelector('[data-pkc-field="append-lock"]')!;
    expect((lock as HTMLElement).hidden).toBe(false);
    for (const a of ['commit-edit', 'cancel-edit']) {
      expect(lock.querySelector(`[data-pkc-action="${a}"]`), `下に ${a} が戻っている`).toBeNull();
      expect(root.querySelectorAll(`[data-pkc-action="${a}"]`)).toHaveLength(1);
    }
    expect(root.querySelector('[data-pkc-region="detail"] [data-pkc-action="commit-edit"]')).not.toBeNull();
  });
});
