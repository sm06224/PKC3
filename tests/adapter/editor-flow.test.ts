/** @vitest-environment happy-dom */
/**
 * editor(P3-5)の end-to-end: binder → dispatcher → renderer → fake store。
 * state mutation → consumer 観測点(DOM / 副作用)まで通す(PKC2 Testing 規約)。
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions, runGlobalCommand } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import * as clipboard from '../../src/adapter/platform/clipboard';
import { vi } from 'vitest';
import { stubRevisionOps } from '../helpers/revision-stub';

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

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function setup(bodies: Record<string, string>, failPersist = false) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail);
  d.onState((s) => detail.render(s));
  bindActions(root, d);
  const persisted: EntryUpsert[] = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => bodies[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    /**
     * ⚠ **題名だけの口**(#178)── 本物は本文に触らない。
     *   だから fake も本文を持たない(触らないものは持たない)。
     */
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () =>
      Promise.reject(new Error('この test では添付の差し替えを使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      // ⚠ 2026-10-18(#1163 依頼 104-1 B): 空き不足は編集の画面へ戻すようになった ── 保存し直しの帯を見るため、空き不足ではない失敗にする
      if (failPersist) throw new Error('書き込みに失敗しました(test)');
      persisted.push(e);
      return stubStamps();
    },
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a')],
    relations: [],
  });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  return { root, d, persisted, q };
}

// 2026-08-14(#104 第 2 弾): 既定は live ── この file は split の機構
// (全文 textarea)を測るので、設定で split を明示する
beforeEach(() => {
  localStorage.setItem('pkc3.editor-mode', 'split');
});

