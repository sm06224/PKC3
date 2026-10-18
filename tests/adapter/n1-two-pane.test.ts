/** @vitest-environment happy-dom */
/**
 * 2 ペインとスマートフォルダ・ブックマークの直し(台帳 #1852 束 N1。#1163 への依頼 97 / 322〜328 / 154 / 155 / 51 / 115-4 / 115-5。
 * Gemini の回答はどれも推薦どおり)。
 *
 * 守る主張(画面の言葉で):
 *  - 移したノートは、移し先の末尾に並ぶ。「元に戻す」は元の位置へ戻す(154 ②)
 *  - 元のフォルダが無いときは「いちばん上の階層に戻しました」と言う(155 ②)
 *  - コピーの後にも「元に戻す」が出て、押すと作った複製がゴミ箱へ入る(97-5 A)
 *  - 作った行にカーソルと印が付く(326 A)
 *  - 種類の札を押したままでも、2 ペインにフォルダが出る(323 A)
 *  - スマートフォルダの状態を、左のペインと同じ字で言う(322 A)
 *  - パンくずに行を落として移せる(327 A)
 *  - スマートフォルダへ落としてタグを付けたあと、集まらなかった分を言う(325 A)
 *  - 書けなかった移動は画面を元に戻す(115-4 A)
 *  - フォルダごとコピーしたとき、中のノート同士のリンクはコピー先を指す(115-5 A)
 *  - 「移す・コピーする元」の言い方(97-6 A)
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions, watchSmartDrop } from '../../src/adapter/ui/actions/binder';
import { DualFilerRenderer } from '../../src/adapter/ui/render/dual-filer';
import {
  SMART_COLLECTING,
  SMART_FAILED,
  SMART_NO_CONDITION,
  SMART_NO_MATCH,
  smartEmptyText,
  smartTruncatedText,
} from '../../src/adapter/ui/render/smart-status';
import { clearDualMoveOffer, currentDualMoveOffer } from '../../src/adapter/ui/render/dual-move-undo';
import { dualListViewOptions } from '../../src/adapter/state/list-view-options';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { getStructuralChildren } from '../../src/features/relation/tree';
import { EMPTY_SMART } from '../../src/features/smart/smart-spec';
import { paneOf } from '../../src/features/relation/dual-pane';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';

function meta(lid: string, order: number, title: string, archetype = 'text'): EntryMeta {
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
const rel = (id: string, fromLid: string, toLid: string): Relation => ({
  id,
  fromLid,
  toLid,
  kind: 'structural',
  createdAt: null,
  updatedAt: null,
});

/** ルート: はこ(f1)/ たな(f2)/ あ(a)/ い(b)/ 絞り込み(s1 = スマートフォルダ)。f1 の中に えっくす(x)、f2 の中に わい(y)。 */
const METAS = [
  meta('f1', 1, 'はこ', 'folder'),
  meta('f2', 2, 'たな', 'folder'),
  meta('a', 3, 'あ'),
  meta('b', 4, 'い'),
  meta('x', 5, 'えっくす'),
  meta('y', 6, 'わい'),
  meta('s1', 7, '絞り込み', 'smart'),
];
const RELS = [rel('r1', 'f1', 'x'), rel('r2', 'f2', 'y')];

