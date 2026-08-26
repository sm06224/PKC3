/** @vitest-environment happy-dom */
/**
 * 🔴 **2 ペインの道具**(#273 残件)── 絞る / 戻る / 留める / 下見。
 *
 * 守る主張:
 * 1. **左右で別に絞れる**(器の 1 本に戻らない)
 * 2. **戻る / 進むは、そのペインの場所を動かす**(押せないときは何もしない)
 * 3. **留めは端末に憶える。置けるなら外せる**(消えた場所からも外せる)
 * 4. **下見は本文を読みに行き、追い越した答えは捨てる**
 * 5. **配線**(欄・ボタン → services / dispatch)── どちらの unit も見ない所
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { DualFilerRenderer } from '../../src/adapter/ui/render/dual-filer';
import { DualPrefsStore } from '../../src/adapter/ui/render/dual-prefs';
import { paneOf, paneScope, PREVIEW_CHARS } from '../../src/features/relation/dual-pane';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';

function meta(lid: string, order: number, title: string, archetype = 'text', bodyChars: number | null = null): EntryMeta {
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
    bodyChars,
  };
}
const rel = (id: string, fromLid: string, toLid: string): Relation => ({
  id,
  fromLid,
  toLid,
  kind: 'structural',
  createdAt: null,
  updatedAt: null,
});

/** ルート: はこ1(f1)/ はこ2(f2)/ あ(a, 100 字)/ いろは(b, 20 字)。f1 の中に x。 */
const METAS = [
  meta('f1', 1, 'はこ1', 'folder'),
  meta('f2', 2, 'はこ2', 'folder'),
  meta('a', 3, 'あ', 'text', 100),
  meta('b', 4, 'いろは', 'text', 20),
  meta('x', 5, 'えっくす', 'text', 7),
];
const RELS = [rel('r1', 'f1', 'x')];

const booted = (): AppState =>
  reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS }).state;

function fakeStorage(): Pick<Storage, 'getItem' | 'setItem'> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe('ペインごとに絞る(#273 残件)', () => {
  it('🔴 左だけ絞っても、右は絞られない', () => {
    let s = booted();
    s = reduce(s, { type: 'DUAL_SET_FILTER', side: 'left', filter: 'いろ' }).state;
    expect(paneOf(s.dual, 'left').filter).toBe('いろ');
    expect(paneOf(s.dual, 'right').filter, '反対のペインまで絞られた').toBe('');
    // 🔑 打った側が「元」になる(他の押し方と揃える)
    expect(s.dual.focus).toBe('left');
  });

  /**
   * 🔴 **画面の行数で見る**(state だけ見ても「効いている」とは言えない ──
   *   §4「観測点は user が見る面」)。
   */
  it('🔴 絞ると、その側の表だけ行が減る', () => {
    const region = document.createElement('div');
    document.body.append(region);
    const r = new DualFilerRenderer(region, undefined, new DualPrefsStore(fakeStorage()));
    let s = booted();
    r.render(s);
    const rowsOf = (side: string): number =>
      region.querySelectorAll(
        `[data-pkc-region="dual-table"] [data-pkc-side="${side}"][data-pkc-entry]`,
      ).length;
    const before = rowsOf('left');
    expect(before, '前提が崩れた(行が出ていない)').toBeGreaterThan(1);
    expect(rowsOf('right')).toBe(before);
    s = reduce(s, { type: 'DUAL_SET_FILTER', side: 'left', filter: 'いろ' }).state;
    r.render(s);
    expect(rowsOf('left'), '絞りが効いていない').toBe(1);
    expect(rowsOf('right'), '反対のペインまで絞られた').toBe(before);
  });

  it('🔴 欄に打つと、その側の絞りとして届く(配線)', () => {
    const region = document.createElement('div');
    document.body.append(region);
    const r = new DualFilerRenderer(region, undefined, new DualPrefsStore(fakeStorage()));
    r.render(booted());
    const d = new Dispatcher();
    bindActions(region, d, {});
    const box = region.querySelector<HTMLInputElement>(
      '[data-pkc-side="right"] [data-pkc-field="dual-filter"]',
    )!;
    box.value = 'えっ';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(paneOf(d.getState().dual, 'right').filter, '打っても届いていない').toBe('えっ');
    expect(paneOf(d.getState().dual, 'left').filter, '反対側まで絞られた').toBe('');
  });
});

