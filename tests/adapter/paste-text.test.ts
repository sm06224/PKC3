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
      return { adopted: new Map(urls.map((u, i) => [u, `asset:k${i + 1}`])), problems: [] };
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

  it('🔴 画像を貼ったときは、文字の変換まで走らせない(同じ絵が 2 回入る)', () => {
    // ⚠ Chrome はウェブページの画像 1 枚のコピーに **file と text/html の両方**を載せる。
    //   画像を処理したあとに文字も処理すると、資産の参照 1 本 + 外部 URL 1 本の
    //   **同じ絵が 2 回**入る
    const pasted: (readonly File[])[] = [];
    const { ta } = setup({
      pasteImages: async (files) => {
        pasted.push(files);
        return ['![ず](asset:k1)'];
      },
    });
    const e = new Event('paste', { bubbles: true, cancelable: true });
    const file = new File([new Uint8Array([1])], 'x.png', { type: 'image/png' });
    Object.defineProperty(e, 'clipboardData', {
      value: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
        getData: (t: string) =>
          t === 'text/html' ? '<img src="https://e.com/a.png" alt="ず">' : '',
      },
    });
    ta.dispatchEvent(e);
    expect(pasted, '画像が資産へ回っていない(この test は空振り)').toHaveLength(1);
    // 🔴 文字側は走っていない ── 走ると外部 URL の参照が**その場で**入る
    expect(ta.value, '画像と文字の両方が入った(同じ絵が 2 回)').toBe('');
  });

  it('🔴 本文の欄でない `<textarea>` では変換しない(名前で見分ける)', () => {
    // ⚠ 観測点を `<input>` にすると `instanceof HTMLTextAreaElement` だけで満たされ、
    //   **名前の allow-list を 1 度も検めない**(代替物で満たせるガード)
    const { root } = setup();
    const other = document.createElement('textarea');
    other.setAttribute('data-pkc-field', 'query-key');
    root.append(other);
    const e = pasteEvent({ 'text/html': '<h2>題</h2>', 'text/plain': '題' });
    other.dispatchEvent(e);
    expect(e.defaultPrevented, '本文でない欄で markdown を組み立てた').toBe(false);
    expect(other.value).toBe('');
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
    const { ta, errors } = setup({
      adoptPastedUrls: async () => ({ adopted: new Map(), problems: [] }),
    });
    ta.dispatchEvent(pasteEvent({ 'text/plain': `![ず](${DATA})` }));
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(ta.value, '読めないのに参照を消した').toBe(`![ず](${DATA})`);
    expect(errors[0]).toContain('1 件');
  });

  it('🔴 置けなかった理由は、件数の総括に**上書きされない**(`state.error` は 1 枠)', async () => {
    // ⚠ 直す前は資産化の側で `OP_FAILED` を撃っていたので、直後に出る
    //   「N 件を読み込めませんでした」に**上書きされて消えて**いた ── user は
    //   直せる原因(空き容量)を知らないまま、同じ操作を繰り返す
    const { ta, errors } = setup({
      adoptPastedUrls: async () => ({
        adopted: new Map(),
        problems: ['添付を保存する空き容量が不足しています: 貼付画像-x.png'],
      }),
    });
    ta.dispatchEvent(pasteEvent({ 'text/plain': `![ず](${DATA})` }));
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
    // 🔴 **最後に残っている文言**を見る(途中で出ても上書きされたら意味が無い)
    expect(errors[errors.length - 1], '理由が総括に上書きされた').toContain('空き容量');
    expect(ta.value, '読めないのに参照を消した').toBe(`![ず](${DATA})`);
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

/**
 * 🔴 **素で貼ったパーマリンクを内部リンクにする**(#251)。
 *
 * ⚠ ここが見るのは**配線**である ── 判定そのものは
 * `tests/features/paste-permalink.test.ts` が決定的に見ている。
 */
describe('パーマリンクの貼付', () => {
  /** ノートを 1 件持つ器を立てて、`ta` へ貼る。 */
  function withNote(over: Partial<BinderServices> = {}) {
    const s = setup(over);
    s.dispatcher.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    s.dispatcher.dispatch({
      type: 'CREATE_ENTRY',
      lid: 'n1',
      archetype: 'text',
      title: '会議のメモ',
    });
    return s;
  }

  it('🔴 素の `pkc://…/entry/<lid>` が題名つきの内部リンクになる', () => {
    const { ta } = withNote();
    const e = pasteEvent({ 'text/plain': 'pkc://c1/entry/n1' });
    ta.dispatchEvent(e);
    expect(e.defaultPrevented, '既定を止めていない').toBe(true);
    expect(ta.value).toBe('[会議のメモ](entry:n1)');
  });

  /**
   * 🔴 **HTML の変換より先に見る。**
   * ⚠ パーマリンクをコピーすると `text/html` に `<a href="pkc://…">` が入ることが
   *   あり、そちらが先に当たると**外部リンクの形**で差さる(押しても面が動かない)。
   */
  it('🔴 HTML にも同じリンクが載っているとき、内部リンクの側が勝つ', () => {
    const { ta } = withNote();
    ta.dispatchEvent(
      pasteEvent({
        'text/html': '<a href="pkc://c1/entry/n1">会議のメモ</a>',
        'text/plain': 'pkc://c1/entry/n1',
      }),
    );
    expect(ta.value, '外部リンクの形で差さっている').toBe('[会議のメモ](entry:n1)');
    expect(ta.value).not.toContain('pkc://');
  });

  it('🔴 知らないノート宛は横取りしない(既定の貼付に任せる)', () => {
    const { ta } = withNote();
    const e = pasteEvent({ 'text/plain': 'pkc://c1/entry/zzz' });
    ta.dispatchEvent(e);
    // ⚠ 既定を止めていない = ブラウザがそのまま貼る(happy-dom では値は変わらない)
    expect(e.defaultPrevented, '横取りしている').toBe(false);
  });

  it('🔴 本文の欄でなければ何もしない(探す欄に貼っても書き換えない)', () => {
    const { outside } = withNote();
    const e = pasteEvent({ 'text/plain': 'pkc://c1/entry/n1' });
    outside.dispatchEvent(e);
    expect(e.defaultPrevented, '本文以外で横取りしている').toBe(false);
  });
});
