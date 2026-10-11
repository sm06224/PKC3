/** @vitest-environment happy-dom */
/**
 * 🔴 **ノートをブックマークに入れる**(#1377)。
 *
 * 守る主張:
 * 1. **置けるなら外せる** ── 行のメニューの「入れる」と「外す」が同じ場所に対で出る
 * 2. **帯の無い面には出さない** ── 左の列の行・フォルダの行には出ない
 * 3. **帯に並び、押すとそのノートのある場所へ移って行を選ぶ**(別のフォルダを見ていても)
 * 4. **消えたノートは帯に出ない。保存は次の足す / 外すまで残る**(ゴミ箱から戻せば復活する)
 * 5. **上限は生きているものだけで数える。満杯なら理由を声に出して断る**
 *
 * ⚠ 台は実物(shell + DualFilerRenderer + BrowseRouter + binder)── メニューが運ぶ lid と
 *   binder の受け手と帯の描画の**合意**は、どれか 1 つの unit には書けない(§7)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { DualFilerRenderer } from '../../src/adapter/ui/render/dual-filer';
import { appDualPrefs } from '../../src/adapter/ui/render/dual-prefs';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { paneOf, paneScope } from '../../src/features/relation/dual-pane';
import {
  MAX_BOOKMARKS,
  MAX_BOOKMARKS_STORED,
  noteBookmarkKey,
} from '../../src/features/relation/dual-bookmarks';

/** この台のコレクションは 'c1'(`SYS_BOOTED` の cid)。別のコレクションは 'c2'。 */
const K = (lid: string, cid = 'c1'): string => noteBookmarkKey(cid, lid);

function meta(lid: string, order: number, archetype = 'text'): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
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

/** ルート: n1 / n2 / f1(フォルダ)。f1 の中に x。 */
const METAS = [meta('n1', 1), meta('n2', 2), meta('f1', 3, 'folder'), meta('x', 4)];
const RELS: Relation[] = [
  { id: 'r1', fromLid: 'f1', toLid: 'x', kind: 'structural', createdAt: null, updatedAt: null },
];

const MENU = '[data-pkc-region="context-menu"]';
const BAR = '[data-pkc-region="dual-bookmarks"]';

function rightClick(el: Element): void {
  el.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
  );
}

beforeEach(() => {
  document.body.textContent = '';
  resetAppDialogForTest();
  appDualPrefs.setBookmarks([]);
});

