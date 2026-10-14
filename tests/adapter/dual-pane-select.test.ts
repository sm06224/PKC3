/** @vitest-environment happy-dom */
/**
 * 2 ペインの選びとコピー・移す 5 つ(Gemini 裁定 = #1163 への依頼 62。推薦どおり)。
 *
 * 1. 相手のペインに選びが残っているとき、パソコンでも件数の行に言う(スマホの専用の行と同じ数)
 * 2. 列見出しの左端に「全部選ぶ」チェック(Ctrl+A のマウス版)
 * 3. 同じ名前のタブは、ぶつかったときだけ番号を添える(最初の 1 枚は素のまま)
 * 4. 移した直後の「元に戻す」(ゴミ箱・予定と同じ、画面の下の知らせの隣)
 * 5. コピーの行き先に同じ題名のノートが既にあれば、知らせに添える(止めない)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { DualFilerRenderer, tabLabels } from '../../src/adapter/ui/render/dual-filer';
import { paintStatusUndo } from '../../src/adapter/ui/render/status-open';
import {
  clearDualMoveOffer,
  currentDualMoveOffer,
} from '../../src/adapter/ui/render/dual-move-undo';
import { paneOf } from '../../src/features/relation/dual-pane';

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

/** ルート: はこ(f1)/ あ(a)/ い(b)/ う(c)/ えっくす(z)。f1 の中に えっくす(x)。 */
const METAS = [
  meta('f1', 1, 'はこ', 'folder'),
  meta('a', 2, 'あ'),
  meta('b', 3, 'い'),
  meta('c', 4, 'う'),
  meta('z', 5, 'えっくす'),
  meta('x', 6, 'えっくす'),
];
const RELS = [rel('r1', 'f1', 'x')];

const foot = (region: HTMLElement, side: string): string =>
  region.querySelector(`[data-pkc-region="dual-pane"][data-pkc-side="${side}"] [data-pkc-field="dual-count"]`)
    ?.textContent ?? '';

describe('① パソコンでも、相手のペインに残っている選びを件数の行で言う', () => {
  it('🔴 焦点の側の件数の行にだけ「左に 2 件選択中(元は右)」が付き、選びを外すと消える', () => {
    document.body.innerHTML = '';
    const region = document.createElement('div');
    document.body.append(region);
    const r = new DualFilerRenderer(region);
    let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS }).state;
    s = reduce(s, { type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' }).state;
    s = reduce(s, { type: 'DUAL_SELECT', side: 'left', lid: 'b', mode: 'toggle' }).state;
    s = reduce(s, { type: 'DUAL_FOCUS', side: 'right' }).state;
    r.render(s);
    expect(foot(region, 'right'), '焦点の側に相手の選びが出ていない').toContain('左に 2 件選択中(元は右)');
    expect(foot(region, 'left'), '選びが残っている側自身には付けない').not.toContain('選択中(元は');
    // スマホ専用の行は、パソコンでは使わない(同じ数を 2 か所で言わない)
    expect(region.querySelector('[data-pkc-field="dual-other-marks"]')?.textContent).toBe('');
    // 対照群: 選びを外せば添え書きも消える(古い字が残らない)
    s = reduce(s, { type: 'DUAL_CLEAR_SELECTION', side: 'left' }).state;
    r.render(s);
    expect(foot(region, 'right'), '選びを外したのに添え書きが残っている').not.toContain('選択中(元は');
  });
});

describe('③ 同じ名前のタブには、ぶつかったときだけ番号を添える', () => {
  it('🔴 tabLabels: 最初は素のまま、2 枚目から ②③。ぶつからない名前は触らない', () => {
    expect(tabLabels(['ルート', 'はこ', 'ルート', 'ルート'])).toEqual([
      'ルート',
      'はこ',
      'ルート ②',
      'ルート ③',
    ]);
    expect(tabLabels(['ルート', 'はこ'])).toEqual(['ルート', 'はこ']);
  });

  it('🔴 「+」で足した 2 枚目・3 枚目が帯の字になる', () => {
    document.body.innerHTML = '';
    const region = document.createElement('div');
    document.body.append(region);
    const r = new DualFilerRenderer(region);
    let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS }).state;
    const names = (): string[] =>
      [
        ...region.querySelectorAll(
          '[data-pkc-region="dual-pane"][data-pkc-side="left"] [data-pkc-action="dual-tab-activate"]',
        ),
      ].map((e) => e.textContent ?? '');
    r.render(s);
    expect(names(), '1 枚だけなら素のまま').toEqual(['ルート']);
    s = reduce(s, { type: 'DUAL_TAB_ADD', side: 'left' }).state;
    s = reduce(s, { type: 'DUAL_TAB_ADD', side: 'left' }).state;
    r.render(s);
    expect(names()).toEqual(['ルート', 'ルート ②', 'ルート ③']);
    // 右のペインは別の帯(番号は帯ごとに数える)
    const right = [
      ...region.querySelectorAll(
        '[data-pkc-region="dual-pane"][data-pkc-side="right"] [data-pkc-action="dual-tab-activate"]',
      ),
    ].map((e) => e.textContent ?? '');
    expect(right).toEqual(['ルート']);
  });
});

