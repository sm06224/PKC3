/** @vitest-environment happy-dom */
/**
 * 🔴 **選んでいるあいだだけ、帯の 4 つの説明が「選んだ範囲を囲みます」になる**(#950 ①)。
 *
 * ## 守る主張
 *
 * 1. **どの 4 つか**は `WRAPS_SELECTION_OPS`(押したときの振る舞いと同じ集合)から引かれる。
 *    集合を外れた op は、押しても囲まない(= 説明だけが嘘にならない)
 * 2. 選んだ範囲が在る → 4 つの `title` が切り替わる / 無い → 元に戻る(**他のボタンは触らない**)
 * 3. 🔑 **状態が変わったときだけ書く**(打鍵のたびに DOM を書かない)
 * 4. 字(`label`)は変えない。⚠ 帯の**高さ**は happy-dom が 0 を返すので、ここでは見ない
 *    (実ブラウザの smoke `format-bar.smoke.spec.ts` が `offsetHeight` で見る)
 * 5. **編集を終えたら購読が外れる**(外し忘れると、閉じた編集の帯を見張り続ける)
 * 6. 割当を変えて説明を組み直しても(`applyShortcutHints`)、選んでいる間の切替が消えない
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
import { buildFormatBar } from '../../src/adapter/ui/render/format-bar';
import {
  WRAPS_SELECTION_ATTR,
  syncWrapHint,
  watchWrapHint,
} from '../../src/adapter/ui/render/format-wrap-hint';
import {
  WRAP_HINT,
  applyShortcutHints,
} from '../../src/adapter/ui/render/shortcut-hint';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import {
  FORMAT_OPS,
  WRAPS_SELECTION_OPS,
  applyFormat,
  type FormatOp,
} from '../../src/features/markdown/text-ops';

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

beforeEach(() => {
  document.body.textContent = '';
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** 手で組んだ編集の面(`formatTarget` が探す `[data-pkc-region="detail"]` の中に帯と欄を置く)。 */
function surface(field: 'editor-body' | 'row-source' = 'editor-body') {
  const region = document.createElement('div');
  region.setAttribute('data-pkc-region', 'detail');
  const bar = buildFormatBar();
  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', field);
  ta.value = 'abcdef';
  region.append(bar, ta);
  document.body.append(region);
  return { region, bar, ta };
}

const wrapButtons = (bar: ParentNode): HTMLButtonElement[] =>
  [...bar.querySelectorAll<HTMLButtonElement>(`[${WRAPS_SELECTION_ATTR}]`)];
const titles = (bar: ParentNode): string[] =>
  [...bar.querySelectorAll<HTMLButtonElement>('button')].map((b) => b.title);
const selectionChanged = (): void => {
  document.dispatchEvent(new Event('selectionchange'));
};

describe('どの 4 つか(#950 ①)', () => {
  it('🔴 集合は 表 / 図 / コードブロック / 数式 の 4 つで、帯の印はその集合そのもの', () => {
    expect(sorted(WRAPS_SELECTION_OPS)).toEqual(['codeblock', 'math', 'mermaid', 'table']);
    const { bar } = surface();
    const marked = wrapButtons(bar);
    // 空振り防止 ── 0 件なら「集合と一致」は自明に通る
    expect(marked.length, '印の付いたボタンが拾えていない').toBe(4);
    expect(sorted(marked.map((b) => b.getAttribute(WRAPS_SELECTION_ATTR)!))).toEqual(
      sorted(WRAPS_SELECTION_OPS),
    );
    // 「図」は `format-text` ではなく `insert-diagram` の押し口 ── 取りこぼさない
    expect(
      marked.find((b) => b.getAttribute(WRAPS_SELECTION_ATTR) === 'mermaid')!.getAttribute(
        'data-pkc-action',
      ),
    ).toBe('insert-diagram');
  });

  it('🔴 集合に居る op は、選ぶと選んだ字を残したまま囲み、外れた op は何もしない(説明と振る舞いが 1 つの門)', () => {
    const sel = { text: 'abc', start: 0, end: 3 };
    for (const op of WRAPS_SELECTION_OPS) {
      const out = applyFormat(sel, op);
      expect(out.text, `${op}: 選んだ字が残っていない`).toContain('abc');
      expect(out.text, `${op}: 何も足していない(囲んでいない)`).not.toBe('abc');
      // 選んでいなければ、選んだ字を持たない雛形が入る(= 選択の有無で振る舞いが分かれる)
      expect(applyFormat({ text: '', start: 0, end: 0 }, op).text).not.toContain('abc');
    }
    // 4 つ以外の「ブロックの op」は集合に居ない(帯の他のボタンに印を付けない)
    const others = FORMAT_OPS.map((o) => o.op).filter((o: FormatOp) => !WRAPS_SELECTION_OPS.has(o));
    expect(others.length).toBeGreaterThan(10);
    const { bar } = surface();
    for (const op of others) {
      const b = bar.querySelector(`[data-pkc-format="${op}"]`);
      if (b !== null) expect(b.hasAttribute(WRAPS_SELECTION_ATTR), `${op} に印が付いている`).toBe(false);
    }
  });
});