function mount(): {
  root: HTMLElement;
  d: Dispatcher;
  region: HTMLElement;
  click: (el: Element) => void;
  events: Array<{ type: string } & Record<string, unknown>>;
  parentsOf: (lid: string) => string[];
  rows: (side: 'left' | 'right') => string[];
} {
  document.body.innerHTML = '';
  clearDualMoveOffer();
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const events: Array<{ type: string } & Record<string, unknown>> = [];
  d.onEvent((e) => events.push(e as never));
  buildShell(root);
  bindActions(root, d, {
    readBodies: async (lids) =>
      new Map(
        lids.map((l) => [
          l,
          l === 'x' ? '[ゆ](entry:y) と [外](entry:b)' : l === 'y' ? '[え](entry:x)' : `# 本文 ${l}`,
        ]),
      ),
    showStatus: () => undefined,
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
  const region = document.createElement('div');
  root.append(region);
  const r = new DualFilerRenderer(region);
  d.onState((st) => r.render(st));
  r.render(d.getState());
  return {
    root,
    d,
    region,
    click: (el) => void el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
    events,
    parentsOf: (lid) =>
      d
        .getState()
        .relations.filter((x) => x.toLid === lid && x.kind === 'structural')
        .map((x) => x.fromLid),
    rows: (side) =>
      [
        ...region.querySelectorAll(
          `[data-pkc-region="dual-pane"][data-pkc-side="${side}"] tbody [data-pkc-entry]`,
        ),
      ].map((e) => e.getAttribute('data-pkc-entry') ?? ''),
  };
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
const undoButton = (root: HTMLElement): HTMLElement => {
  const b = document.createElement('button');
  b.setAttribute('data-pkc-action', 'undo-dual-move');
  root.append(b);
  return b;
};

describe('154 ②: 移したノートは、移し先の末尾に並ぶ / 「元に戻す」は元の位置へ', () => {
  it('🔴 f1 へ移した あ(order 3)は、えっくす の後ろ(全体の末尾)に並び、い を続けて移すとその後ろ', () => {
    const t = mount();
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f1' });
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    t.click(t.region.querySelector('[data-pkc-field="dual-move"]')!);
    const st = t.d.getState();
    const maxOther = Math.max(...[...st.entryMetas.values()].filter((m) => m.lid !== 'a').map((m) => m.entryOrder));
    expect(st.entryMetas.get('a')!.entryOrder, '移したのに途中の位置に残っている').toBeGreaterThan(maxOther);
    expect(getStructuralChildren('f1', st.entryMetas, st.relations).map((m) => m.lid)).toEqual(['x', 'a']);
    expect(st.order[st.order.length - 1], '全体の並びの末尾にも置かれている').toBe('a');
    // 続けて い も移すと、その後ろ
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'b', mode: 'set' });
    t.click(t.region.querySelector('[data-pkc-field="dual-move"]')!);
    const st2 = t.d.getState();
    expect(getStructuralChildren('f1', st2.entryMetas, st2.relations).map((m) => m.lid)).toEqual(['x', 'a', 'b']);
  });

  it('🔴 disk へも並びの値が書かれる(REQUEST_REORDER)── 画面だけ末尾にして開き直すと戻る、を作らない', () => {
    const t = mount();
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f1' });
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    t.click(t.region.querySelector('[data-pkc-field="dual-move"]')!);
    const reorders = t.events.filter((e) => e.type === 'REQUEST_REORDER');
    expect(reorders.length, '並びの値が disk へ書かれていない').toBe(1);
    expect(JSON.stringify(reorders[0])).toContain('"lid":"a"');
  });

  it('🔴 「元に戻す」は、元のフォルダへ戻すだけでなく、移す前の並びの位置へも戻す', () => {
    const t = mount();
    const before = t.d.getState().entryMetas.get('a')!.entryOrder;
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f1' });
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    t.click(t.region.querySelector('[data-pkc-field="dual-move"]')!);
    expect(t.d.getState().entryMetas.get('a')!.entryOrder, '前提: 末尾へ動いていない').not.toBe(before);
    t.click(undoButton(t.root));
    expect(t.parentsOf('a'), '元の場所に戻っていない').toEqual([]);
    expect(t.d.getState().entryMetas.get('a')!.entryOrder, '並びの位置が戻っていない').toBe(before);
    expect(t.rows('left').indexOf('a'), 'ルートで い より前に戻っていない').toBeLessThan(t.rows('left').indexOf('b'));
  });

  it('⚠ 対照群 ── 同じ場所へ移し直しても(何も動かない回)、並びの値は書かない', () => {
    const t = mount();
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    t.click(t.region.querySelector('[data-pkc-field="dual-move"]')!); // 右もルート → もう居る
    expect(t.events.filter((e) => e.type === 'REQUEST_REORDER'), '動いていないのに並びを書いた').toEqual([]);
  });

  it('SET_ENTRY_ORDER の端: 末尾のノートを末尾へは何もしない / 数を渡すとその値へ戻る', () => {
    const base = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS }).state;
    const last = base.order[base.order.length - 1]!;
    const same = reduce(base, { type: 'SET_ENTRY_ORDER', lid: last, entryOrder: 'end' });
    expect(same.events, '末尾のノートを末尾へ置こうとして書いた').toEqual([]);
    const moved = reduce(base, { type: 'SET_ENTRY_ORDER', lid: 'f1', entryOrder: 99 });
    expect(moved.state.entryMetas.get('f1')!.entryOrder).toBe(99);
    expect(moved.state.order[moved.state.order.length - 1], '並びの配列が値に追随していない').toBe('f1');
    const bogus = reduce(base, { type: 'SET_ENTRY_ORDER', lid: 'f1', entryOrder: Number.NaN });
    expect(bogus.events).toEqual([]);
  });
});