function setup(metas: readonly EntryMeta[] = METAS) {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const dual = new DualFilerRenderer(regions.center);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  d.onState((s) => {
    dual.render(s);
    browse.render(s, 'filer');
  });
  // ⚠ main.ts の `toggleDualBookmark` と同じ形(保存を動かして描き直す)
  bindActions(root, d, {
    toggleDualBookmark: (key) => {
      appDualPrefs.toggleBookmark(key);
      dual.render(d.getState());
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [...metas], relations: RELS });
  d.dispatch({ type: 'SET_VIEW_MODE', mode: 'dual' });
  const dualRow = (side: 'left' | 'right', lid: string): HTMLElement => {
    const el = regions.center.querySelector<HTMLElement>(
      `[data-pkc-region="dual-pane"][data-pkc-side="${side}"] [data-pkc-region="dual-table"] [data-pkc-entry="${lid}"]`,
    );
    expect(el, `前提が崩れている: 2 ペインに ${lid} の行が無い`).not.toBeNull();
    return el!;
  };
  const has = (action: string): boolean =>
    root.querySelector(`${MENU} [data-pkc-action="${action}"]`) !== null;
  const press = (action: string): void => {
    const b = root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="${action}"]`);
    expect(b, `メニューに ${action} が無い`).not.toBeNull();
    b!.click();
  };
  const strip = (side: 'left' | 'right' = 'left'): HTMLElement =>
    regions.center.querySelector<HTMLElement>(
      `[data-pkc-region="dual-pane"][data-pkc-side="${side}"] ${BAR}`,
    )!;
  return { root, d, regions, dual, dualRow, has, press, strip };
}

describe('メニューの「入れる / 外す」(#1377)', () => {
  it('🔴 入っていなければ「入れる」だけ、入っていれば「外す」だけが出る(対)', () => {
    const t = setup();
    rightClick(t.dualRow('left', 'n1'));
    expect(t.has('bookmark-note-add'), '入れる口が無い').toBe(true);
    expect(t.has('bookmark-note-remove'), '入っていないのに外す口が出ている').toBe(false);
    t.press('bookmark-note-add');
    expect(appDualPrefs.getBookmarks(), '保存に入っていない').toEqual([K('n1')]);
    document.body.querySelector(MENU)?.remove();
    rightClick(t.dualRow('left', 'n1'));
    expect(t.has('bookmark-note-remove'), '入ったのに外す口が無い(片道)').toBe(true);
    expect(t.has('bookmark-note-add'), '入っているのに入れる口が出ている').toBe(false);
    t.press('bookmark-note-remove');
    expect(appDualPrefs.getBookmarks(), '外しても保存に残っている').toEqual([]);
  });

  it('🔴 フォルダの行には出ない(場所は列の頭の ☆ で入れる)', () => {
    const t = setup();
    rightClick(t.dualRow('left', 'f1'));
    expect(t.root.querySelector(MENU), '空振り防止(メニューが出ていない)').not.toBeNull();
    expect(t.has('bookmark-note-add')).toBe(false);
    expect(t.has('bookmark-note-remove')).toBe(false);
  });

  it('🔴 左の列(ブックマークの帯が見えない面)の行には出ない', () => {
    const t = setup();
    const row = t.regions.browseHost.querySelector<HTMLElement>(
      '[data-pkc-region="filer-table"] tbody [data-pkc-entry="n1"]',
    );
    expect(row, '前提が崩れている: 左の列の行が無い').not.toBeNull();
    rightClick(row!);
    expect(t.root.querySelector(MENU), '空振り防止(メニューが出ていない)').not.toBeNull();
    expect(t.has('bookmark-note-add'), '帯の無い面に「入れる」が出ている').toBe(false);
  });
});

describe('帯に並ぶ・開く・外す(#1377)', () => {
  it('🔴 入れると帯に題名で並び、× で外すと消える(同じ帯から外せる)', () => {
    const t = setup();
    rightClick(t.dualRow('left', 'n1'));
    t.press('bookmark-note-add');
    const bar = t.strip();
    expect(bar.hidden, '帯が出ていない').toBe(false);
    expect(bar.textContent).toContain('t-n1');
    const off = bar.querySelector<HTMLElement>('[data-pkc-action="dual-bookmark-remove"]')!;
    off.click();
    expect(appDualPrefs.getBookmarks(), '帯の × で外せない').toEqual([]);
    expect(t.strip().hidden, '外したのに帯が残っている').toBe(true);
  });

  it('🔴 別のフォルダの中のノートも、押すとそのフォルダへ移って行を選ぶ', () => {
    const t = setup();
    appDualPrefs.setBookmarks([K('x')]);
    t.dual.render(t.d.getState());
    // 前提: 左はルートを見ていて、x の行は表に無い
    expect(paneScope(paneOf(t.d.getState().dual, 'left')), '前提が崩れている').toBeNull();
    const go = t.strip('left').querySelector<HTMLElement>(
      '[data-pkc-action="dual-bookmark-open"][data-pkc-entry="x"]',
    )!;
    expect(go, '帯にノートの口が無い').not.toBeNull();
    go.click();
    const pane = paneOf(t.d.getState().dual, 'left');
    expect(paneScope(pane), 'ノートのある場所へ移っていない').toBe('f1');
    expect(pane.selection, 'ノートの行が選ばれていない').toEqual(['x']);
    expect(t.d.getState().viewMode, '2 ペインを抜けた(本文の画面へ切り替わった)').toBe('dual');
  });

  it('対照群: 場所(フォルダ)のブックマークは今までどおり、その場所へ入る', () => {
    const t = setup();
    appDualPrefs.setBookmarks(['f1']);
    t.dual.render(t.d.getState());
    t.strip('left')
      .querySelector<HTMLElement>('[data-pkc-action="dual-bookmark-open"][data-pkc-entry="f1"]')!
      .click();
    const pane = paneOf(t.d.getState().dual, 'left');
    expect(paneScope(pane)).toBe('f1');
    expect(pane.selection, '場所なのに行を選んだ').toEqual([]);
  });
});

describe('消えたノート(#1377)', () => {
  it('🔴 消えたノートは帯に出ない。保存はそのまま残る(ゴミ箱から戻せば帯へ復活する)', () => {
    const t = setup();
    appDualPrefs.setBookmarks([K('n1'), K('n2')]);
    t.dual.render(t.d.getState());
    expect(t.strip().querySelectorAll('[data-pkc-action="dual-bookmark-open"]')).toHaveLength(2);
    // n1 が消えた(ゴミ箱へ)
    t.d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: METAS.filter((m) => m.lid !== 'n1'),
      relations: RELS,
    });
    const opens = [...t.strip().querySelectorAll('[data-pkc-action="dual-bookmark-open"]')];
    expect(opens.map((o) => o.getAttribute('data-pkc-entry')), '消えたノートが帯に残っている').toEqual(['n2']);
    expect(appDualPrefs.getBookmarks(), '描くだけで保存を書き換えている').toHaveLength(2);
    // 戻ってきたら復活する
    t.d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    expect(t.strip().querySelectorAll('[data-pkc-action="dual-bookmark-open"]')).toHaveLength(2);
  });

  it('🔴 別のブックマークを足しても外しても、消えたノートの綴りは保存に残る(戻せば復活する)', () => {
    const t = setup(METAS.filter((m) => m.lid !== 'n1'));
    appDualPrefs.setBookmarks([K('n1')]); // n1 はもう無い
    rightClick(t.dualRow('left', 'n2'));
    t.press('bookmark-note-add');
    expect(appDualPrefs.getBookmarks(), '足したら消えたノートの綴りが落ちた').toEqual([K('n1'), K('n2')]);
    document.body.querySelector(MENU)?.remove();
    rightClick(t.dualRow('left', 'n2'));
    t.press('bookmark-note-remove');
    expect(appDualPrefs.getBookmarks(), '外したら消えたノートの綴りが落ちた').toEqual([K('n1')]);
    // ゴミ箱から戻った = 帯へ無条件に復活する
    t.d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    expect(
      [...t.strip().querySelectorAll('[data-pkc-action="dual-bookmark-open"]')].map((o) =>
        o.getAttribute('data-pkc-entry'),
      ),
      '戻したのに帯に出ない',
    ).toEqual(['n1']);
  });

  it('対照群: 消えた場所(フォルダ)は今までどおり帯に出て、外せる', () => {
    const t = setup();
    appDualPrefs.setBookmarks(['もう無い']);
    t.dual.render(t.d.getState());
    const go = t.strip().querySelector<HTMLButtonElement>(
      '[data-pkc-action="dual-bookmark-open"][data-pkc-entry="もう無い"]',
    );
    expect(go, '消えた場所が帯から消えた(外しようが無くなる)').not.toBeNull();
    expect(go!.disabled).toBe(true);
  });
});

describe('上限と、コレクションごとの分け方(#1377)', () => {
  it('🔴 上限は「このコレクションの生きているもの」だけで数える(消えた分・別のコレクションの分は数えない)', () => {
    const t = setup();
    const dead = Array.from({ length: 10 }, (_, i) => K(`gone${String(i)}`));
    const other = Array.from({ length: 10 }, (_, i) => K(`o${String(i)}`, 'c2'));
    appDualPrefs.setBookmarks(['f1', ...dead, ...other]); // 保存は 21 件、生きているのは 1 件
    rightClick(t.dualRow('left', 'n1'));
    t.press('bookmark-note-add');
    expect(appDualPrefs.getBookmarks(), '数えてはいけない分に上限を食われた').toContain(K('n1'));
    expect(t.d.getState().error, '入るのに断っている').toBeNull();
  });

  it('🔴 別のコレクションのノートは、帯に出ず、足す / 外すでも消えない(同じ lid でも取り違えない)', () => {
    const t = setup();
    appDualPrefs.setBookmarks([K('n1', 'c2')]); // 別のコレクションの n1
    t.dual.render(t.d.getState());
    expect(
      t.strip().querySelectorAll('[data-pkc-action="dual-bookmark-open"]'),
      '別のコレクションのノートが帯に出ている',
    ).toHaveLength(0);
    rightClick(t.dualRow('left', 'n1'));
    expect(t.has('bookmark-note-add'), '別のコレクションの分で「入っている」と読んだ').toBe(true);
    t.press('bookmark-note-add');
    expect(appDualPrefs.getBookmarks(), '別のコレクションの綴りが消えた / 入っていない').toEqual([
      K('n1', 'c2'),
      K('n1'),
    ]);
  });

  it('🔴 帯は「いまのコレクション」の綴りだけを出す(コレクションが c2 なら c1 の綴りは出ず、c2 の綴りは出る)', () => {
    const t = setup();
    appDualPrefs.setBookmarks([K('n1'), K('n2', 'c2')]);
    t.d.dispatch({ type: 'SYS_BOOTED', cid: 'c2', metas: METAS, relations: RELS });
    const shown = [...t.strip().querySelectorAll('[data-pkc-action="dual-bookmark-open"]')].map((o) =>
      o.getAttribute('data-pkc-entry'),
    );
    expect(shown, 'コレクションの id を見ずに出している').toEqual(['n2']);
  });

  it('🔴 ☆(場所)も保存の総数の上限で断られる', () => {
    const t = setup();
    appDualPrefs.setBookmarks(Array.from({ length: MAX_BOOKMARKS_STORED }, (_, i) => K(`o${String(i)}`, 'c2')));
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' });
    t.regions.center
      .querySelector<HTMLElement>('[data-pkc-region="dual-pane"][data-pkc-side="left"] [data-pkc-action="dual-bookmark"]')!
      .click();
    expect(appDualPrefs.getBookmarks(), '総数の上限を超えて場所を足している').toHaveLength(MAX_BOOKMARKS_STORED);
    expect(t.d.getState().error, '断った理由が出ていない').toContain(String(MAX_BOOKMARKS_STORED));
  });

  it('🔴 生きている 20 件で満杯なら理由を声に出して断り、増えない', () => {
    const t = setup([...METAS, ...Array.from({ length: MAX_BOOKMARKS }, (_, i) => meta(`m${String(i)}`, 10 + i))]);
    appDualPrefs.setBookmarks(Array.from({ length: MAX_BOOKMARKS }, (_, i) => K(`m${String(i)}`)));
    rightClick(t.dualRow('left', 'n1'));
    t.press('bookmark-note-add');
    expect(appDualPrefs.getBookmarks(), '満杯なのに増えた').toHaveLength(MAX_BOOKMARKS);
    expect(appDualPrefs.getBookmarks()).not.toContain(K('n1'));
    expect(t.d.getState().error, '断った理由が出ていない').toContain('ブックマークは 20 件までです');
  });

  it('🔴 保存の総数が上限なら、足すのを断る(外すのは通る)', () => {
    const t = setup();
    const stored = Array.from({ length: MAX_BOOKMARKS_STORED }, (_, i) => K(`o${String(i)}`, 'c2'));
    appDualPrefs.setBookmarks(stored);
    expect(appDualPrefs.getBookmarks(), '前提が崩れている(読み込みで切られた)').toHaveLength(MAX_BOOKMARKS_STORED);
    rightClick(t.dualRow('left', 'n1'));
    t.press('bookmark-note-add');
    expect(appDualPrefs.getBookmarks(), '総数の上限を超えて足している').toHaveLength(MAX_BOOKMARKS_STORED);
    expect(t.d.getState().error, '断った理由が出ていない').toContain(String(MAX_BOOKMARKS_STORED));
  });
});

describe('開くとき、そのペインの名前の絞りを解く(#1377)', () => {
  it('🔴 絞りが掛かっていても、押すとノートの行が選ばれる(絞りは解ける)', () => {
    const t = setup();
    appDualPrefs.setBookmarks([K('x')]);
    // 左を「zzz」で絞り、x(フォルダ f1 の中)を押す ── 絞りが残っていれば行が表に無い
    t.d.dispatch({ type: 'DUAL_SET_FILTER', side: 'left', filter: 'zzz' });
    expect(paneOf(t.d.getState().dual, 'left').filter, '前提が崩れている').toBe('zzz');
    t.strip('left').querySelector<HTMLElement>('[data-pkc-action="dual-bookmark-open"]')!.click();
    const pane = paneOf(t.d.getState().dual, 'left');
    expect(pane.filter, '絞りが残っている').toBe('');
    expect(pane.selection).toEqual(['x']);
    expect(
      t.regions.center.querySelectorAll('[data-pkc-region="dual-pane"][data-pkc-side="left"] [data-pkc-entry][data-pkc-marked]'),
      '選ばれた行が表に見えていない',
    ).toHaveLength(1);
  });

  it('対照群: 反対のペインの絞りは解かない', () => {
    const t = setup();
    appDualPrefs.setBookmarks([K('x')]);
    t.d.dispatch({ type: 'DUAL_SET_FILTER', side: 'right', filter: 'zzz' });
    t.strip('left').querySelector<HTMLElement>('[data-pkc-action="dual-bookmark-open"]')!.click();
    expect(paneOf(t.d.getState().dual, 'right').filter, '押していない側の絞りまで解けた').toBe('zzz');
  });
});
