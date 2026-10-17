/** @vitest-environment happy-dom */
/**
 * 🔴 **編集中の本文のチェックを押すと、下書きの `[ ]` が `[x]` に変わる**(台帳 #1852 I2 / 依頼 78-1。推薦 B)。
 *
 * 直す前は、1 面のライブ編集でも 2 列の下見でも、本文のチェックは灰色(`disabled`)で、押しても何も出なかった。
 * 実物の `DetailRenderer` + 実物の reducer で、2 つの編集面を通す。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { flipTaskInDraft } from '../../src/features/markdown/body-rewrite';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { buildFormatBar, syncWholeNoteTools, WHOLE_NOTE_REASON } from '../../src/adapter/ui/render/format-bar';
import { rowTextAbove } from '../../src/adapter/ui/render/row-swap';

const meta = (lid: string): EntryMeta =>
  ({ lid, title: 'N', archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1, status: null, date: null, archived: false, bodyChars: null }) as EntryMeta;

// frontmatter 付き ── 行番号のずれ(下見は frontmatter を外した側)でも「押した項目」が動くことを見る
const BODY = '---\ntags: [x]\n---\n# 買い物\n\n- [ ] 牛乳\n- [ ] 卵\n- [x] パン\n';
const settle = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function editing(mode: 'live' | 'split', seen: string[]): Promise<HTMLElement> {
  localStorage.setItem('pkc3.editor-mode', mode);
  const root = document.createElement('div');
  document.body.append(root);
  const detail = new DetailRenderer(buildShell(root).detail, null, undefined, (b) => seen.push(b));
  let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('host')], relations: [] }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'host' }).state;
  s = reduce(s, { type: 'BODY_LOADED', lid: 'host', body: BODY }).state;
  detail.render(s);
  await settle();
  s = reduce(s, { type: 'START_EDIT' } as never).state;
  detail.render(s);
  for (let i = 0; i < 6; i += 1) await settle(50);
  return root;
}

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('flipTaskInDraft(下書きのチェック 1 つの切り替え)', () => {
  it('押した行の印の 1 文字だけが変わる(ほかの行は 1 バイトも動かない)', () => {
    expect(flipTaskInDraft(BODY, 5)).toBe(BODY.replace('- [ ] 牛乳', '- [x] 牛乳'));
    expect(flipTaskInDraft(BODY, 7)).toBe(BODY.replace('- [x] パン', '- [ ] パン'));
  });
  it('チェックでない行・無い行は null(当てずっぽうで別の行を書き換えない)', () => {
    expect(flipTaskInDraft(BODY, 3)).toBeNull();
    expect(flipTaskInDraft(BODY, 99)).toBeNull();
  });
  it('コードの中の `- [ ]` は項目ではない(読む側が読まない行は書かない)', () => {
    const b = '```\n- [ ] a\n```\n';
    expect(flipTaskInDraft(b, 1)).toBeNull();
  });
});

describe('編集中の下見のチェック', () => {
  it('🔴 live:灰色(disabled)ではなく押せる形で出て、押すと下書きの印が変わる', async () => {
    const seen: string[] = [];
    const root = await editing('live', seen);
    const pane = root.querySelector<HTMLElement>('[data-pkc-region="editor-live"]')!;
    const boxes = [...pane.querySelectorAll<HTMLInputElement>('input.pkc-task-checkbox')];
    expect(boxes.length, '項目が 3 つ描かれている(前提)').toBe(3);
    expect(boxes.every((b) => !b.disabled), '押せない灰色のまま').toBe(true);
    boxes[1]!.click(); // 卵
    await settle(50);
    expect(seen.at(-1)).toBe(BODY.replace('- [ ] 卵', '- [x] 卵'));
    for (let i = 0; i < 4; i += 1) await settle(50);
    const after = [...pane.querySelectorAll<HTMLInputElement>('input.pkc-task-checkbox')].map((b) => b.checked);
    expect(after).toEqual([false, true, true]);
    // 押した行が入力欄に化けていない(行を開く押しに取られていない)
    expect(pane.querySelector('textarea')).toBeNull();
  });

  it('🔴 split:左の欄の本文が変わる', async () => {
    const root = await editing('split', []);
    const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    const preview = root.querySelector<HTMLElement>('[data-pkc-region="editor-preview"]')!;
    const boxes = [...preview.querySelectorAll<HTMLInputElement>('input.pkc-task-checkbox')];
    expect(boxes.length).toBe(3);
    expect(boxes.every((b) => !b.disabled)).toBe(true);
    boxes[0]!.click(); // 牛乳
    await settle(50);
    expect(ta.value).toBe(BODY.replace('- [ ] 牛乳', '- [x] 牛乳'));
  });
});

describe('1 面の編集の行は、より上の本文を返す(依頼 78-2・114-6 の土台)', () => {
  it('🔴 3 つ目の段落を開くと、その上の 2 段落(最後は改行)が返る。1 つ目を開くと空', async () => {
    localStorage.setItem('pkc3.editor-mode', 'live');
    const body = '基本単価 = 3200\n\n基本単価*8\n';
    const root = document.createElement('div');
    document.body.append(root);
    const detail = new DetailRenderer(buildShell(root).detail);
    let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('host')], relations: [] }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'host' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'host', body }).state;
    detail.render(s);
    await settle();
    s = reduce(s, { type: 'START_EDIT', atLine: 2 } as never).state;
    detail.render(s);
    for (let i = 0; i < 6; i += 1) await settle(50);
    const row = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]');
    expect(row, '3 行目の行が開いていない(前提)').not.toBeNull();
    expect(row!.value).toBe('基本単価*8');
    expect(rowTextAbove(row!)).toBe('基本単価 = 3200\n\n');
    // 対照群:行の欄でない欄は空
    expect(rowTextAbove(document.createElement('textarea'))).toBe('');
  });
});

describe('1 面の編集の行で Enter(依頼 78-2・114-6)', () => {
  it('🔴 別の段落に書いた 基本単価 = 3200 を使って、基本単価*8= + Enter が 25600 になる(上の段落が無い対照群は何も起きない)', async () => {
    localStorage.setItem('pkc3.editor-mode', 'live');
    const store = new Map<string, string>();
    const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    const run = async (body: string, atLine: number): Promise<string> => {
      document.body.innerHTML = '';
      const root = document.createElement('div');
      document.body.append(root);
      const shell = buildShell(root);
      const d = new Dispatcher();
      const detail = new DetailRenderer(shell.detail, null, undefined, (b) => d.dispatch({ type: 'UPDATE_OPEN_BODY', body: b }));
      bindActions(root, d, { showStatus: () => {} }, new KeymapStore(fake));
      d.onState((st) => detail.render(st));
      d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('host')], relations: [] });
      d.dispatch({ type: 'SELECT_ENTRY', lid: 'host' });
      d.dispatch({ type: 'BODY_LOADED', lid: 'host', body });
      await settle();
      d.dispatch({ type: 'START_EDIT', atLine } as never);
      for (let i = 0; i < 6; i += 1) await settle(50);
      const row = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
      expect(row, '行が開いていない(前提)').not.toBeNull();
      row.focus();
      row.setSelectionRange(row.value.length, row.value.length);
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return row.value;
    };
    expect(await run('基本単価 = 3200\n\n基本単価*8=\n', 2)).toBe('基本単価*8=25600');
    // 対照群:定義が無ければ何も起きない
    expect(await run('名前なし\n\n基本単価*8=\n', 2)).toBe('基本単価*8=');
  });
});

describe('1 行ずつ打つ編集のあいだの「番号を振り直す」「完了項目を末尾へ」(依頼 78-4)', () => {
  const tools = (root: HTMLElement): HTMLElement[] => [
    root.querySelector<HTMLElement>('[data-pkc-action="renumber-lists"]')!,
    root.querySelector<HTMLElement>('[data-pkc-action="sort-tasks"]')!,
  ];
  it('🔴 live:灰色(aria-disabled)で、マウスを載せると理由が出る。押したときの案内は残るので disabled にはしない', async () => {
    const root = await editing('live', []);
    for (const b of tools(root)) {
      expect(b.getAttribute('aria-disabled')).toBe('true');
      expect(b.disabled).toBeFalsy();
      expect(b.title).toBe(WHOLE_NOTE_REASON);
    }
    expect(WHOLE_NOTE_REASON).toContain('「全文を編集」');
  });
  it('対照群 split:灰色にならず、元の説明のまま', async () => {
    const root = await editing('split', []);
    for (const b of tools(root)) {
      expect(b.hasAttribute('aria-disabled')).toBe(false);
      expect(b.title).not.toBe(WHOLE_NOTE_REASON);
      expect(b.title.length).toBeGreaterThan(10);
    }
  });
  it('syncWholeNoteTools(bar, false) で元に戻る(全文の欄へ退避したとき)', () => {
    const bar = buildFormatBar();
    const before = tools(bar).map((b) => b.title);
    syncWholeNoteTools(bar, true);
    syncWholeNoteTools(bar, false);
    expect(tools(bar).map((b) => b.title)).toEqual(before);
    expect(tools(bar).every((b) => !b.hasAttribute('aria-disabled'))).toBe(true);
  });
});