describe('155 ②: 元のフォルダが無くなっていたときの「元に戻す」', () => {
  it('🔴 「元のフォルダが無いので、いちばん上の階層に戻しました」と言う(元の場所とは言わない)', () => {
    const t = mount();
    // たな(f2)の中の わい(y)を はこ(f1)へ移す
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f2' });
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f1' });
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'y', mode: 'set' });
    t.click(t.region.querySelector('[data-pkc-field="dual-move"]')!);
    expect(t.parentsOf('y'), '前提: 移せていない').toEqual(['f1']);
    // 元のフォルダ(たな)を消す
    t.d.dispatch({ type: 'DELETE_ENTRIES', lids: ['f2'] });
    expect(t.d.getState().entryMetas.has('f2'), '前提: 消せていない').toBe(false);
    t.click(undoButton(t.root));
    expect(t.parentsOf('y'), 'いちばん上へ戻っていない').toEqual([]);
    const said = t.d.getState().notice ?? '';
    expect(said).toBe('元のフォルダが無いので、1 件をいちばん上の階層に戻しました');
    expect(said, '実際は元の場所ではないのに、そう言った').not.toContain('元の場所');
  });

  it('対照群: 元のフォルダが残っていれば、従来どおり「元の場所に戻しました」', () => {
    const t = mount();
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f2' });
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f1' });
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'y', mode: 'set' });
    t.click(t.region.querySelector('[data-pkc-field="dual-move"]')!);
    t.click(undoButton(t.root));
    expect(t.parentsOf('y')).toEqual(['f2']);
    expect(t.d.getState().notice).toBe('1 件を元の場所に戻しました');
  });

  it('一部だけ元のフォルダが無いときは、件数の内訳を言う', () => {
    const t = mount();
    // たな(f2)の中に わい(y)と、もう 1 件 わい2(y2)を置いて、2 件とも はこ へ移す
    t.d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [...METAS, meta('y2', 8, 'わい2')], relations: [...RELS, rel('r3', 'f2', 'y2')] });
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f2' });
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f1' });
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'y', mode: 'set' });
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'y2', mode: 'toggle' });
    t.click(t.region.querySelector('[data-pkc-field="dual-move"]')!);
    // y の元のフォルダ(f2)だけでなく、y2 も同じ f2 ── 全部が無くなる形(下の全部ルートの文)で確かめる
    t.d.dispatch({ type: 'DELETE_ENTRIES', lids: ['f2'] });
    t.click(undoButton(t.root));
    expect(t.d.getState().notice).toBe('元のフォルダが無いので、2 件をいちばん上の階層に戻しました');
  });
});

