/** @vitest-environment happy-dom */
/**
 * P8 段⑥ の end-to-end: **書式パネル**。
 *
 * > user 指摘 2026-08-03「**書式設定系のパネルも必要 / 何もかも足りない /
 * > ログの追記機構とテキストエントリの追記機構も無い**」
 *
 * 🔴 規則そのもの(`applyFormat`)は `tests/features/text-ops.test.ts`
 * が見ている。**ここが見るのは繋がり**である ── 押した所から textarea を見つけ、
 * 書き戻し、state と画面(プレビュー)が追いつくか。
 *
 * ⚠ 観測点を textarea の `value` だけにしない ── それだと「書き戻したが state に
 * 届いていない」実装が緑で通り、**保存すると書式が消える**。
 */
import { stubStamps } from '../helpers/store-stamps';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    bodyChars: null,
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
  // ⚠ onBodyChange は main.ts と同じ配線(live の確定を state へ写す)
  const detail = new DetailRenderer(regions.detail, null, undefined, (body) =>
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body }),
  );
  d.onState((s) => detail.render(s));
  bindActions(root, d);
  const persisted: EntryUpsert[] = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => bodies[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    persistEntry: async (e) => {
      persisted.push(e);
      return stubStamps();
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
  // 2026-08-14(#104 第 2 弾): 既定は live ── この describe は split の面
  // (editor-body)で測るので、設定で split を明示する
  beforeEach(() => {
    localStorage.setItem('pkc3.editor-mode', 'split');
  });

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

/**
 * 🔴 **live の 1 面でも書式が効く**(2026-08-08)。直す前は書式パネルも
 * Ctrl+B/I/K も `editor-body` を探して**無言 no-op** だった(flag `editor.live`
 * の面には `row-source` しか無い)。
 */
describe('書式パネル ── live の 1 面(2026-08-08)', () => {
  const setLive = (on: boolean): void => {
    // 2026-08-14: flag は設定 `pkc3.editor-mode` へ昇格(#104 第 2 弾。既定 live)
  localStorage.setItem('pkc3.editor-mode', on ? 'live' : 'split');
  };
  afterEach(() => setLive(false));

  /** 編集に入り、段落の行を開いて row-source を返す。 */
  async function openRow(
    q: <T extends HTMLElement>(s: string) => T | null,
    root: HTMLElement,
    text: string,
  ): Promise<HTMLTextAreaElement> {
    q<HTMLElement>('[data-pkc-action="start-edit"]')!.click();
    await tick(30); // 描画は follower(microtask)── 1 拍待つ
    const live = root.querySelector('[data-pkc-region="editor-live"]')!;
    const p = [...live.querySelectorAll('p')].find((e) => e.textContent === text)!;
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    return root.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
  }

  it('🔴 書式パネルが活性の行(row-source)に効き、確定で state まで届く', async () => {
    setLive(true);
    const { d, q, root } = setup([meta('a')], { a: '強調したい' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    const ta = await openRow(q, root, '強調したい');
    ta.setSelectionRange(0, 2);
    q<HTMLElement>('[data-pkc-format="bold"]')!.click();
    expect(ta.value, '書式が行の入力欄に届いていない(無言 no-op)').toBe('**強調**したい');
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([2, 4]);
    // 確定すると本文(state)に入る ── ここが切れていると保存で書式が消える
    ta.blur();
    expect(d.getState().openBody?.body).toBe('**強調**したい');
  });

  it('🔴 Ctrl+B も row-source に効く(近道キーの無言 no-op を塞ぐ)', async () => {
    setLive(true);
    const { d, q, root } = setup([meta('a')], { a: '強調したい' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    const ta = await openRow(q, root, '強調したい');
    ta.setSelectionRange(0, 2);
    const ev = new KeyboardEvent('keydown', {
      key: 'b',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    ta.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(ta.value).toBe('**強調**したい');
  });

  it('🔴 row-source の Ctrl+S は行の確定で、編集の面は閉じない(COMMIT_EDIT に化けない)', async () => {
    setLive(true);
    const { d, q, root, persisted } = setup([meta('a')], { a: 'もとの文。' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await tick();
    const ta = await openRow(q, root, 'もとの文。');
    ta.value = '直した文。';
    const ev = new KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    ta.dispatchEvent(ev);
    expect(ev.defaultPrevented, 'ブラウザの保存ダイアログが開く').toBe(true);
    // 行は確定して state に入るが、**編集の面は続いている**
    expect(d.getState().openBody?.body).toBe('直した文。');
    expect(d.getState().phase).toBe('editing');
    expect(persisted, 'COMMIT_EDIT に化けて保存まで走った').toHaveLength(0);
  });
});
