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
import { answerDialog, dialogMessage } from './dialog-helper';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { DualFilerRenderer } from '../../src/adapter/ui/render/dual-filer';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { MAX_TABS, paneOf, paneScope } from '../../src/features/relation/dual-pane';
import { DUAL_TILE_LID, withBuiltinTiles } from '../../src/features/launcher/tiles';
import { launchTile } from '../../src/adapter/ui/launch-tile';

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

  /**
   * 🔴 **場所が変わらなくても、押した側が元になる**(2026-08-19、リリース前監査)。
   * ⚠ 「いま居る場所のパンくず」と「いま開いているタブ」は、`withScope` /
   *   `withTabActive` が**同じ object を返す**ので、素直に早期 return すると
   *   **枠も向きも動かない** ── 他の押し方は全部焦点を持っていくので、
   *   この 2 つだけが例外という、いちばん気づけない形になる。
   * ⚠ マニュアルは「押したほうのペインに枠が付き」と言い切っている。
   */
  it('🔴 いま居る場所のパンくずを押しても、押した側が元になる', () => {
    const s0 = booted();
    expect(s0.dual.focus, '前提が崩れている').toBe('left');
    // 右はルートに居る ── その「ルート」を押す(場所は変わらない)
    const s = reduce(s0, { type: 'DUAL_SET_SCOPE', side: 'right', lid: null }).state;
    expect(s.dual.focus, '同じ場所を押したら焦点が動かなかった').toBe('right');
    // ⚠ 空振り防止: 自分の側を押した回は state ごと据え置き(無駄な通知を作らない)
    expect(reduce(s, { type: 'DUAL_SET_SCOPE', side: 'right', lid: null }).state).toBe(s);
  });

  it('🔴 いま開いているタブを押しても、押した側が元になる', () => {
    const s0 = booted();
    const s = reduce(s0, { type: 'DUAL_TAB_ACTIVATE', side: 'right', index: 0 }).state;
    expect(s.dual.focus, '開いているタブを押したら焦点が動かなかった').toBe('right');
    expect(reduce(s, { type: 'DUAL_TAB_ACTIVATE', side: 'right', index: 0 }).state).toBe(s);
    // ⚠ 範囲外は**焦点も動かさない**(存在しないタブを押したことにしない)
    expect(reduce(s0, { type: 'DUAL_TAB_ACTIVATE', side: 'right', index: 9 }).state).toBe(s0);
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

  /**
   * 🔴 **焦点は「移す元」そのもの**なので、2 か所で言う(2026-08-19 の作り直し)。
   *
   * ⚠ 直す前は**操作の文言**(「→ 右へ移す」)が向きを言っていたので、焦点を
   *   変えるたびにボタンの字と幅が入れ替わっていた ── 不可侵指示「同じものが
   *   常に同じ場所にある」と逆である。🔑 いまは**ペインの情報行**が言う。
   */
  it('🔴 焦点の側に印が付き、「ここが元」の字もそちらへ移る', () => {
    const r = new DualFilerRenderer(region);
    let s = booted();
    r.render(s);
    const pane = (side: string) =>
      region.querySelector(`[data-pkc-region="dual-pane"][data-pkc-side="${side}"]`)!;
    const foot = (side: string) =>
      pane(side).querySelector('[data-pkc-field="dual-count"]')?.textContent ?? '';
    expect(pane('left').hasAttribute('data-pkc-focused'), '起動時の焦点が左でない').toBe(true);
    expect(foot('left'), '焦点の側が「元」だと字で出ていない').toContain('(ここが元)');
    expect(foot('right'), '両側が「元」に見える').not.toContain('(ここが元)');
    s = reduce(s, { type: 'DUAL_FOCUS', side: 'right' }).state;
    r.render(s);
    expect(pane('right').hasAttribute('data-pkc-focused')).toBe(true);
    expect(pane('left').hasAttribute('data-pkc-focused'), '焦点が 2 つある').toBe(false);
    expect(foot('right'), '焦点を変えても「元」が移らない').toContain('(ここが元)');
    expect(foot('left'), '前の焦点に「元」が残っている').not.toContain('(ここが元)');
  });

  /**
   * 🔴 **操作行は最下段・全幅・固定の並び**(2026-08-19 の作り直し)。
   *
   * ⚠ ここは**位置と並びを等値で pin する** ── 古典 4 実装(Total Commander /
   *   Double Commander / FAR / Krusader)が例外なくこの形で、しかも
   *   **F5 写す / F6 移す / F7 作る / F8 消す** の割当まで一致している。
   *   並びが動くと、user の手が覚えた位置が毎回外れる。
   * ⚠ **左右ペインの後ろ**に在ることも見る ── 間に挟まる旧配置へ戻す変異は、
   *   並びの assert だけでは殺せない(順番は同じまま場所だけ変わる)。
   */
  it('🔴 操作行は左右ペインの下にあり、キーと語の並びが固定である', () => {
    const r = new DualFilerRenderer(region);
    r.render(booted());
    const cmds = region.querySelector('[data-pkc-region="dual-commands"]')!;
    const body = region.querySelector('[data-pkc-region="dual-body"]')!;
    expect(
      body.compareDocumentPosition(cmds) & Node.DOCUMENT_POSITION_FOLLOWING,
      '操作行がペインより前に在る(左右の間へ戻っている)',
    ).toBeTruthy();
    expect(
      [...cmds.querySelectorAll('button')].map((b) => [
        b.getAttribute('data-pkc-action'),
        b.querySelector('[data-pkc-field="cmd-key"]')?.textContent,
        b.querySelector('[data-pkc-field="cmd-label"]')?.textContent,
      ]),
    ).toEqual([
      ['dual-copy', 'F5', '写す'],
      ['dual-move', 'F6', '移す'],
      ['dual-rename-begin', 'F2', '名前'],
      ['dual-mkdir', 'F7', 'フォルダ'],
      // 🔴 **入れ物だけでなく中身も作れる**(#273)── `F7` と隣り合わない鍵にしてある
      //    (隣り合わせると、押し間違いで**別の種類**ができる)
      ['dual-mknote', 'Shift + F4', 'ノート'],
      ['dual-delete', 'F8', 'ゴミ箱'],
      // 🔴 **プレビュー**(#273 残件)── 開かずに中身を確かめる(印は要らない)
      ['dual-preview-toggle', 'F9', 'プレビュー'],
    ]);
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
      region.querySelector(
        '[data-pkc-side="left"][data-pkc-region="dual-pane"] [data-pkc-field="dual-count"]',
      )!;
    /**
     * ⚠ **「選択 / 全体」を対で出す**(2026-08-19 の作り直し)── 古典 4 実装は
     *   例外なくこの形。直す前は「5 件(1 件を選んでいます)」で、選んでいない
     *   ときだけ全体が出る非対称な形だった。
     */
    /**
     * 🔴 **合計も対で出す**(#273 残件)── 古典 4 実装はどれも
     *   「選んだぶん / 全体」を情報行に出す。⚠ この fixture は `bodyChars` が
     *   全部 `null`(数えていない)なので **`—`** が出るのが正しい ──
     *   `0` と出すと「空だ」と読まれる。
     */
    expect(foot().textContent).toBe('5 件中 1 件を選択 · — / —(ここが元)');
    // 絞り込みで a が消える ── 印は state に残るが、画面には出ていない
    s = reduce(s, { type: 'SET_ENTRY_FILTER', query: 'はこ' }).state;
    r.render(s);
    /**
     * ⚠ **フォルダしか残っていないので、合計は出さない** ── 出すと `0` になり、
     *   「中身が空だ」と読まれる(フォルダは本文を持たないだけである)。
     */
    expect(foot().textContent, '画面に無い印を数えている').toBe('2 件(ここが元)');
  });

  /**
   * 🔴 **大きさの列**(2026-08-19 の作り直し。設計 doc §3 行 C/D/F)。
   *
   * ⚠ 「見比べて整理する」面なので、大きさは判断材料の一等地である ──
   *   古典 4 実装とも名前の次に置いている。
   * ⚠ **フォルダは `—`** ── 数を出すと「中に何文字入っているか」と読まれる。
   */
  it('🔴 列は 名前 / 大きさ / 更新 の 3 つで、フォルダの大きさは — になる', () => {
    const r = new DualFilerRenderer(region);
    const s: AppState = {
      ...booted(),
      entryMetas: new Map(
        [...booted().entryMetas].map(([lid, m]) => [
          lid,
          /**
           * ⚠ **フォルダにも数を入れる**(2026-08-20 の変異試験 M21 が生き延びて判明)。
           *   1 稿目は `f1` の `bodyChars` が `null` のままだったので、
           *   `formatBodyChars(null)` も `—` を返し、**フォルダの分岐を消しても緑**だった
           *   (CLAUDE.md §1 の空振り ── 別の理由で条件が満たされていた)。
           */
          {
            ...m,
            bodyChars: lid === 'a' ? 1234 : lid === 'b' ? 0 : lid === 'f1' ? 777 : m.bodyChars,
          },
        ]),
      ),
    };
    r.render(s);
    const pane = region.querySelector('[data-pkc-side="right"][data-pkc-region="dual-pane"]')!;
    expect(
      [...pane.querySelectorAll('thead th')].map((th) => th.textContent),
      '列見出しが 3 つでない(または並びが違う)',
    ).toEqual(['名前', '大きさ', '更新']);
    const sizeOf = (lid: string): string =>
      pane.querySelector(`[data-pkc-entry="${lid}"] [data-pkc-field="dual-size"]`)?.textContent ??
      '';
    expect(sizeOf('a'), '1000 を超えたら K で丸める').toBe('1.2K');
    expect(sizeOf('b'), '空のノートが未計算に見えている').toBe('0');
    expect(sizeOf('c'), '未計算(旧ビルドが書いた行)が 0 に見えている').toBe('—');
    expect(sizeOf('f1'), 'フォルダに数が出ている(中身の量と読まれる)').toBe('—');
  });

  /**
   * 🔴 **見出しを押すと並べ替わり、もう一度押すと向きが反転する**(古典 4 実装が一致)。
   *
   * ⚠ 観測点は **`▲▼` の字と実際の行順の両方**にする ── 片方だけだと
   *   「矢印は変わるのに並びは同じ」型の欠陥が素通りする(見た目と実態の食い違いは
   *   いちばん気づけない)。
   */
  it('🔴 列見出しを押すと並び、もう一度で反転する(矢印と行順の両方)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const r = new DualFilerRenderer(regions.center);
    d.onState((s) => r.render(s));
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'dual' });
    const th = () =>
      regions.center.querySelector<HTMLElement>(
        '[data-pkc-side="right"][data-pkc-region="dual-pane"] th[data-pkc-sort="title"]',
      )!;
    const rows = (): string[] =>
      [
        ...regions.center.querySelectorAll(
          '[data-pkc-side="right"][data-pkc-region="dual-pane"] [data-pkc-region="dual-table"] [data-pkc-entry]',
        ),
      ].map((e) => e.getAttribute('data-pkc-entry') ?? '');
    expect(rows(), '前提: 既定は手動の順').toEqual(['f1', 'f2', 'a', 'b', 'c']);
    th().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(d.getState().entrySort, '押しても並びが変わっていない').toBe('title');
    expect(d.getState().entrySortDesc, '名前は昇順から見たい').toBe(false);
    expect(th().textContent, '向きが字で出ていない').toBe('名前 ▲');
    // あ(a) → い(b) → う(c) → えっくす(x は f1 の中) → はこ1 → はこ2
    expect(rows(), '昇順で並んでいない').toEqual(['a', 'b', 'c', 'f1', 'f2']);
    th().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(d.getState().entrySortDesc, '同じ列をもう一度押しても反転しない').toBe(true);
    expect(th().textContent, '矢印が反転していない').toBe('名前 ▼');
    expect(rows(), '矢印だけ変わって行が動いていない').toEqual(['f2', 'f1', 'c', 'b', 'a']);
  });

  /**
   * 🔴 **別の列へ移ったら、その列の自然な向きから始める**(`NATURAL_DESC`)。
   * ⚠ 向きを持ち越すと、名前を押した瞬間に「ん」から並ぶ。
   */
  it('🔴 別の列を押したら、向きはその列の自然な向きになる', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const r = new DualFilerRenderer(regions.center);
    d.onState((s) => r.render(s));
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'dual' });
    const th = (sort: string) =>
      regions.center.querySelector<HTMLElement>(
        `[data-pkc-side="right"][data-pkc-region="dual-pane"] th[data-pkc-sort="${sort}"]`,
      )!;
    const click = (el: HTMLElement) =>
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    click(th('title'));
    click(th('title'));
    expect(d.getState().entrySortDesc, '前提が崩れている').toBe(true);
    click(th('updated'));
    expect(d.getState().entrySort).toBe('updated');
    expect(d.getState().entrySortDesc, '更新は新しい順から見たい').toBe(true);
    click(th('title'));
    expect(d.getState().entrySortDesc, '前の列の向きを持ち越している').toBe(false);
  });

  /**
   * 🔴 **カーソルは属性の付け替えで塗る**(2026-08-19。印と同じ作法)。
   *
   * ⚠ 印と**別の属性**にする ── 同じものに詰めると、印を塗り直すたびに
   *   カーソルまで動く(分けた意味が消える)。
   * ⚠ **前のカーソルを消すこと**も見る ── 消さないと枠が増え続け、
   *   「どの行に居るか」が読めなくなる(いちばん多い塗り忘れの形)。
   */
  it('🔴 カーソルは 1 行だけに付き、送ると前の行から外れる', () => {
    const r = new DualFilerRenderer(region);
    let s = reduce(booted(), { type: 'DUAL_SET_CURSOR', side: 'left', lid: 'f1' }).state;
    r.render(s);
    const cursors = (): string[] =>
      [...region.querySelectorAll('[data-pkc-side="left"][data-pkc-cursor]')].map(
        (e) => e.getAttribute('data-pkc-entry') ?? '',
      );
    expect(cursors(), 'カーソルが塗られていない').toEqual(['f1']);
    s = reduce(s, { type: 'DUAL_SET_CURSOR', side: 'left', lid: 'f2' }).state;
    r.render(s);
    expect(cursors(), '前の行から外れていない(枠が増えた)').toEqual(['f2']);
  });

  /**
   * 🔴 **表を組み直したら、カーソルを塗り直す**(2026-08-19)。
   *
   * ⚠ 行の object ごと入れ替わるので、**カーソルの指紋を捨てない**と
   *   「同じ lid だから塗らない」で**枠が消えたまま**になる ── しかも
   *   state は正しいので、`↑↓` は効く(枠だけが見えない、いちばん読みにくい形)。
   */
  it('🔴 並べ替えで表を組み直しても、カーソルの枠は残る', () => {
    const r = new DualFilerRenderer(region);
    let s = reduce(booted(), { type: 'DUAL_SET_CURSOR', side: 'left', lid: 'a' }).state;
    r.render(s);
    expect(
      region.querySelectorAll('[data-pkc-side="left"][data-pkc-cursor]'),
      '前提が崩れている',
    ).toHaveLength(1);
    s = reduce(s, { type: 'SET_ENTRY_SORT', sort: 'title' }).state;
    r.render(s);
    expect(
      region.querySelector('[data-pkc-side="left"][data-pkc-cursor]')?.getAttribute(
        'data-pkc-entry',
      ),
      '表を組み直したら枠が消えた',
    ).toBe('a');
  });

  /**
   * 🔴 **操作行の鍵は、割当の表から引く**(2026-08-19。Krusader 方式)。
   *
   * ⚠ 直書きすると、user が割当を変えた瞬間に**画面が嘘をつく**。
   * ⚠ **関数キーを優先**する ── ゴミ箱の既定は `Delete` が先頭だが、ここは
   *   古典の「ファンクションキー行」なので `F8` を出す。
   */
  it('🔴 操作行の鍵は割当から出る(関数キーを優先し、変えれば追従する)', () => {
    const map = new Map<string, string>();
    const store = new KeymapStore({
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    });
    const r = new DualFilerRenderer(region, store);
    r.render(booted());
    const keyOf = (field: string): string =>
      region.querySelector(`[data-pkc-field="${field}"] [data-pkc-field="cmd-key"]`)
        ?.textContent ?? '';
    expect(keyOf('dual-move'), '既定の鍵が出ていない').toBe('F6');
    /**
     * ⚠ ゴミ箱の既定は `['Delete', 'F8']` で**先頭は Delete** ── ここが
     *   「先頭を出す」だけの実装だと `Delete` が出る。**関数キーの行**なので
     *   `F8` を出すのが正しい(古典 4 実装の帯と揃う)。
     */
    expect(keyOf('dual-delete'), '別名(Delete)を拾っている ── 関数キーを優先する').toBe('F8');
    // 割り当て直したら、書いてある字も変わる(画面が嘘をつかない)
    /**
     * ⚠ **空いている鍵で試す** ── `F9` は 2026-08-25 に `dual-preview` が取った。
     *   🔑 落ちたら、まず**この行の鍵が誰かに取られていないか**を見ること
     *   (`tests/features/keymap.test.ts` の同じ注記と対である)。
     */
    expect(store.addBinding('dual-move-to-other', 'F10')).toBeNull();
    store.removeBinding('dual-move-to-other', 'F6');
    r.render(booted());
    expect(keyOf('dual-move'), '割当を変えても画面の字が変わらない').toBe('F10');
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
    /** ⚠ **数える口は 1 つ**にする ── 差し替えるたびに包み直す(下の理由)。 */
    const counted = (arr: AppState['relations']): AppState['relations'] =>
      new Proxy(arr, {
        get(t, k) {
          walks += 1;
          return Reflect.get(t, k) as unknown;
        },
      });
    const s0 = booted();
    const s = { ...s0, relations: counted(s0.relations) };
    const r = new DualFilerRenderer(region);
    r.render(s);
    expect(walks, '1 回目で歩いていない(空振り)').toBeGreaterThan(0);
    const after = walks;
    // この面が読まない field だけ動かす(一時の知らせ / 開いているノート)
    r.render({ ...s, selectedLid: 'b', error: 'なにか' });
    expect(walks - after, '無関係な変化で関係の一覧を歩き直した').toBe(0);
    /**
     * 🔴 **門の材料を 1 つずつ動かす**(2026-08-19、リリース前監査で判明)。
     * ⚠ 1 稿目は `dual` / `entryMetas` / `filterQuery` の 3 つしか動かしておらず、
     *   **`relations` / `entrySort` / `searchHits` を門から落とす変異が全部
     *   生き延びていた**(CLAUDE.md §2「弱いのではなく走っていない」)。
     * ⚠ 実害の経路は 3 本とも実在する ── 左の列の D&D と情報ペインの
     *   「居場所」は `relations` **だけ**を差し替え、並び順は `entrySort` だけ、
     *   本文検索の当たりは `searchHits` だけを遅れて差し替える。
     *   門が 1 行欠けると、2 ペインだけが古いまま残る。
     */
    const armed: [string, (x: AppState) => AppState][] = [
      ['dual', (x) => ({ ...x, dual: reduce(x, { type: 'DUAL_TAB_ADD', side: 'left' }).state.dual })],
      ['entryMetas', (x) => ({ ...x, entryMetas: new Map(x.entryMetas) })],
      ['filterQuery', (x) => ({ ...x, filterQuery: 'あ' })],
      ['entrySort', (x) => ({ ...x, entrySort: 'title' })],
      /**
       * ⚠ **向きも門の材料**(2026-08-19、足したその日に踏んだ)── 入れないと
       *   `▲` を押しても**この面が 1 度も描き直さない**(state だけ反転する)。
       */
      ['entrySortDesc', (x) => ({ ...x, entrySortDesc: !x.entrySortDesc })],
      ['searchHits', (x) => ({ ...x, searchHits: new Set(['a']) })],
      /**
       * ⚠ `relations` は**中身が同じ新しい配列**にする(参照だけが変わる ──
       * 左の列の D&D が state に起こす変化と同じ形)。
       * 🔴 **包み直すのを忘れない** ── 素の配列に差し替えると**計器そのものが外れ**、
       * 「歩いていない」と読める(1 稿目はこれで変異が生き延びた。CLAUDE.md §4
       * 「観測点が、測りたいものを測っているか」)。
       */
      ['relations', (x) => ({ ...x, relations: counted([...x.relations]) })],
    ];
    let cur = s as AppState;
    for (const [name, mutate] of armed) {
      cur = mutate(cur);
      /**
       * 🔴 **計器を読むのは、仕込みが終わってから**(2026-08-19 に踏んだ)。
       * ⚠ `mutate` の中で `[...x.relations]` と書くと**その展開が Proxy を歩く**ので、
       *   仕込みの前に採ると「描き直した」と読める ── 門を外す変異が生き延びた。
       *   測りたいのは `render` が歩いた分だけである。
       */
      const before = walks;
      r.render(cur);
      expect(walks - before, `門の材料に ${name} が入っていない`).toBeGreaterThan(0);
    }
  });

  /**
   * 🔴 **向きは操作行ではなく、説明と情報行が言う**(2026-08-19 の作り直し)。
   *
   * ⚠ 直す前は文言そのものが「→ 右へ移す」/「← 左へ移す」と入れ替わっていた ──
   *   ボタンの幅まで変わるので、焦点を変えるたびに操作行の端がずれた。
   * ⚠ それでも**呼び名の入れ替え**(左右を取り違える変異)は殺さねばならない ──
   *   user は「元がどちら側か」を字で読んで押す。🔑 いまは `title` が受ける。
   */
  it('🔴 操作の字は動かず、向きは説明が言う(左右の呼び名は反転する)', () => {
    const r = new DualFilerRenderer(region);
    let s = booted();
    r.render(s);
    const move = () => region.querySelector<HTMLElement>('[data-pkc-field="dual-move"]')!;
    const trash = () => region.querySelector<HTMLElement>('[data-pkc-field="dual-delete"]')!;
    expect(move().textContent, 'キーと語が違う').toBe('F6移す');
    expect(move().title, '選ぶ前の断りが向きの説明になっている').toBe(
      '移すものを選んでから押してください',
    );
    /**
     * ⚠ **断りは呼び名から機械的に組まない**(2026-08-19 に踏んだ)。
     *   `${label}ものを…` と書くと、ゴミ箱だけ
     *   「**ゴミ箱ものを選んでから押してください**」になる。
     */
    expect(trash().title, '入れ物の名と動作の名が混ざっている').toBe(
      'ゴミ箱へ入れるものを選んでから押してください',
    );
    s = reduce(s, { type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' }).state;
    r.render(s);
    expect(move().title).toBe('左で選んだものを、右のペインへ移します(いま 1 件)');

    s = reduce(s, { type: 'DUAL_FOCUS', side: 'right' }).state;
    s = reduce(s, { type: 'DUAL_SELECT', side: 'right', lid: 'a', mode: 'set' }).state;
    r.render(s);
    expect(move().textContent, '焦点を変えたら操作の字が動いた').toBe('F6移す');
    expect(move().title, '焦点を変えても呼び名が反転しない').toBe(
      '右で選んだものを、左のペインへ移します(いま 1 件)',
    );
    // ⚠ ペインの読み上げ名も同じ表から引く(呼び名の入れ替えを 1 か所で殺す)
    expect(
      region
        .querySelector('[data-pkc-region="dual-pane"][data-pkc-side="right"]')
        ?.getAttribute('aria-label'),
    ).toBe('右のペイン');
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

  /**
   * 🔴 **「空」と「絞り込みで消えた」を分ける**(2026-08-19、リリース前監査)。
   * ⚠ 左の列の探す欄はこの面と**同時に画面に在り**、面を切り替えても語は消えない
   *   ── 語を打ったまま 2 ペインを開くと、両側が「ここには何もありません」になる。
   * ⚠ 一覧とアプリの 2 面は理由を分けているのに、**3 面目だけ落ちていた**。
   */
  it('🔴 絞り込みで消えたときは、空とは別のことを言う', () => {
    const r = new DualFilerRenderer(region);
    let s = booted();
    r.render(s);
    const msg = () =>
      region.querySelector(
        '[data-pkc-region="dual-pane"][data-pkc-side="left"] [data-pkc-field="dual-empty"]',
      )?.textContent ?? null;
    expect(msg(), 'ルートに行が在るのに空だと言っている').toBeNull();
    s = reduce(s, { type: 'SET_ENTRY_FILTER', query: 'どれにも当たらない語' }).state;
    r.render(s);
    expect(msg()).toBe('探している語に当たるものが、ここにはありません');
    // 🔑 **0 件 → 0 件**でも文言が追いつく(行が 0 件だと指紋が空文字になるので、
    //    絞り込みの有無を指紋に入れていないとここで古い字が残る)
    s = reduce(s, { type: 'SET_ENTRY_FILTER', query: '' }).state;
    s = reduce(s, { type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f2' }).state; // 空フォルダ
    r.render(s);
    expect(msg()).toBe('ここには何もありません');
    s = reduce(s, { type: 'SET_ENTRY_FILTER', query: 'どれにも当たらない語' }).state;
    r.render(s);
    expect(msg(), '0 件 → 0 件で文言が古いまま残った').toBe(
      '探している語に当たるものが、ここにはありません',
    );
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

/**
 * 🔴 **導線は「アプリ」の組み込みタイル**(user 指摘 2026-08-19
 * 「2 ペインファイラは**アプリとして** Office のように組み込みの導線を用意しろ」)。
 * ⚠ 1 稿目は左の列の下(アプリ全体の操作が並ぶ帯)にボタンを置いていた ──
 *   user が言った「組み込み」はそこではない。
 */
describe('2 ペインの導線(#241。アプリの組み込みタイル)', () => {
  it('🔴 アプリの一覧に、押せるタイルが最初から在る', () => {
    const tiles = withBuiltinTiles([], { office: false });
    // ⚠ **2 ペインが先頭に居ること**だけを見る(#276 でカレンダーが加わった)──
    //   一覧の全数は `tests/features/launcher-tiles.test.ts` が等値で pin する
    expect(tiles[0]?.lid, 'Office を入れていない端末で出ない').toBe(DUAL_TILE_LID);
    expect(tiles[0]?.title).toBe('2 ペインで整理');
  });

  /**
   * 🔴 **押すと 2 ペインの口へ行く**(2026-08-22 に題名を直した)。
   *
   * ⚠ 直す前の題名は「押すと**中央**が 2 ペインになる(**窓は開かない**)」だった ──
   *   #300 段③ で**タイルは別窓を開く**ようになったので、どちらも嘘である。
   * 🔑 それでも**中身は弱めない** ── ここは `deps.open` を throw で塞いでおり、
   *   「`launchTile` がこの場で窓を開いていない(判断は `view-window.ts` に在る)」
   *   と「**`await` をまたがずに口を叩く**(gesture を切らない)」を守っている。
   *   ⚠ 後者はこの repo で**ここと `launch-tile.test.ts` しか見ていない**。
   */
  it('🔴 押すと 2 ペインの口へ行く(この場では窓を開かない)', () => {
    let opened = 0;
    let officeOpened = 0;
    launchTile(
      { lid: DUAL_TILE_LID, title: '2 ペインで整理', group: '', kind: 'dual' },
      {
        readBlob: async () => null,
        open: () => {
          throw new Error('窓を開いてはいけない');
        },
        createUrl: () => '',
        revokeUrl: () => undefined,
        whenClosed: async () => undefined,
        readSeed: () => ({}),
        baseUrl: 'https://example.test/',
        fail: (m) => {
          throw new Error(`断られた: ${m}`);
        },
        openOffice: () => {
          officeOpened += 1;
        },
        openView: (view) => {
          // ⚠ **どの面へ切り替えたか**まで見る(#276 で口が 1 本になった)──
          //   数えるだけだと、カレンダーへ切り替えても 2 ペインが開いたと読む
          if (view === 'dual') opened += 1;
        },
        // ⚠ ここでは押さない口(マニュアルのタイルは別の test が見る)
        openManual: () => {},
      },
    );
    expect(opened, '2 ペインが開かない').toBe(1);
    expect(officeOpened, 'Office を開いてしまった').toBe(0);
  });

  it('🔴 左の列の帯には、もう入口を出さない(入口は 1 つ)', () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    buildShell(root);
    // ⚠ 空振り防止 ── ほかの面のボタンは在る(帯そのものが消えていない)
    expect(root.querySelector('[data-pkc-action="set-view"][data-pkc-view="help"]')).not.toBeNull();
    expect(
      root.querySelector('[data-pkc-action="set-view"][data-pkc-view="dual"]'),
      '帯にも入口が残っている(同じ物の入口が 2 か所)',
    ).toBeNull();
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
    /**
     * ⚠ **観測点を「タブの命令」へ絞る**(2026-08-24、#273 で組み直した)。
     * 直す前は「撃った全部が `['DUAL_TAB_CLOSE']` と等しい」で見ていたが、
     * `dual-tab-close` は**押した後に焦点を立て直す**(`carryDualFocus`)ので
     * `DUAL_SET_CURSOR` が続く ── 等値では**焦点の直しを入れた日に落ちる**。
     * 🔑 ここが縛りたいのは「**壊れた添字がタブの命令に化けないこと**」なので、
     *   数えるのは `DUAL_TAB_*` だけにする(3 種を前置きで拾う ── 別のタブ命令へ
     *   すり替える変異も同じ網に掛かる)。
     * ⚠ そのうえで**残りは許可制**にする ── 焦点の直し以外が紛れ込んだら落ちる
     *   (絞ったせいで「何でも通る」にしない)。
     * 🔑 **実測**(2026-08-24): 壊れた添字でも `seen` は空にならず
     *   `DUAL_SET_CURSOR` が **2 件**出る ── `carryDualFocus` の立て直しと、
     *   それが `focus()` した結果の `focusin`(state → 焦点 / 焦点 → state の
     *   2 本の橋。同じ値なので reducer が畳む)。⚠ つまりこの検査は
     *   「**記録が空だから通った**」ではない(空振りではない)。
     */
    const seen: string[] = [];
    const orig = d.dispatch.bind(d);
    d.dispatch = (a) => {
      seen.push(a.type);
      return orig(a);
    };
    const tabOnes = (): string[] => seen.filter((t) => t.startsWith('DUAL_TAB_'));
    try {
      const btn = document.createElement('button');
      btn.setAttribute('data-pkc-action', 'dual-tab-close');
      btn.setAttribute('data-pkc-side', 'left');
      btn.setAttribute('data-pkc-tab', 'x');
      region.append(btn);
      click(btn);
      expect(tabOnes(), '壊れた添字がタブの命令になって流れた').toEqual([]);
      expect(
        seen.filter((t) => t !== 'DUAL_SET_CURSOR'),
        '焦点の立て直し以外が走っている(観測点を絞りすぎたか、別の副作用が入った)',
      ).toEqual([]);
      /**
       * ⚠ **空振り防止**(2026-08-19、リリース前監査)── 「0 件だった」は
       * 「弾いた」だけでなく「**そもそも handler に届かなかった**」でも成り立つ。
       * 🔑 同じ仕掛けで**正しい添字**を撃ち、そちらは届くことを見る。
       */
      seen.length = 0;
      const ok = document.createElement('button');
      ok.setAttribute('data-pkc-action', 'dual-tab-close');
      ok.setAttribute('data-pkc-side', 'left');
      ok.setAttribute('data-pkc-tab', '0');
      region.append(ok);
      click(ok);
      expect(tabOnes(), 'そもそも handler に届いていない(この test は空振り)').toEqual([
        'DUAL_TAB_CLOSE',
      ]);
    } finally {
      d.dispatch = orig;
    }
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

/**
 * 🔴 **2 ペインをキーボードで動かす**(#273。user 指摘 2026-08-19
 * 「2 ペインファイラとしては非常にお粗末 / OS のファイラと同じことができないと
 * いけません / 往年の FD などを見習ってください」)。
 *
 * ⚠ 直す前は**開く鍵(`Alt+6`)しか無く**、面の中では 1 打鍵も効かなかった。
 * 🔑 守る主張は 3 つ:
 * 1. **同じ鍵が、焦点のある面に効く**(命令は増やさない = 割り当て直しは 1 回)
 * 2. **押していない側と、左の列は動かない**
 * 3. 🔴 **消す鍵が、画面に出ていないものを消しに行かない**
 */
describe('2 ペインのキーボード操作(#273)', () => {
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

  const row = (side: string, lid: string): HTMLElement =>
    region.querySelector<HTMLElement>(
      `[data-pkc-region="dual-pane"][data-pkc-side="${side}"] [data-pkc-region="dual-table"] [data-pkc-entry="${lid}"]`,
    )!;

  /** ⚠ **行に焦点を置いてから**押す(どこで効かせるかは焦点で決まる)。 */
  const press = (side: string, lid: string, key: string, over: Partial<KeyboardEventInit> = {}) => {
    const el = row(side, lid);
    el.focus();
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...over });
    el.dispatchEvent(ev);
    return ev;
  };

  const sel = (side: 'left' | 'right'): readonly string[] => paneOf(d.getState().dual, side).selection;
  const cur = (side: 'left' | 'right'): string | null => paneOf(d.getState().dual, side).cursor;

  /**
   * 🔴 **行送りはカーソルだけを動かす**(2026-08-19 の作り直し。設計 doc §3 行 H)。
   *
   * ⚠ 直す前は印ごと動いていたので、**見て回ることが選ぶことだった** ── 3 件目まで
   *   下りると 1・2 件目の印が消えるので、飛び飛びに選べない。
   * ⚠ **印が動かないことも見る** ── 見ないと「印も一緒に動かす」旧実装が素通りする
   *   (カーソルは正しく動くので、片側だけの assert では区別が付かない)。
   */
  it('🔴 ↓ はカーソルだけを送る(印は動かない・押していない側も動かない)', () => {
    row('right', 'f1').focus();
    press('right', 'f1', 'ArrowDown');
    expect(cur('right'), 'カーソルが送られていない').toBe('f2');
    expect(sel('right'), '行送りで印まで動いた(カーソルと分けた意味が消える)').toEqual([]);
    expect(cur('left'), '押していない側のカーソルが動いた').toBeNull();
    expect(d.getState().selection, '左の列の印まで動いた').toEqual([]);
    expect(d.getState().dual.focus, '押した側が元になっていない').toBe('right');
  });

  it('🔴 ↑↓ は端で止まる(巻き戻らない)', () => {
    press('left', 'f1', 'ArrowUp');
    expect(cur('left'), '先頭で上を押したら末尾へ飛んだ').toBe('f1');
  });

  /**
   * 🔴 **Space で印を付けて 1 行下へ**(FAR / Directory Opus と同型)。
   * ⚠ **下りるところまでが 1 つの操作** ── 下りないと、同じ行に付けたり外したりし
   *   続けることになり、連続して選べない(飛び飛びに選ぶのがこの鍵の目的である)。
   */
  it('🔴 Space は印を付けて 1 行下へ(飛び飛びに選べる)', () => {
    press('left', 'f1', ' ');
    expect(sel('left'), '印が付いていない').toEqual(['f1']);
    expect(cur('left'), '1 行下へ降りていない(同じ行で付け外しになる)').toBe('f2');
    // 1 つ飛ばして 3 件目に印 ── カーソルと印が別だからできる
    press('left', 'f2', 'ArrowDown');
    press('left', 'a', ' ');
    expect(sel('left'), '飛び飛びに選べていない').toEqual(['f1', 'a']);
  });

  it('🔴 もう一度 Space を押すと印が外れる', () => {
    press('left', 'f1', ' ');
    press('left', 'f2', 'ArrowUp');
    press('left', 'f1', ' ');
    expect(sel('left'), '印が外れない').toEqual([]);
  });

  /**
   * 🔴 **印が 1 つも無ければ、カーソルの行が相手**(古典 4 実装が一致)。
   * ⚠ この規則が無いと、`↑↓` を印から切り離した瞬間に
   *   「矢印で下りて F6」が**断られ続ける**動線に変わる(カーソルが飾りになる)。
   */
  it('🔴 印が無いとき、F6 はカーソルの行を移す', () => {
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f1' });
    press('left', 'f1', 'ArrowDown'); // カーソルを f2 へ(印は付かない)
    expect(sel('left'), '前提が崩れている(印が付いている)').toEqual([]);
    press('left', 'f2', 'F6');
    const parents = d
      .getState()
      .relations.filter((x) => x.toLid === 'f2' && x.kind === 'structural')
      .map((x) => x.fromLid);
    expect(parents, 'カーソルの行が動いていない').toEqual(['f1']);
  });

  /**
   * 🔴 **F キーは押しボタンと同じ実体を通る**(規則を 2 つ作らない)。
   * ⚠ 別々に書くと、断り方が鍵とボタンで割れる ── ここは**断りの文言**で見る
   *   (「動かない」だけを見ると、門が塞いだのか実体が無いのか区別が付かない)。
   */
  it('🔴 F7 は「新しいフォルダ」と同じ実体を呼ぶ', () => {
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' });
    const before = d.getState().entryMetas.size;
    press('left', 'x', 'F7');
    expect(d.getState().entryMetas.size, 'F7 でフォルダが増えていない').toBe(before + 1);
  });

  it('🔴 Shift+↓ で範囲が伸びる', () => {
    press('left', 'f1', 'ArrowDown'); // f2 へ
    press('left', 'f2', 'ArrowDown', { shiftKey: true });
    expect(sel('left')).toEqual(['f2', 'a']);
  });

  /**
   * 🔴 **起点が無いときは、いまの行を起点に立ててから伸ばす**(変異 K7 が生き延びて判明)。
   * ⚠ 1 稿目は Shift の前に必ず ↓ を押していたので、**起点が null の経路を 1 度も
   *   通っていなかった**(CLAUDE.md §2「弱いのではなく走っていない」)。
   * ⚠ `rangeInRows` は起点 null を「行き先 1 件」と解くので、立てないと
   *   **押すたびに 1 件へ潰れて**積み上がらない。
   */
  it('🔴 印が無い状態から Shift+↓ を押しても、そこから伸びる', () => {
    expect(sel('left'), '前提が崩れている(既に印がある)').toEqual([]);
    press('left', 'f1', 'ArrowDown', { shiftKey: true });
    expect(sel('left'), '起点を立てていない(1 件へ潰れた)').toEqual(['f1', 'f2']);
  });

  /**
   * 🔴 **反対側の行の焦点を、自分のものと読まない**(変異 K3 が生き延びて判明)。
   * ⚠ 1 稿目は「焦点を置いた行から押す」形しか無く、**焦点と打鍵の側が食い違う経路**を
   *   1 度も通していなかった。⚠ 読み違えると、右で押した ↓ が**左の行を基準に**動く。
   */
  it('🔴 カーソルが反対側にあるとき、押した側は「カーソルなし」として振る舞う', () => {
    row('left', 'c').focus(); // 左の 3 行目にカーソル(右にはカーソルが無い)
    const host = region.querySelector<HTMLElement>(
      '[data-pkc-region="dual-pane"][data-pkc-side="right"]',
    )!;
    host.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    // 右はカーソルが無いので**先頭から**入る。左の 'c' の次('x' や 'b')になってはいけない
    expect(cur('right'), '反対側のカーソルを自分のものとして読んだ').toBe('f1');
    expect(cur('left'), '押していない側が動いた').toBe('c');
  });

  it('🔴 Ctrl+A はそのペインの全部(反対側は空のまま)', () => {
    press('right', 'a', 'a', { ctrlKey: true });
    expect(sel('right')).toEqual(['f1', 'f2', 'a', 'b', 'c']);
    expect(sel('left'), '反対側まで選ばれた').toEqual([]);
  });

  it('🔴 Enter でフォルダの中へ入る(押したペインだけ)', () => {
    press('right', 'f1', 'Enter');
    expect(paneScope(paneOf(d.getState().dual, 'right'))).toBe('f1');
    expect(paneScope(paneOf(d.getState().dual, 'left')), '反対側まで入った').toBeNull();
    expect(d.getState().scopeLid, '左の列まで入った').toBeNull();
  });

  it('🔴 Backspace で親へ戻る', () => {
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' });
    press('left', 'x', 'Backspace');
    expect(paneScope(paneOf(d.getState().dual, 'left'))).toBeNull();
  });

  it('🔴 Tab で反対のペインへ移る(FD の基本操作)', () => {
    const ev = press('left', 'a', 'Tab');
    expect(ev.defaultPrevented, 'Tab を受けていない').toBe(true);
    expect(d.getState().dual.focus, '反対側へ移っていない').toBe('right');
  });

  /**
   * 🔴 **消す鍵が、画面に出ていないものを消しに行かない**。
   * ⚠ 素通しにすると global の `delete-selected` に落ち、**左の列の印**が消える ──
   *   2 ペインを見ている user から見て、消えるものが画面に無い。不可逆なので必ず止める。
   */
  /**
   * 🔴 **消すのはこのペインの印だけ**(#273 段②)。
   * ⚠ 素通しにすると global の `delete-selected` に落ち、**左の列の印**が消える ──
   *   2 ペインを見ている user から見て、消えるものが画面に無い。
   * 🔑 実体は `deleteFrom` 1 本(左の列と同じ確認・同じ断り方)。
   */
  it('🔴 Delete はこのペインの印を消す(左の列の印は巻き込まない)', async () => {
    d.dispatch({ type: 'TOGGLE_SELECT', lid: 'a' }); // 左の列に印(画面には出ていない相手)
    expect(d.getState().selection, '前提が崩れている').toEqual(['a']);
    press('right', 'b', 'ArrowDown'); // 右で 'f2' を選ぶ…ではなく行を作る
    d.dispatch({ type: 'DUAL_SELECT', side: 'right', lid: 'c', mode: 'set' });
    press('right', 'c', 'Delete');
    // 🔴 **確認が出る**(#299 段②)── 押すまで 1 件も消えない
    expect(d.getState().entryMetas.has('c'), '確認の前に消えている').toBe(true);
    expect(dialogMessage(), '確認の文言に件数が出ていない').toMatch(/1\s*件/);
    await answerDialog('ok');
    expect(d.getState().entryMetas.has('c'), 'このペインの印が消えていない').toBe(false);
    expect(d.getState().entryMetas.has('a'), '左の列の印まで消えた(画面に無いものが消えた)').toBe(
      true,
    );
  });

  /**
   * 🔴 **押しボタンからも同じことができる**(#273 段②。user 指示 2026-08-03
   * 「マウスだけで完結し、キーボードは近道」)。
   */
  it('🔴 「ゴミ箱へ」のボタンも、そのペインの印だけを消す', async () => {
    d.dispatch({ type: 'TOGGLE_SELECT', lid: 'a' });
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'c', mode: 'set' });
    const btn = region.querySelector<HTMLElement>('[data-pkc-field="dual-delete"]')!;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await answerDialog('ok');
    expect(d.getState().entryMetas.has('c'), 'ボタンで消えていない').toBe(false);
    expect(d.getState().entryMetas.has('a'), '左の列の印まで消えた').toBe(true);
  });

  /**
   * 🔴 **確認を待っている間に対象が消えたら、数えて言う**(#308)。
   *
   * ⚠ 黙って残りを消すと、user は「一部が消えなかった」ことに気づけない。
   *   この repo の「落としたものは数えて言う」に揃える。
   * ⚠ 直す前は再確認そのものが無く、**reducer が黙って捨てて**いた。
   */
  it('🔴 待っている間に一部が消えたら、黙って残りを消さない', async () => {
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'b', mode: 'toggle' });
    expect(d.getState().dual.left.selection.length, '前提が崩れている').toBe(2);

    const btn = region.querySelector<HTMLElement>('[data-pkc-field="dual-delete"]')!;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    // 待っている間に片方だけ消える(別タブ / 取込は entry を総入れ替えする)
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: METAS.filter((m) => m.lid !== 'a'),
      relations: RELS,
    });

    await answerDialog('ok');

    expect(d.getState().entryMetas.has('b'), '黙って残りを消した').toBe(true);
    expect(d.getState().error ?? '', '無言で捨てた(理由が出ていない)').toContain(
      '既にありません',
    );
  });

  /**
   * 🔴 **対照群**(空振り防止)── 何も崩れていなければ、今までどおり消える。
   */
  it('対照群: 崩れていなければ、まとめて消える', async () => {
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'b', mode: 'toggle' });
    const btn = region.querySelector<HTMLElement>('[data-pkc-field="dual-delete"]')!;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await answerDialog('ok');
    expect(d.getState().entryMetas.has('a'), '対照群が消えていない').toBe(false);
    expect(d.getState().entryMetas.has('b'), '対照群が消えていない').toBe(false);
  });

  /**
   * 🔴 **その場で名前を打ち替える**(#273 段④。OS のファイラの F2)。
   * ⚠ 入力欄は **state 駆動**で出す ── DOM を直に差し替えると、別タブの保存が
   *   届くだけで打っている最中の入力が消える(この面は state で組み直すため)。
   */
  const renameInput = (side: string): HTMLInputElement | null =>
    region.querySelector<HTMLInputElement>(
      `[data-pkc-region="dual-pane"][data-pkc-side="${side}"] [data-pkc-field="dual-rename"]`,
    );

  it('🔴 F2 で入力欄が出て、Enter で名前が変わる', () => {
    press('left', 'a', 'F2');
    const input = renameInput('left');
    expect(input, 'F2 で入力欄が出ていない').toBeTruthy();
    expect(input!.value, '元の名前が入っていない').toBe('あ');
    input!.value = 'あたらしい名前';
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(d.getState().entryMetas.get('a')?.title).toBe('あたらしい名前');
    expect(renameInput('left'), '確定したのに入力欄が残っている').toBeNull();
  });

  it('🔴 Esc なら変えずに閉じる', () => {
    press('left', 'a', 'F2');
    const input = renameInput('left')!;
    input.value = '打ちかけ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(d.getState().entryMetas.get('a')?.title, 'Esc なのに変わった').toBe('あ');
    expect(renameInput('left')).toBeNull();
  });

  /**
   * 🔴 **打っている最中は、面の鍵に化けない**。⚠ これが無いと `Enter` が「開く」に、
   *   `Backspace` が「親へ」に化けて、名前が打てない。
   */
  it('🔴 打っている最中の Backspace は、親へ戻らない', () => {
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' });
    d.dispatch({ type: 'DUAL_RENAME_BEGIN', side: 'left', lid: 'x' });
    const input = renameInput('left')!;
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
    );
    expect(paneScope(paneOf(d.getState().dual, 'left')), '親へ戻ってしまった').toBe('f1');
  });

  it('⚠ 空白だけの名前にはしない(変えずに閉じる)', () => {
    press('left', 'a', 'F2');
    const input = renameInput('left')!;
    input.value = '   ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(d.getState().entryMetas.get('a')?.title).toBe('あ');
  });

  it('🔴 他所を押したら確定する(OS のファイラと同じ)', () => {
    press('left', 'a', 'F2');
    const input = renameInput('left')!;
    input.value = 'ぼかし確定';
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(d.getState().entryMetas.get('a')?.title).toBe('ぼかし確定');
  });

  /**
   * ⚠ **Esc のあとに blur が来ても、打った値は入らない**。
   * ⚠ これは**空振り気味の test** である ── 実際には `Esc` で入力欄が DOM から
   *   外れ、外れた節点の focusout は root まで上がらないので、そもそも handler に
   *   届かない(だから handler 側の門を外しても緑のまま)。振る舞いの記録として残す。
   */
  it('Esc で閉じたあとに blur が来ても、打った値は入らない', () => {
    press('left', 'a', 'F2');
    const input = renameInput('left')!;
    input.value = '打ちかけ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    // ⚠ 閉じたあとに、外れた入力欄から focusout が届く
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(d.getState().entryMetas.get('a')?.title, 'Esc のあとに打った値が入った').toBe('あ');
  });

  /**
   * 🔴 **打ち替えている相手が消えたら、打つのもやめる**(変異 R5 が生き延びて判明)。
   * ⚠ 残すと、確定した瞬間に**どこにも無い lid へ改名が飛ぶ**。
   */
  it('🔴 打ち替え中に相手が消えたら、入力欄も閉じる', () => {
    press('left', 'a', 'F2');
    expect(d.getState().dual.renaming, '前提が崩れている').not.toBeNull();
    d.dispatch({ type: 'DELETE_ENTRIES', lids: ['a'] });
    expect(d.getState().dual.renaming, '消えた相手の打ち替えが残っている').toBeNull();
  });

  it('🔴 「名前を変える」は 1 件のときだけ(理由を出す)', () => {
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'b', mode: 'toggle' });
    region.querySelector<HTMLElement>('[data-pkc-field="dual-rename-begin"]')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    expect(d.getState().error ?? '').toContain('1 件だけ');
  });

  /**
   * 🔴 **反対側へ写す**(#273 段③。FD の C 相当)。
   * ⚠ この harness は `services` を渡していないので、**断り**の側だけをここで見る
   *   (実際に写す側は下の describe が fake の `readBodies` を渡して見る)。
   */
  it('🔴 本文を読む口が無い版では、黙らずに断る', () => {
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    const btn = region.querySelector<HTMLElement>('[data-pkc-field="dual-copy"]')!;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(d.getState().error ?? '').toContain('写せません');
  });

  it('🔴 何も選ばずに写そうとしたら、理由が出る', () => {
    d.dispatch({ type: 'DUAL_CLEAR_SELECTION', side: 'left' });
    const btn = region.querySelector<HTMLElement>('[data-pkc-field="dual-copy"]')!;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(d.getState().error ?? '').toContain('写すものを選んでください');
  });

  /**
   * 🔴 **開いている場所にフォルダを作る**(#273 段②)。
   * ⚠ **編集に入らない** ── 入ると中央が本文の面へ切り替わり、整理の途中で
   *   面から放り出される(FD は作ったらその場に出る)。
   */
  it('🔴 「新しいフォルダ」は、そのペインの場所に作る(面から出ない)', () => {
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' });
    const before = d.getState().entryMetas.size;
    const btn = region.querySelector<HTMLElement>('[data-pkc-field="dual-mkdir"]')!;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const st = d.getState();
    expect(st.entryMetas.size, 'フォルダが増えていない').toBe(before + 1);
    expect(st.phase, '編集に入って面から出た').toBe('ready');
    // 🔑 **f1 の中に**居る(左の列の現在地ではなく、そのペインの場所)
    const made = [...st.entryMetas.values()].find((m) => m.title === '新しいフォルダ')!;
    expect(made.archetype).toBe('folder');
    expect(
      st.relations.some((r) => r.kind === 'structural' && r.fromLid === 'f1' && r.toLid === made.lid),
      '開いている場所の中に作られていない',
    ).toBe(true);
  });

  /**
   * 🔴 **入れ物だけでなく中身も作れる**(#273)。
   *
   * ⚠ 直す前は `dual-mkdir`(フォルダ)しか無く、整理の面で 1 枚メモを置くのに
   *   左の列へ戻る → 作る → 開き直す → 移す、の 4 手が要った。
   * 🔑 見るのは **種類**と**入れ先**の 2 つ ── どちらかだけだと、
   *   「フォルダができた」も「左の列の現在地にできた」も緑で通る。
   */
  it('🔴 「新しいノート」は、そのペインの場所に text で作る(面から出ない)', () => {
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' });
    const before = d.getState().entryMetas.size;
    const btn = region.querySelector<HTMLElement>('[data-pkc-field="dual-mknote"]')!;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const st = d.getState();
    expect(st.entryMetas.size, 'ノートが増えていない').toBe(before + 1);
    expect(st.phase, '編集に入って面から出た').toBe('ready');
    const made = [...st.entryMetas.values()].find((m) => m.title === '新しいノート')!;
    expect(made, 'ノートが見つからない(名前が違う)').toBeDefined();
    // 🔴 **種類** ── フォルダと同じ口を通すので、ここを取り違えると入れ物ができる
    expect(made.archetype, 'フォルダになっている').toBe('text');
    // 🔑 **入れ先** ── 左の列の現在地ではなく、そのペインが開いている場所
    expect(
      st.relations.some(
        (r) => r.kind === 'structural' && r.fromLid === 'f1' && r.toLid === made.lid,
      ),
      '開いている場所の中に作られていない',
    ).toBe(true);
  });

  /**
   * ⚠ **断り文は「押した場所」と対で pin する**(CLAUDE.md §1)── フォルダと
   *   同じ口を通すので、呼び名を取り違えると **user は別のものを探す**。
   */
  it('🔴 編集中は「ノートを作ってください」と断る(フォルダと呼び違えない)', () => {
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '' });
    d.dispatch({ type: 'START_EDIT' });
    const before = d.getState().entryMetas.size;
    region
      .querySelector<HTMLElement>('[data-pkc-field="dual-mknote"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(d.getState().entryMetas.size, '編集中なのに作られた').toBe(before);
    expect(d.getState().error ?? '').toContain('ノートを作ってください');
    // ⚠ 対照群 ── フォルダ側は「フォルダを作ってください」と言う(同じ字にしない)
    region
      .querySelector<HTMLElement>('[data-pkc-field="dual-mkdir"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(d.getState().error ?? '').toContain('フォルダを作ってください');
  });

  /**
   * 🔴 **印もカーソルも無いときだけ断る**(2026-08-19 の作り直し)。
   *
   * ⚠ 直す前は「印が無ければ断る」だった ── カーソルを印から切り離した以上、
   *   その形のままだと**矢印で下りて Delete が永久に効かない**。
   * 🔑 相手の決め方は `operationTargets` **1 本**(写す・移す・ゴミ箱で共通)。
   */
  it('🔴 印もカーソルも無ければ、理由を出して消さない', () => {
    d.dispatch({ type: 'DUAL_CLEAR_SELECTION', side: 'right' });
    // ⚠ カーソルも外す ── 行に焦点を当てると `focusin` がカーソルを立てるので、
    //   ここは**ペインの器**へ打つ(行の上ではない)
    const host = region.querySelector<HTMLElement>(
      '[data-pkc-region="dual-pane"][data-pkc-side="right"]',
    )!;
    host.focus();
    expect(paneOf(d.getState().dual, 'right').cursor, '前提が崩れている').toBeNull();
    host.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }),
    );
    expect(d.getState().error ?? '').toContain('削除するものを選んでください');
  });

  it('🔴 編集中は理由を出して断る(無言で止めない)', () => {
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '' });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '前提が崩れている').toBe('editing');
    press('right', 'b', 'ArrowDown');
    expect(d.getState().error ?? '').toContain('編集を終了してから');
  });
});

