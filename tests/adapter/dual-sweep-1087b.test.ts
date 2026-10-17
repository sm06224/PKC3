/** @vitest-environment happy-dom */
/**
 * 🔴 **2 ペイン・スマートフォルダの直し**(#1087 A1 / A3 / A4 / A5 / A6)。
 *
 * ⚠ 台は実物(shell + DualFilerRenderer + binder)── ボタンが運ぶ側の属性と binder の受けは、
 *   片方の test では見えない(`dual-fixes-1087.test.ts` と同じ作法)。
 * 🔑 どの it も「直す前の実装に戻すと落ちる」形で書いてある。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DualFilerRenderer } from '../../src/adapter/ui/render/dual-filer';
import { appDualPrefs } from '../../src/adapter/ui/render/dual-prefs';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { paneOf } from '../../src/features/relation/dual-pane';
import { noteBookmarkKey } from '../../src/features/relation/dual-bookmarks';

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
const rel = (id: string, fromLid: string, toLid: string): Relation => ({
  id,
  fromLid,
  toLid,
  kind: 'structural',
  createdAt: null,
  updatedAt: null,
});

/** ルート: f1 f2 a。f2 の中に z。 */
const METAS = [meta('f1', 1, 'folder'), meta('f2', 2, 'folder'), meta('a', 3), meta('z', 4)];
const RELS = [rel('r1', 'f2', 'z')];

beforeEach(() => {
  document.body.textContent = '';
  resetAppDialogForTest();
  appDualPrefs.setBookmarks([]);
});

function setup() {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const dual = new DualFilerRenderer(regions.center);
  d.onState((s) => dual.render(s));
  bindActions(root, d, {});
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
  d.dispatch({ type: 'SET_VIEW_MODE', mode: 'dual' });
  const host = (side: 'left' | 'right'): HTMLElement => {
    const el = regions.center.querySelector<HTMLElement>(
      `[data-pkc-region="dual-pane"][data-pkc-side="${side}"]`,
    );
    expect(el, `前提が崩れている: ${side} のペインが無い`).not.toBeNull();
    return el!;
  };
  /** 操作の帯は 2 つのペインで共有(押した側の属性は無く、元は焦点の側)。 */
  const button = (action: string): HTMLElement => {
    const b = regions.center.querySelector<HTMLElement>(`[data-pkc-field="${action}"]`);
    expect(b, `前提が崩れている: ${action} のボタンが無い`).not.toBeNull();
    return b!;
  };
  const row = (side: 'left' | 'right', lid: string): HTMLElement | null =>
    host(side).querySelector<HTMLElement>(`[data-pkc-region="dual-table"] [data-pkc-entry="${lid}"]`);
  return { d, host, button, row };
}

describe('A1: 移す(F6)も押した側のペインを元にする', () => {
  /**
   * 右のペインの中のボタン(☆)に Tab で焦点を置いて押した形。⚠ 焦点の側(state)は左のまま。
   * 鍵の出た側(右)が元になるのは F5(コピー)で既に在り、F6 だけ焦点の側を見ていた。
   */
  const fromRightButton = (t: ReturnType<typeof setup>, key: string): void => {
    const star = t.host('right').querySelector<HTMLElement>('[data-pkc-action="dual-bookmark"]');
    expect(star, '前提が崩れている(右のペインにボタンが無い)').not.toBeNull();
    star!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  };
  const rig = () => {
    const t = setup();
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f2' });
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'right', lid: 'z', mode: 'set' });
    t.d.dispatch({ type: 'DUAL_FOCUS', side: 'left' });
    expect(t.d.getState().dual.focus, '前提が崩れている(焦点が左でない)').toBe('left');
    return t;
  };

  it('🔴 焦点が左でも、右のペインから F6 を押したら右で選んだ z が動く', () => {
    const t = rig();
    fromRightButton(t, 'F6');
    const st = t.d.getState();
    expect(
      st.relations.some((r) => r.fromLid === 'f2' && r.toLid === 'z'),
      '右で選んだ z が f2 から出ていない(焦点の側を元にしている)',
    ).toBe(false);
    expect(st.error ?? '', '「移すものを選んでください」で断られた(元の側が違う)').not.toContain('選んでください');
  });

  it('対照群: F5(コピー)は同じ押し方で右を元にする', () => {
    const t = rig();
    fromRightButton(t, 'F5');
    expect(t.d.getState().error ?? '', 'コピーが元の側違いで断られた').not.toContain('選んでください');
  });
});

