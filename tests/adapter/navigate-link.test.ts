/** @vitest-environment happy-dom */
/**
 * 🔴 **本文のリンクを押すと、リンク先のノートが開く**(2026-08-08)。
 *
 * ## 直す前に起きていたこと
 *
 * markdown は `[題名](entry:<lid>)` と `@[card](entry:<lid>)` に
 * `data-pkc-action` を焼いていたのに、**binder に受け手が 1 つも無かった** ──
 * 押しても**無言で何も起きない**。記法だけ PKC2 から移植して、受け手を置き忘れた
 * 形である(焼く側のコメントが PKC2 の `action-binder` を指したまま残っていた)。
 *
 * ## この test が守るもの
 *
 * - **押すと開く**(実クリック → binder → dispatcher まで通す)
 * - 🔴 **無言で断らない** ── `SELECT_ENTRY` は編集中 / 未知 lid で**黙って
 *   何もしない**ので、素直に撃つと直そうとしている当のものになる
 * - 🔴 **ブラウザに遷移させない** ── `<a href="entry:…">` の href は剥がして
 *   いないので、`preventDefault` を忘れると未知スキームへ飛ぼうとする
 * - 🔴 **キーボードで押せる** ── `@card` の placeholder は `role="link"
 *   tabindex="0"` なのに、Enter が効かなかった
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { AppState, Dispatchable } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const META = (lid: string): EntryMeta => ({
  lid,
  title: `t-${lid}`,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 0,
  status: 'open',
  date: null,
  archived: false,
});

/**
 * ⚠ **本物の `Dispatcher` を使う**(reduce まで通す)。fake を渡すと
 * 「dispatch した」しか見えず、**reducer が黙って捨てる**のを見逃す ──
 * それがこの test の主題そのものである。
 */
function makeDispatcher(over: Partial<AppState> = {}): {
  dispatcher: Dispatcher;
  lastError: () => string | null;
} {
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'default', metas: [META('a'), META('b')], relations: [] });
  for (const [k, v] of Object.entries(over)) {
    // ⚠ phase 等は action 経由で作る(直に触ると reducer の経路を通らない)
    if (k === 'phase' && v === 'editing') {
      d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
      d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '本文' });
      d.dispatch({ type: 'START_EDIT' });
    }
  }
  /**
   * ⚠ **観測点は `state.error`**(`OP_FAILED` は event を出さず、state に載せる ──
   * 画面の status がそこを読む)。`onEvent` で待つと**永久に来ない**。
   */
  return { dispatcher: d, lastError: () => d.getState().error };
}

let root: HTMLElement;
let stop: (() => void) | null = null;
beforeEach(() => {
  document.body.textContent = '';
  root = document.createElement('div');
  document.body.append(root);
  stop?.();
  stop = null;
});

/** markdown が実際に焼く形を、そのまま置く(勝手な形で試さない)。 */
function entryLink(href: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.setAttribute('href', href);
  a.setAttribute('data-pkc-action', 'navigate-entry-ref');
  a.setAttribute('data-pkc-entry-ref', href);
  a.textContent = '題名';
  root.append(a);
  return a;
}

function cardRef(target: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'pkc-card-placeholder';
  span.setAttribute('data-pkc-action', 'navigate-card-ref');
  span.setAttribute('data-pkc-card-target', target);
  span.setAttribute('data-pkc-card-variant', 'default');
  span.setAttribute('role', 'link');
  span.setAttribute('tabindex', '0');
  span.textContent = '@card';
  root.append(span);
  return span;
}

