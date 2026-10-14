/** @vitest-environment happy-dom */
/**
 * 🔴 **定型文と置き換えを、どちらの編集の仕方でも同じに効かせる**(#1087)。
 *
 * ① 1 面(live)の行の入力欄でも、短縮語 + `Tab` の展開と `${…}` の `Tab` 送りが効く
 *    (直す前は行の `Tab` = 行の確定に取られ、2 列の欄でしか効かなかった)
 * ② 2 列の「すべて置換」の後に、`Ctrl+Z` の履歴が残る(`ta.value =` は履歴を捨てる)
 * ③ 「すべて置換」を帯のボタン以外(操作を探す / 割り当てた鍵)から撃っても、行の打ちかけが消えない
 * ⑤ リンクを選んでいる間に相手がゴミ箱へ移ったら、題名の無いリンクを挿さない
 * (④ 文中コードの `${…}` は `tests/features/snippet-expand.test.ts`)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { alertInApp, resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { snippetItemOf } from '../../src/features/snippet/snippet-table';

function meta(lid: string, title = 't-' + lid): EntryMeta {
  return {
    lid,
    title,
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

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function editingWith(body: string) {
  document.body.innerHTML = '';
  resetAppDialogForTest();
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const center = new CenterRouter(regions.detail, undefined, null, undefined, (b) =>
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: b }),
  );
  d.onState((st) => center.render(st));
  bindActions(root, d);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  d.dispatch({ type: 'START_EDIT' });
  return { root, d };
}

const replaceAllIn = (root: HTMLElement, find: string, to: string) => {
  root.querySelector<HTMLInputElement>('[data-pkc-field="replace-find"]')!.value = find;
  root.querySelector<HTMLInputElement>('[data-pkc-field="replace-with"]')!.value = to;
  root.querySelector<HTMLButtonElement>('[data-pkc-action="replace-all"]')!.click();
};

function tab(ta: HTMLTextAreaElement, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true, ...init });
  ta.dispatchEvent(ev);
  return ev;
}

afterEach(() => localStorage.removeItem('pkc3.editor-mode'));

describe('① 1 面の行の入力欄でも、短縮語 + Tab と ${…} の Tab 送りが効く', () => {
  beforeEach(() => localStorage.setItem('pkc3.editor-mode', 'live'));

  async function openRow(body: string) {
    const { root, d } = editingWith(body);
    await tick();
    const scan = snippetItemOf('s1', '住所', '---\nabbr: addr\n---\n〒100');
    d.dispatch({ type: 'SET_SNIPPET_SCAN', scan: { items: scan === null ? [] : [scan], total: 1, truncated: false } });
    root.querySelector<HTMLButtonElement>('[data-pkc-field="edit-all"]')!.click();
    const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
    expect(ta, '前提: 行の入力欄が開いている').not.toBeNull();
    expect(d.getState().snippetScan?.items, '前提: 短縮語が集まっている').toHaveLength(1);
    return { root, d, ta };
  }

  it('🔴 短縮語の直後の Tab は、確定せずに展開する(行は開いたまま)', async () => {
    const { root, d, ta } = await openRow('あ\n');
    ta.value = 'addr';
    ta.setSelectionRange(4, 4);
    const ev = tab(ta);
    expect(ta.value, '展開されていない(Tab が行の確定に取られた)').toBe('〒100');
    expect(ev.defaultPrevented).toBe(true);
    expect(root.querySelector('[data-pkc-field="row-source"]'), '展開したのに行が閉じた').toBe(ta);
    expect(d.getState().openBody?.body, '展開の途中で本文へ確定してしまった').toBe('あ\n');
  });

  it('🔴 次の ${…} 印があれば、確定せずに印を選ぶ', async () => {
    const { root, ta } = await openRow('あ\n');
    ta.value = 'あ ${名前} い';
    ta.setSelectionRange(0, 0);
    tab(ta);
    expect([ta.selectionStart, ta.selectionEnd], '印が選ばれていない').toEqual([2, 7]);
    expect(root.querySelector('[data-pkc-field="row-source"]'), '印を選んだのに行が閉じた').toBe(ta);
  });

  it('対照群: 短縮語も印も無ければ、今までどおり Tab で確定する', async () => {
    const { d, ta } = await openRow('あ\n');
    ta.value = 'zzz';
    ta.setSelectionRange(3, 3);
    tab(ta);
    await tick();
    expect(d.getState().openBody?.body, '確定されていない').toContain('zzz');
  });

  it('対照群: Shift / Ctrl 付きの Tab では展開しない', async () => {
    const { ta } = await openRow('あ\n');
    ta.value = 'addr';
    ta.setSelectionRange(4, 4);
    tab(ta, { shiftKey: true });
    expect(ta.value).toBe('addr');
  });
});

describe('② 2 列の「すべて置換」は Ctrl+Z の履歴に載る書き方で欄へ書く', () => {
  beforeEach(() => localStorage.setItem('pkc3.editor-mode', 'split'));
  afterEach(() => {
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });

  it('🔴 変わった範囲だけを insertText(execCommand)で書き、value へは代入しない', () => {
    const { root, d } = editingWith('ログを書いた。ログ。\n');
    const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    // 本物のブラウザ相当: 焦点の在る欄の選択範囲を置き換え、input を撃つ
    const typed: string[] = [];
    let inExec = false; // 本物の execCommand の中の書込は数えない(ブラウザの仕事)
    (document as unknown as { execCommand: (c: string, u: boolean, v: string) => boolean }).execCommand = (
      cmd,
      _ui,
      text,
    ) => {
      expect(cmd).toBe('insertText');
      expect(document.activeElement, 'execCommand は焦点の在る欄にしか効かない').toBe(ta);
      typed.push(text);
      const at = ta.selectionStart;
      inExec = true;
      ta.setRangeText(text, at, ta.selectionEnd, 'preserve');
      inExec = false;
      ta.setSelectionRange(at + text.length, at + text.length);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
    let writes = 0;
    Object.defineProperty(ta, 'value', {
      configurable: true,
      get: () => desc.get!.call(ta) as string,
      set: (v: string) => {
        if (!inExec) writes += 1;
        desc.set!.call(ta, v);
      },
    });
    replaceAllIn(root, 'ログ', '記録');
    expect(typed, '前後の同じ字は触らず、違う真ん中だけを書く').toEqual(['記録を書いた。記録']);
    expect(writes, 'value へ代入している(Ctrl+Z の履歴が消える)').toBe(0);
    expect(ta.value).toBe('記録を書いた。記録。\n');
    expect(d.getState().openBody?.body, '欄の input が state へ届いていない').toBe('記録を書いた。記録。\n');
  });

  it('対照群: execCommand が無い環境(happy-dom)でも、同じ結果になる', () => {
    const { root, d } = editingWith('ログを書いた。ログ。\n');
    const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    replaceAllIn(root, 'ログ', '記録');
    expect(ta.value).toBe('記録を書いた。記録。\n');
    expect(d.getState().openBody?.body).toBe('記録を書いた。記録。\n');
  });
});

describe('③ 「すべて置換」を帯のボタン以外から撃っても、行の打ちかけが消えない', () => {
  beforeEach(() => localStorage.setItem('pkc3.editor-mode', 'live'));

  it('🔴 行に打ちかけの字が在るまま撃つと、打ちかけも置換も本文に入る', async () => {
    const { root, d } = editingWith('ログを書いた\n');
    await tick();
    root.querySelector<HTMLButtonElement>('[data-pkc-field="edit-all"]')!.click();
    const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
    ta.focus();
    ta.value += 'X';
    // 焦点は行に居たまま(操作を探す / 鍵から撃った形。`click()` は焦点を動かさない)
    replaceAllIn(root, 'ログ', '記録');
    await tick();
    const body = d.getState().openBody?.body ?? '';
    expect(body, '置換されていない').toContain('記録を書いた');
    expect(body, '打ちかけの字が消えた').toContain('X');
  });

  it('🔴 ダイアログが開いている間は待ち、閉じてから確定して置換する', async () => {
    const { root, d } = editingWith('ログを書いた\n');
    await tick();
    root.querySelector<HTMLButtonElement>('[data-pkc-field="edit-all"]')!.click();
    const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
    ta.focus();
    ta.value += 'X';
    void alertInApp(root, '開いている');
    expect(document.querySelector('dialog[open]'), '前提: ダイアログが開いている').not.toBeNull();
    replaceAllIn(root, 'ログ', '記録');
    expect(d.getState().openBody?.body, 'ダイアログが開いている間に置換が走った').toBe('ログを書いた\n');
    document.querySelector<HTMLButtonElement>('dialog[open] [data-pkc-field="dialog-ok"]')!.click();
    await tick(60);
    const body = d.getState().openBody?.body ?? '';
    expect(body, '閉じた後に置換されていない').toContain('記録を書いた');
    expect(body, '閉じた後に打ちかけが消えた').toContain('X');
  });
});

describe('⑤ リンクを選んでいる間に相手がゴミ箱へ移ったら、題名の無いリンクを挿さない', () => {
  it('🔴 挿さずに「ノートが見つかりません」と言う', async () => {
    document.body.innerHTML = '';
    resetAppDialogForTest();
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    const d = new Dispatcher();
    bindActions(root, d, {}, new KeymapStore());
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', 'めも'), meta('n2', '議事録')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    const detail = document.createElement('div');
    detail.setAttribute('data-pkc-region', 'detail');
    const ta = document.createElement('textarea');
    ta.setAttribute('data-pkc-field', 'editor-body');
    ta.value = 'hello world';
    detail.append(ta);
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'insert-entry-link');
    detail.append(btn);
    root.append(detail);
    ta.focus();
    ta.setSelectionRange(5, 5);
    btn.click();
    await tick();
    const row = document.querySelector<HTMLElement>('[data-pkc-field="entry-pick-row"][data-pkc-lid="n2"]');
    expect(row, '前提: 選ぶ窓が開いている').not.toBeNull();
    // 選んでいる間に、相手が一覧から消える
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', 'めも')], relations: [] });
    expect(d.getState().entryMetas.get('n2'), '前提: 相手が消えている').toBeUndefined();
    row!.click();
    await tick();
    expect(ta.value, '題名の無いリンクを挿した').toBe('hello world');
    expect(d.getState().error).toBe('ノートが見つかりません');
  });
});
