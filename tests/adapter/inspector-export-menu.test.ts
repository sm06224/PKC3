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
import { openContextMenu, scrollClosesMenu, noteMenuUserInput } from '../../src/adapter/ui/render/context-menu';
import { ACTION_ICONS, INSPECTOR_ICON_ACTIONS } from '../../src/adapter/ui/render/icons';
import { ARCHETYPE_ICONS, BROWSE_ICONS } from '../../src/adapter/ui/render/icons';
import {
  ENTRY_MENU_ACTIONS,
  FOLDER_EXPORT_NOTE,
  INSPECTOR_EXPORT_MENU_ACTIONS,
} from '../../src/features/entry-actions';

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

function mounted(opts: { select?: string | null; folder?: boolean; linked?: boolean } = {}) {
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
    if (opts.linked) d.dispatch({ type: 'FILE_LINKED', lid: opts.select ?? 'n1', name: 'memo.md' });
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

  it('選択を n1 から n2 へ切り替えると、「書き出す ▾」の対象も n2 に追従し、項目が n2 を書き出す', () => {
    const s = mounted();
    const btn = s.q<HTMLButtonElement>('[data-pkc-action="open-export-menu"]');
    expect(btn.getAttribute('data-pkc-entry')).toBe('n1');
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    s.d.dispatch({ type: 'BODY_LOADED', lid: 'n2', body: '本文2\n' });
    expect(s.d.getState().selectedLid).toBe('n2');
    // 追従しないと、一覧の項目が前のノート(n1)を書き出す
    expect(btn.getAttribute('data-pkc-entry'), '選択を替えたのに、対象が前のノートのまま').toBe('n2');
    btn.click();
    for (const el of s.menu()!.querySelectorAll('button[data-pkc-action]'))
      expect(el.getAttribute('data-pkc-entry'), '項目の対象が n2 でない').toBe('n2');
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

describe('一覧の項目の状態(#1029 / #501)', () => {
  const items = (m: HTMLElement) =>
    Object.fromEntries(
      [...m.querySelectorAll<HTMLButtonElement>('button[data-pkc-action]')].map((b) => [
        b.getAttribute('data-pkc-action')!,
        {
          disabled: b.disabled,
          hint: b.getAttribute('data-pkc-hint') ?? '',
          group: b.closest('[data-pkc-field="context-menu-group"]')?.getAttribute('data-pkc-group') ?? null,
        },
      ]),
    );

  it('A2: フォルダを選んでも、書き出し系 10 件は隠した器の中(平置きに戻らない)', () => {
    const s = mounted({ folder: true, linked: true });
    expect(INSPECTOR_EXPORT_MENU_ACTIONS.length).toBe(10);
    for (const a of INSPECTOR_EXPORT_MENU_ACTIONS) {
      const b = s.q(`[data-pkc-field="inspector-actions"] [data-pkc-action="${a}"]`);
      expect(b, `${a} が描かれていない`).not.toBeNull();
      expect(b.closest('[hidden]'), `${a} が平置きに戻っている`).not.toBeNull();
    }
    // 対照群: 常設の「書き出す ▾」は隠れていない
    expect(s.q('[data-pkc-action="open-export-menu"]').closest('[hidden]')).toBeNull();
  });

  it('B(通常時): 説明が入り、押せて、塊は右クリックと同じ', () => {
    const s = mounted();
    s.q('[data-pkc-action="open-export-menu"]').click();
    const it = items(s.menu()!);
    expect(Object.keys(it).length).toBeGreaterThanOrEqual(7);
    for (const [a, v] of Object.entries(it)) {
      expect(v.disabled, `${a} が押せない`).toBe(false);
      expect(v.hint, `${a} の説明が空`).not.toBe('');
      expect(v.group, `${a} の塊が違う`).toBe(ENTRY_MENU_ACTIONS.find((x) => x.action === a)!.group);
    }
  });

  it('B(フォルダ選択時): 書き出し 5 つは押せず理由が説明に出る。フォルダのバックアップだけ押せて、別の塊', () => {
    const s = mounted({ folder: true });
    s.q('[data-pkc-action="open-export-menu"]').click();
    const it = items(s.menu()!);
    for (const a of ['export-entry-html', 'export-entry-docx', 'export-entry-pptx', 'export-entry-pdf', 'export-entry-markdown']) {
      expect(it[a], `${a} が一覧に無い`).toBeDefined();
      expect(it[a]!.disabled, `${a} が押せる`).toBe(true);
      expect(it[a]!.hint, `${a} の理由が出ていない`).toContain(FOLDER_EXPORT_NOTE);
    }
    expect(it['export-folder']!.disabled).toBe(false);
    expect(it['export-entry']!.disabled).toBe(false);
    // B2: 2 つのバックアップは別の塊(見出しの間で区別できる)
    expect(it['export-folder']!.group).toBe('this-folder');
    expect(it['export-entry']!.group).toBe('export');
  });

  it('B(編集中): 画面からは開けず、古い DOM から開かれても全項目が押せず理由が出る', () => {
    const s = mounted();
    s.d.dispatch({ type: 'START_EDIT' });
    const btn = s.q<HTMLButtonElement>('[data-pkc-action="open-export-menu"]');
    expect(btn.disabled).toBe(true);
    // 古い(描き直される前の)DOM から撃たれた回を再現する
    btn.disabled = false;
    btn.click();
    expect(s.menu(), '一覧が開かない').not.toBeNull();
    const it = items(s.menu()!);
    expect(Object.keys(it).length).toBeGreaterThanOrEqual(7);
    for (const [a, v] of Object.entries(it)) {
      expect(v.disabled, `編集中なのに ${a} が押せる`).toBe(true);
      expect(v.hint, `${a} の理由が出ていない`).toContain('編集中は使えません');
    }
  });

  it('C: PKC3 入り HTML の中では、コレクション側の export-portable は一覧で押せず理由が出る(対照群: ほかは押せる)', () => {
    const tag = document.createElement('script');
    tag.setAttribute('type', 'application/json');
    tag.setAttribute('data-pkc-bundle', '');
    tag.textContent = JSON.stringify({ id: 'pkcb-2b1f9c04d7', exportedAt: 5 });
    document.head.append(tag);
    try {
      const s = mounted({ select: null });
      s.q('[data-pkc-action="open-collection-export-menu"]').click();
      const it = items(s.menu()!);
      expect(it['export-portable'], 'export-portable が一覧に無い').toBeDefined();
      expect(it['export-portable']!.disabled).toBe(true);
      expect(it['export-portable']!.hint).not.toBe('');
      expect(it['export-html']!.disabled, '対照群: 閲覧用 HTML まで押せなくなっている').toBe(false);
    } finally {
      tag.remove();
    }
  });
});

describe('常設ボタンの並びと、図案を共有しないこと(#1029 / #501)', () => {
  it('並びは コピー群 → 別ウィンドウ → 書き出す ▾ → 履歴 → ゴミ箱へ移す', () => {
    const s = mounted();
    const order = [...s.root.querySelectorAll('[data-pkc-field="inspector-actions"] button[data-pkc-action]')]
      .map((b) => b.getAttribute('data-pkc-action')!)
      .filter((a) =>
        ['copy-entry-ref', 'copy-entry-link', 'copy-plain-markdown', 'open-note-window', 'open-export-menu', 'show-history', 'delete-entry'].includes(a),
      );
    expect(order).toEqual([
      'copy-entry-ref',
      'copy-entry-link',
      'copy-plain-markdown',
      'open-note-window',
      'open-export-menu',
      'show-history',
      'delete-entry',
    ]);
  });

  it('常設のアイコンは、意味の違う別の action・種別・タブと同じ図案を共有しない', () => {
    // 同じ意味の仲間として共有してよい相手(ここに無い共有は落ちる ── 増やすなら理由を書く)
    const SAME_MEANING: Record<string, readonly string[]> = {
      'copy-entry-ref': ['dual-copy'], // 同じ「コピー」
      'copy-entry-link': ['browse:graph'], // つながり(リンク)の絵
      'open-export-menu': ['export-entry', 'write-back-file'], // 同じ「外へ出す」
      'delete-entry': ['delete-selected', 'discard-capture', 'discard-timer', 'open-trash', 'dual-delete'], // 同じ「ゴミ箱」
    };
    const users = (glyph: string, self: string): string[] => [
      ...Object.entries(ACTION_ICONS).filter(([k, v]) => v === glyph && k !== self).map(([k]) => k),
      ...Object.entries(ARCHETYPE_ICONS).filter(([, v]) => v === glyph).map(([k]) => `archetype:${k}`),
      ...Object.entries(BROWSE_ICONS).filter(([, v]) => v === glyph).map(([k]) => `browse:${k}`),
    ];
    let checked = 0;
    for (const a of INSPECTOR_ICON_ACTIONS) {
      if (a === 'open-collection-export-menu') continue;
      const glyph = ACTION_ICONS[a]!;
      // 2 つの「書き出す ▾」は同じ絵(同じ意味)── 数える相手から外す
      const others = users(glyph, a).filter((k) => k !== 'open-collection-export-menu' && k !== 'open-export-menu');
      expect(others.sort(), `${a}(${glyph})が、許した相手以外とも図案を共有している`).toEqual(
        [...(SAME_MEANING[a] ?? [])].sort(),
      );
      checked += 1;
    }
    expect(checked).toBe(7);
    // 取り違えが指摘された組(別のウィンドウ ↔ 2 ペインの「移す」)は、はっきり別の絵
    expect(ACTION_ICONS['open-note-window']).not.toBe(ACTION_ICONS['dual-move']);
  });
});

describe('一覧から押したコピーの合図(#1029 / #501)', () => {
  it('「構成をコピー」を一覧から押すと、閉じた項目ではなく「書き出す ▾」のボタンが光る', () => {
    const s = mounted({ select: null });
    s.d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1'), meta('n2')], relations: [] });
    const opener = s.q<HTMLButtonElement>('[data-pkc-action="open-collection-export-menu"]');
    opener.click();
    const item = s.menu()!.querySelector<HTMLButtonElement>('[data-pkc-action="export-structure"]')!;
    expect(item.getAttribute('data-pkc-flash')).toBeNull();
    item.click();
    expect(s.menu(), '押したら閉じる').toBeNull();
    expect(opener.getAttribute('data-pkc-flash'), '合図が「書き出す ▾」に出ていない').toBe('true');
    expect(item.getAttribute('data-pkc-flash'), '閉じた項目に合図が出ている(誰にも見えない)').toBeNull();
  });
});

/**
 * 🔴 **保存の直後に「書き出す ▾」を押しても、一覧が勝手に消えない**(#1029 / #501)。
 *
 * 実ブラウザで閉じた原因を捕まえた: 開いた後に、右ペイン(`aside`)の `scrollTop` が**ブラウザの都合で**
 * 168 → 148 に動き(`scrollTop` を書いた者は居ない)、その `scroll` で `onScrollCloseMenu` が閉じていた。
 * 位置は動いているので #875 の「開く前に済んだ送り」の判定では守れない。→ user が送る入力が無ければ閉じない。
 */
describe('一覧は、user が送っていないスクロールでは閉じない(#1029 / #501)', () => {
  const aside = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-pkc-region="inspector"]')!;
  const scrollTo = (el: HTMLElement, top: number): void => {
    el.scrollTop = top;
    el.dispatchEvent(new Event('scroll'));
  };

  it('開いたあと、保存の ack と同じ描き直しとスクロールが起きても、一覧は開いたまま。user がホイールで送ったら閉じる', () => {
    const s = mounted();
    aside(s.root).scrollTop = 168; // 開く前に済んだ送り(クリックの焦点)
    s.q('[data-pkc-action="open-export-menu"]').click();
    expect(s.menu(), '前提: 開いていない').not.toBeNull();

    // 保存の ack と同じ再描画(本文・題名の更新)── 器の中の値が差し替わる
    s.d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文が変わった\n見出し\n' });
    // ブラウザの都合で位置が動く(丸め・アンカー)
    scrollTo(aside(s.root), 148);
    expect(s.menu(), '送っていないスクロールで一覧が消えた').not.toBeNull();

    // 対照群: user が送ったら閉じる(緩めすぎていない)
    aside(s.root).dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40 }));
    scrollTo(aside(s.root), 100);
    expect(s.menu(), 'user が送ったのに閉じない').toBeNull();
  });

  it('ホイール・指・スクロールバーの掴み・送りのキーのどれでも「送った」になる。一覧の中の操作は数えない', () => {
    const open = (): ReturnType<typeof mounted> => {
      const s = mounted();
      s.q('[data-pkc-action="open-export-menu"]').click();
      return s;
    };
    const cases: Array<[string, (a: HTMLElement) => Event]> = [
      ['wheel', () => new WheelEvent('wheel', { bubbles: true })],
      ['touchmove', () => new Event('touchmove', { bubbles: true })],
      ['pointerdown', () => new Event('pointerdown', { bubbles: true })],
      ['PageDown', () => new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true })],
    ];
    for (const [name, make] of cases) {
      const s = open();
      aside(s.root).dispatchEvent(make(aside(s.root)));
      scrollTo(aside(s.root), 60);
      expect(s.menu(), `${name} のあとのスクロールで閉じない`).toBeNull();
    }
    // 一覧の中の ↓ は「背面を送る」入力ではない
    const s = open();
    s.menu()!.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    scrollTo(aside(s.root), 60);
    expect(s.menu(), '一覧の中の操作が「送った」に数えられている').not.toBeNull();
  });

  it('判定は 1 か所: 右クリックの一覧(openContextMenu)も、一覧ごとに入力を覚え、次の一覧へ持ち越さない', () => {
    const root = document.createElement('div');
    const scroller = document.createElement('div');
    const btn = document.createElement('button');
    scroller.append(btn);
    root.append(scroller);
    document.body.append(root);
    const items = [{ action: 'x', label: 'x' }];
    openContextMenu(root, { x: 0, y: 0 }, items, btn, {});
    scroller.scrollTop = 50;
    expect(scrollClosesMenu(root, scroller), '送っていないのに閉じる側').toBe(false);
    noteMenuUserInput(root, new WheelEvent('wheel', { bubbles: true }));
    expect(scrollClosesMenu(root, scroller), '送ったのに閉じない側').toBe(true);
    // 開き直した一覧は入力を持ち越さない
    openContextMenu(root, { x: 0, y: 0 }, items, btn, {});
    scroller.scrollTop = 80;
    expect(scrollClosesMenu(root, scroller), '前の一覧の入力が持ち越されている').toBe(false);
    root.remove();
  });
});
