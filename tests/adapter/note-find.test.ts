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
import { findCommand } from '../../src/features/keymap';

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
