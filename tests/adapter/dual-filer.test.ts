/** @vitest-environment happy-dom */
/**
 * 2 ペインタブファイラ(#241 段⑥-a。user 指示 2026-08-17
 * 「アプリに 2 ペインタブファイラを**組み込みで**提供すること」)。
 *
 * 🔴 守る主張:
 * 1. **左右は別の場所を見る** ── 片方を動かしても、もう片方も左の列も動かない
 * 2. **側は「押した物」から決まる** ── 焦点の無いほうを押しても、押したほうが効く
 * 3. **移す向きは焦点の側から反対側へ**(画面にもそう出ている)
 * 4. **黙って断らない** ── 何も選ばずに押したら理由が出る
 * 5. **面は 2 つの表に登録されている** ── 開いたら本文ではなくこの面が出る
 * 6. **編集中でも開ける**(場所を眺めるだけ。実際に移すのは断られる)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { DualFilerRenderer } from '../../src/adapter/ui/render/dual-filer';
import { MAX_TABS, paneOf, paneScope } from '../../src/features/relation/dual-pane';

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
  };
}

function rel(id: string, fromLid: string, toLid: string): Relation {
  return { id, fromLid, toLid, kind: 'structural', createdAt: null, updatedAt: null };
}

/**
 * ルート直下に **フォルダ f1 / f2** と平の **a / b / c**。
 * f1 の中に **x / y** が 2 件。
 * ⚠ フォルダを 2 つ置くのは、**左右が別の場所を見る**ことを言うのに要るから
 *   (1 つだと「動いていない」と「同じ所を見ている」が区別できない)。
 * 🔴 **f1 の中を 2 件にしてある**(変異試験 M6 が生き延びて判明)── 1 件だと
 *   「そのペインの場所で範囲を採る」を壊しても `rangeInRows` が `[]` を返して
 *   **早期 return し、前の印がそのまま残る**ので、正しい答えと見分けが付かない。
 */
const METAS = [
  meta('f1', 1, 'はこ1', 'folder'),
  meta('f2', 2, 'はこ2', 'folder'),
  meta('a', 3, 'あ'),
  meta('b', 4, 'い'),
  meta('c', 5, 'う'),
  meta('x', 6, 'えっくす'),
  meta('y', 7, 'わい'),
];
const RELS = [rel('r1', 'f1', 'x'), rel('r2', 'f1', 'y')];

function booted(): AppState {
  return reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS })
    .state;
}