describe('A3: 作るとき、そのペインの「名前で絞る」を解く', () => {
  it('🔴 絞りに語が入っていても、作った物がそのペインに出る', () => {
    const t = setup();
    t.d.dispatch({ type: 'DUAL_SET_FILTER', side: 'left', filter: 'zzz-no-match' });
    const before = new Set(t.d.getState().entryMetas.keys());
    t.d.dispatch({ type: 'DUAL_FOCUS', side: 'left' });
    t.button('dual-mknote').click();
    const made = [...t.d.getState().entryMetas.keys()].filter((l) => !before.has(l));
    expect(made, '前提が崩れている(ノートが作られていない)').toHaveLength(1);
    expect(paneOf(t.d.getState().dual, 'left').filter, '絞りが解けていない').toBe('');
    expect(t.row('left', made[0]!), '作ったノートがペインに出ていない').not.toBeNull();
  });

  it('🔴 フォルダ(F7 のボタン)も同じ', () => {
    const t = setup();
    t.d.dispatch({ type: 'DUAL_SET_FILTER', side: 'right', filter: 'zzz-no-match' });
    const before = new Set(t.d.getState().entryMetas.keys());
    t.d.dispatch({ type: 'DUAL_FOCUS', side: 'right' });
    t.button('dual-mkdir').click();
    const made = [...t.d.getState().entryMetas.keys()].filter((l) => !before.has(l));
    expect(made).toHaveLength(1);
    expect(paneOf(t.d.getState().dual, 'right').filter).toBe('');
    // 反対のペインの絞りには触らない
    expect(paneOf(t.d.getState().dual, 'left').filter).toBe('');
  });

  it('対照群: 反対のペインの絞りは解かない', () => {
    const t = setup();
    t.d.dispatch({ type: 'DUAL_SET_FILTER', side: 'right', filter: 'keep' });
    t.d.dispatch({ type: 'DUAL_FOCUS', side: 'left' });
    t.button('dual-mknote').click();
    expect(paneOf(t.d.getState().dual, 'right').filter, '押していない側の絞りまで解いた').toBe('keep');
  });
});

describe('A4: ノートのブックマークは、アプリ共通の探す語と種類の札も解く', () => {
  it('🔴 語と札が残っていても、開いたノートの行が表に出る', () => {
    const t = setup();
    appDualPrefs.setBookmarks([noteBookmarkKey('c1', 'a')]);
    t.d.dispatch({ type: 'DUAL_SET_FILTER', side: 'left', filter: 'zzz-no-match' }); // 描き直しのきっかけ
    t.d.dispatch({ type: 'DUAL_SET_FILTER', side: 'left', filter: '' });
    t.d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'zzz-no-match' });
    t.d.dispatch({ type: 'TOGGLE_KIND_FILTER', archetype: 'folder' });
    expect(t.d.getState().filterQuery, '前提が崩れている').toBe('zzz-no-match');
    expect(t.d.getState().kindFilter.size, '前提が崩れている').toBe(1);
    t.d.dispatch({ type: 'DUAL_SET_FILTER', side: 'left', filter: 'x' }); // 帯を描かせる
    const go = t.host('left').querySelector<HTMLElement>(
      '[data-pkc-action="dual-bookmark-open"][data-pkc-entry="a"]',
    );
    expect(go, '前提が崩れている(帯にノートの口が無い)').not.toBeNull();
    go!.click();
    const st = t.d.getState();
    expect(st.filterQuery, '共通の探す語が残っている').toBe('');
    expect(st.kindFilter.size, '種類の札が残っている').toBe(0);
    expect(paneOf(st.dual, 'left').selection).toEqual(['a']);
    expect(t.row('left', 'a'), '行が 0 行で見えない').not.toBeNull();
  });

  it('対照群: 場所(フォルダ)のブックマークは、共通の語に触らない(今までどおり)', () => {
    const t = setup();
    appDualPrefs.setBookmarks(['f1']);
    t.d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'keep' });
    t.d.dispatch({ type: 'DUAL_SET_FILTER', side: 'left', filter: '' });
    t.host('left')
      .querySelector<HTMLElement>('[data-pkc-action="dual-bookmark-open"][data-pkc-entry="f1"]')!
      .click();
    expect(t.d.getState().filterQuery).toBe('keep');
  });
});