describe('editor flow (P3-5)', () => {
  it('編集 → 入力 → 保存: DOM と store まで一貫する', async () => {
    const { d, persisted, q } = setup({ a: '# 原文' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();

    q('[data-pkc-action="start-edit"]')!.click();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]');
    expect(ta).not.toBeNull();
    expect(ta!.value).toBe('# 原文');

    // 入力: input delegation が state に写す。編集中は DOM を作り直さない
    ta!.value = '# 改稿';
    ta!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(d.getState().openBody?.body).toBe('# 改稿');
    expect(q('[data-pkc-field="editor-body"]')).toBe(ta); // 同一 node(カーソル保全)

    q('[data-pkc-action="commit-edit"]')!.click();
    await tick();
    // view へ戻り、新内容が rendered で見える
    expect(q('[data-pkc-field="editor-body"]')).toBeNull();
    expect(q('[data-pkc-field="detail-body"]')?.textContent).toContain('改稿');
    // store には行全体が 1 回だけ書かれ、ack で persisted が確定
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ lid: 'a', body: '# 改稿' });
    expect(d.getState().openBody?.persisted).toBe('# 改稿');
  });

  it('キャンセル(Esc)は baseline へ戻し、書かない', async () => {
    const { d, persisted, q } = setup({ a: '# 原文' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = '捨てる変更';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    // 🔴 打った内容があるので聞かれる(依頼 71-1)── 「捨てる」を答えて初めてやめる
    await tick();
    expect(q('[data-pkc-field="editor-body"]'), '聞かずにやめた').not.toBeNull();
    document.querySelector<HTMLElement>('[data-pkc-field="dialog-ok"]')!.click();
    await tick();
    expect(q('[data-pkc-field="editor-body"]')).toBeNull();
    expect(q('[data-pkc-field="detail-body"]')?.textContent).toContain('原文');
    expect(persisted).toHaveLength(0);
  });

  it('Ctrl+Enter は保存ショートカット', async () => {
    const { d, persisted, q } = setup({ a: 'plain text' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = 'plain text v2';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
    );
    await tick();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.body).toBe('plain text v2');
  });

  it('IME 変換中の Esc は編集キャンセルに化けない(isComposing ガード)', async () => {
    const { d, q } = setup({ a: '# 原文' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = '変換中の draft';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    // 変換中の Esc =「変換の取り消し」── 編集セッションは維持されること
    ta.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }),
    );
    expect(d.getState().phase).toBe('editing');
    expect(d.getState().openBody?.body).toBe('変換中の draft');
    expect(q('[data-pkc-field="editor-body"]')).toBe(ta);
  });

  it('キャンセルボタン(実クリック)も baseline へ戻す', async () => {
    const { d, persisted, q } = setup({ a: '# 原文' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = '捨てる';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    q('[data-pkc-action="cancel-edit"]')!.click();
    await tick(); // 読む面はワーカーで描く(2026-08-06。user 報告 2-8)
    expect(q('[data-pkc-field="detail-body"]')?.textContent).toContain('原文');
    expect(persisted).toHaveLength(0);
  });

  it('保存失敗 → 編集ボタン非表示 + 再保存導線 → 再送で復帰(error 復帰の e2e)', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const detail = new DetailRenderer(regions.detail);
    d.onState((s) => detail.render(s));
    bindActions(root, d);
    let failNext = true;
    const persisted: string[] = [];
    connectStoreEffects(d, {
    ...stubRevisionOps(),
      getBody: async () => '# A',
      deleteEntry: async () => {},
    setEntryParent: async () => {},
      /**
       * ⚠ **題名だけの口**(#178)── 本物は本文に触らない。
       *   だから fake も本文を持たない(触らないものは持たない)。
       */
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () =>
        Promise.reject(new Error('この test では添付の差し替えを使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async (e) => {
        if (failNext) throw new Error('disk full');
        persisted.push(e.body);
        return stubStamps();
      },
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    root.querySelector<HTMLElement>('[data-pkc-action="start-edit"]')!.click();
    const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = 'v2';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLElement>('[data-pkc-action="commit-edit"]')!.click();
    await tick(20);
    expect(d.getState().phase).toBe('error');
    // START_EDIT は ready 限定 ── ボタンを出したまま無言 no-op にしない
    expect(root.querySelector('[data-pkc-action="start-edit"]')).toBeNull();
    // 未達の commit がある ── 再保存導線が出る
    const retry = root.querySelector<HTMLElement>('[data-pkc-action="retry-persist"]');
    expect(retry).not.toBeNull();

    failNext = false;
    retry!.click();
    await tick(20);
    expect(persisted).toEqual(['v2']);
    expect(d.getState().phase).toBe('ready');
    expect(d.getState().openBody?.persisted).toBe('v2');
    // 復帰後は通常の編集導線に戻る
    expect(root.querySelector('[data-pkc-action="start-edit"]')).not.toBeNull();
    expect(root.querySelector('[data-pkc-action="retry-persist"]')).toBeNull();
  });

  it('🔴 保存失敗の帯でも、未保存の本文をコピーで持ち出せる(#1087 D3)', async () => {
    const plain = vi.spyOn(clipboard, 'copyPlainText').mockResolvedValue(true);
    const rich = vi.spyOn(clipboard, 'copyMarkdownAndHtml').mockResolvedValue(true);
    const { d, q } = setup({ a: '# A' }, true);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value = 'v2 未保存';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    q('[data-pkc-action="commit-edit"]')!.click();
    await tick(20);
    expect(d.getState().phase, '前提が崩れている(保存が失敗していない)').toBe('error');
    expect(q('[data-pkc-action="retry-persist"]'), '前提が崩れている(保存し直しの帯ではない)').not.toBeNull();

    const md = q<HTMLButtonElement>('[data-pkc-action="copy-note-md"]');
    const rc = q<HTMLButtonElement>('[data-pkc-action="copy-note-rich"]');
    expect(md, '保存し直しの帯に Markdown をコピーが無い').not.toBeNull();
    expect(rc, '保存し直しの帯に書式付きでコピーが無い').not.toBeNull();
    md!.click();
    rc!.click();
    await tick(0);
    expect(plain.mock.calls.map((c) => c[0])).toEqual(['v2 未保存']);
    expect(rich.mock.calls.map((c) => c[0])).toEqual(['v2 未保存']);
    plain.mockRestore();
    rich.mockRestore();
  });

  it('🔴 HTML ソースをコピー(A2)── 書式付きと同じ掃除をした HTML を、字(text/plain)のまま渡す', async () => {
    const plain = vi.spyOn(clipboard, 'copyPlainText').mockResolvedValue(true);
    const rich = vi.spyOn(clipboard, 'copyMarkdownAndHtml').mockResolvedValue(true);
    const { d, q } = setup({ a: '# 見出し\n\n**太字** の本文\n\n```js\nconst x = 1;\n```' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    const html = q<HTMLButtonElement>('[data-pkc-action="copy-note-html"]');
    expect(html, '帯に HTML ソースをコピーが無い').not.toBeNull();
    expect(html!.disabled, '本文が読めているのに押せない').toBe(false);
    html!.click();
    q<HTMLButtonElement>('[data-pkc-action="copy-note-rich"]')!.click();
    await tick(0);
    expect(plain).toHaveBeenCalledTimes(1);
    const src = plain.mock.calls[0]![0];
    // 原文(markdown)ではなく描いた HTML ── 字として渡る
    expect(src).not.toContain('**太字**');
    expect(src).toMatch(/<strong>太字<\/strong>/);
    expect(src).toMatch(/<h1[^>]*>/);
    // 🔴 掃除が効いている ── 本文の ⧉(コピーの操作子)は残らない
    expect(src).not.toContain('copy-md-block');
    expect(src).not.toContain('data-pkc-action');
    // 書式付きと**同じ** HTML(掃除の道が 1 本)
    expect(rich.mock.calls[0]?.[1]).toBe(src);
    plain.mockRestore();
    rich.mockRestore();
  });

  it('🔴 「コピー ▾」(A2)── 本体は Markdown をコピー、▾ は HTML ソース / 書式付き / 選択範囲を出す', async () => {
    const plain = vi.spyOn(clipboard, 'copyPlainText').mockResolvedValue(true);
    const { d, q, root } = setup({ a: '**太字**' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    const bar = q('[data-pkc-field="detail-toolbar"]')!;
    const run = bar.querySelector<HTMLButtonElement>('[data-pkc-field="copy-run"]');
    expect(run?.getAttribute('data-pkc-action'), '本体が Markdown をコピーではない').toBe('copy-note-md');
    // ▾ の中身は帯の上に見えていない(隠した元に在る)
    const source = bar.querySelector<HTMLElement>('[data-pkc-field="copy-more-source"]')!;
    expect(source.hidden).toBe(true);
    expect([...source.querySelectorAll('[data-pkc-action]')].map((b) => b.getAttribute('data-pkc-action'))).toEqual([
      'copy-note-html',
      'copy-note-rich',
      'copy-selection-md',
    ]);
    const pick = bar.querySelector<HTMLButtonElement>('[data-pkc-field="copy-pick"]')!;
    expect(pick.previousElementSibling, '▾ が本体の隣に無い(1 つの分割ボタンに見えない)').toBe(run);
    pick.click();
    await tick(0);
    const menu = root.querySelector('[data-pkc-region="context-menu"]');
    expect(menu, '▾ で一覧が開かない').not.toBeNull();
    const rows = [...menu!.querySelectorAll('button')];
    expect(rows.map((b) => b.textContent?.trim())).toEqual(['HTML ソースをコピー', '書式付きでコピー', '選択範囲をコピー']);
    // 選択範囲は選択が無い間押せない(元の状態をそのまま写す)
    expect(rows[2]!.disabled).toBe(true);
    rows[0]!.click();
    await tick(0);
    expect(plain).toHaveBeenCalledTimes(1);
    expect(plain.mock.calls[0]![0]).toMatch(/<strong>太字<\/strong>/);
    // 🔴 合図は見える ▾ に出る(隠れた元のボタンに出しても user には見えない)
    expect(pick.getAttribute('data-pkc-flash'), '一覧から実行した合図が ▾ に出ない').toBe('true');
    expect(source.querySelector('[data-pkc-flash]'), '合図が隠れた元に出ている').toBeNull();
    plain.mockRestore();
  });

  it('🔴 「操作を探す」から HTML ソース / 書式付きをコピーできて、合図は ▾ に出る(A2。隠した元のボタンを押す)', async () => {
    const plain = vi.spyOn(clipboard, 'copyPlainText').mockResolvedValue(true);
    const rich = vi.spyOn(clipboard, 'copyMarkdownAndHtml').mockResolvedValue(true);
    const { d, q, root } = setup({ a: '**太字**' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    const noop = (): void => {};
    const keymap = new KeymapStore();
    expect(runGlobalCommand('copy-note-html', root, d, keymap, noop, noop, true), '操作を探すから押せない').toBe(true);
    expect(runGlobalCommand('copy-note-html', root, d, keymap, noop, noop, false)).toBe(true);
    await tick(0);
    expect(plain).toHaveBeenCalledTimes(1);
    expect(plain.mock.calls[0]![0]).toMatch(/<strong>太字<\/strong>/);
    const pick = q('[data-pkc-field="copy-pick"]')!;
    expect(pick.getAttribute('data-pkc-flash'), '操作を探すから実行した合図が見える ▾ に出ない').toBe('true');
    expect(q('[data-pkc-field="copy-more-source"] [data-pkc-flash]'), '合図が隠れた元に出ている').toBeNull();
    pick.removeAttribute('data-pkc-flash');
    runGlobalCommand('copy-note-rich', root, d, keymap, noop, noop, false);
    await tick(0);
    expect(rich).toHaveBeenCalledTimes(1);
    expect(pick.getAttribute('data-pkc-flash')).toBe('true');
    // 本体(見えている)から押したときは本体が光る(▾ に移さない)
    q<HTMLButtonElement>('[data-pkc-field="copy-run"]')!.click();
    await tick(0);
    expect(q('[data-pkc-field="copy-run"]')!.getAttribute('data-pkc-flash')).toBe('true');
    plain.mockRestore();
    rich.mockRestore();
  });

  it('copy-md-block は実 delegation 経路(rendered ⧉ ボタンのクリック)で動く', async () => {
    const spy = vi.spyOn(clipboard, 'copyMarkdownAndHtml').mockResolvedValue(true);
    const { d, q, root } = setup({ a: '```js\nconst x = 1;\n```' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    // renderMarkdown が生成した実ボタン → root delegation → handler → clipboard
    const btn = root.querySelector<HTMLElement>(
      '[data-pkc-field="detail-body"] [data-pkc-action="copy-md-block"]',
    );
    expect(btn).not.toBeNull();
    btn!.click();
    await tick(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toContain('const x = 1;');
    expect(q('[data-pkc-action="copy-md-block"]')?.getAttribute('data-pkc-flash')).toBe(
      'true',
    );
    spy.mockRestore();
  });

  it('無変化の保存は書かない(#1024)', async () => {
    const { persisted, q, d } = setup({ a: '# 原文' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    q('[data-pkc-action="commit-edit"]')!.click();
    await tick();
    expect(persisted).toHaveLength(0);
    expect(q('[data-pkc-field="detail-body"]')?.textContent).toContain('原文');
  });
});
