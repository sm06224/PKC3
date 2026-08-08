/** @vitest-environment happy-dom */
/**
 * 🔴 **読む面のコピー**(2026-08-08。user 裁定「markdown のテキストとしての
 * コピーと HTML 書式ありのコピーの両方」)。
 *
 * ここで守るもの:
 * ① 選択範囲 → 原文の逆引き(行の刻印 + `mapVisibleToSource`)──
 *    **装飾の記号ぶんを数える**こと、**frontmatter の行ずれを起こさない**こと
 * ② ボタンの配線(binder 経由の実クリック)── clipboard へ届き、結果が見える
 * ③ 選択範囲のボタンは**選択があるときだけ活性**(selectionchange 駆動)
 * ⚠ 既定の copy イベントには介入していない(それを確かめる test も持つ)。
 */
import { stubStamps } from '../helpers/store-stamps';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { hasSourceSelection, selectedMarkdown } from '../../src/adapter/ui/actions/copy-source';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { parseFrontmatter } from '../../src/features/markdown/frontmatter';
import { extractHeadingNumberConfig } from '../../src/features/markdown/document-globals';
import * as clipboard from '../../src/adapter/platform/clipboard';
import { stubRevisionOps } from '../helpers/revision-stub';

/** 読む面と同じ形(sourceLineAnchors)で fm.body を描いた host。 */
function renderHost(fullBody: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderMarkdown(parseFrontmatter(fullBody).body, { sourceLineAnchors: true });
  document.body.append(host);
  return host;
}

function select(startNode: Node, startOff: number, endNode: Node, endOff: number): void {
  const r = document.createRange();
  r.setStart(startNode, startOff);
  r.setEnd(endNode, endOff);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(r);
}

function clearSelection(): void {
  document.getSelection()?.removeAllRanges();
}

describe('selectedMarkdown — 選択 → 原文の逆引き', () => {
  const BODY = '# 題\n\n最初の段落です。\n\n次の段落です。';

  it('🔴 塊を跨ぐ選択が、原文の文字位置で切り出される', () => {
    const host = renderHost(BODY);
    const ps = [...host.querySelectorAll('p')];
    // 「段落です。…次の」── p1 の 3 文字目から p2 の 2 文字目まで
    select(ps[0]!.firstChild!, 3, ps[1]!.firstChild!, 2);
    expect(hasSourceSelection(host)).toBe(true);
    expect(selectedMarkdown(host, BODY)).toBe('段落です。\n\n次の');
    clearSelection();
  });

  it('🔴 frontmatter があっても行がずれない(刻印は fm.body 基準)', () => {
    const full = '---\ntitle: x\n---\n# 題\n\n最初の段落です。';
    const host = renderHost(full);
    const p = host.querySelector('p')!;
    select(p.firstChild!, 0, p.firstChild!, 3);
    // ⚠ fullBody の行番号で引くと '---' の側を掴む ── それをここで殺す
    expect(selectedMarkdown(host, full)).toBe('最初の');
    clearSelection();
  });

  it('🔴 装飾(**)を跨ぐ選択は、原文の記号ぶんを数えて切り出す', () => {
    const body = 'あいう**かき**くけこ';
    const host = renderHost(body);
    const p = host.querySelector('p')!;
    // 描画は「あいうかきくけこ」── 「い」から <strong> を跨いで「く」まで
    select(p.firstChild!, 1, p.lastChild!, 1);
    expect(selectedMarkdown(host, body)).toBe('いう**かき**く');
    clearSelection();
  });

  it('⚠ 終端が生成物(見出しの自動採番)に落ちたら、行末まで含める(手前に縮めない)', () => {
    // 採番の数字は**原文に無い文字** ── 終端の逆引きが「正確」を名乗れない実例
    const full = '---\nheading-number: true\n---\nまえがき。\n\n# 章の題';
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(parseFrontmatter(full).body, {
      sourceLineAnchors: true,
      headingNumber: extractHeadingNumberConfig(full),
    });
    document.body.append(host);
    const p = host.querySelector('p')!;
    const h = host.querySelector('h1')!;
    expect(h.textContent!.startsWith('1'), '採番が出ていない(fixture が空振り)').toBe(true);
    const headText = document.createTreeWalker(h, 4 /* SHOW_TEXT */).nextNode()!;
    select(p.firstChild!, 0, headText, 1); // 採番の 1 文字目の直後で終わる選択
    // 🔴 手前に縮めると選択の中身(見出し)が欠ける ── 行末まで広げるのが正しい
    expect(selectedMarkdown(host, full)).toBe('まえがき。\n\n# 章の題');
    clearSelection();
    host.remove();
  });

  it('潰れた選択 / 本文の外の選択は null(押せない・コピーしない)', () => {
    const host = renderHost(BODY);
    const p = host.querySelector('p')!;
    select(p.firstChild!, 2, p.firstChild!, 2); // collapsed
    expect(selectedMarkdown(host, BODY)).toBeNull();
    expect(hasSourceSelection(host)).toBe(false);
    // 刻印の無い外の要素の選択
    const outside = document.createElement('div');
    outside.textContent = 'そとのもじ';
    document.body.append(outside);
    select(outside.firstChild!, 0, outside.firstChild!, 3);
    expect(selectedMarkdown(host, BODY)).toBeNull();
    expect(hasSourceSelection(host)).toBe(false);
    clearSelection();
    outside.remove();
  });
});

