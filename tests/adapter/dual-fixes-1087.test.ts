/** @vitest-environment happy-dom */
/**
 * 🔴 **2 ペインの直し 7 件**(#1087 D1 / D2 / D3 / D4 / D5 / D7 / D10)。
 *
 * ⚠ 台は実物(shell + DualFilerRenderer + binder)で組む ── 右クリックのメニューが運ぶ属性と
 *   binder の受けは、片方の test では見えない(`dual-row-menu.test.ts` と同じ作法)。
 * 🔑 どの it も「直す前の実装に戻すと落ちる」形で書いてある(カーソルは先頭の行ではなく、
 *   途中の行を使う ── 先頭の行は「立てない」実装でも偶然合う)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DualFilerRenderer } from '../../src/adapter/ui/render/dual-filer';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { paneOf } from '../../src/features/relation/dual-pane';

function meta(lid: string, order: number, archetype = 'text', title = 't-' + lid): EntryMeta {
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

/** ルート: f1 f2 a b c(この並び)。f2 の中に z。 */
const METAS = [
  meta('f1', 1, 'folder'),
  meta('f2', 2, 'folder'),
  meta('a', 3),
  meta('b', 4),
  meta('c', 5),
  meta('z', 6),
];
const RELS = [rel('r1', 'f2', 'z')];
const MENU = '[data-pkc-region="context-menu"]';
const PKC_DRAG = 'application/x-pkc-lids';

beforeEach(() => {
  document.body.textContent = '';
  resetAppDialogForTest();
});

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