/**
 * 🔴 **写す(コピー)が本当に増やす**(#273 段③)。
 * ⚠ 本文を読む口(`readBodies`)を渡した配線でしか通らない経路なので、
 *   harness を分ける(渡さない側の断りは上の describe が見ている)。
 */
describe('2 ペインの写す(#273 段③)', () => {
  let root: HTMLElement;
  let d: Dispatcher;
  let region: HTMLElement;
  let asked: string[][] = [];

  beforeEach(() => {
    document.body.innerHTML = '';
    asked = [];
    root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    d = new Dispatcher();
    buildShell(root);
    bindActions(root, d, {
      readBodies: async (lids) => {
        asked.push([...lids]);
        return new Map(lids.map((l) => [l, `# 本文 ${l}`]));
      },
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    region = document.createElement('div');
    root.append(region);
    const r = new DualFilerRenderer(region);
    d.onState((st) => r.render(st));
    r.render(d.getState());
  });

  it('🔴 平のノートを反対側の場所へ写す(元は残る)', async () => {
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f1' }); // 行き先は f1 の中
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    region.querySelector<HTMLElement>('[data-pkc-field="dual-copy"]')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const st = d.getState();
    expect(st.entryMetas.has('a'), '元が消えた(写すのであって移すのではない)').toBe(true);
    const made = [...st.entryMetas.values()].filter((m) => m.title === 'あ' && m.lid !== 'a');
    expect(made.length, '写した先が増えていない').toBe(1);
    expect(
      st.relations.some(
        (r) => r.kind === 'structural' && r.fromLid === 'f1' && r.toLid === made[0]!.lid,
      ),
      '反対側の場所に入っていない',
    ).toBe(true);
    expect(asked[0], '本文を 1 往復で読んでいない').toEqual(['a']);
  });

  /**
   * 🔴 **画面に出ていない印は写さない**(変異 C6 が生き延びて判明)。
   * ⚠ 印は行が見えなくなっても残る(絞り込みで消えた)ので、素で数えると
   *   **画面に無いものが増える** ── 移す・消すと同じ規則(`visibleSelection`)で切る。
   */
  it('🔴 絞り込みで消えた印は写さない(理由を出す)', () => {
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'えっくす' }); // 'あ' は消える
    region.querySelector<HTMLElement>('[data-pkc-field="dual-copy"]')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    expect(d.getState().error ?? '', '画面に無い印まで写した').toContain('写すものを選んでください');
  });

  /**
   * 🔴 **フォルダを写したら中身も行く**。⚠ ここが「お粗末」と言われた所の中身で、
   *   選んだ物だけ写すと**フォルダだけが空で増える**。
   */
  it('🔴 フォルダを写すと、中身も一緒に行く', async () => {
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'f1', mode: 'set' });
    region.querySelector<HTMLElement>('[data-pkc-field="dual-copy"]')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const st = d.getState();
    const copy = [...st.entryMetas.values()].find((m) => m.title === 'はこ1 のコピー')!;
    expect(copy, 'フォルダの写しが無い').toBeTruthy();
    const kids = st.relations.filter((r) => r.kind === 'structural' && r.fromLid === copy.lid);
    expect(kids.length, '中身が付いてきていない(空のフォルダだけ増えた)').toBe(2);
    // ⚠ 元のフォルダの中身は**動いていない**
    expect(
      st.relations.filter((r) => r.kind === 'structural' && r.fromLid === 'f1').length,
      '元の中身が減った',
    ).toBe(2);
  });
});

