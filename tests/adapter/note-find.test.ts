/** @vitest-environment happy-dom */
/**
 * 🔴 ノートの中だけを探す小さな欄(#1163 依頼 163 = 案 ③)。
 *
 * 観測点: 欄の出入り(DOM)・件数の字・塗り(Highlight API を差し込んだ表 / 無いときは `<mark>`)・
 * 焦点の戻り・`Ctrl+F` の行き先(ノートが在れば欄 / 無ければ左の探す欄 / ヘルプではブラウザ)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions, runGlobalCommand } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import {
  closeNoteFind,
  isNoteFindOpen,
  NOTE_FIND_CURRENT_HIGHLIGHT,
  NOTE_FIND_HIGHLIGHT,
  openNoteFind,
  resolveFindTarget,
} from '../../src/adapter/ui/render/note-find';
import { collectHitRanges } from '../../src/adapter/ui/render/search-jump';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { MarkdownClient } from '../../src/adapter/platform/render/markdown-client';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { findCommand, resolveUsableBindings } from '../../src/features/keymap';
import { readFileSync } from 'node:fs';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const BODY_HTML =
  '<p>りんごとミカン。リンゴが好き。</p><p>ﾊﾟﾝ と パン と <strong>pa</strong>n</p><p>りんご りんご</p>';

function mounted(withNote = true) {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  buildShell(root);
  const store = new KeymapStore(fakeStorage());
  const dispose = bindActions(root, d, {}, store);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  let body: HTMLElement | null = null;
  if (withNote) {
    // ⚠ 読む面の本文の器(`DetailRenderer` が組む物と同じ印)を直に置く ── 描画の中身は別の test が見る
    body = document.createElement('div');
    body.setAttribute('data-pkc-field', 'detail-body');
    body.className = 'pkc-md-rendered';
    body.innerHTML = BODY_HTML;
    root.querySelector('[data-pkc-region="detail"]')!.append(body);
  }
  return { root, d, store, body, dispose };
}

const press = (
  key: string,
  init: KeyboardEventInit & { code?: string } = {},
  target: EventTarget = document,
) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
const input = (root: HTMLElement) =>
  root.querySelector<HTMLInputElement>('[data-pkc-field="note-find-input"]');
const count = (root: HTMLElement) =>
  root.querySelector('[data-pkc-field="note-find-count"]')?.textContent;
const type = (root: HTMLElement, v: string) => {
  const i = input(root)!;
  i.value = v;
  i.dispatchEvent(new Event('input', { bubbles: true }));
};

const nodeCount = (el: Node): number => {
  const w = document.createTreeWalker(el, 1 | 4);
  let n = 0;
  while (w.nextNode()) n++;
  return n;
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('note-find: 対象の決め方', () => {
  it('読む面の本文 / 2 ペインのプレビュー / ライブエディタを、同じ関数で選ぶ(優先はライブ > プレビュー > 読む面)', () => {
    const { root, body } = mounted();
    expect(resolveFindTarget(root, null)).toBe(body);
    const preview = document.createElement('div');
    preview.setAttribute('data-pkc-region', 'editor-preview');
    root.querySelector('[data-pkc-region="detail"]')!.append(preview);
    expect(resolveFindTarget(root, null), 'プレビューが読む面に負けている').toBe(preview);
    const live = document.createElement('div');
    live.setAttribute('data-pkc-region', 'editor-live');
    root.querySelector('[data-pkc-region="detail"]')!.append(live);
    expect(resolveFindTarget(root, null), 'ライブが他に負けている').toBe(live);
  });

  it('ノートが無ければ null(対照群)', () => {
    const { root } = mounted(false);
    expect(resolveFindTarget(root, null)).toBeNull();
  });
});

describe('note-find: 開く・数える・送る・閉じる', () => {
  it('開くと小さな欄が中央ペインに出て、焦点が入る / 閉じると消えて元の焦点へ戻る', () => {
    const { root } = mounted();
    const before = document.createElement('button');
    root.append(before);
    before.focus();
    expect(openNoteFind(root)).toBe(true);
    expect(isNoteFindOpen(root)).toBe(true);
    const bar = root.querySelector('[data-pkc-region="note-find"]');
    expect(bar, '欄が出ていない').not.toBeNull();
    expect(bar!.closest('[data-pkc-region="center"]'), '置き場所が中央ペインでない').not.toBeNull();
    expect(document.activeElement).toBe(input(root));
    closeNoteFind(root, true);
    expect(root.querySelector('[data-pkc-region="note-find"]'), '閉じても欄が残る').toBeNull();
    expect(document.activeElement, '焦点が戻らない').toBe(before);
    expect(isNoteFindOpen(root)).toBe(false);
  });

  it('ノートが無いと開かない(false)', () => {
    const { root } = mounted(false);
    expect(openNoteFind(root)).toBe(false);
    expect(root.querySelector('[data-pkc-region="note-find"]')).toBeNull();
  });

  it('打つと件数が「n / m」で出て、全角半角・濁点を揃えて数える(ＡＢＣ=abc、ﾊﾟﾝ=パン、濁点の持ち方)', () => {
    const { root, body } = mounted();
    openNoteFind(root);
    type(root, 'りんご');
    // りんご ×3(⚠ ひらがなとカタカナは揃えない ── `fold-text.ts` の規約。「リンゴ」は数えない)
    expect(count(root)).toBe('1 / 3');
    body!.insertAdjacentHTML('beforeend', '<p>ＡＢＣ abc \u304b\u3099 が</p>');
    type(root, 'abc');
    expect(count(root), '全角 ＡＢＣ と abc が同じ字として数えられていない').toBe('1 / 2');
    type(root, '\u304c');
    // 元の「リンゴが」の が + 「か+濁点」+ 「が」= 3(合成済みと結合文字で数えが割れない)
    expect(count(root), 'か+濁点 と が が同じ字として数えられていない').toBe('1 / 3');
    type(root, 'パン');
    expect(count(root), '半角カナ ﾊﾟﾝ と パン が同じ字として数えられていない').toBe('1 / 2');
    type(root, '存在しない語');
    expect(count(root)).toBe('0 / 0');
    expect(input(root)!.getAttribute('aria-invalid')).toBe('true');
    type(root, '');
    expect(count(root), '空のとき件数が出ている').toBe('');
  });

  it('Enter で次・Shift+Enter で前へ(端で回る)', () => {
    const { root } = mounted();
    openNoteFind(root);
    type(root, 'りんご');
    const i = input(root)!;
    press('Enter', {}, i);
    expect(count(root)).toBe('2 / 3');
    press('Enter', {}, i);
    press('Enter', {}, i);
    expect(count(root), '最後から先頭へ回らない').toBe('1 / 3');
    press('Enter', { shiftKey: true }, i);
    expect(count(root), '先頭から最後へ戻れない').toBe('3 / 3');
  });

  it('🔴 Ctrl+G で次・Ctrl+Shift+G で前へ(ブラウザの「ページ内を検索」の既定を止める)', () => {
    const { root } = mounted();
    openNoteFind(root);
    type(root, 'りんご');
    const i = input(root)!;
    const g = (shiftKey: boolean): KeyboardEvent => {
      const ev = new KeyboardEvent('keydown', { key: 'g', code: 'KeyG', ctrlKey: true, shiftKey, bubbles: true, cancelable: true });
      i.dispatchEvent(ev);
      return ev;
    };
    const e1 = g(false);
    expect(count(root), 'Ctrl+G で次へ送れない').toBe('2 / 3');
    expect(e1.defaultPrevented, 'ブラウザの検索が出る').toBe(true);
    g(true);
    expect(count(root), 'Ctrl+Shift+G で前へ戻れない').toBe('1 / 3');
    g(true);
    expect(count(root), '先頭から最後へ戻れない').toBe('3 / 3');
    // 対照群: Ctrl なしの g は送りではない
    const plain = new KeyboardEvent('keydown', { key: 'g', code: 'KeyG', bubbles: true, cancelable: true });
    i.dispatchEvent(plain);
    expect(count(root)).toBe('3 / 3');
    expect(plain.defaultPrevented).toBe(false);
  });

  it('ボタンでも次・前・閉じる', () => {
    const { root } = mounted();
    openNoteFind(root);
    type(root, 'りんご');
    (root.querySelector('[data-pkc-field="note-find-next"]') as HTMLElement).click();
    expect(count(root)).toBe('2 / 3');
    (root.querySelector('[data-pkc-field="note-find-prev"]') as HTMLElement).click();
    expect(count(root)).toBe('1 / 3');
    (root.querySelector('[data-pkc-field="note-find-close"]') as HTMLElement).click();
    expect(isNoteFindOpen(root)).toBe(false);
  });

  it('Esc で閉じ、焦点が戻り、背後の Esc(ノートを閉じる)へは伝わらない', () => {
    const { root } = mounted();
    const before = document.createElement('textarea');
    root.append(before);
    before.focus();
    openNoteFind(root);
    let leaked = false;
    document.addEventListener('keydown', () => (leaked = true));
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input(root)!.dispatchEvent(ev);
    expect(isNoteFindOpen(root)).toBe(false);
    expect(document.activeElement).toBe(before);
    expect(leaked, 'Esc が背後へ漏れた').toBe(false);
  });

  it('日本語入力の変換中の Enter は送りに使わない', () => {
    const { root } = mounted();
    openNoteFind(root);
    type(root, 'りんご');
    press('Enter', { isComposing: true }, input(root)!);
    expect(count(root)).toBe('1 / 3');
    // Safari は変換を確定した Enter が isComposing: false で keyCode だけ 229
    press('Enter', { keyCode: 229 }, input(root)!);
    expect(count(root), 'keyCode 229 の Enter で送ってしまった').toBe('1 / 3');
    press('Enter', {}, input(root)!);
    expect(count(root), '対照群: ふつうの Enter は送る').toBe('2 / 3');
  });

  it('本文が描き直されたら数え直す(編集中のプレビューが打つたびに変わる)/ 対象が消えたら欄ごと閉じる', async () => {
    vi.useFakeTimers();
    const { root, body } = mounted();
    openNoteFind(root);
    type(root, 'りんご');
    body!.innerHTML = '<p>りんご</p>';
    await vi.advanceTimersByTimeAsync(300);
    expect(count(root), '描き直しに追随していない').toBe('1 / 1');
    body!.remove();
    await vi.advanceTimersByTimeAsync(300);
    expect(isNoteFindOpen(root), '見るものが無いのに欄が残る').toBe(false);
  });
});

describe('note-find: 本文の DOM を壊さない', () => {
  it('塗りの表が使えないとき `<mark>` で包み、閉じると元の節点・字へ戻る', () => {
    const { root, body } = mounted();
    const before = body!.innerHTML;
    const nodesBefore = nodeCount(body!);
    openNoteFind(root);
    type(root, 'りんご');
    expect(
      body!.querySelectorAll('mark.pkc-note-find-mark').length,
      '印が付いていない',
    ).toBe(3);
    expect(
      body!.querySelectorAll('.pkc-note-find-mark-current').length,
      'いまの 1 つが強調されていない',
    ).toBe(1);
    closeNoteFind(root, true);
    expect(body!.innerHTML, '閉じても本文が元へ戻っていない').toBe(before);
    expect(body!.querySelector('mark')).toBeNull();
    // 🔴 字面が同じでも、節点が割れたまま残っていないこと(normalize を忘れると節点の数が増えたままになる)
    expect(nodeCount(body!), '閉じても字の節点が割れたまま').toBe(nodesBefore);
  });

  it('タグをまたぐ語(ab<strong>cd</strong>ef の bcde)も数え、閉じると元へ戻る', () => {
    const { root, body } = mounted();
    body!.innerHTML = '<p>ab<strong>cd</strong>ef</p>';
    openNoteFind(root);
    type(root, 'bcde');
    expect(count(root)).toBe('1 / 1');
    closeNoteFind(root, false);
    expect(body!.innerHTML).toBe('<p>ab<strong>cd</strong>ef</p>');
  });

  it('Highlight API が在れば節点を 1 つも増やさず、全部 + いまの 1 つを表へ登録し、閉じたら外す', () => {
    const reg = new Map<string, { size: number }>();
    class FakeHighlight {
      priority = 0;
      ranges: Range[] = [];
      constructor(...rs: Range[]) {
        this.ranges = rs;
      }
      add(r: Range) {
        this.ranges.push(r);
      }
      get size() {
        return this.ranges.length;
      }
    }
    vi.stubGlobal('CSS', { highlights: reg });
    vi.stubGlobal('Highlight', FakeHighlight);
    const { root, body } = mounted();
    const before = body!.innerHTML;
    openNoteFind(root);
    type(root, 'りんご');
    expect(reg.get(NOTE_FIND_HIGHLIGHT)?.size, '全部の一致が登録されていない').toBe(3);
    expect(reg.get(NOTE_FIND_CURRENT_HIGHLIGHT)?.size, 'いまの 1 つが登録されていない').toBe(1);
    expect(body!.innerHTML, '塗るだけなのに本文の DOM が変わった').toBe(before);
    closeNoteFind(root, true);
    expect(reg.has(NOTE_FIND_HIGHLIGHT), '閉じても塗りが残る').toBe(false);
    expect(reg.has(NOTE_FIND_CURRENT_HIGHLIGHT)).toBe(false);
  });

  it('phrase は打った字を丸ごと 1 句で引く(空白を含む語を AND に割らない)', () => {
    const host = document.createElement('div');
    host.innerHTML = '<p>foo bar</p><p>bar foo</p>';
    document.body.append(host);
    expect(collectHitRanges(host, 'foo bar', 'phrase').length).toBe(1);
    expect(collectHitRanges(host, 'foo bar', 'filter').length, '対照群: filter は語ごとに数える').toBe(4);
  });
});

describe('note-find: Ctrl+F の行き先', () => {
  it('キーの表: Mod+F = ノート内 / Mod+Shift+F = 全ノート検索', () => {
    expect(findCommand('find-in-note')?.defaults).toEqual(['Mod+F']);
    expect(findCommand('find-in-note')?.whileTyping).toBe(true);
    expect(findCommand('focus-search')?.defaults).toEqual(['Mod+Shift+F']);
  });

  it('ノートを開いていれば Ctrl+F で欄が出て、既定動作を止める。左の欄へは行かない', () => {
    const { root } = mounted();
    const ok = press('f', { code: 'KeyF', ctrlKey: true });
    expect(ok, 'ブラウザの検索を止めていない').toBe(false);
    expect(isNoteFindOpen(root)).toBe(true);
    const filter = root.querySelector('[data-pkc-field="entry-filter"]');
    expect(document.activeElement).not.toBe(filter);
    expect(document.activeElement).toBe(input(root));
  });

  it('欄の中で Ctrl+F を押すと欄に留まる(欄は 1 つのまま)', () => {
    const { root } = mounted();
    press('f', { code: 'KeyF', ctrlKey: true });
    input(root)!.value = 'abc';
    press('f', { code: 'KeyF', ctrlKey: true }, input(root)!);
    expect(root.querySelectorAll('[data-pkc-region="note-find"]').length, '欄が 2 つ出た').toBe(1);
    expect(document.activeElement).toBe(input(root));
  });

  it('Ctrl+Shift+F は左の「本文ごと探す」欄へ(全ノート検索の道は残る)', () => {
    const { root } = mounted();
    press('F', { code: 'KeyF', ctrlKey: true, shiftKey: true });
    expect(document.activeElement).toBe(root.querySelector('[data-pkc-field="entry-filter"]'));
    expect(isNoteFindOpen(root), '全ノート検索なのにノート内の欄が出た').toBe(false);
  });

  it('ノートを開いていないときの Ctrl+F は、これまでどおり左の欄へ(対照群)', () => {
    const { root } = mounted(false);
    press('f', { code: 'KeyF', ctrlKey: true });
    expect(isNoteFindOpen(root)).toBe(false);
    expect(document.activeElement).toBe(root.querySelector('[data-pkc-field="entry-filter"]'));
  });

  it('ヘルプを開いている間は、ブラウザに返す(欄も出ない・既定動作を止めない)', () => {
    const { root, d } = mounted();
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'help' });
    const ok = press('f', { code: 'KeyF', ctrlKey: true });
    expect(ok, 'ヘルプで既定動作を止めている').toBe(true);
    expect(isNoteFindOpen(root), 'ヘルプで欄が出た').toBe(false);
  });

  it('パレット(dry)からは、ヘルプでも・ノートが無くても「押せる」', () => {
    const { root, d, store } = mounted(false);
    const noop = (): void => {};
    expect(runGlobalCommand('find-in-note', root, d, store, noop, noop, true)).toBe(true);
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'help' });
    expect(runGlobalCommand('find-in-note', root, d, store, noop, noop, true)).toBe(true);
  });

  it('左の探す欄に居るときの Ctrl+F は、ノート内の欄に奪われない', () => {
    const { root } = mounted();
    const filter = root.querySelector<HTMLInputElement>('[data-pkc-field="entry-filter"]')!;
    filter.focus();
    press('f', { code: 'KeyF', ctrlKey: true }, filter);
    expect(isNoteFindOpen(root)).toBe(false);
  });

  it('画面のボタン(find-in-note)でも同じ欄が出る', () => {
    const { root } = mounted();
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'find-in-note');
    root.append(b);
    b.click();
    expect(isNoteFindOpen(root)).toBe(true);
  });
});

describe('note-find: 実物の DetailRenderer の 3 面で探せる', () => {
  async function surface(mode: 'live' | 'split' | null) {
    localStorage.setItem('pkc3.editor-mode', mode ?? 'live');
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    bindActions(root, d, {}, new KeymapStore(fakeStorage()));
    const detail = new DetailRenderer(regions.detail, null, new MarkdownClient(), null);
    let st = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        {
          lid: 'a',
          title: 't',
          archetype: 'text',
          entryOrder: 1,
          createdAt: null,
          updatedAt: null,
          status: null,
          date: null,
          archived: false,
          bodyChars: null,
        },
      ],
      relations: [],
    }).state;
    st = reduce(st, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    st = reduce(st, { type: 'BODY_LOADED', lid: 'a', body: 'みかんとりんご\n\nりんごのパン' }).state;
    if (mode !== null) st = reduce(st, { type: 'START_EDIT' }).state;
    detail.render(st);
    await new Promise((r) => setTimeout(r, 0));
    return { root, detail };
  }

  afterEach(() => localStorage.removeItem('pkc3.editor-mode'));

  it.each([
    ['読む面', null, 'detail-body'],
    ['1 画面の編集(ライブ)', 'live', 'editor-live'],
    ['2 ペインのプレビュー', 'split', 'editor-preview'],
  ] as const)('%s: Ctrl+F で欄が出て、りんご 2 件を数え、Esc で閉じて本文は無傷', async (_n, mode, hostKey) => {
    const { root } = await surface(mode);
    const host =
      mode === null
        ? root.querySelector('[data-pkc-field="detail-body"]')
        : root.querySelector(`[data-pkc-region="${hostKey}"]`);
    expect(host, `${hostKey} が組めていない(台の空振り)`).not.toBeNull();
    const before = host!.innerHTML;
    expect(resolveFindTarget(root, null), '対象がこの面になっていない').toBe(host);
    press('f', { code: 'KeyF', ctrlKey: true });
    expect(isNoteFindOpen(root), `${hostKey}: 欄が出ない`).toBe(true);
    type(root, 'りんご');
    expect(count(root), `${hostKey}: 件数が違う`).toBe('1 / 2');
    press('Enter', {}, input(root)!);
    expect(count(root)).toBe('2 / 2');
    press('Escape', {}, input(root)!);
    expect(isNoteFindOpen(root)).toBe(false);
    expect(host!.innerHTML, `${hostKey}: 閉じたあと本文が元に戻っていない`).toBe(before);
  });
});

const meta = {
  lid: 'a',
  title: 't',
  archetype: 'text',
  entryOrder: 1,
  createdAt: null,
  updatedAt: null,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
} as const;

describe('note-find: レビュー指摘の直し', () => {
  it('P2: 焦点が欄の外(› ボタン)にあるときの Esc は欄だけ閉じ、ノートは閉じない(次の Esc で閉じる)', () => {
    const { root, d } = mounted();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    expect(d.getState().selectedLid, '台の前提: ノートが選ばれていない').toBe('a');
    openNoteFind(root);
    type(root, 'りんご');
    const next = root.querySelector<HTMLElement>('[data-pkc-field="note-find-next"]')!;
    next.focus();
    press('Escape', {}, next);
    expect(isNoteFindOpen(root), '欄が閉じていない').toBe(false);
    expect(d.getState().selectedLid, '探していたノートまで閉じた').toBe('a');
    press('Escape', {}, document.body);
    expect(d.getState().selectedLid, '対照群: 欄が無ければ Esc でノートが閉じる').toBeNull();
  });

  it('P3: 件数の字の更新では数え直さない(送りのたびに全文を数え直さない)/ 本文の変化では数え直す', async () => {
    vi.useFakeTimers();
    const { root, body } = mounted();
    openNoteFind(root);
    type(root, 'りんご');
    const marksOf = () => [...body!.querySelectorAll('mark')];
    const first = marksOf();
    expect(first.length).toBe(3);
    press('Enter', {}, input(root)!);
    await vi.advanceTimersByTimeAsync(500);
    expect(marksOf().every((m, i) => m === first[i]), '送っただけで数え直した(印が作り直された)').toBe(true);
    body!.insertAdjacentHTML('beforeend', '<p>無関係</p>');
    await vi.advanceTimersByTimeAsync(500);
    expect(marksOf().some((m, i) => m === first[i]), '対照群: 本文の変化で数え直していない').toBe(false);
  });

  it('P5: 位置は CSS だけ(中央ペイン基準の absolute)で、計算も resize の聞き手も持たない', () => {
    const css = readFileSync('src/styles/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (sel: string) => css.match(new RegExp(sel.replace(/[.[\]]/g, '\\$&') + '\\s*\\{([^}]*)\\}'))?.[1] ?? '';
    expect(rule('.pkc-note-find'), '欄が absolute でない').toContain('position: absolute');
    expect(rule('.pkc-note-find')).toContain('max-width: calc(100% - 56px)');
    expect(rule("[data-pkc-region='center']"), '基準の中央ペインが relative でない').toContain('position: relative');
    const add = vi.spyOn(window, 'addEventListener');
    const { root } = mounted();
    openNoteFind(root);
    expect(root.querySelector<HTMLElement>('[data-pkc-region="note-find"]')!.style.top, '位置を JS で計算している').toBe('');
    closeNoteFind(root, true);
    expect(add.mock.calls.filter((c) => (c[0] as string) === 'resize'), 'resize の聞き手が残る').toEqual([]);
    add.mockRestore();
  });

  it('P6: 編集面には mark を差し込まない(塗れないブラウザでは件数と送りだけ)', async () => {
    localStorage.setItem('pkc3.editor-mode', 'live');
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    bindActions(root, d, {}, new KeymapStore(fakeStorage()));
    const detail = new DetailRenderer(regions.detail, null, new MarkdownClient(), null);
    let st = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta], relations: [] }).state;
    st = reduce(st, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    st = reduce(st, { type: 'BODY_LOADED', lid: 'a', body: 'りんごとりんご' }).state;
    st = reduce(st, { type: 'START_EDIT' }).state;
    detail.render(st);
    await new Promise((r) => setTimeout(r, 0));
    const live = root.querySelector('[data-pkc-region="editor-live"]')!;
    const before = live.innerHTML;
    openNoteFind(root);
    type(root, 'りんご');
    expect(count(root), '件数は出る').toBe('1 / 2');
    expect(live.querySelector('mark'), '編集面に mark が混ざった').toBeNull();
    expect(live.innerHTML, '編集面の DOM が変わった').toBe(before);
    press('Enter', {}, input(root)!);
    expect(count(root)).toBe('2 / 2');
    expect(live.innerHTML).toBe(before);
    localStorage.removeItem('pkc3.editor-mode');
  });

  it('Q1: 現在の一致が送りに合わせて変わる(登録された range が ranges[current])', () => {
    const reg = new Map<string, { ranges: Range[] }>();
    class FakeHighlight {
      priority = 0;
      ranges: Range[] = [];
      constructor(...rs: Range[]) {
        this.ranges = rs;
      }
      add(r: Range) {
        this.ranges.push(r);
      }
    }
    vi.stubGlobal('CSS', { highlights: reg });
    vi.stubGlobal('Highlight', FakeHighlight);
    const { root, body } = mounted();
    openNoteFind(root);
    type(root, 'りんご');
    const all = collectHitRanges(body!, 'りんご', 'phrase');
    const same = (a: Range, b: Range) => a.startContainer === b.startContainer && a.startOffset === b.startOffset;
    const cur = () => reg.get(NOTE_FIND_CURRENT_HIGHLIGHT)!.ranges[0]!;
    expect(same(cur(), all[0]!)).toBe(true);
    press('Enter', {}, input(root)!);
    expect(same(cur(), all[1]!), '送ったのに強調が動いていない').toBe(true);
    press('Enter', { shiftKey: true }, input(root)!);
    press('Enter', { shiftKey: true }, input(root)!);
    expect(same(cur(), all[2]!), '前へ戻ると最後の一致').toBe(true);
  });

  it('Q3: 対象の器が替わったら先頭から数え直す', async () => {
    vi.useFakeTimers();
    const { root, body } = mounted();
    openNoteFind(root);
    type(root, 'りんご');
    press('Enter', {}, input(root)!);
    press('Enter', {}, input(root)!);
    expect(count(root)).toBe('3 / 3');
    const next = document.createElement('div');
    next.setAttribute('data-pkc-field', 'detail-body');
    next.innerHTML = '<p>りんご りんご りんご りんご</p>';
    body!.replaceWith(next);
    await vi.advanceTimersByTimeAsync(300);
    expect(count(root), '別のノートなのに前の位置を引き継いだ').toBe('1 / 4');
  });

  it('Q4: 欄が画面から外れていたら、開き直しで組み直す(欄は 1 つ)', () => {
    const { root } = mounted();
    openNoteFind(root);
    root.querySelector('[data-pkc-region="note-find"]')!.remove();
    expect(openNoteFind(root)).toBe(true);
    const bars = root.querySelectorAll('[data-pkc-region="note-find"]');
    expect(bars.length, '欄が組み直されていない').toBe(1);
    expect(bars[0]!.isConnected).toBe(true);
    expect(document.activeElement).toBe(input(root));
  });

  it('P4: user が自分で割り当てた Mod+Shift+F は、新しい既定(focus-search)に勝つ', () => {
    // 対照群: 何も割り当てていなければ新しい既定が効く
    expect(resolveUsableBindings({}).bindings['focus-search']).toEqual(['Mod+Shift+F']);
    // (b) 前の版で別のコマンドへ Mod+Shift+F を割り当てていた
    const b = resolveUsableBindings({ 'create-entry': ['Alt+N', 'Mod+Shift+F'] });
    expect(b.unusable, '使えない割当に落ちた').toEqual([]);
    expect(b.bindings['create-entry']).toContain('Mod+Shift+F');
    expect(b.bindings['focus-search'], '既定が user の割当を奪っている').toEqual([]);
    // (a) 前の版で focus-search に Mod+F と別の鍵を足していた
    const a = resolveUsableBindings({ 'focus-search': ['Mod+F', 'Alt+Q'] });
    expect(a.unusable, 'Mod+F が使えない割当に落ちた').toEqual([]);
    expect(a.bindings['focus-search']).toEqual(['Mod+Shift+F', 'Alt+Q']);
    expect(a.bindings['find-in-note'], 'Mod+F は新しい既定のまま').toEqual(['Mod+F']);
  });
});