// ── 配線(binder 経由の実クリック)と活性 ──────────────────────────────

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
  };
}

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function setup(bodies: Record<string, string>) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail);
  d.onState((s) => detail.render(s));
  bindActions(root, d);
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => bodies[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    persistEntry: async () => stubStamps(),
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  return { root, d, q };
}

const DOC = '# 題\n\n最初の段落です。\n\n次の段落です。';

describe('読む面のコピー ── 配線と活性', () => {
  it('🔴 ツールバーに 3 つ並び、選択範囲だけが不活性で始まる', async () => {
    const { d, q } = setup({ a: DOC });
    clearSelection();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    // 本文が届く前 ── どれも押せない(押せない理由は title)
    expect(q<HTMLButtonElement>('[data-pkc-action="copy-note-md"]')!.disabled).toBe(true);
    await tick(30);
    // 本文が届いたら、全体の 2 つは押せる。選択範囲は選択が無いので押せない
    expect(q<HTMLButtonElement>('[data-pkc-action="copy-note-md"]')!.disabled).toBe(false);
    expect(q<HTMLButtonElement>('[data-pkc-action="copy-note-rich"]')!.disabled).toBe(false);
    expect(q<HTMLButtonElement>('[data-pkc-action="copy-selection-md"]')!.disabled).toBe(true);
  });

  it('🔴 「Markdown をコピー」── 原文が text/plain で渡り、ボタンが光る', async () => {
    const spy = vi.spyOn(clipboard, 'copyPlainText').mockResolvedValue(true);
    const { d, q } = setup({ a: DOC });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick(30);
    const btn = q<HTMLButtonElement>('[data-pkc-action="copy-note-md"]')!;
    btn.click();
    await tick(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe(DOC);
    expect(btn.getAttribute('data-pkc-flash'), '渡ったのに合図が無い').toBe('true');
    spy.mockRestore();
  });

  it('🔴 「書式付きでコピー」── plain は原文・html は描画の両建てで渡る', async () => {
    const spy = vi.spyOn(clipboard, 'copyMarkdownAndHtml').mockResolvedValue(true);
    const { d, q } = setup({ a: DOC });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick(30);
    q<HTMLButtonElement>('[data-pkc-action="copy-note-rich"]')!.click();
    await tick(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe(DOC);
    expect(spy.mock.calls[0]![1]).toContain('<h1');
    expect(spy.mock.calls[0]![1]).toContain('次の段落です。');
    spy.mockRestore();
  });

  it('🔴 選択すると「選択範囲をコピー」が活性になり、Markdown 原文が渡る', async () => {
    const spy = vi.spyOn(clipboard, 'copyPlainText').mockResolvedValue(true);
    const { d, q, root } = setup({ a: DOC });
    clearSelection();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick(30);
    const btn = q<HTMLButtonElement>('[data-pkc-action="copy-selection-md"]')!;
    expect(btn.disabled).toBe(true);
    // 本文の中を選択する(happy-dom は addRange で selectionchange を飛ばす)
    const host = root.querySelector('[data-pkc-field="detail-body"]')!;
    const ps = [...host.querySelectorAll('p')];
    select(ps[0]!.firstChild!, 3, ps[1]!.firstChild!, 2);
    await tick(0);
    expect(btn.disabled, '選択したのに押せない').toBe(false);
    btn.click();
    await tick(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe('段落です。\n\n次の');
    // 選択を消すと、また押せなくなる
    clearSelection();
    await tick(0);
    expect(btn.disabled, '選択が消えたのに押せる').toBe(true);
    spy.mockRestore();
  });

  it('解決できない選択で押されたら、無言ではなく理由を出す', async () => {
    const { d, q } = setup({ a: DOC });
    clearSelection();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick(30);
    const btn = q<HTMLButtonElement>('[data-pkc-action="copy-selection-md"]')!;
    // 活性と実行は競り合う(押した瞬間に選択が消えている)── その瞬間を作る
    btn.disabled = false;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(d.getState().error).toContain('選択してからコピー');
  });

  it('⚠ 既定の copy イベントには介入していない(見た目のコピー期待を壊さない)', () => {
    // 「copy を聴く実装が 1 つも無い」を機械で確かめる ── 介入を足したら落ちる
    for (const f of [
      'src/adapter/ui/actions/copy-source.ts',
      'src/adapter/ui/actions/binder.ts',
      'src/adapter/ui/render/detail.ts',
    ]) {
      const text = readFileSync(f, 'utf-8');
      expect(text, `${f} が copy イベントに介入している`).not.toMatch(
        /addEventListener\(\s*['"]copy['"]/,
      );
    }
  });
});