/**
 * 🔴 **掴んで落とす(#273 段⑤。user 指摘 2026-08-19「往年の FD などを見習って
 * ください / OS のファイラと同じことができないといけません」)。**
 *
 * ⚠ 2 ペインの本題は「**左右のあいだで動かす**」ことなので、掴んで落とせないと
 *   帯のボタン(移す)だけが唯一の動線になる ── OS のファイラでは主動線である。
 *
 * 🔑 守る主張は 4 つ:
 * 1. **掴んだ面の印を運ぶ**(左の列の印を運ばない ── 画面に無いものが動く)
 * 2. **ペインの地は「そのペインがいま開いている場所」へ落ちる**(追随する)
 * 3. **フォルダの行はその中へ**(OS のファイラと同じ)
 * 4. **落とし先が無い所では受けない**(光ったままにしない)
 *
 * ⚠ `DataTransfer` は happy-dom に無いが、実装が使うのは
 *   `types` / `getData` / `setData` / `dropEffect` の 4 つだけなので stub で回る
 *   (`tests/adapter/folder-organize.test.ts` と同じ作法)。
 */
const PKC_DRAG_DUAL = 'application/x-pkc-lids';

function dtStub(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    dropEffect: 'none',
    effectAllowed: 'none',
    get types(): string[] {
      return [...data.keys()];
    },
    getData: (t: string) => data.get(t) ?? '',
    setData: (t: string, v: string) => void data.set(t, v),
    files: { length: 0, item: () => null },
    items: [] as unknown[],
  };
}

