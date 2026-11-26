/** @vitest-environment happy-dom */
/**
 * 🔴 **書式の帯の「文字色 ▾」「配置 ▾」「ページ設定 ▾」**(v4.0 Phase 1 / PR-04)── 配線の検査。
 *
 * - ▾ を押すと隠した元と同じ一覧が出て、本文の欄の焦点は動かない(選んだ範囲が消えない)
 * - 項目を押すと、2 ペインの欄 / 1 画面編集の行の欄(`row-source`)のどちらにも効く。Ctrl+Z の道(`insertText`)を通る
 * - 「ページ設定 ▾」は情報ペインと同じ部品のポップオーバーを開き、どちらで変えても両方が即座に一致する
 * - `Esc` / 外を押すと閉じ、`Esc` で編集は終わらない。閉じると ▾ へ焦点が戻る
 * ⚠ 書き換えの規則そのものは `tests/features/markdown/word-format.test.ts`、実ブラウザは `word-format.smoke.spec.ts`。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { readNoteLayout } from '../../src/features/page-layout';
import { TEXT_COLORS, textColorValue } from '../../src/features/markdown/word-format';

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

/** ⚠ 前の test の配線を外す(文書に張った聞き耳が残ると、1 回の押下が 2 回走る ── 切替が往復して元に戻る)。 */
const unbinds: (() => void)[] = [];
afterEach(() => {
  for (const u of unbinds.splice(0)) u();
});

beforeEach(() => {
  document.body.textContent = '';
  localStorage.setItem('pkc3.editor-mode', 'split');
  localStorage.removeItem('pkc3.print-layout');
  document.documentElement.removeAttribute('data-pkc-print-layout');
});

function editing(body = '字') {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail, null, undefined, (b) => d.dispatch({ type: 'UPDATE_OPEN_BODY', body: b }));
  const inspector = new InspectorRenderer(regions.inspector);
  d.onState((s) => {
    detail.render(s);
    inspector.render(s);
  });
  // ⚠ 知らせの口(`showStatus`)は渡さない ── 渡さなくても切替などの本体が走ること自体を見る(`?.` の罠の回帰)
  unbinds.push(bindActions(root, d, {}));
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  d.dispatch({ type: 'START_EDIT' });
  const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
  const bar = root.querySelector<HTMLElement>('[data-pkc-region="format-bar"]')!;
  const menu = (): HTMLElement | null => root.querySelector('[data-pkc-region="context-menu"]');
  const opener = (id: 'color' | 'align'): HTMLElement =>
    bar.querySelector<HTMLElement>(`button[data-pkc-action="open-format-menu"][data-pkc-format-menu="${id}"]`)!;
  return { root, d, ta, bar, menu, opener };
}

function select(ta: HTMLTextAreaElement, needle: string): void {
  ta.focus();
  const i = ta.value.indexOf(needle);
  ta.setSelectionRange(i, i + needle.length);
}

describe('「文字色 ▾」', () => {
  it('🔴 押すと 6 色 + 色を解除 の一覧が出て、本文の欄の焦点は動かない', () => {
    const { ta, menu, opener } = editing();
    select(ta, '字');
    const btn = opener('color');
    expect(btn.textContent).toBe('文字色 ▾');
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    btn.click();
    const items = [...menu()!.querySelectorAll<HTMLElement>('button[data-pkc-action="apply-text-color"]')];
    expect(items.map((b) => b.textContent)).toEqual([...TEXT_COLORS.map((c) => c.label), '色を解除']);
    expect(document.activeElement, '焦点が一覧へ移った(1 画面編集の行が確定して閉じる原因)').toBe(ta);
    // 見本の色は項目に写る(頭の四角)── 色を解除は見本を持たない
    expect(items[0]!.getAttribute('style')).toContain(TEXT_COLORS[0].value);
    expect(items.at(-1)!.getAttribute('data-pkc-color')).toBe('');
  });

  it('🔴 色を付ける → 別の色に差し替える(入れ子にならない)→ 色を解除で元に戻る', () => {
    const { d, ta, menu, opener } = editing('前 字 後');
    select(ta, '字');
    opener('color').click();
    menu()!.querySelector<HTMLElement>('[data-pkc-color="red"]')!.click();
    const red = textColorValue('red')!;
    expect(ta.value).toBe(`前 :字:${red}: 後`);
    expect(d.getState().openBody?.body, 'state に届いていない').toBe(ta.value);
    expect(menu(), '選んだら一覧が閉じる').toBeNull();
    // 選択は中身のまま ── 続けて別の色を選べる
    opener('color').click();
    menu()!.querySelector<HTMLElement>('[data-pkc-color="blue"]')!.click();
    expect(ta.value).toBe(`前 :字:${textColorValue('blue')!}: 後`);
    opener('color').click();
    menu()!.querySelector<HTMLElement>('[data-pkc-color=""]')!.click();
    expect(ta.value).toBe('前 字 後');
  });

  it('🔴 1 画面編集の行の欄(row-source)にも効く', () => {
    const { root, menu, opener } = editing();
    // 1 画面編集の行の欄を置く(書き込む先は `formatTarget` ── 行の欄が 2 ペインの欄より先)
    const row = document.createElement('textarea');
    row.setAttribute('data-pkc-field', 'row-source');
    row.value = '行の字';
    root.querySelector('[data-pkc-region="detail"]')!.append(row);
    select(row, '行の');
    opener('color').click();
    expect(document.activeElement, '行の欄から焦点が外れた').toBe(row);
    menu()!.querySelector<HTMLElement>('[data-pkc-color="green"]')!.click();
    expect(row.value).toBe(`:行の:${textColorValue('green')!}:字`);
  });
});

