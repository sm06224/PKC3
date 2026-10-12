/** @vitest-environment happy-dom */
/**
 * 🔴 **一覧が変わっても、変わっていない行の node は作り直さない**(#1087)。
 *
 * ## 何が起きていたか
 *
 * フォルダの表は、`entryMetas` の指紋が動くたびに `region.textContent = ''` で
 * **全行を作り直して**いた。平置き 5,700 件で「ノートを 1 件足す」と、
 * クリックから新しい行が見えるまで **2.7 秒**・renderer が **約 +120〜185 MB** 膨らんだ
 * (実ブラウザ・n=3。`docs/development/long-list-add-2026-10.md`)。
 *
 * ## 🔑 直し
 *
 * 表と tbody を持ち越し、行は**指紋(題名・種別・日付・名前の打ち替え・親の名前)が同じなら
 * 同じ node のまま**並べ直す(`reconcileRows`)。選択と印は属性だけ合わせる。
 *
 * ⚠ 守るのは「node が同じ」だけではない ── **見える結果は変えない**
 * (並び・選択・印・題名)。下の it は 2 つの向きを必ず対で持つ。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';

function meta(lid: string, order: number, title = 't-' + lid, archetype = 'text'): EntryMeta {
  return {
    lid,
    title,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const booted = (metas: EntryMeta[]): AppState =>
  reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] }).state;

/** 同じ state のまま `entryMetas` だけ差し替える(保存・取り込みで届く形)。 */
const withMetas = (s: AppState, metas: EntryMeta[]): AppState => ({
  ...s,
  entryMetas: new Map(metas.map((m) => [m.lid, m])),
});

function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  const pane = root.querySelector<HTMLElement>('[data-pkc-browse-pane="filer"]')!;
  const row = (lid: string) => pane.querySelector<HTMLElement>(`tbody [data-pkc-entry="${lid}"]`);
  const order = () =>
    [...pane.querySelectorAll<HTMLElement>('tbody tr')].map((r) => r.getAttribute('data-pkc-entry'));
  return { render: (s: AppState) => browse.render(s, 'filer'), row, order, pane };
}

beforeEach(() => {
  document.body.textContent = '';
});

const BASE = [meta('a', 1), meta('b', 2), meta('c', 3)];

