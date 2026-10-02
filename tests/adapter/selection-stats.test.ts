/** @vitest-environment happy-dom */
/**
 * 🔴 **編集中、選んだ範囲の文字数と行数が帯の右端の枠に出る**(#1215)。
 *
 * ## 守る主張
 *
 * 1. 選ぶと「選択: N 文字(M 行)」/ 外すと空(枠は残る)
 * 2. 効く欄は `formatTarget` が引く 3 つ(`editor-body` / `row-source` / 全文編集の欄)。
 *    **追記欄・章の欄は対象外**(そこで選んでも枠は動かない)
 * 3. 🔑 字が同じなら書かない(setter を数える)/ caret だけなら本文(`value`)を読まない
 * 4. 🔑 選びが止まってから 1 度だけ読む(trailing debounce。連打の最中は何も読まない ──
 *    数 MB の欄で読むたびに layout が確定して long task が積み増しになった実測の裏)
 * 5. IME の変換中は書かない / 確定したら合わせる
 * 6. 編集を終えると購読が外れる(待っている 1 回の読みも捨てる)
 *
 * ⚠ 帯の**幅・折り返し**は happy-dom が測れないので、実ブラウザの smoke
 *   (`format-bar.smoke.spec.ts` / `live-editor.smoke.spec.ts`)が見る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import {
  SELECTION_STATS_DELAY_MS,
  SELECTION_STATS_FIELD,
  syncSelectionStats,
  watchSelectionStats,
} from '../../src/adapter/ui/render/selection-stats';

/** 時間は手で進める(止まるまで読まないことを見るため、勝手には走らせない)。 */
const flush = (): void => {
  vi.advanceTimersByTime(SELECTION_STATS_DELAY_MS);
};
/** 待っている読みの数(0 なら何も待っていない)。 */
const pending = (): number => vi.getTimerCount();