describe('97-5 A: コピーの後にも「元に戻す」が出て、押すと作った複製がゴミ箱へ入る', () => {
  it('🔴 コピーすると戻す材料を持ち、押すと複製だけがゴミ箱へ入る(元は残る)', async () => {
    const t = mount();
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f2' });
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    t.click(t.region.querySelector('[data-pkc-field="dual-copy"]')!);
    await tick();
    const offer = currentDualMoveOffer();
    expect(offer, 'コピーの後に戻す材料が無い(片道になっている)').not.toBeNull();
    expect(offer!.created.length).toBe(1);
    expect(offer!.moves, 'コピーなのに移した物として持っている').toEqual([]);
    const copyLid = offer!.created[0]!;
    expect(t.d.getState().entryMetas.has(copyLid), '前提: 複製が作られていない').toBe(true);
    expect(t.d.getState().notice).toBe('1 件を「たな」へコピーしました');
    t.click(undoButton(t.root));
    expect(t.d.getState().entryMetas.has(copyLid), '複製がゴミ箱へ入っていない').toBe(false);
    expect(t.d.getState().entryMetas.has('a'), '元まで消した').toBe(true);
    expect(t.d.getState().notice).toBe('コピーした 1 件をゴミ箱へ入れました(ゴミ箱から戻せます)');
    expect(currentDualMoveOffer(), '戻した後も材料を持っている').toBeNull();
  });

  it('フォルダごとコピーしたら、複製を全部(中身も)ゴミ箱へ入れる', async () => {
    const t = mount();
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f2' });
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'f1', mode: 'set' });
    t.click(t.region.querySelector('[data-pkc-field="dual-copy"]')!);
    await tick();
    const created = currentDualMoveOffer()!.created;
    expect(created.length, '前提: フォルダと中身の 2 件').toBe(2);
    t.click(undoButton(t.root));
    for (const lid of created) expect(t.d.getState().entryMetas.has(lid)).toBe(false);
    expect(t.d.getState().entryMetas.has('f1')).toBe(true);
    expect(t.d.getState().entryMetas.has('x')).toBe(true);
  });

  it('戻す前に複製を消していたら、戻せるものが無いと言う', async () => {
    const t = mount();
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f2' });
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    t.click(t.region.querySelector('[data-pkc-field="dual-copy"]')!);
    await tick();
    t.d.dispatch({ type: 'DELETE_ENTRIES', lids: [...currentDualMoveOffer()!.created] });
    t.click(undoButton(t.root));
    expect(t.d.getState().notice).toBe('戻せるものがありません(コピーした物がもうありません)');
  });
});

describe('115-5 A: フォルダごとコピーすると、一緒にコピーしたノートへのリンクはコピー先を指す', () => {
  it('🔴 はこ(中に えっくす と わい)を丸ごとコピーすると、複製どうしのリンクは複製を指す。コピーしなかった物へのリンクは元のまま', async () => {
    // f1 の中の えっくす(x)は「わい(y)」と「い(b)」へリンクしている。x と y を同時にコピーしたとき、
    // x' のリンクは y' を指し、コピーしなかった b へのリンクは元のまま
    const t = mount();
    t.d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [rel('r1', 'f1', 'x'), rel('r2', 'f1', 'y')] });
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f2' });
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'f1', mode: 'set' });
    t.click(t.region.querySelector('[data-pkc-field="dual-copy"]')!);
    await tick();
    const persisted = t.events
      .filter((e) => e.type === 'PERSIST_ENTRY')
      .map((e) => (e as unknown as { entry: { lid: string; title: string; body: string } }).entry);
    const copyOfX = persisted.find((p) => p.title === 'えっくす');
    const copyOfY = persisted.find((p) => p.title === 'わい');
    expect(copyOfX && copyOfY, '前提: 中身 2 件がコピーされていない').toBeTruthy();
    expect(copyOfX!.body, 'x の複製のリンクが、y の複製に付け替わっていない').toContain(`entry:${copyOfY!.lid}`);
    expect(copyOfX!.body, 'x の複製が元の y を指したまま').not.toContain('entry:y)');
    expect(copyOfX!.body, 'コピーしなかった い へのリンクまで付け替えた').toContain('(entry:b)');
    expect(copyOfY!.body, 'y の複製のリンクが x の複製に付け替わっていない').toContain(`entry:${copyOfX!.lid}`);
  });

  it('⚠ 対照群 ── 1 件だけコピーしたとき、その中のリンクは元のまま(付け替える先が無い)', async () => {
    const t = mount();
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' });
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f2' });
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'x', mode: 'set' });
    t.click(t.region.querySelector('[data-pkc-field="dual-copy"]')!);
    await tick();
    const copy = t.events
      .filter((e) => e.type === 'PERSIST_ENTRY')
      .map((e) => (e as unknown as { entry: { title: string; body: string } }).entry)
      .find((p) => p.title === 'えっくす');
    expect(copy!.body).toBe('[ゆ](entry:y) と [外](entry:b)');
  });
});