describe('戻る / 進む(#273 残件)', () => {
  it('🔴 入ってから戻ると、元の場所へ帰る', () => {
    let s = booted();
    s = reduce(s, { type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' }).state;
    expect(paneScope(paneOf(s.dual, 'left'))).toBe('f1');
    s = reduce(s, { type: 'DUAL_BACK', side: 'left' }).state;
    expect(paneScope(paneOf(s.dual, 'left')), '戻れていない').toBeNull();
    s = reduce(s, { type: 'DUAL_FORWARD', side: 'left' }).state;
    expect(paneScope(paneOf(s.dual, 'left')), '進めていない').toBe('f1');
  });

  /**
   * 🔴 **押せないときは焦点も動かさない** ── 端で押したときに焦点だけ動くと、
   * 「戻ったのに場所が同じ」に見える。
   */
  it('🔴 端で押しても、焦点まで動かない', () => {
    const s = booted();
    const after = reduce(s, { type: 'DUAL_BACK', side: 'right' }).state;
    expect(after, '何も起きないはずが state が動いた').toBe(s);
    expect(after.dual.focus, '端で押しただけで焦点が動いた').toBe('left');
  });

  it('🔴 押せないボタンは disabled で出る(無言の dead click を作らない)', () => {
    const region = document.createElement('div');
    document.body.append(region);
    const r = new DualFilerRenderer(region, undefined, new DualPrefsStore(fakeStorage()));
    let s = booted();
    r.render(s);
    const btn = (side: string, action: string): HTMLButtonElement =>
      region.querySelector<HTMLButtonElement>(
        `[data-pkc-region="dual-head"][data-pkc-side="${side}"] [data-pkc-action="${action}"]`,
      )!;
    expect(btn('left', 'dual-back').disabled, 'まだ行っていないのに押せる').toBe(true);
    expect(btn('left', 'dual-forward').disabled).toBe(true);
    s = reduce(s, { type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' }).state;
    r.render(s);
    expect(btn('left', 'dual-back').disabled, '入ったのに戻れない').toBe(false);
    expect(btn('right', 'dual-back').disabled, '反対側まで押せるようになった').toBe(true);
  });
});

describe('留めた場所(#273 残件)', () => {
  const mount = (): {
    region: HTMLElement;
    r: DualFilerRenderer;
    prefs: DualPrefsStore;
  } => {
    const region = document.createElement('div');
    document.body.append(region);
    const prefs = new DualPrefsStore(fakeStorage());
    return { region, r: new DualFilerRenderer(region, undefined, prefs), prefs };
  };

  it('1 件も無ければ帯ごと畳む(空の枠を出さない)', () => {
    const { region, r } = mount();
    r.render(booted());
    const bar = region.querySelector<HTMLElement>('[data-pkc-region="dual-bookmarks"]')!;
    expect(bar.hidden, '空の帯が出ている').toBe(true);
  });

  it('🔴 留めると帯に題名で並び、押すとその場所へ移る', () => {
    const { region, r, prefs } = mount();
    prefs.toggleBookmark('f1');
    r.render(booted());
    const bar = region.querySelector<HTMLElement>('[data-pkc-region="dual-bookmarks"]')!;
    expect(bar.hidden).toBe(false);
    expect(bar.textContent, '題名で並んでいない').toContain('はこ1');
    const d = new Dispatcher();
    // ⚠ binder は自分の state を見る ── 実在しない lid へは入らないので、先に起こす
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    bindActions(region, d, {});
    region
      .querySelector<HTMLElement>(
        '[data-pkc-side="right"] [data-pkc-action="dual-bookmark-open"][data-pkc-entry="f1"]',
      )!
      .click();
    expect(paneScope(paneOf(d.getState().dual, 'right')), '押しても移らない').toBe('f1');
  });

  /**
   * 🔴 **置けるなら外せる**(user 指示 2026-08-23)。
   * ⚠ **消えた場所からも外せる** ── 出さないと帯から消えて見えるのに留めは残り、
   *   永久に外しようがなくなる(#301 の一覧と同じ規律)。
   */
  it('🔴 消えた場所も帯に出て、そこから外せる', () => {
    const { region, r, prefs } = mount();
    prefs.toggleBookmark('もう無い');
    r.render(booted());
    const go = region.querySelector<HTMLButtonElement>(
      '[data-pkc-side="left"] [data-pkc-action="dual-bookmark-open"][data-pkc-entry="もう無い"]',
    )!;
    expect(go.disabled, '消えた場所へ入れてしまう').toBe(true);
    const off = region.querySelector<HTMLElement>(
      '[data-pkc-action="dual-bookmark-remove"][data-pkc-entry="もう無い"]',
    );
    expect(off, '外す口が無い(永久に残る)').not.toBeNull();
    const toggleDualBookmark = vi.fn();
    bindActions(region, new Dispatcher(), { toggleDualBookmark });
    off!.click();
    expect(toggleDualBookmark).toHaveBeenCalledWith('もう無い');
  });

  it('🔴 「留める」を押すと、いま開いている場所が渡る(配線)', () => {
    const { region, r } = mount();
    const s = reduce(booted(), { type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f2' }).state;
    r.render(s);
    const d = new Dispatcher();
    // ⚠ binder は自分の state を持つので、同じ場所まで動かしてから押す
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f2' });
    const toggleDualBookmark = vi.fn();
    bindActions(region, d, { toggleDualBookmark });
    region
      .querySelector<HTMLElement>('[data-pkc-side="left"] [data-pkc-action="dual-bookmark"]')!
      .click();
    expect(toggleDualBookmark, 'いまの場所が渡っていない').toHaveBeenCalledWith('f2');
  });

  it('⚠ ルートでは留められない(1 押しで行ける所を帯に並べない)', () => {
    const { region, r } = mount();
    r.render(booted());
    const pin = region.querySelector<HTMLButtonElement>(
      '[data-pkc-side="left"] [data-pkc-action="dual-bookmark"]',
    )!;
    expect(pin.disabled, 'ルートを留められてしまう').toBe(true);
  });
});

describe('下見(#273 残件)', () => {
  /**
   * 🔴 **器は左右とも出す** ── 焦点のある側にだけ出すと、反対のペインを押した
   * 瞬間に**両側の表の高さが入れ替わる**(掴む手の下で行が動く ── #270 と同じ害)。
   * ⚠ 中身が入るのは元になっている側だけ(読みに行くのは 1 本である)。
   */
  it('🔴 下見の器は左右とも出る(押すたびに表の高さが入れ替わらない)', () => {
    const region = document.createElement('div');
    document.body.append(region);
    const r = new DualFilerRenderer(region, undefined, new DualPrefsStore(fakeStorage()));
    const s = reduce(booted(), { type: 'DUAL_SET_PREVIEW', on: true }).state;
    r.render(s);
    const box = (side: string): HTMLElement =>
      region.querySelector<HTMLElement>(
        `[data-pkc-side="${side}"][data-pkc-region="dual-pane"] [data-pkc-region="dual-preview"]`,
      )!;
    expect(box('left').hidden, '元の側に出ていない').toBe(false);
    expect(box('right').hidden, '反対側に器が無い(押すと高さが入れ替わる)').toBe(false);
    // ⚠ 中身は元の側だけ ── 反対側は「押せば出る」と言うに留める
    expect(box('right').textContent, '反対側まで読みに行っている').toContain('押すと');
  });

  it('🔴 点けると、カーソルの行の本文を読みに行く', () => {
    let s = booted();
    s = reduce(s, { type: 'DUAL_SET_CURSOR', side: 'left', lid: 'a' }).state;
    const out = reduce(s, { type: 'DUAL_SET_PREVIEW', on: true });
    expect(out.events, '読みに行っていない').toEqual([{ type: 'REQUEST_DUAL_PREVIEW', lid: 'a' }]);
  });

  /**
   * ⚠ **フォルダは読みに行かない** ── 本文が無いので、行っても
   * 「読めなかった」と「空だった」が見分けられなくなる。
   */
  it('⚠ フォルダを指しているときは読みに行かない', () => {
    let s = reduce(booted(), { type: 'DUAL_SET_PREVIEW', on: true }).state;
    const out = reduce(s, { type: 'DUAL_SET_CURSOR', side: 'left', lid: 'f1' });
    expect(out.events, 'フォルダの本文を読みに行った').toEqual([]);
    s = out.state;
    expect(s.dual.preview, 'フォルダなのに下見が残っている').toBeNull();
  });

  it('🔴 届いた本文が画面に出る', () => {
    const region = document.createElement('div');
    document.body.append(region);
    const r = new DualFilerRenderer(region, undefined, new DualPrefsStore(fakeStorage()));
    let s = reduce(booted(), { type: 'DUAL_SET_PREVIEW', on: true }).state;
    s = reduce(s, { type: 'DUAL_SET_CURSOR', side: 'left', lid: 'a' }).state;
    r.render(s);
    const box = (): HTMLElement =>
      region.querySelector<HTMLElement>(
        '[data-pkc-side="left"][data-pkc-region="dual-pane"] [data-pkc-region="dual-preview"]',
      )!;
    expect(box().hidden, '点けたのに出ていない').toBe(false);
    expect(box().textContent, '読んでいる間が空欄(空のノートと区別が付かない)').toContain('読んで');
    s = reduce(s, { type: 'DUAL_PREVIEW_LOADED', lid: 'a', body: 'これは あ の中身' }).state;
    r.render(s);
    expect(box().textContent, '届いた本文が出ていない').toBe('これは あ の中身');
    // しまうと器ごと畳む
    s = reduce(s, { type: 'DUAL_SET_PREVIEW', on: false }).state;
    r.render(s);
    expect(box().hidden, 'しまったのに出たまま').toBe(true);
  });

  /**
   * 🔴 **追い越しは捨てる** ── 読みは非同期なので、送った先の行を通り過ぎた後に
   * 届くことが普通に起きる。⚠ 古い本文を映すほうがずっと悪い。
   */
  it('🔴 いま指していない行の本文が届いても、映さない', () => {
    let s = reduce(booted(), { type: 'DUAL_SET_PREVIEW', on: true }).state;
    s = reduce(s, { type: 'DUAL_SET_CURSOR', side: 'left', lid: 'a' }).state;
    s = reduce(s, { type: 'DUAL_SET_CURSOR', side: 'left', lid: 'b' }).state;
    const after = reduce(s, { type: 'DUAL_PREVIEW_LOADED', lid: 'a', body: '古い本文' }).state;
    expect(after.dual.preview, '通り過ぎた行の本文を映している').toBeNull();
    // 対照群 ── いま指している行なら映る
    const ok = reduce(s, { type: 'DUAL_PREVIEW_LOADED', lid: 'b', body: '新しい' }).state;
    expect(ok.dual.preview?.body, 'いま指している行まで捨てている').toBe('新しい');
  });

  it('🔴 押すと state と端末の保存の両方が動く(配線)', () => {
    const region = document.createElement('div');
    document.body.append(region);
    const r = new DualFilerRenderer(region, undefined, new DualPrefsStore(fakeStorage()));
    r.render(booted());
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    const rememberDualPreview = vi.fn();
    bindActions(region, d, { rememberDualPreview });
    region
      .querySelector<HTMLElement>('[data-pkc-action="dual-preview-toggle"]')!
      .click();
    expect(d.getState().dual.previewOn, '効いていない(state)').toBe(true);
    expect(rememberDualPreview, '憶えていない(次に開くと消えている)').toHaveBeenCalledWith(true);
  });
});

describe('情報行の合計(#273 残件)', () => {
  let region: HTMLElement;
  beforeEach(() => {
    document.body.textContent = '';
    region = document.createElement('div');
    document.body.append(region);
  });

  it('🔴 選んだぶんと全体を対で出す', () => {
    const r = new DualFilerRenderer(region, undefined, new DualPrefsStore(fakeStorage()));
    let s = booted();
    s = reduce(s, { type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' }).state;
    r.render(s);
    const foot = region.querySelector<HTMLElement>(
      '[data-pkc-side="left"][data-pkc-region="dual-pane"] [data-pkc-field="dual-count"]',
    )!;
    // a=100 / b=20 ── フォルダは数えない
    expect(foot.textContent, '合計が出ていない').toBe('4 件中 1 件を選択 · 100 / 120(ここが元)');
  });

  it('⚠ フォルダしか無い場所では合計を出さない(0 と出すと空だと読まれる)', () => {
    const r = new DualFilerRenderer(region, undefined, new DualPrefsStore(fakeStorage()));
    const s = reduce(booted(), { type: 'SET_ENTRY_FILTER', query: 'はこ' }).state;
    r.render(s);
    const foot = region.querySelector<HTMLElement>(
      '[data-pkc-side="left"][data-pkc-region="dual-pane"] [data-pkc-field="dual-count"]',
    )!;
    expect(foot.textContent).toBe('2 件(ここが元)');
  });
});


/**
 * 🔴 **下見が本当に storage を読むところまで**(#273 残件)。
 *
 * ⚠ ここまでの test は reducer と描画で、**間の配線**(effect 層)は誰も通らない
 *   (CLAUDE.md §7「A と B が合意していることは、A の test にも B の test にも
 *   書けない」)── だから実物の effect を繋いで 1 往復させる。
 */
describe('下見の配線(effect 層まで)', () => {
  const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('🔴 点けると本文が読まれ、画面まで届く', async () => {
    const d = new Dispatcher();
    const disk: Record<string, string> = { a: 'あの中身' };
    const reads: string[] = [];
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async (lid) => {
        reads.push(lid);
        return disk[lid] ?? null;
      },
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async () => stubStamps(),
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    d.dispatch({ type: 'DUAL_SET_CURSOR', side: 'left', lid: 'a' });
    d.dispatch({ type: 'DUAL_SET_PREVIEW', on: true });
    await tick();
    expect(reads, '本文を読みに行っていない').toContain('a');
    expect(d.getState().dual.preview, '読んだのに届いていない').toEqual({
      lid: 'a',
      body: 'あの中身',
    });
  });

  /**
   * 🔴 **長い本文はここで切る** ── 切らずに state へ渡すと、行を合わせただけで
   * その全文が常駐する(不可侵指示「効くのは定常」)。
   */
  it('🔴 長い本文は、state に入る前に切られる', async () => {
    const d = new Dispatcher();
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => 'ん'.repeat(PREVIEW_CHARS + 500),
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async () => stubStamps(),
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    d.dispatch({ type: 'DUAL_SET_PREVIEW', on: true });
    d.dispatch({ type: 'DUAL_SET_CURSOR', side: 'left', lid: 'b' });
    await tick();
    const body = d.getState().dual.preview?.body ?? '';
    expect(body.length, '切らずに state へ入れている').toBe(PREVIEW_CHARS + 1);
  });

  it('⚠ 読めなかったら黙って終える(帯に赤い字を出さない)', async () => {
    const d = new Dispatcher();
    const errors: string[] = [];
    d.onState((s) => {
      if (s.error !== null && !errors.includes(s.error)) errors.push(s.error);
    });
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => null,
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async () => stubStamps(),
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    d.dispatch({ type: 'DUAL_SET_PREVIEW', on: true });
    d.dispatch({ type: 'DUAL_SET_CURSOR', side: 'left', lid: 'a' });
    await tick();
    expect(errors, '下見が読めないだけで帯が出ている').toEqual([]);
    expect(d.getState().dual.preview).toBeNull();
  });
});


/**
 * 🔴 **変異試験が突いた 2 件**(2026-08-25)── どちらも
 * 「**その経路を 1 度も通していなかった**」型である(CLAUDE.md §2)。
 */
describe('絞りと帯の、通っていなかった経路', () => {
  /**
   * 🔴 **帯は state の外(端末の保存)で増える** ── 面を開いたまま留めたのに
   * 帯が変わらないと、user は「留まっていない」と読む。
   * ⚠ **同じインスタンスで 2 回描く**のが肝 ── 新しい器を作ると初回ビルドの
   *   経路しか通らず、「組み直しの経路」を 1 度も実行しないまま緑になる
   *   (`settings-same-origin.test.ts` と同じ理由)。
   */
  it('🔴 面を開いたまま留めたら、次の render で帯に出る', () => {
    const region = document.createElement('div');
    document.body.append(region);
    const prefs = new DualPrefsStore(fakeStorage());
    const r = new DualFilerRenderer(region, undefined, prefs);
    const s = booted();
    r.render(s);
    const bar = (): HTMLElement =>
      region.querySelector<HTMLElement>('[data-pkc-region="dual-bookmarks"]')!;
    expect(bar().hidden, '前提が崩れた(最初から帯が出ている)').toBe(true);
    prefs.toggleBookmark('f1'); // ← 別の面(ペインの ☆)で留めた、に相当
    r.render(s); // ⚠ **state は 1 文字も動いていない**
    expect(bar().hidden, '古い姿のまま凍っている').toBe(false);
    expect(bar().textContent).toContain('はこ1');
  });

  /**
   * 🔴 **絞りは「見えている行」を決めるので、操作の相手も決める**(CLAUDE.md §7)。
   *
   * ⚠ 描く側だけ絞りを見て、鍵・ボタンの側が器の語のままだと、
   *   **目で見た範囲と選ばれる範囲が違う**という、いちばん気づけない食い違いになる。
   * 🔑 だから `Ctrl + A`(いま出ている行をぜんぶ選ぶ)で見る ── 絞ってあれば
   *   **絞ったぶんだけ**が選ばれるはずである。
   */
  it('🔴 絞ってから「ぜんぶ選ぶ」と、見えている行だけが選ばれる', () => {
    const region = document.createElement('div');
    document.body.append(region);
    const r = new DualFilerRenderer(region, undefined, new DualPrefsStore(fakeStorage()));
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    d.onState((st) => r.render(st));
    r.render(d.getState());
    bindActions(region, d, {});

    d.dispatch({ type: 'DUAL_SET_FILTER', side: 'left', filter: 'いろ' });
    const row = region.querySelector<HTMLElement>(
      '[data-pkc-region="dual-pane"][data-pkc-side="left"] [data-pkc-entry="b"]',
    )!;
    // 前提 ── 絞った結果、この 1 行だけが出ている
    expect(
      region.querySelectorAll(
        '[data-pkc-region="dual-pane"][data-pkc-side="left"] [data-pkc-region="dual-table"] [data-pkc-entry]',
      ).length,
      '前提が崩れた(絞れていない)',
    ).toBe(1);
    row.focus();
    row.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(
      paneOf(d.getState().dual, 'left').selection,
      '画面に出ていない行まで選ばれた(鍵の側が絞りを見ていない)',
    ).toEqual(['b']);
  });

  /**
   * 🔴 **カーソルの行き先も、見えている行から採る**(変異試験 D26 が突いた)。
   *
   * ⚠ 上の「ぜんぶ選ぶ」だけでは**足りなかった** ── 鍵の側が絞りを見ていなくても、
   *   範囲を解く reducer の側が見ているので**答えが揃ってしまう**
   *   (CLAUDE.md §1「救い手が変わっただけ」)。
   * 🔑 カーソルは reducer が**実在するかしか見ない**ので、鍵の側が絞りを
   *   落とすと**画面に出ていない行に枠が付く**(user から見ると枠が消える)。
   */
  it('🔴 絞ってから ↓ を押すと、見えている行にカーソルが乗る', () => {
    const region = document.createElement('div');
    document.body.append(region);
    const r = new DualFilerRenderer(region, undefined, new DualPrefsStore(fakeStorage()));
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    d.onState((st) => r.render(st));
    r.render(d.getState());
    bindActions(region, d, {});

    d.dispatch({ type: 'DUAL_SET_FILTER', side: 'left', filter: 'いろ' });
    // 前提 ── カーソルはまだどこにも無い(絞ると外れる)
    expect(paneOf(d.getState().dual, 'left').cursor, '前提が崩れた').toBeNull();
    const pane = region.querySelector<HTMLElement>(
      '[data-pkc-region="dual-pane"][data-pkc-side="left"]',
    )!;
    pane.focus();
    pane.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    expect(
      paneOf(d.getState().dual, 'left').cursor,
      '画面に出ていない行へカーソルが飛んだ(鍵の側が絞りを見ていない)',
    ).toBe('b');
  });
});