describe('A5: 開いているスマートフォルダは、取り込み・別タブの再読込で集め直す', () => {
  const SM = [meta('s1', 1, 'smart'), meta('s2', 2, 'smart'), meta('a', 3)];
  const boot = (s: AppState, cid: string, metas: EntryMeta[]) =>
    reduce(s, { type: 'SYS_BOOTED', cid, metas, relations: [] });
  const scanned = (s: AppState, lid: string): AppState =>
    reduce(s, { type: 'SMART_SCANNED', lid, lids: ['a'], total: 1, spec: { tags: [], words: [], kinds: [] } } as never)
      .state;
  const scans = (events: readonly { type: string; lid?: string }[]): string[] =>
    events.filter((e) => e.type === 'REQUEST_SMART_SCAN').map((e) => e.lid as string);

  it('🔴 集めたことのあるスマートフォルダだけ、同じコレクションの再読込で撃ち直す', () => {
    let s = boot(initialState, 'c1', SM).state;
    s = scanned(s, 's1');
    expect(s.smartHits.has('s1'), '前提が崩れている').toBe(true);
    const r = boot(s, 'c1', SM);
    expect(scans(r.events), 's1 を撃ち直していない / 一度も集めていない s2 まで撃った').toEqual(['s1']);
    expect(r.state.smartHits.get('s1')?.lids, '前の当たりは返事が来るまで映す').toEqual(['a']);
  });

  it('対照群: 別のコレクションへ替わったときは撃たない / 消えたノートには撃たない', () => {
    let s = boot(initialState, 'c1', SM).state;
    s = scanned(s, 's1');
    expect(scans(boot(s, 'c2', SM).events), '別のコレクションの再読込で撃った').toEqual([]);
    expect(
      scans(boot(s, 'c1', [meta('a', 3)]).events),
      '消えたスマートフォルダに撃った',
    ).toEqual([]);
    expect(
      scans(boot(s, 'c1', [meta('s1', 1, 'smart'), meta('a', 3)]).events),
      '空振り防止: 残っていれば撃つ',
    ).toEqual(['s1']);
  });
});

describe('A6: 押しっぱなし(キーリピート)で、作る・消す・写す・移す・名前を変える鍵は撃たない', () => {
  const press = (el: HTMLElement, key: string, repeat: boolean, shiftKey = false): void => {
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key, repeat, shiftKey, bubbles: true, cancelable: true }));
  };

  it('🔴 F7(フォルダを作る): 1 回目は作り、リピートでは作らない', () => {
    const t = setup();
    const row = t.row('left', 'a')!;
    const n0 = t.d.getState().entryMetas.size;
    press(row, 'F7', false);
    expect(t.d.getState().entryMetas.size, '前提が崩れている(1 回目で作れていない)').toBe(n0 + 1);
    press(t.row('left', 'a')!, 'F7', true);
    press(t.row('left', 'a')!, 'F7', true);
    expect(t.d.getState().entryMetas.size, 'リピートのたびに作られた').toBe(n0 + 1);
  });

  it('🔴 Shift+F4(ノートを作る)も同じ', () => {
    const t = setup();
    const n0 = t.d.getState().entryMetas.size;
    press(t.row('left', 'a')!, 'F4', true, true);
    expect(t.d.getState().entryMetas.size, 'リピートで作られた').toBe(n0);
    press(t.row('left', 'a')!, 'F4', false, true);
    expect(t.d.getState().entryMetas.size, '前提が崩れている(リピートでない 1 回で作れていない)').toBe(n0 + 1);
  });

  it('🔴 F2(名前を変える): リピートでは入力欄を開かない', () => {
    const t = setup();
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    press(t.row('left', 'a')!, 'F2', true);
    expect(t.d.getState().dual.renaming, 'リピートで名前の欄が開いた').toBeNull();
    press(t.row('left', 'a')!, 'F2', false);
    expect(t.d.getState().dual.renaming, '前提が崩れている(リピートでない 1 回で開けない)').not.toBeNull();
  });

  it('🔴 F6(移す)も、リピートでは動かさない', () => {
    const t = setup();
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f1' });
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    const parentOfA = (): string | undefined =>
      t.d.getState().relations.find((r) => r.toLid === 'a' && r.kind === 'structural')?.fromLid;
    expect(parentOfA(), '前提が崩れている(a が最初からフォルダの中)').toBeUndefined();
    press(t.row('left', 'a')!, 'F6', true);
    expect(parentOfA(), 'リピートで移った').toBeUndefined();
    press(t.row('left', 'a')!, 'F6', false);
    expect(parentOfA(), '前提が崩れている(リピートでない F6 で移らない)').toBe('f1');
  });

  it('対照群: 移動の鍵(↓)はリピートでも通る', () => {
    const t = setup();
    t.d.dispatch({ type: 'DUAL_SET_CURSOR', side: 'left', lid: 'f1' });
    const c0 = paneOf(t.d.getState().dual, 'left').cursor;
    press(t.row('left', 'f1')!, 'ArrowDown', true);
    expect(paneOf(t.d.getState().dual, 'left').cursor, '↓ の押しっぱなしが止まった').not.toBe(c0);
  });
});
