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
    adoptUrls: async (urls) => {
      asked.push(urls);
      return { adopted: new Map(urls.map((u, i) => [u, `asset:k${i + 1}`])), failures: [] };
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
      adoptUrls: async (urls) => ({
        adopted: new Map(),
        // 🔴 **理由を返す**(#264 段②)── 直す前は `r.failed` を数えて
        //    「読み込めませんでした」と綴っていたので、**読めていたのに画像で
        //    なかった**ものまで同じ字になっていた
        failures: urls.map((url) => ({
          url,
          why: '読み込めませんでした(置き場所が許可していないか、届きませんでした)',
          fixable: false,
        })),
      }),
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
      adoptUrls: async (urls) => ({
        adopted: new Map(),
        failures: urls.map((url) => ({
          url,
          why: '添付を保存する空き容量が不足しています: 貼付画像-x.png',
          fixable: true,
        })),
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
    const { ta } = setup({ adoptUrls: undefined });
    const e = pasteEvent({ 'text/html': '<h2>題</h2>', 'text/plain': '題' });
    ta.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(ta.value).toBe('## 題');
  });

  it('⚠ 資産にする口が無ければ `data:` の平文は**既定のまま**(勝手に止めない)', () => {
    const { ta } = setup({ adoptUrls: undefined });
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

/**
 * 🔴 **リッチテキスト(RTF)の貼付**(user 指示 2026-08-25)。
 *
 * ⚠ ここが見るのは**順番**である ── 変換そのものは
 * `tests/features/rtf-to-markdown.test.ts`。
 * 🔑 順番を外すと user から見える壊れ方は「Word から貼ると**見出しが消える**」
 *   (RTF が HTML を押しのけた)なので、そこを名指しで pin する。
 */
describe('リッチテキスト(RTF)の貼付', () => {
  const RTF =
    String.raw`{\rtf1\ansi\deff0{\fonttbl{\f0 Calibri;}}` +
    String.raw`{\stylesheet{\s1 heading 1;}}` +
    String.raw`\pard\s1 RTF の見出し\par\pard \b 太字\b0 です\par}`;

  it('🔴 `text/html` が無ければ RTF を使う(いままで平文に潰れていた)', () => {
    const { ta } = setup();
    const e = pasteEvent({ 'text/rtf': RTF, 'text/plain': 'RTF の見出し\n太字です' });
    ta.dispatchEvent(e);
    expect(e.defaultPrevented, '既定の貼付を止めていない').toBe(true);
    expect(ta.value).toBe('# RTF の見出し\n\n**太字**です');
  });

  it('🔴 `text/html` が在るときは HTML が勝つ(RTF に押しのけさせない)', () => {
    // ⚠ Word / Excel / Google ドキュメントは**両方**を載せる ── HTML のほうが忠実
    const { ta } = setup();
    ta.dispatchEvent(
      pasteEvent({
        'text/html': '<h2>HTML の見出し</h2>',
        'text/rtf': RTF,
        'text/plain': 'HTML の見出し',
      }),
    );
    expect(ta.value, 'RTF が HTML を押しのけている').toBe('## HTML の見出し');
  });

  it('⚠ HTML が「変換して得るものが無い」ときは RTF に回る', () => {
    const { ta } = setup();
    ta.dispatchEvent(
      pasteEvent({
        // 構造も飾りもリンクも無い HTML ── `convertPastedHtml` は `null` を返す
        'text/html': '<p>ただの段落</p>',
        'text/rtf': RTF,
        'text/plain': 'ただの段落',
      }),
    );
    expect(ta.value).toBe('# RTF の見出し\n\n**太字**です');
  });

  it('🔴 本文の欄でなければ触らない(題名や検索欄に markdown を組み立てない)', () => {
    const { outside } = setup();
    const e = pasteEvent({ 'text/rtf': RTF, 'text/plain': 'RTF の見出し' });
    outside.dispatchEvent(e);
    expect(e.defaultPrevented, '本文の欄でないのに既定を止めている').toBe(false);
  });

  it('⚠ 変換して得るものが無い RTF なら既定に委ねる', () => {
    const { ta } = setup();
    const plainRtf = String.raw`{\rtf1\ansi\deff0 ただの一行です\par}`;
    const e = pasteEvent({ 'text/rtf': plainRtf, 'text/plain': 'ただの一行です' });
    ta.dispatchEvent(e);
    expect(e.defaultPrevented, '得るものが無いのに既定を止めている').toBe(false);
    expect(ta.value).toBe('');
  });

  it('🔴 RTF の中の画像も、資産へ逃がす経路に乗る', async () => {
    const { ta, asked } = setup();
    const PNG_HEX =
      '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
      '1f15c4890000000a49444154789c630001000005000' +
      '10d0a2db40000000049454e44ae426082';
    const withPict =
      String.raw`{\rtf1\ansi\deff0 {\pict\pngblip\picw16\pich16 ` + PNG_HEX + '}' + String.raw`\par}`;
    ta.dispatchEvent(pasteEvent({ 'text/rtf': withPict, 'text/plain': '' }));
    await Promise.resolve();
    await Promise.resolve();
    // 🔑 `data:` を資産へ逃がすのは呼び側の仕事 ── そこへ届いていることを見る
    expect(asked.flat().some((u) => u.startsWith('data:image/png'))).toBe(true);
  });
});

/**
 * 🔴 **切替の配線**(user 指示 2026-08-25)── 設定とフラグが**対**で効く。
 *
 * ⚠ 判定そのものは `tests/features/paste-source.test.ts`。
 * ここが見るのは「**設定が本当に届いているか**」「**フラグが本当に出すか**」である。
 */
describe('貼付の切替(設定)と診断(フラグ)', () => {
  const HTML = '<h2>HTML の見出し</h2>';
  const RTF =
    String.raw`{\rtf1\ansi\deff0{\stylesheet{\s1 heading 1;}}` +
    String.raw`\pard\s1 RTF の見出し\par}`;
  const both = { 'text/html': HTML, 'text/rtf': RTF, 'text/plain': '見出し' };

  it('既定(自動)ではウェブページの形が勝つ', () => {
    const { ta } = setup();
    ta.dispatchEvent(pasteEvent(both));
    expect(ta.value).toBe('## HTML の見出し');
  });

  it('🔴 「リッチテキストを優先」にすると、そちらが勝つ', () => {
    const { ta } = setup({ pasteSource: () => 'rtf' });
    ta.dispatchEvent(pasteEvent(both));
    expect(ta.value, '設定が届いていない').toBe('# RTF の見出し');
  });

  it('🔴 「ウェブページの形だけ」にすると、リッチテキストは読まない', () => {
    const { ta } = setup({ pasteSource: () => 'html' });
    const e = pasteEvent({ 'text/rtf': RTF, 'text/plain': '見出し' });
    ta.dispatchEvent(e);
    expect(e.defaultPrevented, 'リッチテキストを読んでいる').toBe(false);
    expect(ta.value).toBe('');
  });

  it('🔴 「変換しない」にすると、何も横取りしない', () => {
    const { ta } = setup({ pasteSource: () => 'plain' });
    const e = pasteEvent(both);
    ta.dispatchEvent(e);
    expect(e.defaultPrevented, '「変換しない」なのに既定を止めている').toBe(false);
    expect(ta.value).toBe('');
  });

  it('⚠ 設定を渡さなければ、いままでどおり(自動)', () => {
    const { ta } = setup();
    ta.dispatchEvent(pasteEvent({ 'text/rtf': RTF, 'text/plain': '見出し' }));
    expect(ta.value).toBe('# RTF の見出し');
  });

  it('🔴 フラグが切なら、診断を出さない(ふだんは黙っている)', () => {
    const { ta, dispatcher } = setup();
    const seen: string[] = [];
    dispatcher.onState((st) => {
      if (st.notice) seen.push(st.notice);
    });
    ta.dispatchEvent(pasteEvent(both));
    expect(seen).toEqual([]);
  });

  it('🔴 フラグが入なら、何が届いてどれを使ったかを出す', () => {
    const { ta, dispatcher } = setup({ pasteInspect: () => true });
    const seen: string[] = [];
    dispatcher.onState((st) => {
      if (st.notice && !seen.includes(st.notice)) seen.push(st.notice);
    });
    ta.dispatchEvent(pasteEvent(both));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('ウェブページの形を使いました');
    // 🔴 **中身は出さない**(貼った文字が画面とお知らせの履歴に残らない)
    expect(seen[0], '貼った中身が出ている').not.toContain('見出し');
  });

  it('🔴 横取りしなかった回こそ出す(「何も起きない」の理由が要る)', () => {
    const { ta, dispatcher } = setup({ pasteSource: () => 'plain', pasteInspect: () => true });
    const seen: string[] = [];
    dispatcher.onState((st) => {
      if (st.notice && !seen.includes(st.notice)) seen.push(st.notice);
    });
    const e = pasteEvent(both);
    ta.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(seen, '止めたときに何も言っていない').toHaveLength(1);
    expect(seen[0]).toContain('変換しない');
  });

  /**
   * 🔴 **実物どうしが繋がっているか**(#708 段③、着地前レビュー 🔴2)。
   *
   * ⚠ `tests/features/paste-plain-table.test.ts` の順番の検査は**偽の変換器**を
   *   渡しているので、`binder.ts` の配線を `() => null` に変えても 1 件も落ちない
   *   (変異試験 M1 が SURVIVED で教えた)── CLAUDE.md §7
   *   「**A と B が合意していることは、A の test にも B の test にも書けない**」。
   * 🔑 だから**合意を見る場所をここに 1 つ作る** ── 実物の `choosePaste` +
   *   実物の `tsvFenceFromPlain` を通し、**欄に入った字**まで見る。
   */
  it('🔴 タブ区切りの平文は、実物の配線を通って表の囲みで差さる', () => {
    const { ta } = setup();
    const e = pasteEvent({ 'text/plain': '品名\t数\nりんご\t3' });
    ta.dispatchEvent(e);
    expect(e.defaultPrevented, '横取りしていない').toBe(true);
    expect(ta.value, '囲みになっていない').toBe('```tsv\n品名\t数\nりんご\t3\n```');
  });

  /**
   * 🔴 **囲みは行頭から差す**(着地前レビュー ⚠8)。
   *
   * ⚠ 柵は行頭に無いと柵として読まれない ── `メモ: ` の続きに貼ると、画面には
   *   `メモ: ```tsv` という 1 つの段落が出て、**閉じの柵が新しい囲みを開く**。
   * ⚠ この形は `html-fence` の設定にも前から在ったが、平文の貼付は**行の途中で
   *   起きやすい**ので、この段で当たる頻度が上がる。
   */
  it('🔴 行の途中に貼っても、囲みが柵として読まれる', () => {
    const { ta } = setup();
    ta.value = 'メモ: ';
    ta.selectionStart = ta.value.length;
    ta.selectionEnd = ta.value.length;
    ta.dispatchEvent(pasteEvent({ 'text/plain': '品名\t数\nりんご\t3' }));
    expect(ta.value, '柵が行の途中に露出している').toBe(
      'メモ: \n```tsv\n品名\t数\nりんご\t3\n```',
    );
  });

  it('⚠ 行頭に貼るときは、余計な改行を足さない', () => {
    const { ta } = setup();
    ta.dispatchEvent(pasteEvent({ 'text/plain': '品名\t数\nりんご\t3' }));
    expect(ta.value.startsWith('```tsv'), '行頭なのに改行を足した').toBe(true);
  });

  /**
   * ⚠ **対照群を同じ場面に置く** ── 置かないと「別の理由で差さった」を次に
   *   見抜けない。タブの無い平文は**いままでどおり素通り**する。
   */
  it('⚠ タブの無い平文は横取りしない(素の貼付に任せる)', () => {
    const { ta } = setup();
    const e = pasteEvent({ 'text/plain': 'ふつうの文\nもう 1 行' });
    ta.dispatchEvent(e);
    expect(e.defaultPrevented, 'ふつうの文を横取りした').toBe(false);
    expect(ta.value, '欄に勝手に字を入れた').toBe('');
  });
});
