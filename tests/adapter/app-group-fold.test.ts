/** @vitest-environment happy-dom */
/**
 * 🔴 **グループの見出しを押すと畳める**(#857 段④)。
 *
 * ⚠ 意味論(何を畳めるか / 絞り込み中は無視する)は
 *   `tests/features/group-fold.test.ts`。**ここが見るのは繋がり**である ──
 *   押した見出しから、保存と画面まで本当に届くか。
 *
 * 🔴 守る主張:
 * 1. 見出しを押すと、その群のタイルが**画面から消える**(件数は見出しに出る)
 * 2. もう一度押すと戻る
 * 3. **名前の無い群には押し所を出さない**(畳んだら開く口が消えるため)
 * 4. 🔴 **絞り込みを打つと、畳んでいても出る**(打ったのに何も出ない、を作らない)
 * 5. 畳みは**端末ごと**の保存に書かれる(state には入っていない)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LONG_PRESS_MS } from '../../src/adapter/ui/actions/long-press';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { LauncherRenderer } from '../../src/adapter/ui/render/launcher';
import { GroupFoldStore } from '../../src/adapter/ui/render/group-fold';
import { withBuiltinTiles, type LauncherTile } from '../../src/features/launcher/tiles';

function meta(lid: string, order: number): EntryMeta {
  return {
    lid,
    title: lid,
    archetype: 'attachment',
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

/** 名前の無い群に 1 枚、「資料」に 2 枚 + 組み込み。 */
const TILES = (): LauncherTile[] =>
  withBuiltinTiles(
    [
      { lid: 'a1', title: '電卓', group: '', kind: 'url', url: 'https://a.test/', order: 0 },
      { lid: 'b1', title: '地図', group: '資料', kind: 'url', url: 'https://b.test/', order: 0 },
      { lid: 'b2', title: '辞書', group: '資料', kind: 'url', url: 'https://c.test/', order: 1 },
    ],
    { office: false },
  );

let root: HTMLElement;
let region: HTMLElement;
let d: Dispatcher;
let folds: GroupFoldStore;
let detach: () => void;

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);
  region = document.createElement('div');
  root.append(region);
  folds = new GroupFoldStore(null);
  const r = new LauncherRenderer(region, folds);
  d = new Dispatcher();
  /**
   * 🔑 **配線は実物どうしで繋ぐ**(CLAUDE.md §7)── binder が撃つ service を
   *   `main.ts` と同じ形(保存へ書いて描き直す)でここに置く。
   */
  detach = bindActions(root, d, {
    toggleAppGroup: (g) => {
      folds.toggle(g);
      r.render(d.getState());
    },
    toggleAllAppGroups: (gs) => {
      folds.toggleAll(gs);
      r.render(d.getState());
    },
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a1', 1), meta('b1', 2), meta('b2', 3)],
    relations: [],
  });
  d.dispatch({ type: 'LAUNCHER_TILES_LOADED', tiles: TILES() });
  d.onState(() => r.render(d.getState()));
  r.render(d.getState());
});

afterEach(() => detach());

const headBtn = (name: string): HTMLElement => {
  const el = region.querySelector<HTMLElement>(`[data-pkc-action="toggle-app-group"][data-pkc-group="${name}"]`);
  expect(el, `「${name}」の見出しに押し所が無い`).not.toBeNull();
  return el!;
};
const foldAll = (): HTMLElement | null =>
  region.querySelector<HTMLElement>('[data-pkc-field="launcher-fold-all"]');
const shown = (lid: string): boolean =>
  region.querySelector(`[data-pkc-tile="${lid}"]`) !== null;
const heads = (): string[] =>
  [...region.querySelectorAll('[data-pkc-field="launcher-group"]')].map((h) => h.textContent ?? '');