function dragEv(type: string, dt: ReturnType<typeof dtStub>): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: dt });
  return e;
}

describe('2 ペインの掴んで落とす(#273 段⑤)', () => {
  let root: HTMLElement;
  let d: Dispatcher;
  let region: HTMLElement;

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
    const r = new DualFilerRenderer(region);
    d.onState((st) => r.render(st));
    r.render(d.getState());
  });

  const pane = (side: string): HTMLElement =>
    region.querySelector<HTMLElement>(
      `[data-pkc-region="dual-pane"][data-pkc-side="${side}"]`,
    )!;
  const row = (side: string, lid: string): HTMLElement =>
    pane(side).querySelector<HTMLElement>(
      `[data-pkc-region="dual-table"] [data-pkc-entry="${lid}"]`,
    )!;
  const parentOf = (lid: string): string | null =>
    d.getState().relations.find((r) => r.kind === 'structural' && r.toLid === lid)?.fromLid ?? null;
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('🔴 行は掴めて、フォルダの行は落とし先にもなる', () => {
    expect(row('left', 'a').getAttribute('draggable'), '行が掴めない').toBe('true');
    expect(row('left', 'f1').getAttribute('data-pkc-drop')).toBe('folder');
    expect(
      row('left', 'a').hasAttribute('data-pkc-drop'),
      '平のノートの行そのものが落とし先を名乗っている',
    ).toBe(false);
  });

  /**
   * ⚠ **ペイン自身が entry に見えてはいけない**(だから行き先は別の属性で渡す)。
   * ここが崩れると、ペインの地へ落としたときに**ペインを entry として**動かそうと
   * する ── `data-pkc-drop-scope` を置いている理由そのものである。
   */
  it('ペインの地は落とし先だが、entry ではない', () => {
    expect(pane('right').getAttribute('data-pkc-drop')).toBe('pane');
    expect(
      pane('right').hasAttribute('data-pkc-entry'),
      'ペイン自身が entry を名乗っている',
    ).toBe(false);
  });

  /**
   * 🔴 **行き先は、そのペインがいま開いている場所に追随する。**
   * ⚠ 書き忘れると、フォルダの中を開いていても**ルートへ**落ちる(いちばん
   *   気づけない形 ── 落ちること自体は成功するので、断りも出ない)。
   */
  it('🔴 ペインの地の行き先が、いま開いている場所に追随する', () => {
    expect(pane('right').getAttribute('data-pkc-drop-scope'), 'ルートは空文字').toBe('');
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f1' });
    expect(
      pane('right').getAttribute('data-pkc-drop-scope'),
      'フォルダを開いても行き先がルートのまま',
    ).toBe('f1');
    // ⚠ 反対側は動いていない(片方の場所がもう片方の行き先になっていない)
    expect(pane('left').getAttribute('data-pkc-drop-scope')).toBe('');
  });

  /**
   * 🔴 **これが段⑤の本題** ── 左のペインから掴んで、右のペインへ落とす。
   */
  it('🔴 反対側のペインの地へ落とすと、その場所へ入る', async () => {
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f1' });
    pane('right').dispatchEvent(dragEv('drop', dtStub({ [PKC_DRAG_DUAL]: 'a' })));
    await tick();
    expect(parentOf('a'), '右のペインが開いている場所へ入っていない').toBe('f1');
  });

  it('🔴 ルートを開いているペインへ落とすと、フォルダから出る', async () => {
    expect(parentOf('x'), '前提が崩れている').toBe('f1');
    pane('right').dispatchEvent(dragEv('drop', dtStub({ [PKC_DRAG_DUAL]: 'x' })));
    await tick();
    expect(parentOf('x'), 'ルートへ出ていない').toBeNull();
  });

  it('🔴 フォルダの行へ落とすと、その中へ入る', async () => {
    row('right', 'f2').dispatchEvent(dragEv('drop', dtStub({ [PKC_DRAG_DUAL]: 'a' })));
    await tick();
    expect(parentOf('a'), 'フォルダの行へ落としたのに入っていない').toBe('f2');
  });

  /**
   * ⚠ **平の行へ落としても捨てない** ── 行の上で離しても、OS のファイラは
   *   「その一覧が開いている場所」へ入れる。⚠ 無反応にすると、user は
   *   「掴めているのに落とせない」と読む(狙いの隙間が細くなる)。
   */
  it('平の行へ落としても、そのペインの場所へ入る', async () => {
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f1' });
    row('right', 'x').dispatchEvent(dragEv('drop', dtStub({ [PKC_DRAG_DUAL]: 'a' })));
    await tick();
    expect(parentOf('a'), '行の上で離したら捨てられた').toBe('f1');
  });

  /**
   * 🔴 **掴んだ面の印を運ぶ**(#273 段⑤の要)。
   *
   * ⚠ ここを左の列の印(`st.selection`)のまま書くと、**画面に出ていないものが動く**
   *   ── 移す・写す・消すで既に踏んでいる罠の 4 つ目の顔である。
   * 🔑 空振りを避けるため、**両方の印に掴んだ行を入れ、相方だけを変える**
   *   ── どちらか片方にしか居ないと、`marked.includes(lid)` が false になって
   *   **どちらの実装でも「1 件だけ」**になり、変異が生き延びる。
   */
  /**
   * 🔴 **落とした後を F6 と同じ形に揃える**(2026-08-21、cowork #15)。
   *
   * cowork の報告は「D&D の後、選択が**落とした行の 1 つ下**へ移る(実害は見ていない)」。
   * ⚠ 調べたら選択は**移っていなかった** ── 見えていたのは `:hover` の塗りで、
   *   `tr[data-pkc-marked] td` と `tr:hover td` が**同じ地色**だったための見間違い。
   * 🔴 **ただし別の実害が 2 つ在った**(こちらが本体):
   *   ① drop の経路だけ「動いた回だけ印を外す」が抜けており、次にゴミ箱を押すと
   *      **「選んでいた行がいま画面にありません」という的外れな断り**が出る
   *   ② 焦点の引き継ぎも抜けており、落とした直後の `↑` `↓` が**無言で死ぬ**
   */
  it('🔴 落とした後、掴んだ側の印が外れる(次の操作が的外れな断りを出さない)', async () => {
    // 左で 2 件に印を付けてから掴む
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'b', mode: 'toggle' });
    expect(d.getState().dual.left.selection.length, '前提が崩れている').toBe(2);

    /**
     * ⚠ **本当に動く落とし方にする**(1 稿目はここを間違えた)。ルートに在るものを
     *   ルートの地へ落としても `alreadyThere` で**動かない** ── そのとき印を
     *   外さないのが正しい挙動なので、fixture の側が主張を検査できていなかった。
     */
    const dt = dtStub();
    row('left', 'a').dispatchEvent(dragEv('dragstart', dt));
    row('right', 'f2').dispatchEvent(dragEv('drop', dt));
    await tick();
    expect(parentOf('a'), '前提が崩れている(動いていない)').toBe('f2');

    expect(
      d.getState().dual.left.selection,
      '掴んだ側の印が残っている(次の操作が消えた行を指す)',
    ).toEqual([]);
  });

  it('🔴 落とした後、掴んだ側のカーソルが生きている行を指す(↑↓ が死なない)', async () => {
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    const dt = dtStub();
    row('left', 'a').dispatchEvent(dragEv('dragstart', dt));
    row('right', 'f2').dispatchEvent(dragEv('drop', dt));
    await tick();
    expect(parentOf('a'), '前提が崩れている(動いていない)').toBe('f2');

    const cur = d.getState().dual.left.cursor;
    expect(cur, 'カーソルが立っていない(次の ↑↓ が先頭へ飛ぶ)').not.toBeNull();
    // ⚠ **画面に出ている行**を指していること(消えた行を指したままにしない)
    const still = pane('left').querySelector(`[data-pkc-entry="${cur}"]`);
    expect(still, 'カーソルが画面に無い行を指している').not.toBeNull();
  });

  /**
   * ⚠ **落とし先が無い / 動かなかった回は、印を外さない。**
   *   外すと「掴んで戻しただけで選択が消える」になる(F6 が同じ形で守っている)。
   */
  /**
   * ⚠ **落とし先は在るが、動かなかった回。**
   *   1 稿目は「落とし先の属性が無い所」へ落としていたが、それは
   *   `dropTargetOf === undefined` で**手前で return する**ので、
   *   検査したい「動いた回だけ外す」の判定を**1 度も通っていなかった**
   *   (変異試験で `relations !== before` を外しても生き延びた)。
   * 🔑 ルートに在るものを**ルートを開いているペインの地**へ落とす ──
   *   落とし先は成立し、`alreadyThere` で 1 件も動かない形。
   */
  it('落とし先は在るが動かなかった回は、印を外さない', async () => {
    expect(parentOf('a'), '前提が崩れている(a はルートに在ること)').toBeNull();
    expect(pane('left').getAttribute('data-pkc-drop-scope'), '前提: 左はルート').toBe('');
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    const dt = dtStub();
    row('left', 'a').dispatchEvent(dragEv('dragstart', dt));
    pane('left').dispatchEvent(dragEv('drop', dt));
    await tick();
    expect(parentOf('a'), '前提が崩れている(動いてしまった)').toBeNull();
    expect(d.getState().dual.left.selection, '動いていないのに印が消えた').toEqual(['a']);
  });

  /**
   * 🔴 **掴んだ側は `dragstart` のたびに決め直す**(2026-08-21)。
   * ⚠ 決め直さないと、2 ペインで掴んだ後に**左の列**から掴んだとき、
   *   前の側(2 ペイン)の印を外してしまう。
   */
  it('🔴 2 ペイン以外から掴んだ drag は、2 ペインの印を外さない', async () => {
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    // ① まず 2 ペインから掴む(ここで「掴んだ側 = left」が立つ)
    const first = dtStub();
    row('left', 'a').dispatchEvent(dragEv('dragstart', first));
    // ② 次に **2 ペインの外**(器そのもの)から掴む ── 側は無い
    const second = dtStub({ [PKC_DRAG_DUAL]: 'b' });
    region.dispatchEvent(dragEv('dragstart', second));
    // ③ その drag を右の f2 へ落とす(動きはする)
    row('right', 'f2').dispatchEvent(dragEv('drop', second));
    await tick();
    expect(parentOf('b'), '前提が崩れている(動いていない)').toBe('f2');
    expect(
      d.getState().dual.left.selection,
      '別の所から掴んだのに 2 ペインの印が外れた',
    ).toEqual(['a']);
  });

  /**
   * 🔴 **`dragenter` でも受理を宣言する**(2026-08-21)。
   * ⚠ 直す前は `dragover` しか受けておらず、仕様上の受理判定点(`dragenter`)を
   *   1 つ落としていた ── cowork の「地は 5/5・行は 0/5」という**落とし先で割れる**
   *   非対称を説明できる、コード上で名指しできる唯一の穴だった。
   */
  it('🔴 dragenter でも落とし先として受理する(dragover だけに頼らない)', () => {
    const dt = dtStub({ [PKC_DRAG_DUAL]: 'a' });
    const ev = dragEv('dragenter', dt);
    row('left', 'f1').dispatchEvent(ev);
    expect(ev.defaultPrevented, 'dragenter を受理していない').toBe(true);
  });

  it('🔴 2 ペインから掴んだら、2 ペインの印を運ぶ(左の列の印ではない)', () => {
    // 左の列の印: a と c
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'TOGGLE_SELECT', lid: 'c' });
    // 2 ペイン(左)の印: a と b
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'b', mode: 'toggle' });
    const dt = dtStub();
    row('left', 'a').dispatchEvent(dragEv('dragstart', dt));
    expect(
      dt.getData(PKC_DRAG_DUAL).split(' ').sort(),
      '掴んだ面ではなく左の列の印を運んでいる',
    ).toEqual(['a', 'b']);
  });

  it('印の付いていない行を掴んだら、その 1 件だけ運ぶ', () => {
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    const dt = dtStub();
    row('left', 'c').dispatchEvent(dragEv('dragstart', dt));
    expect(dt.getData(PKC_DRAG_DUAL)).toBe('c');
  });

  /**
   * ⚠ **印は行が見えなくなっても残る** ── 素で数えると、絞り込みで消えたものまで
   *   運ぶ(移す・写す・消すと同じ規則で切る)。
   */
  it('🔴 絞り込みで消えた印は運ばない', () => {
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'b', mode: 'toggle' });
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'い' }); // 'あ' が消え、'い' が残る
    const dt = dtStub();
    row('left', 'b').dispatchEvent(dragEv('dragstart', dt));
    expect(dt.getData(PKC_DRAG_DUAL), '画面に無い印まで運んだ').toBe('b');
  });

  /**
   * 🔴 **落とし先を光らせる / 落とせない所では消す**(#240 と同じ規則を
   * 2 ペインでも通す)。⚠ 光ったままにすると「そこへ入った」と読まれる。
   */
  it('🔴 落とし先が光り、落とせない所へ移ったら消える', () => {
    const folder = row('right', 'f1');
    folder.dispatchEvent(dragEv('dragover', dtStub({ [PKC_DRAG_DUAL]: 'a' })));
    expect(folder.hasAttribute('data-pkc-dropping'), '落とし先が光っていない').toBe(true);
    // region の外(この面の外)へ抜ける ── 落とせない
    root.dispatchEvent(dragEv('dragover', dtStub({ [PKC_DRAG_DUAL]: 'a' })));
    expect(
      folder.hasAttribute('data-pkc-dropping'),
      '落とせない所へ移ったのに、前の行が光ったまま',
    ).toBe(false);
  });

  /**
   * ⚠ **断る理由を出す**(無言で捨てない)── フォルダを自分の中へは入れられない。
   * 🔑 経路は `moveEntries` 1 本なので、断り方も帯のボタンと同じである。
   */
  it('🔴 輪になる落とし方は断る(黙って捨てない)', async () => {
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f1' });
    pane('right').dispatchEvent(dragEv('drop', dtStub({ [PKC_DRAG_DUAL]: 'f1' })));
    await tick();
    expect(d.getState().error ?? '', '無言で捨てている').toContain('自分の中');
  });
});