describe('一覧が変わっても、変わっていない行の node は持ち越す(#1087)', () => {
  it('🔴 1 件足しても、表も既存の行も同じ node のまま(末尾へ)', () => {
    const { render, row, order, pane } = setup();
    const s0 = booted(BASE);
    render(s0);
    const table = pane.querySelector('table');
    const before = ['a', 'b', 'c'].map((l) => row(l));
    expect(before.every((r) => r !== null), '前提が崩れている(行が出ていない)').toBe(true);

    render(withMetas(s0, [...BASE, meta('d', 4)]));

    expect(order(), '新しい行が末尾に出ていない').toEqual(['a', 'b', 'c', 'd']);
    expect(pane.querySelector('table'), '表を作り直した').toBe(table);
    ['a', 'b', 'c'].forEach((l, i) => expect(row(l), `${l} の行を作り直した`).toBe(before[i]));
  });

  it('🔴 途中へ足したら、その位置に入り、他の行は同じ node のまま', () => {
    const { render, row, order } = setup();
    const s0 = booted(BASE);
    render(s0);
    const before = ['a', 'b', 'c'].map((l) => row(l));

    render(withMetas(s0, [meta('a', 1), meta('x', 2), meta('b', 3), meta('c', 4)]));

    expect(order()).toEqual(['a', 'x', 'b', 'c']);
    ['a', 'b', 'c'].forEach((l, i) => expect(row(l), `${l} の行を作り直した`).toBe(before[i]));
  });

  it('🔴 1 件消したら、その行だけ消え、他は同じ node のまま', () => {
    const { render, row, order } = setup();
    const s0 = booted(BASE);
    render(s0);
    const [a, c] = [row('a'), row('c')];
    const gone = row('b')!;

    render(withMetas(s0, [BASE[0]!, BASE[2]!]));

    expect(order()).toEqual(['a', 'c']);
    expect(gone.isConnected, '消えたノートの行が残っている').toBe(false);
    expect(row('a')).toBe(a);
    expect(row('c')).toBe(c);
  });

  /**
   * 🔴 **対照群**(空振り防止)。⚠ 持ち越しが「何でも持ち越す」に化けていないこと ──
   * 題名が変われば、その行は作り直されて新しい字が出る(他の行は同じ node のまま)。
   */
  it('対照群: 題名が変わった行だけ作り直され、字が新しくなる', () => {
    const { render, row, pane } = setup();
    const s0 = booted(BASE);
    render(s0);
    const [a, c] = [row('a'), row('c')];
    const b = row('b');

    render(withMetas(s0, [BASE[0]!, meta('b', 2, 'あたらしい名前'), BASE[2]!]));

    expect(row('b'), '題名が変わったのに行を持ち越した').not.toBe(b);
    expect(row('b')!.textContent).toContain('あたらしい名前');
    expect(pane.textContent, '古い題名が残っている').not.toContain('t-b');
    expect(row('a')).toBe(a);
    expect(row('c')).toBe(c);
  });

  it('対照群: 種類(アイコン)が変わった行も作り直される', () => {
    const { render, row } = setup();
    const s0 = booted(BASE);
    render(s0);
    const b = row('b');

    render(withMetas(s0, [BASE[0]!, meta('b', 2, 't-b', 'folder'), BASE[2]!]));

    expect(row('b'), '種類が変わったのに行を持ち越した').not.toBe(b);
    expect(row('b')!.getAttribute('data-pkc-archetype')).toBe('folder');
    expect(row('b')!.getAttribute('data-pkc-drop'), 'フォルダの落とし先の印が無い').toBe('folder');
  });

  it('🔴 並び順が変わったら、同じ node のまま並び直る(作り直さない)', () => {
    const { render, row, order } = setup();
    const s0 = booted(BASE);
    render(s0);
    const before = ['a', 'b', 'c'].map((l) => row(l));

    render(withMetas(s0, [meta('a', 3), meta('b', 1), meta('c', 2)]));

    expect(order(), '並びが変わっていない').toEqual(['b', 'c', 'a']);
    ['a', 'b', 'c'].forEach((l, i) => expect(row(l), `${l} の行を作り直した`).toBe(before[i]));
  });

  it('🔴 見える結果は同じ: 選択の印は持ち越した行でも正しい 1 行にだけ付く', () => {
    const { render, row } = setup();
    let s = booted(BASE);
    render(s);
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'b' }).state;
    render(s);
    const b = row('b')!;
    expect(b.hasAttribute('data-pkc-selected'), '前提が崩れている').toBe(true);

    s = withMetas(s, [...BASE, meta('d', 4)]);
    render(s);
    expect(row('b'), '選んだ行を作り直した').toBe(b);
    expect(b.hasAttribute('data-pkc-selected')).toBe(true);
    expect(document.querySelectorAll('tbody [data-pkc-selected]').length, '選択の印が 1 つでない').toBe(1);

    // 選択が別の行へ移り、同時に一覧も変わった回: 古い印が残らない
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'c' }).state;
    s = withMetas(s, [...BASE, meta('d', 4), meta('e', 5)]);
    render(s);
    expect(row('b')!.hasAttribute('data-pkc-selected'), '古い選択の印が残った').toBe(false);
    expect(row('c')!.hasAttribute('data-pkc-selected')).toBe(true);
  });

  it('🔴 見える結果は同じ: 複数選択の印も、持ち越した行へ合わせる', () => {
    const { render, row } = setup();
    let s = booted(BASE);
    render(s);
    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'a' }).state;
    render(s);
    expect(row('a')!.hasAttribute('data-pkc-marked'), '前提が崩れている').toBe(true);
    const a = row('a');

    s = reduce(s, { type: 'TOGGLE_SELECT', lid: 'a' }).state;
    s = withMetas(s, [...BASE, meta('d', 4)]);
    render(s);

    expect(row('a'), '印を外した行を作り直した').toBe(a);
    expect(a!.hasAttribute('data-pkc-marked'), '外した印が残った').toBe(false);
    expect(a!.hasAttribute('aria-selected')).toBe(false);
  });

  it('🔴 焦点のある行は、1 件足しても焦点を保ったまま', () => {
    const { render, row } = setup();
    const s0 = booted(BASE);
    render(s0);
    const b = row('b')!;
    b.focus();
    expect(document.activeElement, '前提が崩れている(焦点が入らない)').toBe(b);

    render(withMetas(s0, [...BASE, meta('d', 4)]));

    expect(document.activeElement, '焦点が行から外れた').toBe(b);
  });

  it('焦点のある行へ `focus()` を撃ち直さない(見える位置へ動かさない)', () => {
    const { render, row } = setup();
    const s0 = booted(BASE);
    render(s0);
    const b = row('b')!;
    b.focus();
    const spy = vi.spyOn(b, 'focus');

    render(withMetas(s0, [...BASE, meta('d', 4)]));

    expect(spy, '焦点が在る行へ focus() を撃ち直した(スクロールが動く)').not.toHaveBeenCalled();
  });

  it('🔴 「更新」順のときは、日付が変わった行の字が新しくなる(古い日付を持ち越さない)', () => {
    const { render, row } = setup();
    let s0 = booted(BASE);
    s0 = { ...s0, entrySort: 'updated' };
    render(s0);
    const dateOf = (l: string) =>
      row(l)!.querySelector<HTMLElement>('[data-pkc-field="updated"]')!.textContent;
    expect(dateOf('a'), '前提が崩れている(日付が空でない)').toBe('');
    const at = `${new Date().getFullYear()}-01-02 03:04:05`;

    render(withMetas(s0, [{ ...BASE[0]!, updatedAt: at }, BASE[1]!, BASE[2]!]));

    expect(dateOf('a'), '日付が変わったのに古い字を持ち越した').toBe('01/02');
  });

  it('対照群: 焦点のある行が消えたら、表へ戻す(body に落とさない)', () => {
    const { render, row, pane } = setup();
    const s0 = booted(BASE);
    render(s0);
    row('b')!.focus();

    render(withMetas(s0, [BASE[0]!, BASE[2]!]));

    expect(document.activeElement).toBe(pane.querySelector('table'));
  });
});