describe('説明の切替(#950 ①)', () => {
  it('🔴 選ぶと 4 つだけが切り替わり、選びを外すと元の説明に戻る / 字は変わらない', () => {
    const { region, bar, ta } = surface();
    const before = titles(bar);
    const labelsBefore = [...bar.querySelectorAll('[data-pkc-field="label"]')].map((e) => e.textContent);
    const unsubscribe = watchWrapHint(region);

    ta.setSelectionRange(1, 4);
    selectionChanged();
    const on = titles(bar);
    const buttons = [...bar.querySelectorAll<HTMLButtonElement>('button')];
    buttons.forEach((b, i) => {
      if (b.hasAttribute(WRAPS_SELECTION_ATTR)) {
        expect(on[i], `${b.getAttribute('data-pkc-format') ?? b.getAttribute('data-pkc-action')}`).toBe(WRAP_HINT);
      } else {
        expect(on[i], '4 つ以外のボタンの説明まで書き換えた').toBe(before[i]);
      }
    });

    ta.setSelectionRange(2, 2);
    selectionChanged();
    expect(titles(bar), '選びを外したのに元へ戻っていない').toEqual(before);
    expect(
      [...bar.querySelectorAll('[data-pkc-field="label"]')].map((e) => e.textContent),
      '字(label)は変えない',
    ).toEqual(labelsBefore);
    unsubscribe();
  });

  it('🔴 live の 1 面(行の入力欄 row-source)でも、2 列の面(editor-body)でも切り替わる', () => {
    for (const field of ['row-source', 'editor-body'] as const) {
      document.body.textContent = '';
      const { region, bar, ta } = surface(field);
      const un = watchWrapHint(region);
      ta.setSelectionRange(0, 3);
      selectionChanged();
      expect(wrapButtons(bar).map((b) => b.title), field).toEqual([WRAP_HINT, WRAP_HINT, WRAP_HINT, WRAP_HINT]);
      un();
    }
  });

  it('🔑 状態が変わったときだけ書く(同じ状態の selectionchange では 1 度も title を書かない)', () => {
    const { region, bar, ta } = surface();
    const un = watchWrapHint(region);
    const writes: string[] = [];
    // title の setter を数える(happy-dom の prototype 側を包む)
    // `title` は祖先の prototype に居る(HTMLElement)── 持ち主まで遡る
    let proto = Object.getPrototypeOf(wrapButtons(bar)[0]!) as object;
    while (proto !== null && Object.getOwnPropertyDescriptor(proto, 'title') === undefined)
      proto = Object.getPrototypeOf(proto) as object;
    const desc = Object.getOwnPropertyDescriptor(proto, 'title');
    // 空振り防止 ── setter が拾えなければ「書いていない」は自明に通る
    expect(desc?.set, 'title の setter が拾えない').toBeTypeOf('function');
    Object.defineProperty(proto, 'title', {
      configurable: true,
      get() {
        return desc!.get!.call(this);
      },
      set(v: string) {
        writes.push(v);
        desc!.set!.call(this, v);
      },
    });
    try {
      selectionChanged(); // 選んでいない → 選んでいない
      selectionChanged();
      expect(writes, '何も変わっていないのに書いた').toEqual([]);
      ta.setSelectionRange(0, 2);
      selectionChanged();
      expect(writes.length, '選んだとき 4 つ書いていない').toBe(4);
      ta.setSelectionRange(0, 4); // 選んだまま範囲だけ変わる
      selectionChanged();
      selectionChanged();
      expect(writes.length, '選んだまま範囲が動いただけで書き直した').toBe(4);
      ta.setSelectionRange(1, 1);
      selectionChanged();
      expect(writes.length, '戻すとき 4 つ書いていない').toBe(8);
    } finally {
      Object.defineProperty(proto, 'title', desc!);
      un();
    }
  });

  it('🔴 syncWrapHint は書き換えた数を返し、同じ状態なら 0(空振りと区別できる)', () => {
    const { bar } = surface();
    expect(syncWrapHint(bar, true)).toBe(4);
    expect(syncWrapHint(bar, true)).toBe(0);
    expect(syncWrapHint(bar, false)).toBe(4);
    expect(syncWrapHint(bar, false)).toBe(0);
  });

  it('🔴 選んでいる間に割当を組み直しても(applyShortcutHints)、切替は消えない / 戻したら元の土台', () => {
    const { bar } = surface();
    const k = new KeymapStore({ getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const base = titles(bar);
    syncWrapHint(bar, true);
    expect(applyShortcutHints(bar, k), '空振り').toBeGreaterThan(0);
    // 鍵の割当を持つボタン(= 説明の土台を名乗るボタン)も、選んでいる間は「囲みます」のまま
    for (const b of wrapButtons(bar)) {
      if (b.hasAttribute('data-pkc-hint-command')) expect(b.title).toBe(WRAP_HINT);
    }
    expect(wrapButtons(bar).filter((b) => b.hasAttribute('data-pkc-hint-command')).length).toBeGreaterThan(0);
    syncWrapHint(bar, false);
    expect(titles(bar)).toEqual(base);
  });
});

describe('編集セッションの寿命(#950 ①)', () => {
  it('🔴 unsubscribe の後は、selectionchange が来ても帯を書かない', () => {
    const { region, bar, ta } = surface();
    const un = watchWrapHint(region);
    un();
    ta.setSelectionRange(0, 3);
    selectionChanged();
    expect(wrapButtons(bar).filter((b) => b.title === WRAP_HINT)).toEqual([]);
  });

  it('🔴 編集を始めると 1 つ購読し、保存して抜けると同じ物を外す(実際の編集の流れ)', async () => {
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
      getBody: async () => 'abcdef',
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
    const addedBefore = added.length;
    q('[data-pkc-action="start-edit"]')!.click();
    const ta = q<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
    // 編集の面は selectionchange を 2 つ購読する(この件 + #1215 の選んだ範囲の字数)。
    // ⚠ 数が変わったら、足した購読を外す手順(`disposeLends`)も同じ数であることを見直す
    expect(added.length - addedBefore, '編集を始めても購読が 2 つ(説明の切替 + 字数)になっていない').toBe(2);
    const mine = added[addedBefore]!; // 先に購読するのが説明の切替
    expect(removed, '編集中に外れている').not.toContain(mine);

    // 実際の編集の中で効く(帯は detail.ts が組んだ本物)
    const bar = q('[data-pkc-region="format-bar"]')!;
    expect(wrapButtons(bar).length, '本物の帯で 4 つ拾えていない').toBe(4);
    ta.setSelectionRange(1, 4);
    selectionChanged();
    expect(wrapButtons(bar).map((b) => b.title)).toEqual([WRAP_HINT, WRAP_HINT, WRAP_HINT, WRAP_HINT]);

    q('[data-pkc-action="commit-edit"]')!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(q('[data-pkc-field="editor-body"]')).toBeNull();
    expect(removed, '編集を抜けたのに購読を外していない').toContain(mine);
  });
});
