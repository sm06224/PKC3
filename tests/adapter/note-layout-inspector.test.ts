/** @vitest-environment happy-dom */
/**
 * 🔴 情報ペインの「ページ設定」と、書き込みの reducer(v4.0 Phase 1 / PR-03)。
 *
 * - 選択欄の値はノートの前書きから読む。先頭は常に「アプリの設定に従う」
 * - 「すべてアプリの設定に戻す」は指定があるときだけ押せる(片道を作らない)
 * - 本文が届いていない間・ほかの書けない状態は選べない / フォルダ・system 領域では行ごと畳む
 * - 🔴 PR-04: 編集中のそのノートは選べる(下書きの前書きを書き換える ── 書式の帯の「ページ設定 ▾」と同じ 1 本)
 * - `SET_NOTE_LAYOUT` は既存の前書き書換 1 本の event を出し、`null` はキーを消す
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { readNoteLayout } from '../../src/features/page-layout';
import { PAGE_FORMATS } from '../../src/features/page-format';

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: Number(lid.replace(/\D/g, '')) || 0,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
    ...over,
  };
}

function boot(metas: EntryMeta[], lid: string, body: string | null): AppState {
  let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid }).state;
  if (body !== null) s = reduce(s, { type: 'BODY_LOADED', lid, body }).state;
  return s;
}

function mount(): { root: HTMLElement; inspector: InspectorRenderer } {
  document.body.textContent = '';
  const root = document.createElement('div');
  document.body.append(root);
  return { root, inspector: new InspectorRenderer(buildShell(root).inspector) };
}

const dd = (root: HTMLElement): HTMLElement => root.querySelector<HTMLElement>('[data-pkc-field="inspector-page-layout"]')!;
const select = (root: HTMLElement, f: string): HTMLSelectElement =>
  dd(root).querySelector<HTMLSelectElement>(`select[data-pkc-note-layout-field="${f}"]`)!;
const reset = (root: HTMLElement): HTMLButtonElement => dd(root).querySelector<HTMLButtonElement>('[data-pkc-action="reset-note-layout"]')!;

describe('情報ペインの「ページ設定」', () => {
  it('🔴 4 つの選択欄の先頭は「アプリの設定に従う」、選択肢は正本の表から', () => {
    const { root, inspector } = mount();
    inspector.render(boot([meta('n1')], 'n1', '本文'));
    for (const f of ['pageFormat', 'pageMargin', 'pageColumns', 'pageFont']) {
      const sel = select(root, f);
      expect(sel, f).not.toBeNull();
      expect(sel.options[0]!.value).toBe('');
      expect(sel.options[0]!.textContent).toBe('アプリ設定');
      expect(sel.getAttribute('data-pkc-action')).toBe('set-note-layout');
    }
    expect([...select(root, 'pageFormat').options].slice(1).map((o) => o.value)).toEqual(PAGE_FORMATS.map((f) => f.id));
    // 2 択: 通常が押された状態、印刷レイアウトは押されていない
    const seg = dd(root).querySelector('[data-pkc-field="inspector-print-layout"]')!;
    expect(seg.querySelector('[data-pkc-print-layout-choice="off"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(seg.querySelector('[data-pkc-print-layout-choice="on"]')?.getAttribute('aria-pressed')).toBe('false');
    expect([...seg.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['通常', '印刷レイアウト']);
  });

  it('🔴 前書きの値を選択欄に映す。指定があるときだけ「すべてアプリの設定に戻す」を押せる', () => {
    const { root, inspector } = mount();
    inspector.render(boot([meta('n1')], 'n1', '本文'));
    expect(select(root, 'pageFormat').value).toBe('');
    expect(reset(root).disabled, '指定が無いのに押せる').toBe(true);
    inspector.render(boot([meta('n1')], 'n1', '---\npage_format: a4-landscape\npage_columns: 2\n---\n本文'));
    expect(select(root, 'pageFormat').value).toBe('a4-landscape');
    expect(select(root, 'pageColumns').value).toBe('2');
    expect(select(root, 'pageMargin').value).toBe('');
    expect(select(root, 'pageFont').value).toBe('');
    expect(reset(root).disabled).toBe(false);
    expect(select(root, 'pageFormat').disabled).toBe(false);
  });

  it('本文が届いていない間は選べない', () => {
    const { root, inspector } = mount();
    inspector.render(boot([meta('n1')], 'n1', null));
    expect(select(root, 'pageFont').disabled).toBe(true);
    expect(reset(root).disabled).toBe(true);
  });

  it('🔴 編集中のそのノートは選べる(PR-04。下書きの前書きを書き換える)', () => {
    const { root, inspector } = mount();
    let s = boot([meta('n1')], 'n1', '---\npage_font: mono\n---\n本文');
    s = { ...s, phase: 'editing' };
    inspector.render(s);
    expect(select(root, 'pageFont').disabled).toBe(false);
    expect(select(root, 'pageFont').value).toBe('mono');
    expect(reset(root).disabled).toBe(false);
  });

  it('🔴 書けない状態(読み込みに失敗した後など、編集中以外の断り)では選べない(断りの字を添える)', () => {
    const { root, inspector } = mount();
    let s = boot([meta('n1')], 'n1', '---\npage_font: mono\n---\n本文');
    s = { ...s, phase: 'error' };
    inspector.render(s);
    expect(select(root, 'pageFont').disabled).toBe(true);
    expect(reset(root).disabled).toBe(true);
    expect(select(root, 'pageFont').title.split('\n').length, '断りの字が無い').toBe(2);
  });

  it('🔴 フォルダ・system 領域では行ごと畳む', () => {
    const { root, inspector } = mount();
    inspector.render(boot([meta('f1', { archetype: 'folder' })], 'f1', ''));
    expect(dd(root).hidden).toBe(true);
    const { root: r2, inspector: i2 } = mount();
    i2.render(boot([meta('sys-messages')], 'sys-messages', '本文'));
    expect(dd(r2).hidden).toBe(true);
    const { root: r3, inspector: i3 } = mount();
    i3.render(boot([meta('n1')], 'n1', '本文'));
    expect(dd(r3).hidden).toBe(false);
  });
});

describe('SET_NOTE_LAYOUT', () => {
  type Rewrite = { kind: string; keys: Record<string, unknown> };
  const rewriteOf = (r: ReturnType<typeof reduce>): Rewrite | undefined =>
    (r.events.find((e) => e.type === 'REQUEST_BODY_REWRITE') as unknown as { rewrite: Rewrite } | undefined)?.rewrite;

  it('🔴 既存の前書き書換 1 本の event を出す。null はキーを消す(undefined)', () => {
    const s = boot([meta('n1')], 'n1', '本文');
    expect(rewriteOf(reduce(s, { type: 'SET_NOTE_LAYOUT', lid: 'n1', patch: { pageFormat: 'a4-landscape', pageColumns: '2' } }))).toEqual({
      kind: 'frontmatter',
      keys: { page_format: 'a4-landscape', page_columns: 2 },
    });
    const off = rewriteOf(reduce(s, { type: 'SET_NOTE_LAYOUT', lid: 'n1', patch: { pageFont: null } }))!;
    expect('page_font' in off.keys && off.keys['page_font'] === undefined).toBe(true);
  });

  it('本文に当てると前書きに入り、全部戻すと元の本文へ戻る(往復で 1 バイトも変わらない)', () => {
    const body = '本文\n';
    const s = boot([meta('n1')], 'n1', body);
    const on = rewriteOf(reduce(s, { type: 'SET_NOTE_LAYOUT', lid: 'n1', patch: { pageMargin: 'wide', pageFont: 'mincho' } }))!;
    const written = applyBodyRewrite(body, on as never)!;
    expect(readNoteLayout(written)).toEqual({ pageFormat: null, pageMargin: 'wide', pageColumns: null, pageFont: 'mincho' });
    const clear = rewriteOf(
      reduce(s, { type: 'SET_NOTE_LAYOUT', lid: 'n1', patch: { pageFormat: null, pageMargin: null, pageColumns: null, pageFont: null } }),
    )!;
    expect(applyBodyRewrite(written, clear as never)).toBe(body);
  });

  it('🔴 編集中のそのノートは、保存せずに下書きの前書きだけを書き換える(PR-04)', () => {
    const s = boot([meta('n1')], 'n1', '本文\n');
    const editing = { ...s, phase: 'editing', editingLid: 'n1' } as AppState;
    const r = reduce(editing, { type: 'SET_NOTE_LAYOUT', lid: 'n1', patch: { pageFont: 'mono', pageMargin: 'wide' } });
    expect(r.events, '編集中に保存の event を出した').toEqual([]);
    expect(r.state.error ?? null).toBeNull();
    expect(readNoteLayout(r.state.openBody!.body)).toEqual({ pageFormat: null, pageMargin: 'wide', pageColumns: null, pageFont: 'mono' });
    expect(r.state.openBody!.body.endsWith('本文\n'), '本文が変わった').toBe(true);
    // 戻すと下書きは元の 1 バイトまで戻る(片道にしない)
    const back = reduce(r.state, {
      type: 'SET_NOTE_LAYOUT',
      lid: 'n1',
      patch: { pageFormat: null, pageMargin: null, pageColumns: null, pageFont: null },
    });
    expect(back.state.openBody!.body).toBe('本文\n');
    // 変わらない指示では state を変えない
    expect(reduce(back.state, { type: 'SET_NOTE_LAYOUT', lid: 'n1', patch: { pageFont: null } }).state).toBe(back.state);
  });

  it('🔴 書けない状態は声に出して断る / フォルダ・system 領域・知らない lid・空の指示は何もしない', () => {
    const s = boot([meta('n1'), meta('f1', { archetype: 'folder' }), meta('sys-jobs')], 'n1', '本文');
    const failed = reduce({ ...s, phase: 'error' } as AppState, {
      type: 'SET_NOTE_LAYOUT',
      lid: 'n1',
      patch: { pageFont: 'mono' },
    });
    expect(failed.events).toEqual([]);
    expect(failed.state.error, '黙って捨てている').toMatch(/ページ設定を変えてください/);
    expect(reduce(s, { type: 'SET_NOTE_LAYOUT', lid: 'f1', patch: { pageFont: 'mono' } }).events).toEqual([]);
    expect(reduce(s, { type: 'SET_NOTE_LAYOUT', lid: 'sys-jobs', patch: { pageFont: 'mono' } }).events).toEqual([]);
    expect(reduce(s, { type: 'SET_NOTE_LAYOUT', lid: 'zz', patch: { pageFont: 'mono' } }).events).toEqual([]);
    expect(reduce(s, { type: 'SET_NOTE_LAYOUT', lid: 'n1', patch: {} }).events).toEqual([]);
  });
});