describe('326 A: 作った行にカーソルと印が付く(名前の打ち替えには入らない)', () => {
  it.each([
    ['dual-mkdir', 'folder'],
    ['dual-mknote', 'text'],
  ])('🔴 %s で作ると、その行が選ばれてカーソルが乗る', (field, archetype) => {
    const t = mount();
    t.click(t.region.querySelector(`[data-pkc-field="${field}"]`)!);
    const st = t.d.getState();
    const made = [...st.entryMetas.values()].find((m) => m.title.startsWith('新しい') && m.archetype === archetype)!;
    expect(made, '前提: 作れていない').toBeTruthy();
    const pane = paneOf(st.dual, 'left');
    expect(pane.selection, '作った行に印が付いていない').toEqual([made.lid]);
    expect(pane.cursor, '作った行にカーソルが乗っていない').toBe(made.lid);
    expect(st.dual.renaming, '名前の打ち替えまで入った(続けて作るときに邪魔になる)').toBeNull();
    const row = t.region.querySelector(`[data-pkc-region="dual-pane"][data-pkc-side="left"] tr[data-pkc-entry="${made.lid}"]`)!;
    expect(row.hasAttribute('data-pkc-cursor'), '画面でカーソルが見えない').toBe(true);
  });

  it('⚠ 対照群 ── 編集中は作れない(CREATE_ENTRY が捨てられる)ので、何も選ばない', () => {
    const t = mount();
    t.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    t.d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '' });
    t.d.dispatch({ type: 'START_EDIT' });
    expect(t.d.getState().phase, '前提: 編集に入れていない').toBe('editing');
    t.click(t.region.querySelector('[data-pkc-field="dual-mknote"]')!);
    expect(paneOf(t.d.getState().dual, 'left').selection).toEqual([]);
  });
});

describe('323 A: 種類の札を押したままでも、2 ペインにフォルダが出る', () => {
  it('🔴 「ノート」の札を押しても、両方のペインにフォルダが出て、左の列の札は外れない', () => {
    const t = mount();
    t.d.dispatch({ type: 'TOGGLE_KIND_FILTER', archetype: 'text' });
    expect(t.d.getState().kindFilter.size, '前提: 札が押されていない').toBe(1);
    for (const side of ['left', 'right'] as const) {
      expect(t.rows(side), `${side} のペインからフォルダが消えた`).toContain('f1');
    }
    expect(t.d.getState().kindFilter.size, '2 ペインが札を勝手に外した').toBe(1);
  });

  it('範囲選択(reducer)と描画と対象の決め方が、同じ 1 本(札を見ない)', () => {
    const t = mount();
    t.d.dispatch({ type: 'TOGGLE_KIND_FILTER', archetype: 'text' });
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'f1', mode: 'set' });
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'f2', mode: 'range' });
    expect(paneOf(t.d.getState().dual, 'left').selection, 'Shift の範囲が札で欠けた').toEqual(['f1', 'f2']);
    expect(dualListViewOptions(t.d.getState()).kinds.size, '2 ペインの並び方が札を持っている').toBe(0);
  });
});