describe('「配置 ▾」', () => {
  it('🔴 中央揃え → 右揃え(差し替え)→ 揃えを解除 / 字下げを増やす → 減らす', () => {
    const { ta, menu, opener } = editing('段落');
    ta.focus();
    ta.setSelectionRange(1, 1);
    const pickOp = (op: string): void => {
      opener('align').click();
      const item = menu()!.querySelector<HTMLElement>(`[data-pkc-action="format-text"][data-pkc-format="${op}"]`);
      expect(item, `${op} が一覧に無い`).not.toBeNull();
      item!.click();
    };
    expect(opener('align').textContent).toBe('配置 ▾');
    pickOp('align-center');
    expect(ta.value).toBe(':::format{align=center}\n段落\n:::');
    pickOp('align-right');
    expect(ta.value).toBe(':::format{align=right}\n段落\n:::');
    pickOp('align-clear');
    expect(ta.value).toBe('段落');
    pickOp('indent-more');
    expect(ta.value).toBe(':::format{indent=1}\n段落\n:::');
    pickOp('indent-less');
    expect(ta.value).toBe('段落');
  });

  it('一覧の字は 6 つ(揃え 3 + 解除 + 字下げ 2)', () => {
    const { menu, opener, ta } = editing();
    ta.focus();
    opener('align').click();
    expect([...menu()!.querySelectorAll('button[data-pkc-action]')].map((b) => b.textContent)).toEqual([
      '左揃え',
      '中央揃え',
      '右揃え',
      '揃えを解除',
      '字下げを増やす',
      '字下げを減らす',
    ]);
  });
});