describe('2 ペインの reducer(#241 段⑥-a)', () => {
  it('🔴 片側の現在地を動かしても、もう片方と左の列は動かない', () => {
    const s = reduce(booted(), { type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' }).state;
    expect(paneScope(paneOf(s.dual, 'left'))).toBe('f1');
    expect(paneScope(paneOf(s.dual, 'right')), '反対側まで動いた').toBeNull();
    expect(s.scopeLid, '左の列(#240 の現在地)まで動いた').toBeNull();
  });

  it('現在地を触った側へ焦点も移る(移す向きの元になる)', () => {
    const s = reduce(booted(), { type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f2' }).state;
    expect(s.dual.focus, '押した側が元になっていない').toBe('right');
  });

  it('実在しない場所へは入らない', () => {
    const s0 = booted();
    const s = reduce(s0, { type: 'DUAL_SET_SCOPE', side: 'left', lid: 'nope' }).state;
    expect(s.dual, '消えた lid の中身として空の表が出る').toBe(s0.dual);
  });

  it('🔴 印の 3 種は左の列と同じ意味論(set / toggle / range)', () => {
    let s = reduce(booted(), { type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' }).state;
    expect(paneOf(s.dual, 'left').selection).toEqual(['a']);
    s = reduce(s, { type: 'DUAL_SELECT', side: 'left', lid: 'b', mode: 'toggle' }).state;
    expect(paneOf(s.dual, 'left').selection).toEqual(['a', 'b']);
    s = reduce(s, { type: 'DUAL_SELECT', side: 'left', lid: 'b', mode: 'toggle' }).state;
    expect(paneOf(s.dual, 'left').selection, 'もう一度で外れない').toEqual(['a']);
    // 起点は b(最後に印を動かした行)── 表示順で b..c
    s = reduce(s, { type: 'DUAL_SELECT', side: 'left', lid: 'c', mode: 'range' }).state;
    expect(paneOf(s.dual, 'left').selection).toEqual(['b', 'c']);
    expect(s.selection, '2 ペインの印が左の列まで動かした').toEqual([]);
  });

  /**
   * 🔴 **範囲はそのペインの表示順で採る**(#240 段②と同じ規則)。
   * ⚠ ペインの現在地ではなく `state.scopeLid` で並びを組むと、**別の場所の並び**で
   *   範囲が採られる ── この test はそこを突く(左は f1 の中を見ている)。
   */
  it('🔴 範囲は「そのペインが見ている場所」の並びで採る', () => {
    let s = reduce(booted(), { type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' }).state;
    s = reduce(s, { type: 'DUAL_SELECT', side: 'left', lid: 'x', mode: 'set' }).state;
    /**
     * ⚠ 左の列の現在地(ルート)で並びを組むと、`x` も `y` もその並びに**居ない**
     * ので `rangeInRows` が `[]` を返し、reducer は**早期 return する**
     * ── つまり壊れた実装の症状は「印が増えない」である。だから
     * **増えるはずの筋**(2 件)で見る(1 件で見ると見分けが付かない)。
     */
    s = reduce(s, { type: 'DUAL_SELECT', side: 'left', lid: 'y', mode: 'range' }).state;
    expect(paneOf(s.dual, 'left').selection, '別の場所の並びで範囲を採っている').toEqual([
      'x',
      'y',
    ]);
  });

  it('🔴 場所が変われば印は外れる(見えていないものを数えない)', () => {
    let s = reduce(booted(), { type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' }).state;
    s = reduce(s, { type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' }).state;
    expect(paneOf(s.dual, 'left').selection).toEqual([]);
  });

  it('タブを足す / 開く / 閉じる', () => {
    let s = reduce(booted(), { type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' }).state;
    s = reduce(s, { type: 'DUAL_TAB_ADD', side: 'left' }).state;
    expect(paneOf(s.dual, 'left').tabs).toHaveLength(2);
    s = reduce(s, { type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f2' }).state;
    expect(paneOf(s.dual, 'left').tabs.map((t) => t.scopeLid)).toEqual(['f1', 'f2']);
    s = reduce(s, { type: 'DUAL_TAB_ACTIVATE', side: 'left', index: 0 }).state;
    expect(paneScope(paneOf(s.dual, 'left'))).toBe('f1');
    s = reduce(s, { type: 'DUAL_TAB_CLOSE', side: 'left', index: 0 }).state;
    expect(paneOf(s.dual, 'left').tabs.map((t) => t.scopeLid)).toEqual(['f2']);
  });

  /**
   * 🔴 **消えたものは印からも現在地からも落ちる。**
   * ⚠ 掃除は `reduce` の 1 か所に在るので、**entry を消す case を足しても自動で乗る**
   *   ── ここはその配線が生きていることを見る。
   */
  it('🔴 消したフォルダを見ていたペインはルートへ戻り、印も落ちる', () => {
    let s = reduce(booted(), { type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' }).state;
    s = reduce(s, { type: 'DUAL_SELECT', side: 'left', lid: 'x', mode: 'set' }).state;
    s = reduce(s, { type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f2' }).state;
    expect(paneScope(paneOf(s.dual, 'left')), '前提が崩れている').toBe('f1');
    // 別タブが f1 を消した(= boot のやり直しで entryMetas が縮む)
    s = reduce(s, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: METAS.filter((m) => m.lid !== 'f1'),
      relations: [],
    }).state;
    expect(paneScope(paneOf(s.dual, 'left')), '消えたフォルダを見たまま').toBeNull();
    expect(paneOf(s.dual, 'left').selection, '消えた場所の印が残っている').toEqual([]);
    expect(paneScope(paneOf(s.dual, 'right')), '生きている側まで巻き添えになった').toBe('f2');
  });

  it('別の container を開いたら 2 ペインは畳む(lid の偶然衝突を持ち越さない)', () => {
    let s = reduce(booted(), { type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' }).state;
    s = reduce(s, { type: 'SYS_BOOTED', cid: 'other', metas: METAS, relations: RELS }).state;
    expect(paneScope(paneOf(s.dual, 'left'))).toBeNull();
  });

  /**
   * 🔴 **編集中でも場所は見られる**(P11 の「無言の dead click」を作り直さない)。
   * ⚠ 逆側(実際に動かす操作)は `moveEntries` が**声に出して**断る ── 下の binder の test。
   */
  it('🔴 編集中でも現在地と印は動く(止める理由が無い)', () => {
    let s = reduce(booted(), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '' }).state;
    s = reduce(s, { type: 'START_EDIT' }).state;
    expect(s.phase, '前提が崩れている').toBe('editing');
    s = reduce(s, { type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' }).state;
    expect(paneScope(paneOf(s.dual, 'left')), '編集中に黙って捨てられた').toBe('f1');
    s = reduce(s, { type: 'DUAL_SELECT', side: 'left', lid: 'x', mode: 'set' }).state;
    expect(paneOf(s.dual, 'left').selection).toEqual(['x']);
  });
});

describe('2 ペインの面(描画)', () => {
  let region: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '';
    region = document.createElement('div');
    document.body.append(region);
  });

  it('🔴 左右が別の場所を出す', () => {
    const r = new DualFilerRenderer(region);
    let s = reduce(booted(), { type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' }).state;
    s = reduce(s, { type: 'DUAL_FOCUS', side: 'left' }).state;
    r.render(s);
    /**
     * ⚠ **表へスコープする**(CLAUDE.md §1)。ペイン全体で `[data-pkc-entry]` を
     * 数えると、**パンくずのボタン**(それ自身が folder を表す要素なので
     * `data-pkc-entry` を持つ)に満たされて 1 件多く数える ── 1 稿目で実際に踏んだ。
     */
    const rows = (side: string): string[] =>
      [
        ...region.querySelectorAll(
          `[data-pkc-region="dual-pane"][data-pkc-side="${side}"] [data-pkc-region="dual-table"] [data-pkc-entry]`,
        ),
      ].map((e) => e.getAttribute('data-pkc-entry') ?? '');
    expect(rows('left'), '左が f1 の中を出していない').toEqual(['x', 'y']);
    expect(rows('right'), '右がルートを出していない').toEqual(['f1', 'f2', 'a', 'b', 'c']);
  });

  it('🔴 焦点の側に印が付き、真ん中のボタンの向きがそれに従う', () => {
    const r = new DualFilerRenderer(region);
    let s = booted();
    r.render(s);
    const pane = (side: string) =>
      region.querySelector(`[data-pkc-region="dual-pane"][data-pkc-side="${side}"]`)!;
    const move = () => region.querySelector('[data-pkc-field="dual-move"]')!;
    expect(pane('left').hasAttribute('data-pkc-focused'), '起動時の焦点が左でない').toBe(true);
    expect(move().textContent, '向きが字で出ていない').toContain('右へ移す');
    s = reduce(s, { type: 'DUAL_FOCUS', side: 'right' }).state;
    r.render(s);
    expect(pane('right').hasAttribute('data-pkc-focused')).toBe(true);
    expect(pane('left').hasAttribute('data-pkc-focused'), '焦点が 2 つある').toBe(false);
    expect(move().textContent, '焦点を変えても向きが変わらない').toContain('左へ移す');
  });

  it('🔴 タブの帯: 開いている 1 枚が分かり、最後の 1 枚には閉じる口を出さない', () => {
    const r = new DualFilerRenderer(region);
    let s = booted();
    r.render(s);
    const left = () => region.querySelector('[data-pkc-side="left"][data-pkc-region="dual-pane"]')!;
    expect(
      left().querySelectorAll('[data-pkc-action="dual-tab-close"]'),
      '最後の 1 枚に閉じる口が出ている(押しても何も起きない)',
    ).toHaveLength(0);
    s = reduce(s, { type: 'DUAL_TAB_ADD', side: 'left' }).state;
    s = reduce(s, { type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' }).state;
    r.render(s);
    const tabs = [...left().querySelectorAll('[data-pkc-region="dual-tab"]')];
    expect(tabs).toHaveLength(2);
    expect(tabs.map((t) => t.textContent)).toEqual(['ルート×', 'はこ1×']);
    expect(tabs[1]!.hasAttribute('data-pkc-active'), '開いているタブが分からない').toBe(true);
    expect(left().querySelectorAll('[data-pkc-action="dual-tab-close"]')).toHaveLength(2);
  });

  it('パンくずは祖先を順に出す(押すとその場所へ戻れる)', () => {
    const r = new DualFilerRenderer(region);
    const s = reduce(booted(), { type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' }).state;
    r.render(s);
    const crumbs = [
      ...region.querySelectorAll(
        '[data-pkc-side="left"][data-pkc-region="dual-pane"] [data-pkc-action="dual-crumb"]',
      ),
    ];
    expect(crumbs.map((c) => c.textContent)).toEqual(['ルート', 'はこ1']);
    expect(crumbs[0]!.hasAttribute('data-pkc-entry'), 'ルートに lid が付いている').toBe(false);
  });

  /**
   * 🔴 **数えるのは「いま表に出ている印」だけ**(#240 の着地前レビュー 2)。
   * ⚠ 素で数えると、画面に印が 1 つも無いのに「1 件を選んでいます」と出る。
   */
  it('🔴 件数は、いま表に出ている印だけを数える', () => {
    const r = new DualFilerRenderer(region);
    let s = reduce(booted(), { type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' }).state;
    r.render(s);
    const foot = () =>
      region.querySelector('[data-pkc-side="left"][data-pkc-region="dual-pane"] [data-pkc-field="dual-count"]')!;
    expect(foot().textContent).toBe('5 件(1 件を選んでいます)');
    // 絞り込みで a が消える ── 印は state に残るが、画面には出ていない
    s = reduce(s, { type: 'SET_ENTRY_FILTER', query: 'はこ' }).state;
    r.render(s);
    expect(foot().textContent, '画面に無い印を数えている').toBe('2 件');
  });

  it('印は属性の付け替えで塗る(表を組み直さない)', () => {
    const r = new DualFilerRenderer(region);
    let s = booted();
    r.render(s);
    const rowA = region.querySelector(
      '[data-pkc-region="dual-table"] [data-pkc-side="left"][data-pkc-entry="a"]',
    )!;
    s = reduce(s, { type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' }).state;
    r.render(s);
    expect(rowA.hasAttribute('data-pkc-marked'), '印が塗られていない').toBe(true);
    expect(
      region.querySelector(
        '[data-pkc-region="dual-table"] [data-pkc-side="left"][data-pkc-entry="a"]',
      ),
      '印を付けただけで行を作り直した(押す寸前のものが消える)',
    ).toBe(rowA);
  });

  /**
   * 🔴 **上限に達したら足す口を出さない**(着地前レビュー R2)。
   * ⚠ 「押しても何も起きないボタンを作らない」は閉じる側だけ直してあり、
   *   足す側が同型のまま残っていた。
   */
  it('🔴 タブが上限に達したら、+ を出さずに理由を出す', () => {
    const r = new DualFilerRenderer(region);
    let s = booted();
    const add = () =>
      region.querySelector('[data-pkc-action="dual-tab-add"][data-pkc-side="left"]');
    r.render(s);
    expect(add(), '足す口が最初から無い(空振り)').not.toBeNull();
    for (let i = 1; i < MAX_TABS; i += 1) s = reduce(s, { type: 'DUAL_TAB_ADD', side: 'left' }).state;
    r.render(s);
    expect(paneOf(s.dual, 'left').tabs, '前提が崩れている').toHaveLength(MAX_TABS);
    expect(add(), '上限なのに押せる口が出ている(無言の dead click)').toBeNull();
    expect(
      region.querySelector('[data-pkc-side="left"] [data-pkc-field="dual-tab-full"]')?.textContent,
    ).toBe(`タブは ${MAX_TABS} 枚までです`);
  });

  /**
   * 🔴 **真ん中の文言も「見えている印」で数える**(着地前レビュー R5)。
   * ⚠ 生の `selection.length` を使うと、「1 件を…入れます」と書いてあるのに
   *   押すと「移すものを選んでください」になる(同じ問いに 3 つ目の口を作らない)。
   */
  it('🔴 移すボタンの説明が、件数の行と同じ数を言う', () => {
    const r = new DualFilerRenderer(region);
    let s = reduce(booted(), { type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' }).state;
    r.render(s);
    const move = () => region.querySelector<HTMLElement>('[data-pkc-field="dual-move"]')!;
    expect(move().title).toContain('1 件');
    s = reduce(s, { type: 'SET_ENTRY_FILTER', query: 'はこ' }).state; // a が消える
    r.render(s);
    expect(move().title, '画面に無い印を数えている').toBe('移すものを選んでから押してください');
  });

  /**
   * 🔴 **入力が変わっていないなら描き直さない**(着地前レビュー R4)。
   * ⚠ `main.ts` は state が動くたび無条件に呼ぶので、門が無いと**あらゆる変化**で
   *   `filerRows` を 2 回(= 全 relation 走査)回すことになる。
   * 🔑 観測点は「行の DOM が同じ object のままか」── 作り直していれば別物になる。
   */
  it('🔴 関係ない state 変化では、関係の一覧を歩き直さない', () => {
    /**
     * 🔑 **観測点は「歩いたか」**。⚠ 1 稿目は「行の DOM が同じ object か」で見たが、
     *   門を外しても**表の指紋が同じなら行は作り直されない**ので、変異が生き延びた
     *   (CLAUDE.md §4「その観測点は、測りたいものを測っているか」)。
     *   門が省くのは DOM ではなく **`filerRows` の計算**(= 全 relation 走査)である。
     * ⚠ 門は `===` しか見ないので**配列を 1 度も触らない** ── だから
     *   「触った回数」に門の有無がそのまま出る。
     */
    let walks = 0;
    const s0 = booted();
    const relations = new Proxy(s0.relations, {
      get(t, k) {
        walks += 1;
        return Reflect.get(t, k) as unknown;
      },
    });
    const s = { ...s0, relations };
    const r = new DualFilerRenderer(region);
    r.render(s);
    expect(walks, '1 回目で歩いていない(空振り)').toBeGreaterThan(0);
    const after = walks;
    // この面が読まない field だけ動かす(一時の知らせ / 開いているノート)
    r.render({ ...s, selectedLid: 'b', error: 'なにか' });
    expect(walks - after, '無関係な変化で関係の一覧を歩き直した').toBe(0);
    // ⚠ 逆向きも見る ── 門が全部を止めてしまっていないこと
    r.render({ ...s, dual: reduce(s, { type: 'DUAL_TAB_ADD', side: 'left' }).state.dual });
    expect(walks - after, '関係のある変化でも描き直していない').toBeGreaterThan(0);
  });

  /**
   * 🔴 **題名 / 種別 / 更新日が変わったら描き直す**(着地前レビュー M1)。
   * ⚠ 指紋を `lid` だけにする変異が生き延びていた ── 別タブで改名された /
   *   保存で更新日が変わった、のどちらでも**古い文字を出し続ける**。
   */
  it('🔴 題名が変わったら、行の文字も変わる', () => {
    const r = new DualFilerRenderer(region);
    const s = booted();
    r.render(s);
    const cell = () =>
      region.querySelector('[data-pkc-region="dual-table"] [data-pkc-entry="a"] td')?.textContent;
    expect(cell()).toContain('あ');
    const metas = new Map(s.entryMetas);
    metas.set('a', { ...metas.get('a')!, title: 'あらため' });
    r.render({ ...s, entryMetas: metas });
    expect(cell(), '改名が画面に届いていない').toContain('あらため');
  });

  /**
   * 🔴 **表を組み直したら、印の指紋も戻す**(着地前レビュー M2)。
   * ⚠ 戻さないと「印が変わらないまま行が入れ替わる」筋で塗り直しが飛び、
   *   **画面では選ばれていないのに件数の行は数え、押すと動く**状態になる。
   */
  it('🔴 絞り込みで表を組み直しても、印の塗りが追いつく', () => {
    const r = new DualFilerRenderer(region);
    let s = reduce(booted(), { type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' }).state;
    r.render(s);
    // 'a' は残る絞り込み(題名「あ」)── 印は動かないが、行は作り直される
    s = reduce(s, { type: 'SET_ENTRY_FILTER', query: 'あ' }).state;
    r.render(s);
    const rowA = region.querySelector('[data-pkc-region="dual-table"] [data-pkc-entry="a"]');
    expect(rowA, '前提が崩れている(行が消えた)').not.toBeNull();
    expect(rowA!.hasAttribute('data-pkc-marked'), '組み直したあと印が塗られていない').toBe(true);
  });

  it('空のフォルダは、空だと言う', () => {
    const r = new DualFilerRenderer(region);
    const s = reduce(booted(), { type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f2' }).state;
    r.render(s);
    expect(
      region.querySelector(
        '[data-pkc-region="dual-pane"][data-pkc-side="left"] [data-pkc-field="dual-empty"]',
      )?.textContent,
    ).toBe('ここには何もありません');
  });
});

describe('2 ペインの面(中央の router)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /**
   * 🔴 **2 つの表の食い違いを落とす**(`center.ts` の `ASIDE` と
   * `app-state.ts` の `ASIDE_PANES`)。⚠ 片方だけに足すと「開いても本文が出る」。
   * ⚠ `help-pane.test.ts` の全数 test と**同じ主張**だが、こちらは
   *   **この面が実際に何を描いたか**まで見る(器だけ出ていても落ちる)。
   */
  it('🔴 dual を開いたら、本文ではなくこの面が出る', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const router = new CenterRouter(host);
    router.render({ ...booted(), viewMode: 'dual' });
    const shown = [...host.querySelectorAll('[data-pkc-view-pane]')].filter(
      (e) => !(e as HTMLElement).hidden,
    );
    expect(shown).toHaveLength(1);
    expect(shown[0]!.getAttribute('data-pkc-view-pane')).toBe('dual');
    expect(
      shown[0]!.querySelectorAll('[data-pkc-region="dual-pane"]'),
      '器だけで中身が描かれていない',
    ).toHaveLength(2);
  });

  it('🔴 編集中でも開ける(場所を眺めるだけ)', () => {
    let s = reduce(booted(), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '' }).state;
    s = reduce(s, { type: 'START_EDIT' }).state;
    const r = reduce(s, { type: 'SET_VIEW_MODE', mode: 'dual' });
    expect(r.state.viewMode, '編集中に黙って捨てられた').toBe('dual');
  });

  it('一覧のノートを押したら、中央はノートへ戻る', () => {
    let s = reduce(booted(), { type: 'SET_VIEW_MODE', mode: 'dual' }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    expect(s.viewMode, '押しても何も起きない面になっている').toBe('detail');
  });
});

describe('2 ペインの配線(binder)', () => {
  let root: HTMLElement;
  let d: Dispatcher;
  let region: HTMLElement;
  let r: DualFilerRenderer;

  beforeEach(() => {
    document.body.innerHTML = '';
    root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    d = new Dispatcher();
    buildShell(root);
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    region = document.createElement('div');
    root.append(region);
    r = new DualFilerRenderer(region);
    d.onState((st) => r.render(st));
    r.render(d.getState());
  });

  /**
   * ⚠ **表へスコープする**(着地前レビュー R6)── パンくずのボタンも
   * `data-pkc-entry` を持ち、DOM 順では**表より前**に在る。フォルダの中に
   * 入った状態で `row(side, lid)` を呼ぶと、表の行ではなく**パンくず**が返り、
   * 実装が壊れていても緑になる(描画側の test は同じ罠を踏んで直してある)。
   */
  const row = (side: string, lid: string): HTMLElement =>
    region.querySelector<HTMLElement>(
      `[data-pkc-region="dual-pane"][data-pkc-side="${side}"] [data-pkc-region="dual-table"] [data-pkc-entry="${lid}"]`,
    )!;
  const click = (el: HTMLElement, init: MouseEventInit = {}): void => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  };

  it('🔴 行を押すと、押した側の印になる(焦点も押した側へ)', () => {
    click(row('right', 'a'));
    expect(paneOf(d.getState().dual, 'right').selection).toEqual(['a']);
    expect(paneOf(d.getState().dual, 'left').selection, '押していない側が動いた').toEqual([]);
    expect(d.getState().dual.focus, '押した側が元になっていない').toBe('right');
    expect(d.getState().selection, '左の列の印まで動いた').toEqual([]);
  });

  it('🔴 Ctrl / Shift つきのクリックも、押した側だけに効く', () => {
    click(row('right', 'a'));
    click(row('right', 'b'), { ctrlKey: true });
    expect(paneOf(d.getState().dual, 'right').selection).toEqual(['a', 'b']);
    click(row('right', 'c'), { shiftKey: true });
    // 起点は b(最後に印を動かした行)── 表示順で b..c
    expect(paneOf(d.getState().dual, 'right').selection).toEqual(['b', 'c']);
    expect(paneOf(d.getState().dual, 'left').selection).toEqual([]);
  });

  /**
   * 🔴 **2 クリックで入るのは「押した側」だけ**。
   * ⚠ 直す前の形(`SET_SCOPE` を撃つ)だと、**押していない左の列が動いて
   *   押した側は 1 ミリも動かない** ── ここはその向きを突く。
   */
  it('🔴 フォルダを 2 回押すと、その側だけが中へ入る', () => {
    click(row('left', 'f1'));
    click(row('left', 'f1'));
    expect(paneScope(paneOf(d.getState().dual, 'left'))).toBe('f1');
    expect(paneScope(paneOf(d.getState().dual, 'right')), '反対側まで入った').toBeNull();
    expect(d.getState().scopeLid, '左の列(#240 の現在地)が動いた').toBeNull();
  });

  it('ノートを 2 回押しても、どこにも入らない', () => {
    click(row('left', 'a'));
    click(row('left', 'a'));
    expect(paneScope(paneOf(d.getState().dual, 'left'))).toBeNull();
  });

  it('パンくず / タブ / + が効く', () => {
    click(row('left', 'f1'));
    click(row('left', 'f1'));
    expect(paneScope(paneOf(d.getState().dual, 'left'))).toBe('f1');
    click(
      region.querySelector<HTMLElement>(
        '[data-pkc-side="left"][data-pkc-region="dual-pane"] [data-pkc-action="dual-crumb"]',
      )!,
    );
    expect(paneScope(paneOf(d.getState().dual, 'left')), 'パンくずでルートへ戻れない').toBeNull();
    click(
      region.querySelector<HTMLElement>(
        '[data-pkc-action="dual-tab-add"][data-pkc-side="left"]',
      )!,
    );
    expect(paneOf(d.getState().dual, 'left').tabs).toHaveLength(2);
    click(
      region.querySelectorAll<HTMLElement>(
        '[data-pkc-side="left"][data-pkc-region="dual-pane"] [data-pkc-action="dual-tab-close"]',
      )[0]!,
    );
    expect(paneOf(d.getState().dual, 'left').tabs).toHaveLength(1);
  });

  /**
   * 🔴 **この面の主目的**。⚠ 「移した」の観測点は**関係の辺**にする ──
   *   画面の行数だけを見ると、絞り込みや並べ替えでも変わる。
   */
  it('🔴 → 右へ移す: 焦点の側の印が、反対側の場所へ入る', () => {
    // 右を f1 の中へ、左でルートの a を選ぶ
    click(row('right', 'f1'));
    click(row('right', 'f1'));
    click(row('left', 'a'));
    expect(d.getState().dual.focus).toBe('left');
    click(region.querySelector<HTMLElement>('[data-pkc-field="dual-move"]')!);
    const parents = d
      .getState()
      .relations.filter((x) => x.toLid === 'a' && x.kind === 'structural')
      .map((x) => x.fromLid);
    expect(parents, 'a が f1 の中へ入っていない').toEqual(['f1']);
    expect(paneOf(d.getState().dual, 'left').selection, '移したのに印が残っている').toEqual([]);
  });

  it('🔴 何も選ばずに押したら、理由を言う(黙って何も起きない、にしない)', () => {
    const before = d.getState().relations;
    click(region.querySelector<HTMLElement>('[data-pkc-field="dual-move"]')!);
    expect(d.getState().error, '断りが画面に出ない').toContain('移すものを選んでください');
    expect(d.getState().relations, '選んでいないのに何かが動いた').toBe(before);
  });

  it('🔴 編集中に「移す」を押したら、理由を言って動かさない', () => {
    click(row('left', 'a'));
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'b', body: '' });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '前提が崩れている').toBe('editing');
    const before = d.getState().relations;
    click(region.querySelector<HTMLElement>('[data-pkc-field="dual-move"]')!);
    expect(d.getState().error).toContain('編集を終了してから');
    expect(d.getState().relations, '編集中に動いた').toBe(before);
    /**
     * 🔴 **断られた回に印を消さない**(着地前レビュー R1)。
     * ⚠ 消すと user は理由を読んで保存し、戻ってきて**選び直し**になる
     *   (この面は編集中でも開ける設計なので、必ず踏む筋である)。
     */
    expect(
      paneOf(d.getState().dual, 'left').selection,
      '1 件も動いていないのに印が消えた(選び直しになる)',
    ).toEqual(['a']);
  });

  it('🔴 全件断られた回も、印は残る(そこへは入れられません)', () => {
    // フォルダ f1 を選び、反対側を f1 の中にする → f1 を自分の中へは入れられない
    click(row('right', 'f1'));
    click(row('right', 'f1'));
    click(row('left', 'f1'));
    const before = d.getState().relations;
    click(region.querySelector<HTMLElement>('[data-pkc-field="dual-move"]')!);
    expect(d.getState().error, '断りが出ていない').toContain('そこへは入れられません');
    expect(d.getState().relations, '入れられないのに動いた').toBe(before);
    expect(paneOf(d.getState().dual, 'left').selection, '断られたのに印が消えた').toEqual(['f1']);
  });

  /**
   * 🔴 **2 クリックの記憶は面ごと**(着地前レビュー R3)。
   * ⚠ 起動時は左右ともルートなので**同じフォルダが両方の表に出ている** ──
   *   鍵が `lid` だけだと、左で 1 回・右で 1 回が「もう一度押した」に化け、
   *   **印を付けたかっただけの右が中へ入る**。
   */
  it('🔴 左で 1 回・右で 1 回は「2 クリック」ではない', () => {
    click(row('left', 'f1'));
    click(row('right', 'f1'));
    expect(paneScope(paneOf(d.getState().dual, 'right')), '別の面の 1 回で入った').toBeNull();
    expect(paneScope(paneOf(d.getState().dual, 'left')), '別の面の 1 回で入った').toBeNull();
    // ⚠ 同じ面で 2 回なら入る(空振り防止 ── 鍵を厳しくして全部止めていない)
    click(row('right', 'f1'));
    expect(paneScope(paneOf(d.getState().dual, 'right'))).toBe('f1');
  });

  /**
   * 🔴 **ペインの地を押しても焦点が移る**(着地前レビュー M3)。
   * ⚠ 行 / タブ / パンくずの上しか押していないと、`dual-focus` の**中身を空にする
   *   変異が生き延びる**(`closest` はそちらに当たるので一度も呼ばれない)。
   */
  it('🔴 ペインの余白(件数の行)を押しても、移す元がそちらへ移る', () => {
    expect(d.getState().dual.focus, '前提が崩れている').toBe('left');
    click(
      region.querySelector<HTMLElement>(
        '[data-pkc-region="dual-pane"][data-pkc-side="right"] [data-pkc-field="dual-count"]',
      )!,
    );
    expect(d.getState().dual.focus, '地を押しても元が変わらない').toBe('right');
  });

  /**
   * ⚠ 手で立てた壊れた添字を、**下流へ流さない**(着地前レビュー M5)。
   * 🔑 観測点は「**dispatch したか**」── 「state が変わらないこと」で見ると、
   *   下流(`inRange` の整数検査)が受け止めてくれるので**上流を消しても緑**になる。
   *   ここが縛りたいのは「壊れた値をそもそも流さない」ほうである。
   */
  it('数として読めないタブの添字は、dispatch にも届かない', () => {
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'dual-tab-close');
    btn.setAttribute('data-pkc-side', 'left');
    btn.setAttribute('data-pkc-tab', 'x');
    region.append(btn);
    const seen: string[] = [];
    const orig = d.dispatch.bind(d);
    d.dispatch = (a) => {
      seen.push(a.type);
      return orig(a);
    };
    try {
      click(btn);
    } finally {
      d.dispatch = orig;
    }
    expect(seen, '壊れた添字がそのまま下流へ流れた').toEqual([]);
  });

  /**
   * 🔴 **画面に無いものを動かさない**(#240 の着地前レビュー 2 と同型)。
   * ⚠ 印を付けたあと絞り込みで消しても、印は state に残る ── そのまま押すと
   *   **user に見えていないものがフォルダへ入る**。
   */
  it('🔴 絞り込みで消えた印は、移す対象にも入らない', () => {
    click(row('right', 'f1'));
    click(row('right', 'f1'));
    click(row('left', 'a'));
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'はこ' }); // a は消える
    click(region.querySelector<HTMLElement>('[data-pkc-field="dual-move"]')!);
    expect(d.getState().error, '見えていないものを黙って動かした').toContain(
      '移すものを選んでください',
    );
    expect(
      d.getState().relations.some((x) => x.toLid === 'a' && x.fromLid === 'f1'),
      '画面に無いものが動いた',
    ).toBe(false);
  });
});