describe('322 A: スマートフォルダを開いたとき、状態を左のペインと同じ字で言う', () => {
  const left = (t: ReturnType<typeof mount>): string =>
    t.region.querySelector('[data-pkc-region="dual-pane"][data-pkc-side="left"] [data-pkc-field="dual-empty"]')?.textContent ?? '';
  const foot = (t: ReturnType<typeof mount>): string =>
    t.region.querySelector('[data-pkc-region="dual-pane"][data-pkc-side="left"] [data-pkc-field="dual-count"]')?.textContent ?? '';

  it('🔴 4 つの状態を、それぞれ別の字で言う(全部「何もありません」にしない)', () => {
    const t = mount();
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'left', lid: 's1' });
    expect(left(t), '集めている途中').toBe(SMART_COLLECTING);
    t.d.dispatch({ type: 'SMART_SCANNED', lid: 's1', lids: [], total: 0, spec: EMPTY_SMART });
    expect(left(t), '条件が空').toBe(SMART_NO_CONDITION);
    t.d.dispatch({ type: 'SMART_SCANNED', lid: 's1', lids: [], total: 0, spec: { ...EMPTY_SMART, tags: ['t'] } });
    expect(left(t), '条件はあるが一致が無い').toBe(SMART_NO_MATCH);
    t.d.dispatch({ type: 'SMART_SCAN_FAILED', lid: 's1' });
    expect(left(t), '集められなかった').toBe(SMART_FAILED);
    expect(left(t), '失敗を「何もない」と言った').not.toContain('何もありません');
  });

  it('🔴 500 件で切ったら件数の行で総数を言う(一致の数 = 総数、出している数)', () => {
    const t = mount();
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'left', lid: 's1' });
    t.d.dispatch({ type: 'SMART_SCANNED', lid: 's1', lids: ['a', 'b'], total: 600, spec: { ...EMPTY_SMART, tags: ['t'] } });
    expect(foot(t)).toContain('600 件中 2 件を出しています');
    // 対照群: 切っていなければ言わない
    t.d.dispatch({ type: 'SMART_SCANNED', lid: 's1', lids: ['a', 'b'], total: 2, spec: { ...EMPTY_SMART, tags: ['t'] } });
    expect(foot(t)).not.toContain('件中');
  });

  it('語を打って 0 件のときは、絞り込みの字を保つ(条件が空・集めている途中・失敗のほうを先に言う)', () => {
    expect(smartEmptyText({ lids: [], total: 0, failed: false, spec: { ...EMPTY_SMART, tags: ['t'] } }, true)).toBeNull();
    expect(smartEmptyText({ lids: [], total: 0, failed: false, spec: { ...EMPTY_SMART, tags: ['t'] } }, false)).toBe(SMART_NO_MATCH);
    expect(smartEmptyText(null, true)).toBe(SMART_COLLECTING);
    expect(smartEmptyText({ lids: [], total: 0, failed: true, spec: EMPTY_SMART }, true)).toBe(SMART_FAILED);
    expect(smartTruncatedText(null)).toBe('');
    expect(smartTruncatedText({ lids: ['a'], total: 1, failed: false, spec: EMPTY_SMART })).toBe('');
  });
});

describe('327 A: パンくずにも行を落として移せる', () => {
  const PKC_DRAG = 'application/x-pkc-lids';
  const dt = (data: Record<string, string>) => {
    const m = new Map(Object.entries(data));
    return {
      dropEffect: 'none',
      effectAllowed: 'none',
      get types(): string[] {
        return [...m.keys()];
      },
      getData: (k: string) => m.get(k) ?? '',
      setData: (k: string, v: string) => void m.set(k, v),
      files: { length: 0, item: () => null },
      items: [] as unknown[],
    };
  };
  const drop = (el: Element, data: Record<string, string>): void => {
    const e = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'dataTransfer', { value: dt(data) });
    el.dispatchEvent(e);
  };

  it('🔴 パンくずの各段(ルート・親のフォルダ)が落とし先の印を持つ', () => {
    const t = mount();
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' });
    const crumbs = [...t.region.querySelectorAll('[data-pkc-region="dual-pane"][data-pkc-side="left"] [data-pkc-action="dual-crumb"]')];
    expect(crumbs.length, '前提: パンくずが 2 段ではない').toBe(2);
    for (const c of crumbs) expect(c.getAttribute('data-pkc-drop'), '落とし先の印が無い').toBe('crumb');
  });

  it('🔴 右のペインの あ を、左のペインのパンくず「ルート」へ落とすと、ルートへ出る(はこ の中にあったとして)', () => {
    const t = mount();
    // えっくす(x)は はこ(f1)の中。左は f1 を開き、右は たな(f2)を開く
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' });
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f2' });
    expect(t.parentsOf('y')).toEqual(['f2']);
    const rootCrumb = t.region.querySelector('[data-pkc-region="dual-pane"][data-pkc-side="left"] [data-pkc-action="dual-crumb"]:not([data-pkc-entry])')!;
    expect(rootCrumb.textContent).toBe('ルート');
    drop(rootCrumb, { [PKC_DRAG]: 'y' });
    expect(t.parentsOf('y'), 'パンくずに落としたのにルートへ出ていない').toEqual([]);
    // 親のフォルダの段へ落とす: わい を はこ へ
    drop(t.region.querySelector('[data-pkc-region="dual-pane"][data-pkc-side="left"] [data-pkc-action="dual-crumb"][data-pkc-entry="f1"]')!, { [PKC_DRAG]: 'a' });
    expect(t.parentsOf('a'), '親のフォルダの段に落としたのに入っていない').toEqual(['f1']);
  });
});