describe('配線(binder)', () => {
  let root: HTMLElement;
  let d: Dispatcher;
  let region: HTMLElement;
  let statuses: string[];

  beforeEach(() => {
    document.body.innerHTML = '';
    statuses = [];
    clearDualMoveOffer();
    root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    d = new Dispatcher();
    buildShell(root);
    bindActions(root, d, {
      readBodies: async (lids) => new Map(lids.map((l) => [l, `# 本文 ${l}`])),
      showStatus: (t: string) => void statuses.push(t),
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
    region = document.createElement('div');
    root.append(region);
    const r = new DualFilerRenderer(region);
    d.onState((st) => r.render(st));
    r.render(d.getState());
  });

  const click = (el: Element): void => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  const selectAll = (side: string): HTMLInputElement =>
    region.querySelector<HTMLInputElement>(
      `[data-pkc-region="dual-pane"][data-pkc-side="${side}"] thead [data-pkc-action="dual-select-all"]`,
    )!;
  const parentsOf = (lid: string): string[] =>
    d
      .getState()
      .relations.filter((x) => x.toLid === lid && x.kind === 'structural')
      .map((x) => x.fromLid);

  describe('② 列見出しの「全部選ぶ」チェック', () => {
    it('🔴 見出しの左端にあり、押すと見えている行が全部選ばれ、状態が表に映る。もう一度押すと外れる', () => {
      const box = selectAll('left');
      expect(box, '見出しにチェックが無い').toBeTruthy();
      expect(box.getAttribute('aria-label')).toBe('全部選ぶ');
      expect(box.title).toBe('全部選ぶ');
      // 見出しの最初の部品である(左端)
      expect(box.closest('th')?.parentElement?.firstElementChild).toBe(box.closest('th'));
      expect(box.checked).toBe(false);
      click(box);
      const sel = paneOf(d.getState().dual, 'left').selection;
      expect([...sel].sort(), '見えている 5 行が全部選ばれていない').toEqual(['a', 'b', 'c', 'f1', 'z']);
      expect(selectAll('left').checked, '全部選んだのにチェックが付かない').toBe(true);
      expect(selectAll('right').checked, '反対のペインまで付いた').toBe(false);
      // 対照群: 全部選んでいるときに押すと外れる
      click(selectAll('left'));
      expect(paneOf(d.getState().dual, 'left').selection).toEqual([]);
      expect(selectAll('left').checked).toBe(false);
    });

    it('🔴 一部だけ選んでいるときは「途中」の表示(全部ではない)', () => {
      d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
      expect(selectAll('left').checked).toBe(false);
      expect(selectAll('left').indeterminate, '一部だけなのに途中の表示が出ない').toBe(true);
    });

    it('🔴 絞り込みで消えた行は選ばない(見えている行だけ)', () => {
      d.dispatch({ type: 'DUAL_SET_FILTER', side: 'left', filter: 'え' });
      click(selectAll('left'));
      expect(paneOf(d.getState().dual, 'left').selection).toEqual(['z']);
    });
  });

  describe('④ 移した直後の「元に戻す」', () => {
    const moveAToBox = (): void => {
      d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f1' });
      d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
      d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'b', mode: 'toggle' });
      click(region.querySelector('[data-pkc-field="dual-move"]')!);
    };
    const undoBtn = (): HTMLElement => {
      const b = document.createElement('button');
      b.hidden = true;
      return b;
    };
    const none = { lastMove: null, lastAppend: null, noticeOpen: null };

    it('🔴 移すと知らせの隣に「元に戻す」が出て、押すと元の場所へ戻る', () => {
      expect(parentsOf('a')).toEqual([]);
      moveAToBox();
      expect(parentsOf('a'), '前提: 移せていない').toEqual(['f1']);
      const line = d.getState().notice ?? '';
      expect(line).toBe('2 件を「はこ」へ入れました');
      expect(currentDualMoveOffer()?.moves.map((m) => m.lid).sort()).toEqual(['a', 'b']);
      const b = undoBtn();
      paintStatusUndo(b, { ...none, notice: line }, line);
      expect(b.hidden, '戻す口が出ない(片道になっている)').toBe(false);
      expect(b.getAttribute('data-pkc-action')).toBe('undo-dual-move');
      expect(b.textContent).toBe('元に戻す');
      // 別の知らせが来たら畳む
      paintStatusUndo(b, { ...none, notice: '別の知らせ' }, '別の知らせ');
      expect(b.hidden, '別の知らせの隣に残っている').toBe(true);
      // 押すと戻る(押し口は binder の受け手)
      b.setAttribute('data-pkc-action', 'undo-dual-move');
      root.append(b);
      click(b);
      expect(parentsOf('a'), '戻っていない').toEqual([]);
      expect(parentsOf('b')).toEqual([]);
      expect(d.getState().notice).toBe('2 件を元の場所に戻しました');
      expect(currentDualMoveOffer(), '戻した後も材料を持っている').toBeNull();
    });

    it('🔴 移した後に別の場所へ動かした物は戻さない', () => {
      moveAToBox();
      // a をルートへ出し直した(移した先から離れた)
      d.dispatch({ type: 'SET_ENTRY_PARENT', lid: 'a', parentLid: null, relationId: 'rr' });
      const b = document.createElement('button');
      b.setAttribute('data-pkc-action', 'undo-dual-move');
      root.append(b);
      click(b);
      expect(parentsOf('a')).toEqual([]);
      expect(parentsOf('b'), 'b だけが戻る').toEqual([]);
      expect(d.getState().notice).toBe('1 件を元の場所に戻しました');
    });

    it('🔴 戻すと輪になる物は戻さず、戻したとも数えない(#1087)', () => {
      // はこ(f1)の中のたな(f2)をルートへ出し、その後はこをたなの中へ入れた ── たなを はこ へ戻すと輪になる
      d.dispatch({ type: 'CREATE_ENTRY', archetype: 'folder', lid: 'f2', title: 'たな', parentLid: 'f1', relationId: 'r2', edit: false });
      d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' });
      d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: null });
      d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'f2', mode: 'set' });
      click(region.querySelector('[data-pkc-field="dual-move"]')!);
      expect(parentsOf('f2'), '前提: ルートへ出せていない').toEqual([]);
      d.dispatch({ type: 'SET_ENTRY_PARENT', lid: 'f1', parentLid: 'f2', relationId: 'r3' });
      expect(parentsOf('f1'), '前提: はこ が たな に入っていない').toEqual(['f2']);
      const b = document.createElement('button');
      b.setAttribute('data-pkc-action', 'undo-dual-move');
      root.append(b);
      click(b);
      expect(parentsOf('f2'), '輪を作った').toEqual([]);
      expect(d.getState().notice, '戻していないのに戻したと言った').not.toContain('元の場所に戻しました');
    });

    it('🔴 何も動かなかった回(同じ場所への移し直し)では出さない', () => {
      d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
      click(region.querySelector('[data-pkc-field="dual-move"]')!); // 右もルート → もう居る
      expect(currentDualMoveOffer(), '動いていないのに戻す口が出る').toBeNull();
      expect(statuses.at(-1)).toBe('すでに「ルート」に入っています');
    });
  });

  describe('⑤ コピーの行き先に同じ題名があれば、知らせに添える', () => {
    const copyZ = async (lid: string): Promise<void> => {
      d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'right', lid: 'f1' }); // 行き先: はこ(中に「えっくす」)
      d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid, mode: 'set' });
      click(region.querySelector('[data-pkc-field="dual-copy"]')!);
      await new Promise((r) => setTimeout(r, 0));
    };

    it('🔴 同じ題名が行き先に既にあれば添える。止めずにコピーはする', async () => {
      await copyZ('z');
      expect(statuses.at(-1)).toBe(
        '1 件を「はこ」へコピーしました(うち 1 件は、同じ題名のノートが既にあります)',
      );
      expect(
        [...d.getState().entryMetas.values()].filter((m) => m.title === 'えっくす').length,
        '止めずにコピーされている',
      ).toBe(3);
    });

    it('対照群: 同じ題名が無ければ添えない', async () => {
      await copyZ('a');
      expect(statuses.at(-1)).toBe('1 件を「はこ」へコピーしました');
    });
  });
});