describe('本文のリンクを押す', () => {
  it('🔴 `entry:` のリンクを押すと、そのノートが開く', () => {
    const { dispatcher } = makeDispatcher();
    stop = bindActions(root, dispatcher);
    entryLink('entry:b').click();
    expect(dispatcher.getState().selectedLid, '押しても開かない').toBe('b');
  });

  /**
   * 🔑 **fragment 付きでも lid で開く。** PKC2 から取り込んだ本文には
   * `entry:c-log#2026-07-01-090000` の形が実在するので、fragment を理由に
   * 断ると**今日も無反応のまま**になる。
   */
  it('🔴 fragment が付いていても開く(断らない)', () => {
    const { dispatcher, lastError } = makeDispatcher();
    stop = bindActions(root, dispatcher);
    entryLink('entry:b#2026-07-01-090000').click();
    expect(dispatcher.getState().selectedLid, 'fragment を理由に断った').toBe('b');
    expect(lastError(), '断りの理由が出ている(開けたのに)').toBeNull();
  });

  it('🔴 `@card` の placeholder を押しても開く(解決器は同じ 1 本)', () => {
    const { dispatcher } = makeDispatcher();
    stop = bindActions(root, dispatcher);
    cardRef('entry:b').click();
    expect(dispatcher.getState().selectedLid, 'カードを押しても開かない').toBe('b');
  });

  it('🔴 携帯参照(pkc://…/entry/…)のカードも開く', () => {
    const { dispatcher } = makeDispatcher();
    stop = bindActions(root, dispatcher);
    cardRef('pkc://default/entry/b').click();
    expect(dispatcher.getState().selectedLid).toBe('b');
  });
});

/**
 * 🔴 **無言で断らない**(`delete-entry` が確立した倒し方)。
 * ⚠ `SELECT_ENTRY` は編集中 / 未知 lid で**黙って何もしない** ── 素直に撃つと、
 *   直そうとしている「押しても無言」がそのまま残る。
 */
describe('🔴 断るときは理由を出す', () => {
  it('🔴 リンク先が無いとき', () => {
    const { dispatcher, lastError } = makeDispatcher();
    stop = bindActions(root, dispatcher);
    // ⚠ **綴りは正しいが居ない** lid を使う(非 ASCII だと「読めません」側へ落ちる)
    entryLink('entry:zzz').click();
    expect(lastError(), '無言で断った').toContain('見つかりません');
  });

  it('🔴 リンクの綴りが壊れているとき', () => {
    const { dispatcher, lastError } = makeDispatcher();
    stop = bindActions(root, dispatcher);
    entryLink('entry:abc#').click();
    expect(lastError(), '無言で断った').toContain('読めません');
  });

  it('🔴 別の PKC を指しているとき(カード)', () => {
    const { dispatcher, lastError } = makeDispatcher();
    stop = bindActions(root, dispatcher);
    // ⚠ asset の携帯参照は entry として開けない ── 黙って別ノートへ飛ばさない
    cardRef('pkc://other/asset/ast-1').click();
    expect(lastError(), '無言で断った').not.toBeNull();
  });

  /**
   * ⚠ **編集中は移らない**(下書きを守る)。⚠ 面の切替とは**別の判断**である ──
   *   あちらは面が常駐するので開けるようにした(user 裁定 2026-08-08)。
   */
  it('🔴 編集中は移らず、理由が出る', () => {
    const { dispatcher, lastError } = makeDispatcher({ phase: 'editing' } as Partial<AppState>);
    stop = bindActions(root, dispatcher);
    entryLink('entry:b').click();
    expect(dispatcher.getState().selectedLid, '編集中に移ってしまった').toBe('a');
    expect(lastError(), '無言で断った').toContain('編集');
  });

  /**
   * 🔴 **断る理由は「先に当たったほう」を出す**(2026-08-08、変異試験で判明)。
   *
   * ⚠ 1 巡目は「編集中は移らない」を**居るノート**でしか試しておらず、
   * 編集中の判定のあとに `return` を忘れる変異が**生き延びた** ── `SELECT_ENTRY`
   * は編集中に reducer が捨てるので、**画面上の結果が同じ**だったからである。
   *
   * 🔑 **居ないノートへのリンクなら差が出る** ── 素通りすると理由が
   * 「見つかりません」で上書きされ、user は**直せない指示**を読むことになる
   * (本当は保存すれば開けるかもしれない)。
   */
  it('🔴 編集中に居ないノートへのリンクを押しても、「編集中」と言う', () => {
    const { dispatcher, lastError } = makeDispatcher({ phase: 'editing' } as Partial<AppState>);
    stop = bindActions(root, dispatcher);
    entryLink('entry:zzz').click();
    expect(lastError(), '理由が「見つかりません」で上書きされた').toContain('編集');
  });
});

