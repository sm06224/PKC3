/** @vitest-environment happy-dom */
/**
 * 🔴 **右の列の書き出し系は「書き出す ▾」1 つに畳まれ、主要操作は 1 クリックのまま**(#1029 / #501。user 裁定 2026-11-03)。
 *
 * 守る主張:
 * 1. 書き出し系は画面に平置きされず、「書き出す ▾」を押すと一覧が開き、各項目が**既存の action** で既存の書き出しを呼ぶ
 * 2. 🔴 一覧の対象は押したボタンの `data-pkc-entry`(選択中のノートから採らない)
 * 3. `Esc` で閉じて焦点がボタンへ戻り、その `Esc` はノート選択の解除(`deselect-entry`)へ届かない
 * 4. 編集中は「書き出す ▾」が押せない(これまでの門と同じ)
 * 5. 常設の主要操作は隠れず、図案は互いに別。一覧の中の各形式は字だけ
 * 6. コレクション(何も選んでいないとき)も同じ形
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { ACTION_ICONS, INSPECTOR_ICON_ACTIONS } from '../../src/adapter/ui/render/icons';
import { ENTRY_MENU_ACTIONS, INSPECTOR_EXPORT_MENU_ACTIONS } from '../../src/features/entry-actions';

function meta(lid: string, archetype: EntryMeta['archetype'] = 'text'): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

beforeEach(() => {
  document.body.textContent = '';
});

function mounted(opts: { select?: string | null; folder?: boolean } = {}) {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const inspector = new InspectorRenderer(regions.inspector);
  d.onState((s) => inspector.render(s));
  const calls: string[] = [];
  bindActions(root, d, {
    exportEntry: (lid) => void calls.push(`entry:${lid}`),
    exportEntryDocx: (lid) => void calls.push(`docx:${lid}`),
    exportEntryHtml: (lid) => void calls.push(`html:${lid}`),
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('n1', opts.folder ? 'folder' : 'text'), meta('n2')],
    relations: [],
  });
  if (opts.select !== null) {
    d.dispatch({ type: 'SELECT_ENTRY', lid: opts.select ?? 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: opts.select ?? 'n1', body: '本文\n' });
  }
  const q = <T extends HTMLElement>(sel: string): T => root.querySelector<T>(sel)!;
  const menu = (): HTMLElement | null => root.querySelector<HTMLElement>('[data-pkc-region="context-menu"]');
  return { root, d, q, menu, calls };
}

const menuActions = (m: HTMLElement | null): string[] =>
  [...(m?.querySelectorAll('button[data-pkc-action]') ?? [])].map((b) => b.getAttribute('data-pkc-action') ?? '');

describe('右の列の「書き出す ▾」(#1029 / #501)', () => {
  it('書き出し系は画面に平置きされない(押せる位置に在るのは「書き出す ▾」だけ)', () => {
    const s = mounted();
    const visible = (action: string): boolean => {
      const b = s.q(`[data-pkc-field="inspector-actions"] [data-pkc-action="${action}"]`);
      return b !== null && b.closest('[hidden]') === null;
    };
    expect(INSPECTOR_EXPORT_MENU_ACTIONS.length).toBeGreaterThanOrEqual(10);
    for (const a of INSPECTOR_EXPORT_MENU_ACTIONS) {
      expect(visible(a), `${a} が平置きのまま`).toBe(false);
    }
    expect(visible('open-export-menu')).toBe(true);
    // 対照群: 常設の主要操作は押せる位置に居る
    for (const a of ['copy-entry-ref', 'copy-entry-link', 'copy-plain-markdown', 'open-note-window', 'show-history', 'delete-entry']) {
      expect(visible(a), `${a} が隠れている`).toBe(true);
    }
  });

  it('押すと一覧が開き、並びは右クリックの書き出し群と同じ。項目に図案は付かない', () => {
    const s = mounted();
    s.q('[data-pkc-action="open-export-menu"]').click();
    const m = s.menu();
    expect(m).not.toBeNull();
    const shown = menuActions(m);
    // ノートでは「フォルダ」「字幕」「元ファイル」は畳まれる
    const expected = INSPECTOR_EXPORT_MENU_ACTIONS.filter(
      (a) => !['export-folder', 'export-entry-srt', 'write-back-file'].includes(a),
    );
    expect(shown).toEqual(expected);
    expect(shown.length).toBeGreaterThanOrEqual(7);
    // 右クリックの定義順と同じ順
    const order = ENTRY_MENU_ACTIONS.map((a) => a.action);
    expect(shown).toEqual([...shown].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    expect(m!.querySelectorAll('[data-pkc-icon]').length, '一覧の中は字だけ').toBe(0);
    expect(s.q<HTMLButtonElement>('[data-pkc-action="open-export-menu"]').getAttribute('aria-haspopup')).toBe('menu');
  });

  it('項目を押すと、押したボタンの対象ノートで既存の書き出しが呼ばれる(選択中ではない)', () => {
    const s = mounted();
    // 押したボタンが指すノートと選択中のノートがずれた状態を作る
    s.q('[data-pkc-action="open-export-menu"]').setAttribute('data-pkc-entry', 'n2');
    s.q('[data-pkc-action="open-export-menu"]').click();
    (s.menu()!.querySelector('[data-pkc-action="export-entry-docx"]') as HTMLButtonElement).click();
    expect(s.calls).toEqual(['docx:n2']);
    expect(s.menu(), '押したら閉じる').toBeNull();
  });

  it('フォルダでは「このフォルダをバックアップ」が一覧に出る', () => {
    const s = mounted({ folder: true });
    s.q('[data-pkc-action="open-export-menu"]').click();
    expect(menuActions(s.menu())).toContain('export-folder');
  });

  it('Esc で閉じて焦点がボタンへ戻り、その Esc はノート選択の解除へ届かない', () => {
    const s = mounted();
    const btn = s.q<HTMLButtonElement>('[data-pkc-action="open-export-menu"]');
    btn.focus();
    btn.click();
    expect(s.menu()).not.toBeNull();
    expect(s.root.ownerDocument.activeElement).not.toBe(btn);
    s.root.ownerDocument.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(s.menu()).toBeNull();
    expect(s.root.ownerDocument.activeElement).toBe(btn);
    expect(s.d.getState().selectedLid, 'Esc がノートの選択を解除した').toBe('n1');
  });

  it('↑↓ で項目を移れる', () => {
    const s = mounted();
    s.q('[data-pkc-action="open-export-menu"]').click();
    const items = [...s.menu()!.querySelectorAll<HTMLButtonElement>('button[data-pkc-action]')];
    expect(items[0]).toBe(document.activeElement);
    items[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(items[1]);
  });

  it('編集中は「書き出す ▾」が押せず、理由が title に出る。終えれば戻る', () => {
    const s = mounted();
    const btn = s.q<HTMLButtonElement>('[data-pkc-action="open-export-menu"]');
    expect(btn.disabled).toBe(false);
    s.d.dispatch({ type: 'START_EDIT' });
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain('編集');
    btn.click();
    expect(s.menu(), '押せない').toBeNull();
    s.d.dispatch({ type: 'CANCEL_EDIT' });
    expect(btn.disabled).toBe(false);
  });

  it('常設の代表ボタンには図案が付き、互いに別の絵である', () => {
    const s = mounted();
    const names: string[] = [];
    for (const a of INSPECTOR_ICON_ACTIONS) {
      if (a === 'open-collection-export-menu') continue;
      const b = s.q(`[data-pkc-field="inspector-actions"] [data-pkc-action="${a}"]`);
      expect(b, `${a} が描かれていない`).not.toBeNull();
      const sym = b.querySelector('[data-pkc-icon]')?.getAttribute('data-pkc-symbol');
      expect(sym, `${a} に図案が無い`).toBe(ACTION_ICONS[a]);
      names.push(sym!);
      // 字は変わらない(図案は textContent に混ざらない)
      expect(b.textContent).toBe(b.querySelector('[data-pkc-field="label"]')!.textContent);
    }
    expect(names.length).toBe(7);
    expect(new Set(names).size, `図案が重なっている: ${names.join(',')}`).toBe(names.length);
    expect(names).not.toContain('sunny');
    // 図案を付けないボタンは字だけ(平置きの残り)
    expect(s.q('[data-pkc-action="rename-entry-begin"]').querySelector('[data-pkc-icon]')).toBeNull();
  });
});

describe('コレクション(何も選んでいないとき)の「書き出す ▾」', () => {
  it('平置きの書き出しは無く、一覧に 5 件以上の書き出しが並ぶ。項目は既存の action', () => {
    const s = mounted({ select: null });
    const btn = s.q<HTMLButtonElement>('[data-pkc-action="open-collection-export-menu"]');
    expect(btn).not.toBeNull();
    expect(btn.querySelector('[data-pkc-icon]')).not.toBeNull();
    const flat = s.q('[data-pkc-field="collection-commands"]');
    expect(flat.querySelector('[data-pkc-field="collection-export-source"]')!.hasAttribute('hidden')).toBe(true);
    btn.click();
    const shown = menuActions(s.menu());
    for (const a of ['export-html', 'export-portable', 'export-pkc2-html', 'export-markdown', 'export-structure']) {
      expect(shown, a).toContain(a);
    }
    // 書き出しではない「整理案を適用」は平置きのまま
    expect(s.q('[data-pkc-action="toggle-plan-apply"]').closest('[hidden]')).toBeNull();
  });
});