function setup(services: Parameters<typeof bindActions>[2] = {}) {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const dual = new DualFilerRenderer(regions.center);
  d.onState((s) => dual.render(s));
  bindActions(root, d, services);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
  d.dispatch({ type: 'SET_VIEW_MODE', mode: 'dual' });
  const row = (side: 'left' | 'right', lid: string): HTMLElement => {
    const el = regions.center.querySelector<HTMLElement>(
      `[data-pkc-region="dual-pane"][data-pkc-side="${side}"] [data-pkc-region="dual-table"] [data-pkc-entry="${lid}"]`,
    );
    expect(el, `前提が崩れている: ${side} に ${lid} の行が無い`).not.toBeNull();
    return el!;
  };
  const cursor = (side: 'left' | 'right' = 'left'): string | null => paneOf(d.getState().dual, side).cursor;
  const selection = (side: 'left' | 'right' = 'left'): readonly string[] =>
    paneOf(d.getState().dual, side).selection;
  const key = (el: HTMLElement, k: string): void => {
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  };
  const rightClick = (el: Element): void => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  };
  const press = (action: string): void => {
    const b = root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="${action}"]`);
    expect(b, `メニューに ${action} が無い`).not.toBeNull();
    b!.click();
  };
  return { root, d, regions, row, cursor, selection, key, rightClick, press };
}

describe('2 ペインの直し(#1087)', () => {
  it('🔴 D1: 右クリックの「ゴミ箱へ移す」の後、カーソルが隣の行に立ち、焦点も連れて行く', () => {
    const t = setup();
    t.rightClick(t.row('left', 'b'));
    expect(t.cursor(), '前提が崩れている(右クリックの行にカーソルが立っていない)').toBe('b');
    t.press('delete-entry');
    expect(t.d.getState().entryMetas.has('b'), '前提が崩れている(移っていない)').toBe(false);
    // b が居た位置(3 番目)の行 = c
    expect(t.cursor(), '消した後にカーソルが立っていない').toBe('c');
    expect(document.activeElement, '焦点が body へ落ちた(続けて ↓ / Delete が効かない)').toBe(
      t.row('left', 'c'),
    );
  });

  it('🔴 D2: 複数の印の中の行を右クリックしても、印は 1 件に崩れない', () => {
    const t = setup();
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'c', mode: 'range' });
    expect(t.selection(), '前提が崩れている').toEqual(['a', 'b', 'c']);
    t.rightClick(t.row('left', 'b'));
    expect(t.root.querySelector(MENU), '空振り防止(メニューが出ていない)').not.toBeNull();
    expect(t.selection(), '印が右クリックで 1 件に崩れた').toEqual(['a', 'b', 'c']);
    expect(t.cursor(), 'カーソルが押した行へ動いていない').toBe('b');
  });

  it('D2 対照群: 印の外の行を右クリックしたら、従来どおりその 1 件を選ぶ', () => {
    const t = setup();
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'b', mode: 'toggle' });
    t.rightClick(t.row('left', 'c'));
    expect(t.selection()).toEqual(['c']);
  });

  it('🔴 D2: 複数の印の中で右クリックした行の「名前」は、その行を打ち替える(印の件数で断らない)', () => {
    const t = setup();
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'c', mode: 'range' });
    t.rightClick(t.row('left', 'b'));
    t.press('dual-rename-begin');
    expect(t.d.getState().dual.renaming).toEqual({ side: 'left', lid: 'b' });
  });

  it('🔴 D3: 掴んで別のフォルダへ落とした後、カーソルは元の位置の行に立つ(先頭へ飛ばない)', async () => {
    const t = setup();
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'b', mode: 'set' });
    const data = new Map<string, string>();
    const dt = {
      dropEffect: 'none',
      effectAllowed: 'none',
      get types() {
        return [...data.keys()];
      },
      getData: (k: string) => data.get(k) ?? '',
      setData: (k: string, v: string) => void data.set(k, v),
      files: { length: 0, item: () => null },
    };
    const ev = (type: string): Event => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: dt });
      return e;
    };
    t.row('left', 'b').dispatchEvent(ev('dragstart'));
    expect(data.get(PKC_DRAG), '前提が崩れている(掴めていない)').toContain('b');
    t.row('left', 'f2').dispatchEvent(ev('drop'));
    await tick();
    expect(
      t.d.getState().relations.find((r) => r.toLid === 'b')?.fromLid,
      '前提が崩れている(動いていない)',
    ).toBe('f2');
    // 行は f1 f2 a c ── b が居た位置(3 番目)の c。先頭の f1 ではない
    expect(t.cursor()).toBe('c');
  });

  it('🔴 D4: Backspace で親へ出たら、出てきたフォルダにカーソルが立つ(先頭へ飛ばない)', () => {
    const t = setup();
    t.d.dispatch({ type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f2' });
    t.key(t.row('left', 'z'), 'Backspace');
    // ルートの先頭は f1。出てきたのは f2
    expect(t.cursor()).toBe('f2');
  });

  it('🔴 D5: 名前を打っている最中に表が組み直されても、打った字とキャレットを失わない', () => {
    const t = setup();
    t.key(t.row('left', 'a'), 'F2');
    const input = () => t.regions.center.querySelector<HTMLInputElement>('[data-pkc-field="dual-rename"]')!;
    expect(input(), '前提が崩れている(入力欄が出ていない)').toBeTruthy();
    input().value = 'うちかけの名前';
    input().setSelectionRange(2, 4);
    const before = input();
    // 別の行の題名が変わった(別のタブの保存 / 再読み込み)── 指紋が動いて表が作り直される
    t.d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: METAS.map((m) => (m.lid === 'c' ? { ...m, title: '別の題名' } : m)),
      relations: RELS,
    });
    expect(t.d.getState().dual.renaming, '前提が崩れている(打ち替えが終わっている)').not.toBeNull();
    expect(input(), '前提が崩れている(表が作り直されていない)').not.toBe(before);
    expect(input().value, '打った字が元の題名に戻った').toBe('うちかけの名前');
    expect(input().selectionStart).toBe(2);
    expect(input().selectionEnd).toBe(4);
  });

  it('🔴 D7: 印が複数あるとき、F2 は印の外のカーソルの行を改名せず、ボタンと同じ断りを出す', () => {
    const t = setup();
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'b', mode: 'toggle' });
    t.d.dispatch({ type: 'DUAL_SET_CURSOR', side: 'left', lid: 'c' });
    t.key(t.row('left', 'c'), 'F2');
    expect(t.d.getState().dual.renaming, '印の無い行の名前が打てる').toBeNull();
    const viaKey = t.d.getState().error;
    expect(viaKey).toBe('名前を変えられるのは 1 件だけです');
    // ボタンも同じ字(同じ 1 本の決め方を通る)
    const btn = t.regions.center.querySelector<HTMLElement>('[data-pkc-action="dual-rename-begin"]');
    expect(btn, '前提が崩れている(名前ボタンが無い)').not.toBeNull();
    btn!.click();
    expect(t.d.getState().dual.renaming, 'ボタンでは打てた').toBeNull();
    expect(t.d.getState().error).toBe(viaKey);
  });

  it('🔴 D7: 印が 1 件でカーソルが別の行にあるとき、F2 は印の行を改名する', () => {
    const t = setup();
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' });
    t.d.dispatch({ type: 'DUAL_SET_CURSOR', side: 'left', lid: 'c' });
    t.key(t.row('left', 'c'), 'F2');
    expect(t.d.getState().dual.renaming).toEqual({ side: 'left', lid: 'a' });
  });

  it('🔴 D10: 消している間にカーソルを動かしたら、消し終わった後に上書きしない', async () => {
    const t = setup({ acquireEditLock: async () => 'granted' } as never);
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'b', mode: 'set' });
    t.key(t.row('left', 'b'), 'Delete');
    // 確かめている間(非同期)に user が a へ動かした
    expect(t.d.getState().entryMetas.has('b'), '前提が崩れている(同期に消えた)').toBe(true);
    t.d.dispatch({ type: 'DUAL_SET_CURSOR', side: 'left', lid: 'a' });
    await tick();
    expect(t.d.getState().entryMetas.has('b'), '前提が崩れている(消えていない)').toBe(false);
    expect(t.cursor(), 'user が動かしたカーソルを上書きした').toBe('a');
  });

  it('D10 対照群: 動かさなければ、消した位置の行に立つ(非同期でも)', async () => {
    const t = setup({ acquireEditLock: async () => 'granted' } as never);
    t.d.dispatch({ type: 'DUAL_SELECT', side: 'left', lid: 'b', mode: 'set' });
    t.key(t.row('left', 'b'), 'Delete');
    await tick();
    expect(t.cursor()).toBe('c');
  });
});