beforeEach(() => {
  document.body.textContent = '';
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Field = 'editor-body' | 'row-source' | 'append-input';

/** 手で組んだ編集の面(帯の枠と、`formatTarget` が探す欄)。 */
function surface(field: Field = 'editor-body', value = 'abc\ndef\nghi') {
  const region = document.createElement('div');
  region.setAttribute('data-pkc-region', 'detail');
  const bar = document.createElement('div');
  bar.setAttribute('data-pkc-field', 'detail-toolbar');
  const slot = document.createElement('span');
  slot.setAttribute('data-pkc-field', SELECTION_STATS_FIELD);
  bar.append(slot);
  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', field);
  ta.value = value;
  region.append(bar, ta);
  document.body.append(region);
  return { region, slot, ta };
}
const selectionChanged = (): void => {
  document.dispatchEvent(new Event('selectionchange'));
};
/** 選びを動かして、selectionchange → 止まるまで時間を進める。 */
function select(ta: HTMLTextAreaElement, s: number, e: number): void {
  ta.setSelectionRange(s, e);
  selectionChanged();
  flush();
}

describe('出る / 消える(#1215)', () => {
  it('🔴 選ぶと「選択: N 文字(M 行)」、外すと空(枠は残る)', () => {
    const { region, slot, ta } = surface();
    const un = watchSelectionStats(region);
    select(ta, 1, 6); // 'bc\nde' = 5 字 2 行
    expect(slot.textContent).toBe('選択: 5 文字(2 行)');
    select(ta, 2, 2);
    expect(slot.textContent, '選びを外したのに残っている').toBe('');
    expect(slot.isConnected, '枠そのものが消えた(版面が動く)').toBe(true);
    // 対照群: 選び直すとまた出る(「常に空」で通る空振りを防ぐ)
    select(ta, 0, 3);
    expect(slot.textContent).toBe('選択: 3 文字(1 行)');
    un();
  });

  it('🔴 数は UTF-16 の長さ(selectionEnd - selectionStart)── 絵文字 1 つは 2', () => {
    const { region, slot, ta } = surface('editor-body', 'a😀b');
    const un = watchSelectionStats(region);
    select(ta, 0, 3); // 'a' + 😀(2 単位)
    expect(slot.textContent).toBe('選択: 3 文字(1 行)');
    un();
  });

  it('🔴 末尾の改行で選択が終わるときは次の行を数えない(行の頭まで選んだ場合)', () => {
    const { region, slot, ta } = surface();
    const un = watchSelectionStats(region);
    select(ta, 0, 8); // 'abc\ndef\n'
    expect(slot.textContent).toBe('選択: 8 文字(2 行)');
    select(ta, 0, 9); // 次の行の 1 字まで入った
    expect(slot.textContent).toBe('選択: 9 文字(3 行)');
    un();
  });

  it('🔴 効く欄は editor-body / row-source の 2 つ(全文編集の欄は editor-body)。追記欄は対象外', () => {
    for (const field of ['row-source', 'editor-body'] as const) {
      document.body.textContent = '';
      const { region, slot, ta } = surface(field);
      const un = watchSelectionStats(region);
      select(ta, 0, 3);
      expect(slot.textContent, field).toBe('選択: 3 文字(1 行)');
      un();
    }
    // 対象外の欄(追記欄)で選んでも枠は動かない
    document.body.textContent = '';
    const { region, slot, ta } = surface('append-input');
    const un = watchSelectionStats(region);
    select(ta, 0, 3);
    expect(slot.textContent, '追記欄の選びを数えた').toBe('');
    un();
  });

  it('枠が無い面(読む面の帯など)では何もしない', () => {
    const region = document.createElement('div');
    region.setAttribute('data-pkc-region', 'detail');
    expect(syncSelectionStats(region)).toBe(false);
  });
});

describe('🔴 焦点が別の入力欄へ移ったら空にする(#1264 §1)', () => {
  /** 題名の欄(別の入力欄)と書式のボタンを足した面。 */
  function withNeighbors() {
    const s = surface();
    const title = document.createElement('input');
    title.setAttribute('data-pkc-field', 'editor-title');
    const bold = document.createElement('button');
    bold.setAttribute('data-pkc-action', 'format-bold');
    s.region.append(title, bold);
    return { ...s, title, bold };
  }
  /** 焦点を動かして focusin を撃ち、止まるまで時間を進める(happy-dom は focus() で撃つ)。 */
  const focusTo = (el: HTMLElement): void => {
    el.focus();
    flush();
  };

  it('本文で選ぶ → 題名の欄へ移る → 空 / 本文へ戻る → また出る / 書式ボタンへ移る間は残る(対照群)', () => {
    const { region, slot, ta, title, bold } = withNeighbors();
    const un = watchSelectionStats(region);
    focusTo(ta);
    select(ta, 0, 3);
    expect(slot.textContent, '前提:選んだら出ている').toBe('選択: 3 文字(1 行)');
    focusTo(title);
    expect(slot.textContent, '題名の欄へ移ったのに、選んでいない字の数が残っている').toBe('');
    focusTo(ta);
    expect(slot.textContent, '本文へ戻ったのに出ない(選びは残っている)').toBe('選択: 3 文字(1 行)');
    focusTo(bold);
    expect(slot.textContent, '書式ボタンへ移ったら消えた(意図は「残す」)').toBe('選択: 3 文字(1 行)');
    un();
  });

  it('別の textarea(追記欄)・contenteditable へ移っても空になる', () => {
    const { region, slot, ta } = withNeighbors();
    const un = watchSelectionStats(region);
    select(ta, 0, 3);
    const other = document.createElement('textarea');
    region.append(other);
    focusTo(other);
    expect(slot.textContent, '別の textarea').toBe('');
    focusTo(ta);
    expect(slot.textContent).toBe('選択: 3 文字(1 行)');
    const ce = document.createElement('div');
    ce.setAttribute('contenteditable', 'true');
    ce.tabIndex = 0;
    region.append(ce);
    focusTo(ce);
    expect(slot.textContent, 'contenteditable').toBe('');
    un();
  });

  it('どこにも焦点が無くなったとき(題名の欄から外れて何も掴まない)も合わせ直す ── 書式ボタンへ移るのと同じ向きで、また出る', () => {
    const { region, slot, ta, title } = withNeighbors();
    const un = watchSelectionStats(region);
    focusTo(ta);
    select(ta, 0, 3);
    focusTo(title);
    expect(slot.textContent, '前提:題名の欄の間は空').toBe('');
    title.blur();
    flush();
    expect(slot.textContent, '焦点が外れたのに空のまま(focusout を見ていない)').toBe('選択: 3 文字(1 行)');
    un();
  });

  it('編集を終えたら焦点の購読も外れる(外した後に焦点が動いても枠を書かない)', () => {
    const { region, slot, ta, title } = withNeighbors();
    const un = watchSelectionStats(region);
    focusTo(ta);
    select(ta, 0, 3);
    focusTo(title);
    expect(slot.textContent, '前提:題名の欄の間は空').toBe('');
    un();
    title.blur();
    flush();
    expect(slot.textContent, 'focusout の購読が残っている').toBe('');
    focusTo(ta);
    expect(slot.textContent, 'focusin の購読が残っている').toBe('');
    expect(pending(), '待っている読みが残っている').toBe(0);
  });
});

describe('書き込みを減らす(#1215)', () => {
  it('🔑 字が同じなら書かない(setter を数える)', () => {
    const { region, slot, ta } = surface();
    const un = watchSelectionStats(region);
    const writes: string[] = [];
    let proto = Object.getPrototypeOf(slot) as object;
    while (proto !== null && Object.getOwnPropertyDescriptor(proto, 'textContent') === undefined)
      proto = Object.getPrototypeOf(proto) as object;
    const desc = Object.getOwnPropertyDescriptor(proto, 'textContent');
    // 空振り防止 ── setter が拾えなければ「書いていない」は自明に通る
    expect(desc?.set, 'textContent の setter が拾えない').toBeTypeOf('function');
    Object.defineProperty(proto, 'textContent', {
      configurable: true,
      get() {
        return desc!.get!.call(this);
      },
      set(v: string) {
        if (this === slot) writes.push(v);
        desc!.set!.call(this, v);
      },
    });
    try {
      select(ta, 2, 2); // 選んでいない → 選んでいない
      select(ta, 3, 3);
      expect(writes, '何も変わっていないのに書いた').toEqual([]);
      select(ta, 0, 3);
      expect(writes).toEqual(['選択: 3 文字(1 行)']);
      select(ta, 4, 7); // 別の範囲だが字は同じ(3 文字 1 行)
      select(ta, 0, 3);
      expect(writes.length, '字が同じなのに書き直した').toBe(1);
      select(ta, 0, 5); // 字が変わる
      expect(writes.length).toBe(2);
      select(ta, 1, 1); // 外す
      expect(writes.length).toBe(3);
      expect(writes[2]).toBe('');
    } finally {
      Object.defineProperty(proto, 'textContent', desc!);
      un();
    }
  });

  it('🔑 caret だけのときは本文(value)を読まない / 選んだときだけ読む', () => {
    const { region, ta } = surface();
    const un = watchSelectionStats(region);
    let reads = 0;
    const proto = Object.getPrototypeOf(ta) as object;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')!;
    // 空振り防止 ── getter が拾えなければ「読んでいない」は自明に通る
    expect(desc.get, 'value の getter が拾えない').toBeTypeOf('function');
    // ⚠ 数えるのは**こちらの処理が走る間だけ**(happy-dom の `setSelectionRange` も値を読む)
    let counting = false;
    Object.defineProperty(ta, 'value', {
      configurable: true,
      get() {
        if (counting) reads += 1;
        return desc.get!.call(this);
      },
      set(v: string) {
        desc.set!.call(this, v);
      },
    });
    const moveAndCount = (s: number, e: number): void => {
      ta.setSelectionRange(s, e);
      counting = true;
      selectionChanged();
      flush();
      counting = false;
    };
    moveAndCount(4, 4);
    moveAndCount(5, 5);
    expect(reads, 'caret だけなのに本文を読んだ').toBe(0);
    moveAndCount(0, 3);
    expect(reads, '選んだのに本文を読んでいない(行数が数えられない)').toBeGreaterThan(0);
    un();
  });

  it('🔑 連打の最中は読まない(動くたびに待ちを延ばす)/ 止まって 1 度だけ読んで最後の選びが出る', () => {
    const { region, slot, ta } = surface();
    const un = watchSelectionStats(region);
    // 数える ── 連打の最中に `selectionStart` を読むと、数 MB の欄で layout が確定して long task が積み増しになる
    let reads = 0;
    const proto = Object.getPrototypeOf(ta) as object;
    const desc = Object.getOwnPropertyDescriptor(proto, 'selectionStart')!;
    expect(desc.get, 'selectionStart の getter が拾えない').toBeTypeOf('function');
    let counting = false;
    Object.defineProperty(ta, 'selectionStart', {
      configurable: true,
      get() {
        if (counting) reads += 1;
        return desc.get!.call(this);
      },
    });
    ta.setSelectionRange(0, 1);
    counting = true;
    selectionChanged();
    // 待ちが終わる直前にまた動く ── 待ちは延びる
    vi.advanceTimersByTime(SELECTION_STATS_DELAY_MS - 1);
    counting = false;
    ta.setSelectionRange(0, 2);
    counting = true;
    selectionChanged();
    vi.advanceTimersByTime(SELECTION_STATS_DELAY_MS - 1);
    counting = false;
    ta.setSelectionRange(0, 3);
    counting = true;
    selectionChanged();
    vi.advanceTimersByTime(SELECTION_STATS_DELAY_MS - 1);
    expect(reads, '選びが動いている最中に読んだ').toBe(0);
    expect(slot.textContent, '止まる前に書いた').toBe('');
    expect(pending(), '待ちが 1 つに畳まれていない').toBe(1);
    vi.advanceTimersByTime(1);
    counting = false;
    expect(reads, '止まったのに読んでいない').toBeGreaterThan(0);
    expect(slot.textContent).toBe('選択: 3 文字(1 行)');
    expect(pending(), '読んだ後も待ちが残っている').toBe(0);
    un();
  });
});

describe('IME の変換中(#1215)', () => {
  it('🔴 変換中は書かない / 確定したら合わせる', () => {
    const { region, slot, ta } = surface();
    const un = watchSelectionStats(region);
    ta.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    select(ta, 0, 3);
    expect(slot.textContent, '変換中に書いた').toBe('');
    expect(pending(), '変換中に読みを待たせた').toBe(0);
    ta.dispatchEvent(new Event('compositionend', { bubbles: true }));
    flush();
    expect(slot.textContent, '確定したのに合わせていない').toBe('選択: 3 文字(1 行)');
    // 対照群: 確定後は通常どおり動く
    select(ta, 0, 5);
    expect(slot.textContent).toBe('選択: 5 文字(2 行)');
    un();
  });

  it('待っている読みが変換の開始をまたいでも書かない', () => {
    const { region, slot, ta } = surface();
    const un = watchSelectionStats(region);
    ta.setSelectionRange(0, 3);
    selectionChanged(); // 読みを待たせる
    expect(pending()).toBe(1);
    ta.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    flush();
    expect(slot.textContent).toBe('');
    un();
  });
});

describe('編集セッションの寿命(#1215)', () => {
  it('🔴 unsubscribe の後は、selectionchange が来ても書かない / 待っている読みも捨てる', () => {
    const { region, slot, ta } = surface();
    const un = watchSelectionStats(region);
    ta.setSelectionRange(0, 3);
    selectionChanged();
    expect(pending(), '前提: 読みが待たされている').toBe(1);
    un();
    expect(pending(), '待っている読みを捨てていない').toBe(0);
    ta.setSelectionRange(0, 5);
    selectionChanged();
    flush();
    expect(slot.textContent).toBe('');
    expect(pending(), '外した後に読みを待たせた').toBe(0);
  });

  it('🔴 編集を始めると購読が 1 つ増え、保存して抜けると外れる / 本物の帯の右端の枠に出る(実際の編集の流れ)', async () => {
    // 非同期の配線(store-effects)を待つので、この 1 本だけ実時間で回す
    vi.useRealTimers();
    localStorage.setItem('pkc3.editor-mode', 'split');
    const added: Array<EventListenerOrEventListenerObject> = [];
    const removed: Array<EventListenerOrEventListenerObject> = [];
    const realAdd = document.addEventListener.bind(document);
    const realRemove = document.removeEventListener.bind(document);
    vi.spyOn(document, 'addEventListener').mockImplementation(((t: string, h: never, o?: never) => {
      if (t === 'selectionchange') added.push(h);
      return realAdd(t, h, o);
    }) as typeof document.addEventListener);
    vi.spyOn(document, 'removeEventListener').mockImplementation(((t: string, h: never, o?: never) => {
      if (t === 'selectionchange') removed.push(h);
      return realRemove(t, h, o);
    }) as typeof document.removeEventListener);

    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const detail = new DetailRenderer(regions.detail);
    d.onState((s) => detail.render(s));
    bindActions(root, d);
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => 'abc\ndef\nghi',
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async () => stubStamps(),
    });
    const meta: EntryMeta = {
      lid: 'a',
      title: 't',
      archetype: 'text',
      createdAt: null,
      updatedAt: null,
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
      bodyChars: null,
    };
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    await new Promise((r) => setTimeout(r, 10));

    const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s);
    // 読む面の帯には枠を出さない(編集中だけ)
    expect(q('[data-pkc-field="selection-stats"]'), '読む面に枠が出ている').toBeNull();
    const addedBefore = added.length;
    q('[data-pkc-action="start-edit"]')!.click();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    // 帯(wrap-hint と本件)で 2 つ
    expect(added.length - addedBefore, '編集を始めても購読が 2 つ増えていない').toBe(2);

    // 枠は編集の帯の中の最後の要素(右端)
    const slot = q('[data-pkc-field="detail-toolbar"] [data-pkc-field="selection-stats"]')!;
    expect(slot, '帯の中に枠が無い').not.toBeNull();
    expect(slot.parentElement!.lastElementChild, '枠が帯の右端(最後)にいない').toBe(slot);

    ta.setSelectionRange(1, 6);
    selectionChanged();
    await new Promise((r) => setTimeout(r, SELECTION_STATS_DELAY_MS + 60));
    expect(slot.textContent).toBe('選択: 5 文字(2 行)');

    q('[data-pkc-action="commit-edit"]')!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(q('[data-pkc-field="editor-body"]')).toBeNull();
    // 追加した 2 つが両方外れている
    const mine = added.slice(addedBefore);
    for (const h of mine) expect(removed, '編集を抜けたのに購読を外していない').toContain(h);
    expect(q('[data-pkc-field="selection-stats"]'), '抜けた後に枠が残っている').toBeNull();
  });
});