/**
 * 🔴 **ブラウザに遷移させない**(2026-08-08)。
 *
 * 本文の `entry:` リンクは `<a href="entry:…">` として出る。binder は
 * `preventDefault` を呼んでいなかったので、⚠ **押すとブラウザが未知スキームへの
 * 遷移を試みる**。`asset:` の枝だけは焼く側で href を剥がして避けていた ──
 * **対称の反対側が放置されていた**。
 */
describe('🔴 アプリ内リンクでブラウザを遷移させない', () => {
  it('🔴 `<a href>` の既定動作を止める', () => {
    const { dispatcher } = makeDispatcher();
    stop = bindActions(root, dispatcher);
    const a = entryLink('entry:b');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    expect(ev.defaultPrevented, '既定動作を止めていない(ブラウザが遷移を試みる)').toBe(true);
  });

  /**
   * 🔴 **checkbox では止めない。**
   * ⚠ 止めると**チェック状態が巻き戻る** ── フラグ画面と設定が壊れる。
   *   だから「`<a href>` に限る」が要件そのものである。
   */
  it('🔴 checkbox の既定動作は止めない(チェックが巻き戻る)', () => {
    const { dispatcher } = makeDispatcher();
    let seen: boolean | null = null;
    stop = bindActions(root, dispatcher, { setFlag: (_n, on) => (seen = on) });
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.setAttribute('data-pkc-action', 'set-flag');
    box.setAttribute('data-pkc-flag', 'x');
    root.append(box);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    box.dispatchEvent(ev);
    expect(ev.defaultPrevented, 'checkbox の既定を止めた(チェックが巻き戻る)').toBe(false);
    expect(seen, '受け手が呼ばれていない(fixture の空振り)').not.toBeNull();
  });
});

/**
 * 🔴 **キーボードで押せる**(user 指示「マウスだけで完結し、キーボードは近道」)。
 *
 * ⚠ `@card` の placeholder は PKC3 で**唯一 `tabindex="0"` を持つ要素**なのに、
 * binder の keydown が `data-pkc-field` の門で必ず抜けていた ──
 * **フォーカスできるのに Enter が効かない**要素が 1 種類だけ存在していた。
 */
describe('🔴 role="link" のものは Enter / Space で押せる', () => {
  it.each([['Enter'], [' ']])('🔴 %s で開く', (key) => {
    const { dispatcher } = makeDispatcher();
    stop = bindActions(root, dispatcher);
    const span = cardRef('entry:b');
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    span.dispatchEvent(ev);
    expect(dispatcher.getState().selectedLid, `${key} で開かない`).toBe('b');
    // ⚠ Space は既定でページを送る ── 押した先が動くほうが正しい
    expect(ev.defaultPrevented, '既定動作を止めていない').toBe(true);
  });

  /** ⚠ 変換中の Enter は**確定**であって、押下ではない。 */
  it('⚠ IME 変換中の Enter では開かない', () => {
    const { dispatcher } = makeDispatcher();
    stop = bindActions(root, dispatcher);
    const span = cardRef('entry:b');
    span.dispatchEvent(
      // happy-dom は isComposing を options から受ける
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
    );
    expect(dispatcher.getState().selectedLid, '変換の確定で飛んだ').not.toBe('b');
  });

  /**
   * ⚠ **`<button>` / `<a>` は対象外**(ブラウザ既定で Enter → click に乗る)。
   *   ここで拾うと**二重に撃つ**。
   */
  it('⚠ tabindex を持たないものは、この経路で撃たない', () => {
    const { dispatcher } = makeDispatcher();
    let n = 0;
    stop = bindActions(root, dispatcher, { resetFlags: () => (n += 1) });
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'reset-flags');
    root.append(btn);
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(n, 'ブラウザ既定と二重に撃っている').toBe(0);
  });
});

/** ⚠ 型だけ使う(未使用 import を避ける)。 */
export type _Dispatchable = Dispatchable;
