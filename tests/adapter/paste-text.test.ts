/** @vitest-environment happy-dom */
/**
 * 🔴 **文字の貼付**(#251)。binder の配線だけをここで見る
 * (変換そのものは `tests/features/html-to-markdown.test.ts` /
 *  `tests/features/inline-url-adopt.test.ts`)。
 *
 * ⚠ ここが守るのは「**既定の貼付を殺していないか**」である ── 横取りの判断を
 * 間違えると、変換の要らない普通の貼付まで**こちらの都合で書き換わる**。
 */
import { describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';

const DATA = 'data:image/png;base64,AAAA';

function pasteEvent(data: Readonly<Record<string, string>>): Event & { defaultPrevented: boolean } {
  const e = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', {
    value: {
      items: [],
      getData: (type: string) => data[type] ?? '',
    },
  });
  return e as Event & { defaultPrevented: boolean };
}

function setup(over: Partial<BinderServices> = {}) {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.innerHTML =
    '<div data-pkc-region="detail"><textarea data-pkc-field="row-source"></textarea></div>' +
    '<div data-pkc-region="append"><textarea data-pkc-field="append-input"></textarea></div>' +
    '<div data-pkc-region="entry-list"><input data-pkc-field="find" /></div>';
  document.body.append(root);
  const asked: (readonly string[])[] = [];
  const services: BinderServices = {
    adoptPastedUrls: async (urls) => {
      asked.push(urls);
      return new Map(urls.map((u, i) => [u, `asset:k${i + 1}`]));
    },
    ...over,
  };
  const dispatcher = new Dispatcher();
  bindActions(root, dispatcher, services);
  const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
  const append = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="append-input"]')!;
  const outside = root.querySelector('input')!;
  // ⚠ `OP_FAILED` は **event を出さない**(`state.error` を書くだけ)── 観測点は state
  const errors: string[] = [];
  dispatcher.onState((st) => {
    const e = st.error;
    if (e !== null && e !== undefined && e !== errors[errors.length - 1]) errors.push(e);
  });
  return { root, ta, append, outside, asked, dispatcher, errors };
}

describe('HTML の貼付を markdown へ戻す', () => {
  it('🔴 本文の欄なら変換して差し込む(既定は止める)', () => {
    const { ta } = setup();
    const e = pasteEvent({ 'text/html': '<h2>題</h2><p>本文</p>', 'text/plain': '題 本文' });
    ta.dispatchEvent(e);
    expect(e.defaultPrevented, '既定の貼付を止めていない').toBe(true);
    expect(ta.value).toBe('## 題\n\n本文');
  });

  it('継ぎ足しの欄でも効く(本文の欄はここも含む)', () => {
    const { append } = setup();
    append.dispatchEvent(pasteEvent({ 'text/html': '<h2>題</h2>', 'text/plain': '題' }));
    expect(append.value).toBe('## 題');
  });

  it('🔴 本文でない欄(検索・題名)では**何もしない**', () => {
    const { outside } = setup();
    const e = pasteEvent({ 'text/html': '<h2>題</h2>', 'text/plain': '題' });
    outside.dispatchEvent(e);
    expect(e.defaultPrevented, '検索欄で markdown を組み立てている').toBe(false);
  });

  it('🔴 変換するものが無ければ**既定に任せる**(普通の貼付を横取りしない)', () => {
    const { ta } = setup();
    const e = pasteEvent({ 'text/plain': 'ただの文' });
    ta.dispatchEvent(e);
    expect(e.defaultPrevented, '普通の貼付を横取りした').toBe(false);
    expect(ta.value).toBe('');
  });

  it('🔴 text/plain が markdown 原文なら横取りしない(AI の「コピー」)', () => {
    const { ta } = setup();
    const e = pasteEvent({
      'text/html': '<h2>題</h2><ul><li>あ</li></ul>',
      'text/plain': '## 題\n\n- あ',
    });
    ta.dispatchEvent(e);
    expect(e.defaultPrevented, '原文を捨てて HTML から作り直した').toBe(false);
  });

  it('差し込みは **state にも届く**(画面だけ変わって保存されない、を作らない)', () => {
    const { root, dispatcher } = setup();
    const host = root.querySelector('[data-pkc-region="detail"]')!;
    const ta = document.createElement('textarea');
    ta.setAttribute('data-pkc-field', 'editor-body');
    host.append(ta);
    dispatcher.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    dispatcher.dispatch({ type: 'CREATE_ENTRY', lid: 'e1', archetype: 'text', title: 'n' });
    dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    dispatcher.dispatch({ type: 'BODY_LOADED', lid: 'e1', body: '' });
    dispatcher.dispatch({ type: 'START_EDIT' });
    ta.dispatchEvent(pasteEvent({ 'text/html': '<h2>題</h2>', 'text/plain': '題' }));
    expect(dispatcher.getState().openBody?.body ?? '', 'state に届いていない').toContain('## 題');
  });
});