describe('325 A: スマートフォルダへ落としてタグを付けたあと、集まらなかった分を言う', () => {
  it('🔴 他の条件(種類)も持つスマートフォルダ: 集め直しの結果に居ない分を件数で言う', () => {
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    d.dispatch({ type: 'SMART_SCANNED', lid: 's1', lids: [], total: 0, spec: { ...EMPTY_SMART, tags: ['t'], kind: 'folder' } });
    watchSmartDrop(d, 's1', ['a', 'b']);
    expect(d.getState().notice ?? '', '結果が来る前に言った').toBe('');
    // 集め直しの結果: a だけが集まった(b は種類が合わない)
    d.dispatch({ type: 'SMART_SCANNED', lid: 's1', lids: ['a'], total: 1, spec: { ...EMPTY_SMART, tags: ['t'], kind: 'folder' } });
    expect(d.getState().notice).toBe('1 件はほかの条件に合わないので、ここには出ません(タグは付けました)');
  });

  it('⚠ 対照群 ── 条件がタグだけなら必ず集まるので何も言わない / 全部集まったときも言わない', () => {
    const tagOnly = new Dispatcher();
    tagOnly.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    tagOnly.dispatch({ type: 'SMART_SCANNED', lid: 's1', lids: [], total: 0, spec: { ...EMPTY_SMART, tags: ['t'] } });
    watchSmartDrop(tagOnly, 's1', ['a']);
    tagOnly.dispatch({ type: 'SMART_SCANNED', lid: 's1', lids: [], total: 0, spec: { ...EMPTY_SMART, tags: ['t'] } });
    expect(tagOnly.getState().notice ?? '').toBe('');

    const all = new Dispatcher();
    all.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    all.dispatch({ type: 'SMART_SCANNED', lid: 's1', lids: [], total: 0, spec: { ...EMPTY_SMART, tags: ['t'], kind: 'text' } });
    watchSmartDrop(all, 's1', ['a']);
    all.dispatch({ type: 'SMART_SCANNED', lid: 's1', lids: ['a'], total: 1, spec: { ...EMPTY_SMART, tags: ['t'], kind: 'text' } });
    expect(all.getState().notice ?? '', '全部集まったのに言った').toBe('');
  });

  it('上限で切れた一覧は「無い」と言い切れないので言わない / 一度も開いていない(条件が分からない)ときも言わない', () => {
    const cut = new Dispatcher();
    cut.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    cut.dispatch({ type: 'SMART_SCANNED', lid: 's1', lids: [], total: 0, spec: { ...EMPTY_SMART, kind: 'text' } });
    watchSmartDrop(cut, 's1', ['a']);
    cut.dispatch({ type: 'SMART_SCANNED', lid: 's1', lids: ['b'], total: 900, spec: { ...EMPTY_SMART, kind: 'text' } });
    expect(cut.getState().notice ?? '').toBe('');

    const unknown = new Dispatcher();
    unknown.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    watchSmartDrop(unknown, 's1', ['a']);
    unknown.dispatch({ type: 'SMART_SCANNED', lid: 's1', lids: [], total: 0, spec: { ...EMPTY_SMART, kind: 'text' } });
    expect(unknown.getState().notice ?? '').toBe('');
  });
});

