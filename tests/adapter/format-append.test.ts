/** @vitest-environment happy-dom */
/**
 * P8 段⑥ の end-to-end: **書式パネル**と**追記**。
 *
 * > user 指摘 2026-08-03「**書式設定系のパネルも必要 / 何もかも足りない /
 * > ログの追記機構とテキストエントリの追記機構も無い**」
 *
 * 🔴 規則そのもの(`applyFormat` / `appendAt`)は `tests/features/text-ops.test.ts`
 * が見ている。**ここが見るのは繋がり**である ── 押した所から textarea を見つけ、
 * 書き戻し、state と画面(プレビュー)が追いつくか。
 *
 * ⚠ 観測点を textarea の `value` だけにしない ── それだと「書き戻したが state に
 * 届いていない」実装が緑で通り、**保存すると書式が消える**。
 */
import { describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { FORMAT_OPS } from '../../src/features/markdown/text-ops';
import { stubRevisionOps } from '../helpers/revision-stub';

function meta(lid: string, archetype = 'text'): EntryMeta {
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
  };
}

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function setup(metas: EntryMeta[], bodies: Record<string, string>) {
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
    persistEntry: async (e) => {
      persisted.push(e);
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s);
  return { root, d, persisted, q };
}

/** 選択して書式ボタンを押す(実 UI と同じ順序 ── 選択は押す前に決まっている)。 */
function press(
  q: <T extends HTMLElement>(s: string) => T | null,
  op: string,
  range?: [number, number],
): HTMLTextAreaElement {
  const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
  if (range) ta.setSelectionRange(range[0], range[1]);
  q(`[data-pkc-format="${op}"]`)!.click();
  return ta;
}

describe('書式パネル(P8 段⑥)', () => {
  it('🔴 押すと本文・state・プレビューが**そろって**変わる', async () => {
    const { d, q } = setup([meta('a')], { a: '強調したい' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();

    const ta = press(q, 'bold', [0, 2]);
    // ① 本文
    expect(ta.value).toBe('**強調**したい');
    // ② 🔴 state ── ここが繋がっていないと**保存した瞬間に書式が消える**
    expect(d.getState().openBody?.body).toBe('**強調**したい');
    // ③ 選択は中身のまま(続けて斜体を押せる)
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([2, 4]);
    // ④ プレビュー(rAF 1 枚ぶん待つ)
    await tick(30);
    expect(q('[data-pkc-region="editor-preview"]')!.querySelector('strong')?.textContent).toBe(
      '強調',
    );
  });

  it('🔴 パネルのボタンは**表と 1 対 1**(押しても何も起きないボタンが無い)', async () => {
    const { d, q, root } = setup([meta('a')], { a: 'あいう' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    const buttons = [...root.querySelectorAll('[data-pkc-action="format-text"]')];
    expect(buttons.map((b) => b.getAttribute('data-pkc-format'))).toEqual(
      FORMAT_OPS.map((o) => o.op),
    );
    expect(buttons.map((b) => b.querySelector('[data-pkc-field="label"]')?.textContent)).toEqual(
      FORMAT_OPS.map((o) => o.label),
    );
  });

  it('🔴 押しても編集欄から focus を奪わない', async () => {
    const { d, q } = setup([meta('a')], { a: 'あ' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    const ev = new Event('mousedown', { bubbles: true, cancelable: true });
    q('[data-pkc-format="bold"]')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('近道キー(Ctrl+B)がボタンと同じ結果になる', async () => {
    const { d, q } = setup([meta('a')], { a: '強調' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.setSelectionRange(0, 2);
    ta.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(ta.value).toBe('**強調**');
    expect(d.getState().openBody?.body).toBe('**強調**');
  });

  it('⚠ 変換中(IME)のキーは書式にしない', async () => {
    const { d, q } = setup([meta('a')], { a: '強調' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="start-edit"]')!.click();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.setSelectionRange(0, 2);
    ta.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'b',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }),
    );
    expect(ta.value).toBe('強調');
  });

  it('閲覧中は書式パネルを出さない(押す先が無い)', async () => {
    const { d, q } = setup([meta('a')], { a: 'あ' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    expect(q('[data-pkc-region="format-bar"]')).toBeNull();
  });
});

describe('追記(P8 段⑥)', () => {
  it('🔴 閲覧中に押しても効く(先に「編集」を押させない)', async () => {
    // ⚠ ここが本丸 ── `START_EDIT` は同期で detail を描き直すので、
    // **押したボタンはその時点で DOM から外れている**。押した所を起点に
    // textarea を探す実装は、ここで必ず落ちる
    const { d, q } = setup([meta('log', 'textlog')], { log: '前の記録' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'log' });
    await tick();
    expect(q('[data-pkc-action="start-edit"]')).not.toBeNull();

    q('[data-pkc-action="append-section"]')!.click();

    expect(d.getState().phase).toBe('editing');
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    const lines = ta.value.split('\n');
    expect(lines[0]).toBe('前の記録');
    // 🔴 日時の節(秒まで)── マニュアルが「`## <日時>` の節を末尾に足す」と
    // 書いている当のもの
    expect(lines[2]).toMatch(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // カーソルは末尾(そのまま打ち始められる)
    expect(ta.selectionStart).toBe(ta.value.length);
    expect(d.getState().openBody?.body).toBe(ta.value);
  });

  it('🔴 ノートは日時の見出しを足さない(構造は書く人のもの)', async () => {
    const { d, q } = setup([meta('a')], { a: '本文' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    q('[data-pkc-action="append-section"]')!.click();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    expect(ta.value).toBe('本文\n\n');
    expect(ta.value).not.toContain('##');
  });

  it('🔴 追記した本文が**保存まで届く**', async () => {
    const { d, q, persisted } = setup([meta('log', 'textlog')], { log: '前の記録' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'log' });
    await tick();
    q('[data-pkc-action="append-section"]')!.click();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    ta.value += '今日のできごと';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    q('[data-pkc-action="commit-edit"]')!.click();
    await tick();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.body).toContain('今日のできごと');
    expect(persisted[0]!.body).toMatch(/## \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n\n今日のできごと/);
  });

  it('編集中にもう一度押すと 2 件目の節が足される', async () => {
    const { d, q } = setup([meta('log', 'textlog')], { log: '' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'log' });
    await tick();
    q('[data-pkc-action="append-section"]')!.click();
    q('[data-pkc-action="append-section"]')!.click();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    expect(ta.value.match(/^## /gm)).toHaveLength(2);
  });

  it('🔴 追記できない種類には導線を出さない', async () => {
    // 添付の本文は「説明」であって記録の連なりではない ── 出すと押しても
    // 何も起きないボタンになる
    const { d, q } = setup([meta('f', 'attachment')], { f: '{}' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'f' });
    await tick();
    expect(q('[data-pkc-action="append-section"]')).toBeNull();
  });

  it('⚠ 本文がまだ読めていないときは何もしない(空で上書きしない)', async () => {
    const never = vi.fn(async () => new Promise<string | null>(() => null));
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const detail = new DetailRenderer(regions.detail);
    d.onState((s) => detail.render(s));
    bindActions(root, d);
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: never,
      deleteEntry: async () => {},
      persistEntry: async () => {},
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('log', 'textlog')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'log' });
    await tick();
    // 読み込み中は導線ごと出ない ── 出ていたら押して phase を確かめる
    const btn = root.querySelector<HTMLElement>('[data-pkc-action="append-section"]');
    btn?.click();
    expect(d.getState().phase).not.toBe('editing');
  });
});