describe('「ページ設定 ▾」', () => {
  const panel = (root: HTMLElement): HTMLElement | null => root.querySelector('[data-pkc-region="page-setup-panel"]');
  const panelSelect = (root: HTMLElement, f: string): HTMLSelectElement =>
    panel(root)!.querySelector<HTMLSelectElement>(`select[data-pkc-note-layout-field="${f}"]`)!;
  const paneSelect = (root: HTMLElement, f: string): HTMLSelectElement =>
    root.querySelector<HTMLSelectElement>(`[data-pkc-field="inspector-page-layout"] select[data-pkc-note-layout-field="${f}"]`)!;
  const choose = (sel: HTMLSelectElement, v: string): void => {
    sel.value = v;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('🔴 開くと情報ペインと同じ部品が並び、編集中でも選べる。焦点はポップオーバーの中', () => {
    const { root, bar } = editing();
    const btn = bar.querySelector<HTMLElement>('button[data-pkc-action="open-page-setup"]')!;
    expect(btn.textContent).toBe('ページ設定 ▾');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    btn.click();
    const p = panel(root);
    expect(p, 'ポップオーバーが出ない').not.toBeNull();
    expect(p!.getAttribute('role')).toBe('dialog');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(btn.getAttribute('aria-controls')).toBe(p!.id);
    expect(p!.contains(document.activeElement), '焦点がポップオーバーへ入らない').toBe(true);
    for (const f of ['pageFormat', 'pageMargin', 'pageColumns', 'pageFont']) {
      expect(panelSelect(root, f).disabled, `${f} が編集中に押せない`).toBe(false);
      expect(panelSelect(root, f).options[0]!.textContent).toBe('アプリの設定に従う');
    }
    expect(p!.querySelector('[data-pkc-action="toggle-print-layout"]')).not.toBeNull();
    expect(p!.querySelector('[data-pkc-action="reset-note-layout"]')).not.toBeNull();
  });

  it('🔴 ポップオーバーで変える → 下書きの前書き・編集欄・情報ペインがそろう / 情報ペインで変える → ポップオーバーもそろう', () => {
    const { root, d, ta, bar } = editing('本文');
    bar.querySelector<HTMLElement>('button[data-pkc-action="open-page-setup"]')!.click();
    choose(panelSelect(root, 'pageFormat'), 'a4-landscape');
    expect(readNoteLayout(d.getState().openBody!.body).pageFormat).toBe('a4-landscape');
    expect(d.getState().phase, '保存して編集が終わった').toBe('editing');
    expect(ta.value, '編集欄に映らない(次の打鍵で消える)').toBe(d.getState().openBody!.body);
    expect(paneSelect(root, 'pageFormat').value, '情報ペインが一致しない').toBe('a4-landscape');
    choose(paneSelect(root, 'pageMargin'), 'wide');
    expect(panelSelect(root, 'pageMargin').value, 'ポップオーバーが一致しない').toBe('wide');
    expect(readNoteLayout(ta.value).pageMargin).toBe('wide');
    // すべて戻す → 本文は元の字へ
    panel(root)!.querySelector<HTMLElement>('[data-pkc-action="reset-note-layout"]')!.click();
    expect(d.getState().openBody!.body).toBe('本文');
    expect(ta.value).toBe('本文');
    expect(panelSelect(root, 'pageFormat').value).toBe('');
  });

  it('🔴 印刷レイアウト表示の切替は情報ペインのボタンとそろう(知らせの口が無くても切り替わる)', () => {
    const { root, bar } = editing();
    bar.querySelector<HTMLElement>('button[data-pkc-action="open-page-setup"]')!.click();
    const toggle = panel(root)!.querySelector<HTMLElement>('[data-pkc-action="toggle-print-layout"]')!;
    toggle.click();
    expect(document.documentElement.getAttribute('data-pkc-print-layout')).toBe('1');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    const pane = root.querySelector<HTMLElement>('[data-pkc-field="inspector-print-layout"]')!;
    expect(pane.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    expect(document.documentElement.hasAttribute('data-pkc-print-layout')).toBe(false);
  });

  it('🔴 Esc で閉じ、編集は終わらない。焦点は ▾ へ戻る', () => {
    const { root, d, bar } = editing();
    const btn = bar.querySelector<HTMLElement>('button[data-pkc-action="open-page-setup"]')!;
    btn.click();
    const sel = panelSelect(root, 'pageFont');
    sel.focus();
    // ⚠ 同じ Escape が画面のほかの受け手(編集をやめる・選択を外す・一覧を閉じる)へ流れないこと(伝播を止める)
    const leaked: string[] = [];
    const spy = (ev: Event): void => void leaked.push((ev as KeyboardEvent).key);
    document.addEventListener('keydown', spy);
    sel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    document.removeEventListener('keydown', spy);
    expect(leaked, 'Escape がポップオーバーの外へ流れた').toEqual([]);
    expect(panel(root), 'Esc で閉じない').toBeNull();
    expect(d.getState().phase, 'Esc で編集が終わった').toBe('editing');
    expect(document.activeElement).toBe(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('▾ をもう一度押す・× を押す・外を押すと閉じる(片づけ後は聞き耳を残さない)', () => {
    const { root, ta, bar } = editing();
    const btn = bar.querySelector<HTMLElement>('button[data-pkc-action="open-page-setup"]')!;
    btn.click();
    btn.click();
    expect(panel(root)).toBeNull();
    btn.click();
    panel(root)!.querySelector<HTMLElement>('[data-pkc-action="close-page-setup"]')!.click();
    expect(panel(root)).toBeNull();
    btn.click();
    ta.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(panel(root), '外を押しても閉じない').toBeNull();
  });

  it('編集を終えると閉じる(押す先の無いポップオーバーを残さない)', () => {
    const { root, d, bar } = editing();
    bar.querySelector<HTMLElement>('button[data-pkc-action="open-page-setup"]')!.click();
    expect(panel(root)).not.toBeNull();
    d.dispatch({ type: 'CANCEL_EDIT' });
    expect(panel(root)).toBeNull();
  });
});