describe('115-4 A: 書けなかった移動は、画面を元に戻して赤い字だけを出す', () => {
  it('🔴 reducer: 移す前の居場所を載せ、戻す要求で居場所が元に戻る', () => {
    const base = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS }).state;
    const moved = reduce(base, { type: 'SET_ENTRY_PARENT', lid: 'y', parentLid: 'f1', relationId: 'rr' });
    const ev = moved.events[0] as { type: string; previous?: Relation[] };
    expect(ev.type).toBe('REQUEST_SET_PARENT');
    expect(ev.previous?.map((r) => r.fromLid), '移す前の居場所を運んでいない').toEqual(['f2']);
    const back = reduce(moved.state, { type: 'ROLLBACK_ENTRY_PARENT', lid: 'y', previous: ev.previous! });
    const parents = back.state.relations.filter((r) => r.toLid === 'y').map((r) => r.fromLid);
    expect(parents, '画面の居場所が元に戻っていない').toEqual(['f2']);
  });

  it('🔴 effect: 書けなかったら(setEntryParent が落ちる)画面を元に戻し、赤い字を出す', async () => {
    const d = new Dispatcher();
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => null,
      deleteEntry: async () => {},
      setEntryParent: async () => {
        throw new Error('quota');
      },
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async () => stubStamps(),
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    d.dispatch({ type: 'SET_ENTRY_PARENT', lid: 'y', parentLid: 'f1', relationId: 'rr' });
    expect(d.getState().relations.some((r) => r.toLid === 'y' && r.fromLid === 'f1'), '前提: 先に画面が動いていない').toBe(true);
    await tick(20);
    const parents = d.getState().relations.filter((r) => r.toLid === 'y').map((r) => r.fromLid);
    expect(parents, '書けなかったのに画面の移動が残っている').toEqual(['f2']);
    expect(d.getState().error ?? '', '赤い字が出ていない').toContain('フォルダへの所属を変えられませんでした');
  });

  it('⚠ 対照群 ── 書けたときは戻さない', async () => {
    const d = new Dispatcher();
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
    d.dispatch({ type: 'SET_ENTRY_PARENT', lid: 'y', parentLid: 'f1', relationId: 'rr' });
    await tick(20);
    expect(d.getState().relations.filter((r) => r.toLid === 'y').map((r) => r.fromLid)).toEqual(['f1']);
    expect(d.getState().error ?? '').toBe('');
  });
});

describe('97-6 A: 「移す・コピーする元」を動きで言う', () => {
  it('🔴 焦点のあるペインの件数の行が「(ここから移す・コピーします)」で終わる。「元」と書かない', () => {
    const t = mount();
    const foot = (side: string): string =>
      t.region.querySelector(`[data-pkc-region="dual-pane"][data-pkc-side="${side}"] [data-pkc-field="dual-count"]`)?.textContent ?? '';
    expect(foot('left')).toContain('(ここから移す・コピーします)');
    expect(foot('right'), '両方に付いた').not.toContain('ここから移す');
    expect(foot('left'), '「元に戻す」と同じ字の「元」が残っている').not.toMatch(/元/);
  });
});

describe('51-4 A: 移した後の知らせは、押したボタンと同じ「移す」で言う', () => {
  it('🔴 「N 件を「X」へ移しました」(ルートへ出したときも同じ形)', () => {
    const t = mount();
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f1' });
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    t.click(t.region.querySelector('[data-pkc-field="dual-move"]')!);
    expect(t.d.getState().notice).toBe('1 件を「はこ」へ移しました');
    // ルートへ出す
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' });
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: null });
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'x', mode: 'set' });
    t.click(t.region.querySelector('[data-pkc-field="dual-move"]')!);
    expect(t.d.getState().notice).toBe('1 件を「ルート」へ移しました');
  });
});