describe('グループを畳む(#857 段④)', () => {
  it('🔴 ① 見出しを押すと中のタイルが消え、件数が出る', () => {
    expect(shown('b1') && shown('b2'), '前提が崩れている').toBe(true);
    headBtn('資料').click();
    expect(shown('b1') || shown('b2'), '畳んだのにタイルが残っている').toBe(false);
    expect(heads(), '畳んだのに件数が出ていない').toContain('資料(2)');
    // ⚠ 他の群は巻き込まない(名前の無い群のタイルは出たまま)
    expect(shown('a1'), '関係ない群まで畳んだ').toBe(true);
  });

  it('🔴 ② もう一度押すと戻る', () => {
    headBtn('資料').click();
    headBtn('資料').click();
    expect(shown('b1') && shown('b2'), '開かない(片道の操作になっている)').toBe(true);
    expect(heads(), '開いたのに件数が残っている').toContain('資料');
  });

  it('🔴 ③ 名前の無い群には押し所を出さない(開く口が消えるため)', () => {
    expect(
      region.querySelector('[data-pkc-action="toggle-app-group"][data-pkc-group=""]'),
      '名前の無い群に畳む口を出した',
    ).toBeNull();
  });

  it('🔴 ④ 絞り込みを打つと、畳んでいても出る', () => {
    headBtn('資料').click();
    expect(shown('b1'), '前提が崩れている(畳めていない)').toBe(false);
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '地図' });
    expect(shown('b1'), '絞り込んだのに畳みが隠した(打ったのに何も出ない)').toBe(true);
    // ⚠ 対照群 ── 絞り込みを消したら、畳みは効いたまま(押した覚えが消えない)
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '' });
    expect(shown('b1'), '絞り込みを消したら畳みまで解けた').toBe(false);
  });

  /**
   * 🔴 **すべて畳む / すべて開く**(#857 段④ の仕上げ)。
   * ⚠ 押し所は 1 つで、いまの状態で字が裏返る ── 2 つ並べるとどちらかが常に空振りする。
   */
  it('🔴 ⑥ 「すべて畳む」で名前の付いた群が全部畳まれ、字が裏返る', () => {
    const btn = foldAll();
    expect(btn, '「すべて畳む」の押し所が無い').not.toBeNull();
    expect(btn!.textContent, '全部開いているのに「すべて開く」と出ている').toBe('すべて畳む');

    btn!.click();
    expect(shown('b1') || shown('b2'), '「すべて畳む」で畳まれていない').toBe(false);
    // ⚠ 名前の無い群は畳めない ── 巻き込まれていないこと(開く口が消えないため)
    expect(shown('a1'), '名前の無い群まで畳んだ(開く口が画面から消える)').toBe(true);
    expect([...folds.get()].includes('資料'), '保存に書かれていない').toBe(true);
    expect(foldAll()?.textContent, '全部畳んだのに字が裏返らない').toBe('すべて開く');

    foldAll()!.click();
    expect(shown('b1') && shown('b2'), '「すべて開く」で開かない(片道の操作)').toBe(true);
    expect(foldAll()?.textContent, '全部開いたのに字が戻らない').toBe('すべて畳む');
  });

  it('🔴 ⑦ 名前の付いた群が 1 つも無ければ、押し所を出さない', () => {
    // ⚠ 名前の無いまとまりは畳めないので、出すと**押しても何も起きない**押し所になる
    d.dispatch({
      type: 'LAUNCHER_TILES_LOADED',
      tiles: [{ lid: 'a1', title: '電卓', group: '', kind: 'url', url: 'https://a.test/', order: 0 }],
    });
    expect(shown('a1'), '前提が崩れている(タイルが出ていない)').toBe(true);
    expect(foldAll(), '畳める群が無いのに「すべて畳む」を出した').toBeNull();
  });

  /**
   * 🔴 **絞り込み中は押し所を出さない**(#857 段④ の仕上げ)。
   *
   * ⚠ 絞り込み中は畳みを**無視して出す**(上の④)ので、ここで押せてしまうと
   *   **押しても画面が 1 ドットも変わらない**(無言の dead click)。しかも
   *   欄を空にした瞬間に畳まれるので、**忘れた頃に効く**という結び付けにくい形になる。
   */
  it('🔴 ⑧ 絞り込み中は、見出しにも「すべて畳む」にも押し所を出さない', () => {
    expect(foldAll(), '前提が崩れている').not.toBeNull();
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '地図' });
    expect(
      region.querySelector('[data-pkc-action="toggle-app-group"]'),
      '絞り込み中に畳む口が出ている(押しても何も起きない)',
    ).toBeNull();
    expect(foldAll(), '絞り込み中に「すべて畳む」が出ている').toBeNull();
    // ⚠ 字は出す ── どの群かは探している間も要る
    expect(heads().join(' '), '群の見出しの字まで消えた').toContain('資料');
    // 対照群 ── 欄を空にすれば押し所が戻る
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '' });
    expect(foldAll(), '絞り込みを消しても押し所が戻らない').not.toBeNull();
  });

  /**
   * 🔴 **「すべて」は、この面の中だけ**(#857 段④ の仕上げ。変異試験 M9 が教えた)。
   *
   * ⚠ 直す前は、範囲(`closest`)を document 全体の走査に変えても
   *   **20 件とも緑のまま**だった ── 面が 1 枚しか無いので区別が付かない。
   * 🔑 だから**おとりを 1 つ置く** ── 一覧の外に同じ押し所を生やし、
   *   それが巻き込まれないことを見る(別窓で 2 枚目の一覧が出た日に鳴る)。
   */
  it('🔴 ⑨ 一覧の外に同じ押し所が在っても、巻き込まない', () => {
    const decoy = document.createElement('button');
    decoy.setAttribute('data-pkc-action', 'toggle-app-group');
    decoy.setAttribute('data-pkc-group', 'よその面の群');
    root.append(decoy); // ⚠ **一覧(launcher-list)の外**に置く

    foldAll()!.click();
    const got = [...folds.get()];
    expect(got, '一覧の外の群まで畳んだ(範囲が面を越えている)').not.toContain('よその面の群');
    // ⚠ 対照群 ── 面の中の群は畳めている(何も畳まずに通る空振りではない)
    expect(got, '前提が崩れている(面の中の群も畳めていない)').toContain('資料');
  });

  /**
   * 🔴 **指だけの端末にも入口を置く**(#857 段②。着地前の動線レビュー)。
   *
   * ⚠ 目印を選ぶ口が**右クリックにしか無かった** ── 指で触る端末には
   *   入口が 1 つも無い(タイルの並べ替えで一度直した穴と**同じ形**)。
   * 🔑 長押しで**右クリックと同じメニュー**を出す(別の口を作らない)。
   */
  it('🔴 ⑩ 見出しを長押しすると、右クリックと同じメニューが出る', () => {
    vi.useFakeTimers();
    try {
      headBtn('資料').dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerType: 'touch',
          button: 0,
          clientX: 0,
          clientY: 0,
        }),
      );
      vi.advanceTimersByTime(LONG_PRESS_MS);
      const menu = root.querySelector('[data-pkc-region="context-menu"]');
      expect(menu, '長押ししてもメニューが出ない(指だけの端末に入口が無い)').not.toBeNull();
      const item = menu!.querySelector('[data-pkc-action="pick-app-group-icon"]');
      expect(item, '「目印を選ぶ…」が出ていない').not.toBeNull();
      // 🔑 **効く先は押した見出し**(メニューは root の直下に出るので、身元を写す)
      expect(item!.getAttribute('data-pkc-group'), '押した群が写っていない').toBe('資料');
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 🔴 **長押しの後の押しで畳まない**(#857 段②)。
   * ⚠ 押しを捨てる名前の一覧は**手で並んでいる**(`'dual-row' | 'open-tile'`)ので、
   *   足し忘れると**メニューが出たうえに、指を離した瞬間に畳まれる**。
   */
  it('🔴 ⑪ 長押しの直後の押しで、そのグループが畳まれない', () => {
    vi.useFakeTimers();
    try {
      const btn = headBtn('資料');
      btn.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerType: 'touch',
          button: 0,
          clientX: 0,
          clientY: 0,
        }),
      );
      vi.advanceTimersByTime(LONG_PRESS_MS);
      btn.click();
      expect(shown('b1'), '長押しの後の押しで畳まれた(押した物と効く先が食い違う)').toBe(true);
      expect([...folds.get()], '保存にまで畳みが書かれた').toEqual([]);
      /**
       * 🔴 **その押しでメニューが閉じない**(実ブラウザの smoke が掘った)。
       *
       * ⚠ 「押した物がメニューを開く口か」を見る一覧(`MENU_OPENERS`)は
       *   **捨てる一覧とは別に手で並んでいる**ので、片方だけ足すと
       *   **メニューは出るのに、指を離した瞬間に選ぶ前へ閉じる**。
       * ⚠ 右クリックで無事だったのは、**右ボタンの離しが `click` を撃たない**から ──
       *   穴が無かったのではなく、踏む経路が無かっただけである。
       */
      expect(
        root.querySelector('[data-pkc-region="context-menu"]'),
        '指を離した合図でメニューが閉じた(選ぶ前に消える)',
      ).not.toBeNull();
      /**
       * 🔴 **対照群 ── 緩めすぎていないこと。**
       * ⚠ 直しは「閉じる条件」を 1 つ緩めているので、**緩めすぎると今度は
       *   メニューが居座り、下に在る物を覆い隠す**(実ブラウザで実際にそうなった)。
       * 🔑 **本物の押し方で撃つ** ── `pointerdown` が先に来るので、長押しの窓は
       *   その時点で閉じている(合成 `click` だけでは、この門は何も見ない)。
       */
      const other = region.querySelector<HTMLElement>('[data-pkc-field="launcher-lead"]');
      expect(other, '前提が崩れている(押す先が無い)').not.toBeNull();
      other!.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', button: 0 }),
      );
      other!.click();
      expect(
        root.querySelector('[data-pkc-region="context-menu"]'),
        'メニューの外を普通に押しても閉じない(閉じる条件を緩めすぎている)',
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('🔴 ⑤ 畳みは保存の側に在る(state は 1 バイトも動かない)', () => {
    /**
     * ⚠ **「state に `資料` の字が無い」では見られない** ── 群の名前は
     *   タイルのデータとして state に**正しく在る**(1 稿目はそこで外した)。
     * 🔑 見るのは「**畳んでも state が動かない**」ことである。
     */
    const before = JSON.stringify(d.getState());
    headBtn('資料').click();
    expect([...folds.get()], '保存に書かれていない').toEqual(['資料']);
    expect(
      JSON.stringify(d.getState()),
      '端末ごとの見え方が container の state に紛れ込んでいる',
    ).toBe(before);
  });

  it('⚠ 組み込みの群も畳める(名前を持つので)', () => {
    expect(shown('builtin:dual'), '前提が崩れている').toBe(true);
    headBtn('組み込みアプリ').click();
    expect(shown('builtin:dual'), '組み込みの群だけ畳めない').toBe(false);
  });
});
