/** @vitest-environment happy-dom */
/**
 * 🔴 **「今日」を押したあとのカーソル**(#1087 流れ 29 Q1。Gemini 裁定 = #1163 への依頼 29 の回答)。
 *
 * - 今日のノートがまだ無い → 作って、**本文**にカーソル(題名は日付のまま。他の作り方は題名のまま)
 * - 既に在る → 選んで、本文の下の**追記欄**にカーソル
 *
 * ⚠ 配線を通して見る(binder → dispatcher → effect → detail / 追記欄)── 札は binder が置き、
 *   描く側が引き取るので、片端だけの test は食い違いを見られない(CLAUDE.md §7「両端が stub と話す」)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import { createByUi } from '../helpers/create-entry';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { AppendBoxRenderer } from '../../src/adapter/ui/render/append-box';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { todayNoteTitle } from '../../src/features/schedule/today-note';
import {
  FOCUS_REQUEST_TTL_MS,
  requestAppendFocus,
  requestBodyFocus,
  resetFocusRequests,
  takeAppendFocus,
  takeBodyFocus,
} from '../../src/adapter/ui/render/focus-request';

function meta(lid: string, title: string, order: number): EntryMeta {
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

const tick = async (ms = 20): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

function setup(metas: EntryMeta[], bodies: Record<string, string>) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost, 'filer');
  const detail = new DetailRenderer(regions.detail);
  const appendBox = new AppendBoxRenderer(regions.append);
  d.onState((s) => {
    browse.render(s, 'filer');
    detail.render(s);
    appendBox.render(s);
  });
  bindActions(root, d);
  const store = { ...bodies };
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => store[lid] ?? null,
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      store[e.lid] = e.body;
      return stubStamps();
    },
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const pressToday = (): void => q<HTMLElement>('[data-pkc-action="open-today"]')!.click();
  return { root, d, q, pressToday };
}

beforeEach(() => {
  document.body.textContent = '';
  resetFocusRequests();
});

describe.each([['split'], ['live']])('「今日」を押したあと(編集欄 = %s)', (mode) => {
  beforeEach(() => localStorage.setItem('pkc3.editor-mode', mode));

  it('🔴 無い日は作って、カーソルは本文に在る(題名は日付のまま・題名には当てない)', async () => {
    const { d, q, pressToday } = setup([meta('x', 'ほかのノート', 1)], { x: 'X' });
    pressToday();
    await tick();
    expect(d.getState().phase, '前提: 作って編集に入っている').toBe('editing');
    const title = q<HTMLInputElement>('[data-pkc-field="editor-title"]')!;
    expect(title.value, '題名が日付でない').toBe(todayNoteTitle(new Date()));
    const active = document.activeElement as HTMLElement | null;
    expect(active, '焦点が題名に当たっている(本文であるべき)').not.toBe(title);
    expect(
      active?.closest('[data-pkc-region="detail"]'),
      '焦点が本文の編集欄に無い',
    ).not.toBeNull();
    expect(active?.tagName === 'TEXTAREA' || active?.isContentEditable === true || active?.tagName === 'INPUT').toBe(true);
    expect(
      title.selectionStart === 0 && title.selectionEnd === title.value.length && document.activeElement === title,
      '題名が全選択されている',
    ).toBe(false);
  });

  it('🔑 対照群: 「ノートを作る」は今までどおり題名に当たって全選択される', async () => {
    const { root, q } = setup([meta('x', 'ほかのノート', 1)], { x: 'X' });
    createByUi(root, 'text');
    await tick();
    const title = q<HTMLInputElement>('[data-pkc-field="editor-title"]')!;
    expect(document.activeElement, '他の作り方まで本文に変わった').toBe(title);
  });
});

describe('「今日」を押したあと(既に在る日)', () => {
  it('🔴 選んで、カーソルは本文の下の追記欄に在る', async () => {
    const title = todayNoteTitle(new Date());
    const { d, q, pressToday } = setup(
      [meta('t', title, 1), meta('x', 'ほかのノート', 2)],
      { t: '今日の本文', x: 'X' },
    );
    // 別のノートを見ている状態から押す
    q<HTMLElement>('[data-pkc-entry="x"]')!.click();
    await tick();
    pressToday();
    await tick(40);
    expect(d.getState().selectedLid, '今日のノートを選んでいない').toBe('t');
    const input = q<HTMLTextAreaElement>('[data-pkc-field="append-input"]')!;
    expect(input, '追記欄が無い(前提)').not.toBeNull();
    expect(document.activeElement, 'カーソルが追記欄に無い').toBe(input);
  });

  it('🔴 今日のノートを開いていて、焦点が別の入力欄にあっても追記欄へ移る(押した本人の頼み)', async () => {
    const title = todayNoteTitle(new Date());
    const { q, pressToday } = setup([meta('t', title, 1)], { t: '今日の本文' });
    q<HTMLElement>('[data-pkc-entry="t"]')!.click();
    await tick();
    const other = document.createElement('input');
    document.body.append(other);
    other.focus();
    expect(document.activeElement, '前提').toBe(other);
    pressToday();
    await tick(40);
    expect(document.activeElement, '追記欄へ移っていない').toBe(
      q<HTMLTextAreaElement>('[data-pkc-field="append-input"]'),
    );
  });
});

describe('一回限りの頼み(focus-request)', () => {
  it('頼んだノートのときだけ、1 回だけ引き取れる', () => {
    requestBodyFocus('a', 1000);
    expect(takeBodyFocus('b', 1000), '別のノートが引き取った').toBe(false);
    expect(takeBodyFocus('a', 1000)).toBe(true);
    expect(takeBodyFocus('a', 1000), '2 回引き取れた').toBe(false);
    requestAppendFocus('a', 1000);
    expect(takeAppendFocus('b', 1000)).toBe(false);
    expect(takeAppendFocus('a', 1000)).toBe(true);
    expect(takeAppendFocus('a', 1000)).toBe(false);
  });

  it('期限を過ぎた頼みは叶えない(何分も後に焦点を奪わない)', () => {
    requestBodyFocus('a', 1000);
    expect(takeBodyFocus('a', 1000 + FOCUS_REQUEST_TTL_MS + 1)).toBe(false);
    requestAppendFocus('a', 1000);
    expect(takeAppendFocus('a', 1000 + FOCUS_REQUEST_TTL_MS + 1)).toBe(false);
  });

  it('新しい頼みは前の頼みを置き換える(本文と追記欄を両方叶えない)', () => {
    requestBodyFocus('a', 1000);
    requestAppendFocus('a', 1000);
    expect(takeBodyFocus('a', 1000), '前の頼みが残っている').toBe(false);
    expect(takeAppendFocus('a', 1000)).toBe(true);
  });
});

describe('Alt+T', () => {
  it('🔴 「今日のノートを開く」の既定のキーは Alt+T で、他の命令と重ならない', async () => {
    const { KEY_COMMANDS } = await import('../../src/features/keymap');
    const cmd = KEY_COMMANDS.find((c) => c.id === 'open-today')!;
    expect(cmd.defaults).toEqual(['Alt+T']);
    const others = KEY_COMMANDS.filter((c) => c.id !== 'open-today' && c.defaults.includes('Alt+T'));
    expect(others.map((c) => c.id), 'Alt+T を使う命令が他にある').toEqual([]);
  });
});

