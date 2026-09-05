/** @vitest-environment happy-dom */
/**
 * 🔴 **空の一覧に「次の一手」を置く**(#722 P2-13)。
 *
 * 立ち上げた直後の PKC は 0 件で、出ていた字は「まだ何もありません」だけだった ──
 * 案内は**本文の面**に在るが、狭い幅では本文が別ページなので**画面の外**である。
 *
 * ## ここで守るもの
 *
 * | 主張 | なぜ |
 * |---|---|
 * | 0 件のとき、一覧タブ / フォルダの面の**両方**に 2 つの口が出る | 面によって出たり出なかったりしたら、それは動線ではない |
 * | 絞り込みで 0 件のときは**出さない** | ノートは在る ── 要るのは「作る」ではなく「絞りを外す」 |
 * | 押すと**本当にノートができる** | 出しただけの口は dead click(#722 が直そうとしている当のもの) |
 * | 「取り込む」が**既存の受け手**に届く | 同じ仕事の受け手を 2 つ作らない(CLAUDE.md §7) |
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { bindActions } from '../../src/adapter/ui/actions/binder';

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

type Mode = 'list' | 'filer';

function setup(metas: EntryMeta[], relations: Relation[] = [], mode: Mode = 'list') {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost, mode);
  d.onState((s) => browse.render(s, mode));
  bindActions(root, d);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations });
  return { root, d };
}

/** 「次の一手」の器。⚠ **面の中で**探す(別の面の字に満たされない ── CLAUDE.md §1)。 */
const box = (root: HTMLElement, mode: Mode): HTMLElement | null =>
  root.querySelector<HTMLElement>(
    `[data-pkc-browse-pane="${mode}"] [data-pkc-field="empty-start"]`,
  ) ??
  // ⚠ 一覧タブの器は `entry-list` の**すぐ後ろ**に置かれる(器を作り替えないため
  //    `browse-pane` に包まれていない)── その形も受ける
  root.querySelector<HTMLElement>(
    '[data-pkc-region="sidebar"] [data-pkc-field="entry-list-empty"] [data-pkc-field="empty-start"]',
  );

const labels = (el: HTMLElement | null): string[] =>
  [...(el?.querySelectorAll('button') ?? [])].map((b) => b.textContent ?? '');

beforeEach(() => {
  document.body.textContent = '';
});

describe('🔴 一覧が空のとき、次の一手を出す(#722 P2-13)', () => {
  for (const mode of ['list', 'filer'] as const) {
    it(`🔴 ${mode}: 0 件なら「作る」と「取り込む」が出る`, () => {
      const { root } = setup([], [], mode);
      const el = box(root, mode);
      expect(el, `${mode}: 0 件なのに次の一手が無い`).not.toBeNull();
      expect(labels(el), `${mode}: 口が 2 つ揃っていない`).toEqual([
        '+ ノートを作る',
        '取り込む',
      ]);
    });

    it(`⚠ 対照群 ${mode}: 1 件でも在れば出さない`, () => {
      const { root } = setup([meta('a', 1, '買い物メモ')], [], mode);
      expect(box(root, mode), `${mode}: ノートが在るのに「作る」を勧めた`).toBeNull();
    });

    it(`🔴 ${mode}: 絞り込みで 0 件になっただけなら出さない`, () => {
      const { root, d } = setup([meta('a', 1, '買い物メモ')], [], mode);
      d.dispatch({ type: 'SET_ENTRY_FILTER', query: '存在しない語' });
      // ⚠ **前提**:絞りで 0 件になっている(ここが崩れると何も見ていない)
      expect(
        root.querySelectorAll(`[data-pkc-browse-pane="${mode}"] [data-pkc-entry]`).length +
          root.querySelectorAll('[data-pkc-region="entry-list"] [data-pkc-entry]').length,
        '前提が崩れている(絞っても行が残っている)',
      ).toBe(0);
      expect(box(root, mode), `${mode}: ノートは在るのに「作る」を勧めた`).toBeNull();
    });
  }

  /**
   * 🔴 **フォルダの中が空でも出さない**。
   * ⚠ 空なのは**このフォルダ**だけで、「取り込む」の行き先はここではない ──
   *   既存の字(「このフォルダは空です」/「まだ何もありません」)がその 2 つを
   *   既に見分けているので、判定をそこに合わせる。
   */
  it('🔴 フォルダの中が空でも出さない(空なのは PKC ではなくこのフォルダ)', () => {
    const { root, d } = setup([meta('f1', 1, '箱', 'folder')], [], 'filer');
    d.dispatch({ type: 'SET_SCOPE', lid: 'f1' });
    const pane = root.querySelector<HTMLElement>('[data-pkc-browse-pane="filer"]');
    expect(
      pane?.querySelector('[data-pkc-field="filer-empty"]')?.textContent,
      '前提が崩れている(フォルダの中に入っていない)',
    ).toBe('このフォルダは空です');
    expect(box(root, 'filer'), 'フォルダの中で PKC ごと空のように勧めた').toBeNull();
  });

  /**
   * 🔴 **押したら本当にノートができる**(dead click にしない)。
   * ⚠ `create-entry` は種類を**隣の `<select>`** から取る形なので、離れた場所に
   *   置いたこのボタンは自分で `data-pkc-archetype` を名乗る必要がある ──
   *   名乗りを落とすと binder は**黙って return する**(いちばん気づけない壊れ方)。
   */
  it('🔴 「+ ノートを作る」を押すと、本当に 1 件できる', () => {
    const { root, d } = setup([], [], 'filer');
    const btn = box(root, 'filer')?.querySelector<HTMLElement>(
      '[data-pkc-field="empty-start-create"]',
    );
    expect(btn, '押す口が無い').not.toBeNull();
    btn!.click();
    expect(d.getState().entryMetas.size, '押しても何も起きない(dead click)').toBe(1);
    expect(
      [...d.getState().entryMetas.values()][0]?.archetype,
      '別の種類ができた(種類の名乗りが落ちている)',
    ).toBe('text');
  });

  /**
   * 🔴 **「取り込む」は既存の受け手に届く**(新しい受け手を作らない ── §7)。
   * 🔑 観測点は**器の中の hidden な file 選択**が押されたこと ── `import-file` の
   *   仕事はそこを叩くことなので、届いたかはここでしか見えない。
   */
  it('🔴 「取り込む」は既存の file 選択を開く', () => {
    const { root } = setup([], [], 'filer');
    const input = root.querySelector<HTMLInputElement>('[data-pkc-field="import-input"]');
    expect(input, '前提が崩れている(器に file 選択が無い)').not.toBeNull();
    const spy = vi.spyOn(input!, 'click').mockImplementation(() => {});
    box(root, 'filer')
      ?.querySelector<HTMLElement>('[data-pkc-field="empty-start-import"]')!
      .click();
    expect(spy, '押しても file 選択が開かない').toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 **一覧タブとフォルダの面で、同じ物が出る**(部品を 2 か所で組まない)。
   * ⚠ 片方だけ直す事故は CLAUDE.md §7 の常連なので、**並べて**見る。
   */
  it('🔴 2 つの面で、出る口の綴りが揃っている', () => {
    const a = setup([], [], 'list');
    const listLabels = labels(box(a.root, 'list'));
    document.body.textContent = '';
    const b = setup([], [], 'filer');
    expect(labels(box(b.root, 'filer')), '面によって口の字が違う').toEqual(listLabels);
    expect(listLabels.length, '空振り(どちらの面にも口が無い)').toBe(2);
  });
});