describe('`data:` / `blob:` を資産へ逃がす', () => {
  it('🔴 平文に混じった `data:` でも資産へ逃がす(HTML が無くても効く)', async () => {
    const { ta, asked } = setup();
    const e = pasteEvent({ 'text/plain': `![ず](${DATA})` });
    ta.dispatchEvent(e);
    expect(e.defaultPrevented, '逃がすために止めていない').toBe(true);
    await vi.waitFor(() => expect(ta.value).toBe('![ず](asset:k1)'));
    expect(asked[0]).toEqual([DATA]);
  });

  it('HTML から起こした `data:` も同じ経路で逃がす', async () => {
    const { ta } = setup();
    ta.dispatchEvent(
      pasteEvent({ 'text/html': `<h2>題</h2><img src="${DATA}" alt="ず">`, 'text/plain': '題' }),
    );
    await vi.waitFor(() => expect(ta.value).toContain('![ず](asset:k1)'));
    expect(ta.value, '見出しまで落ちている').toContain('## 題');
    expect(ta.value, '本文に base64 が残っている').not.toContain('base64');
  });

  it('🔴 読めなかった分は**元のまま残し**、件数を言う(黙って消さない)', async () => {
    const { ta, errors } = setup({ adoptPastedUrls: async () => new Map() });
    ta.dispatchEvent(pasteEvent({ 'text/plain': `![ず](${DATA})` }));
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(ta.value, '読めないのに参照を消した').toBe(`![ず](${DATA})`);
    expect(errors[0]).toContain('1 件');
  });

  it('🔴 待っている間に**別のノートを開いたら差し込まない**(断りは出す)', async () => {
    const { root, ta, dispatcher, errors } = setup();
    dispatcher.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    dispatcher.dispatch({ type: 'CREATE_ENTRY', lid: 'e1', archetype: 'text', title: 'a' });
    dispatcher.dispatch({ type: 'CREATE_ENTRY', lid: 'e2', archetype: 'text', title: 'b' });
    dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    dispatcher.dispatch({ type: 'BODY_LOADED', lid: 'e1', body: '' });
    dispatcher.dispatch({ type: 'START_EDIT' });
    ta.dispatchEvent(pasteEvent({ 'text/plain': `![ず](${DATA})` }));
    // ⚠ 待っている間に別のノートへ移る ── 取り消したはずの貼付が**別のノートに現れる**
    dispatcher.dispatch({ type: 'CANCEL_EDIT' });
    dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: 'e2' });
    dispatcher.dispatch({ type: 'BODY_LOADED', lid: 'e2', body: '' });
    dispatcher.dispatch({ type: 'START_EDIT' });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(ta.value, '別のノートを開いたのに差し込んだ').toBe('');
    expect(errors[0]).toContain('もう一度');
    expect(root.isConnected).toBe(true);
  });

  it('待っている間に欄が作り直されても、**いま在る欄**へ差す', async () => {
    const { root, ta } = setup();
    ta.dispatchEvent(pasteEvent({ 'text/plain': `![ず](${DATA})` }));
    const host = root.querySelector('[data-pkc-region="detail"]')!;
    ta.remove();
    const fresh = document.createElement('textarea');
    fresh.setAttribute('data-pkc-field', 'row-source');
    host.append(fresh);
    await vi.waitFor(() => expect(fresh.value).toContain('asset:k1'));
    expect(ta.value, '外れた欄のほうへ書いている').toBe('');
  });

  it('⚠ 資産にする口が無い環境でも貼付は成立する(変換だけ効く)', () => {
    const { ta } = setup({ adoptPastedUrls: undefined });
    const e = pasteEvent({ 'text/html': '<h2>題</h2>', 'text/plain': '題' });
    ta.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(ta.value).toBe('## 題');
  });

  it('⚠ 資産にする口が無ければ `data:` の平文は**既定のまま**(勝手に止めない)', () => {
    const { ta } = setup({ adoptPastedUrls: undefined });
    const e = pasteEvent({ 'text/plain': `![ず](${DATA})` });
    ta.dispatchEvent(e);
    expect(e.defaultPrevented, '逃がせないのに既定を止めた').toBe(false);
  });
});
