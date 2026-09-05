/** @vitest-environment happy-dom */
/**
 * 🔴 **スタックを鍵とパレットから呼ぶ**(#633 段②。user 裁定 2026-08-30
 * 「**スタックからすぐ呼び出せるようにしろ**」)。
 *
 * ⚠ 直す前、スタックを触る口は**本文の上の帯の札だけ**だった ── 帯は載せていないと
 *   出ないので、「いま読んでいるノートを載せる」は右クリックまで行くしか無かった。
 *
 * ここで見るのは**繋がり**である ── ①鍵を押すと action が dispatch されるか
 * ②パレットに行が出て、押せない理由が読めるか ③対象が無いときに**無言で終わらない**か。
 * 🔑 `runGlobalCommand` は鍵とパレットの共通の 1 本なので、ここが落ちる変異は
 *   両方を同時に殺す(CLAUDE.md §7)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions, runGlobalCommand } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { DIALOG_REGION, resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { NOT_READY_PREFIX } from '../../src/features/palette/palette-rows';
import { findCommand } from '../../src/features/keymap';

function meta(lid: string, title: string, archetype = 'text'): EntryMeta {
  return {
    lid,
    title,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: 0,
  };
}

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function setup() {
  document.body.innerHTML = '';
  resetAppDialogForTest();
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  const said: string[] = [];
  const store = new KeymapStore();
  bindActions(root, d, { showStatus: (t) => said.push(t) }, store);
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a', '議事録'), meta('b', '資料 B'), meta('c', '去年の稟議')],
    relations: [],
  });
  sent.length = 0;
  return { root, d, sent, said, store };
}

const noop = (): void => {};
/** 打鍵を document へ流す(近道の経路)。 */
const key = (init: KeyboardEventInit & { code: string }): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
};
const dialog = (): HTMLDialogElement | null =>
  document.querySelector<HTMLDialogElement>(`[data-pkc-region="${DIALOG_REGION}"]`);
const pickRows = (): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-pkc-field="entry-pick-row"]')];
const paletteRowOf = (id: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-pkc-field="palette-row"]')].find(
    (b) => b.getAttribute('data-pkc-command') === id,
  );
const whyOf = (id: string): string =>
  paletteRowOf(id)?.querySelector('[data-pkc-field="palette-why"]')?.textContent ?? '';

beforeEach(() => {
  document.body.innerHTML = '';
  resetAppDialogForTest();
});

describe('既定の鍵(#633 段②)', () => {
  it('🔴 3 手とも Alt+Shift+<字> で、小窓(Alt+Shift+W)と同じ族に居る', () => {
    // ⚠ Alt+数字にしない ── 打鍵中に止まるうえ、面の切替(Alt+1〜6)の並びに紛れる
    expect(findCommand('stack-push')?.defaults).toEqual(['Alt+Shift+S']);
    expect(findCommand('stack-open')?.defaults).toEqual(['Alt+Shift+O']);
    expect(findCommand('stack-clear')?.defaults).toEqual(['Alt+Shift+D']);
    for (const id of ['stack-push', 'stack-open', 'stack-clear']) {
      expect(findCommand(id)?.contexts, `${id} が全域でない(パレットに出ない)`).toEqual(['global']);
    }
  });
});

describe('いま読んでいるノートをスタックに載せる(stack-push)', () => {
  it('🔴 鍵 Alt+Shift+S を押すと、選んでいるノートが PIN_SPLIT_ENTRY で載る', () => {
    const { d, sent } = setup();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'b' });
    sent.length = 0;
    key({ key: 'S', code: 'KeyS', altKey: true, shiftKey: true });
    expect(sent).toContainEqual({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    expect(d.getState().splitLids).toEqual(['b']);
  });

  it('🔴 ノートを開いていなければ、理由を言って終わる(無言にしない)/ パレットでは押せない', () => {
    const { root, d, store, said } = setup();
    expect(d.getState().selectedLid, '前提: 何も選んでいない').toBeNull();
    expect(runGlobalCommand('stack-push', root, d, store, noop, noop, true), 'dry').toBe(false);
    let prevented = 0;
    const told: string[] = [];
    expect(
      runGlobalCommand('stack-push', root, d, store, () => (prevented += 1), (t) => told.push(t)),
    ).toBe(true);
    expect(prevented, '鍵を食っていない(ブラウザに渡っている)').toBe(1);
    expect(told.join(''), '理由が出ていない').toContain('ノートがありません');
    expect(d.getState().splitLids).toEqual([]);
    expect(said, '状態の行へは binder 経由でしか出ない(ここは直呼び)').toEqual([]);
  });

  it('⚠ 対照群: 選んでいれば dry は true(パレットで押せる)', () => {
    const { root, d, store } = setup();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    expect(runGlobalCommand('stack-push', root, d, store, noop, noop, true)).toBe(true);
  });
});

describe('スタックから開く(stack-open)', () => {
  it('🔴 一覧は載せてある順(一番上から)で、選んだ物が一番上へ上がる', async () => {
    const { root, d, store, sent } = setup();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    // ⚠ 前提: いま一番上は b(でなければ「選んだ物が上がる」が空振りする)
    expect(d.getState().splitLids).toEqual(['b', 'a']);
    sent.length = 0;
    expect(runGlobalCommand('stack-open', root, d, store, noop, noop)).toBe(true);
    await tick();
    expect(dialog()?.open, '一覧の器が開いていない').toBe(true);
    expect(
      dialog()?.querySelector('[data-pkc-field="dialog-title"]')?.textContent ?? '',
      '題がリンクを入れる面のまま(押した物の名前でない)',
    ).toContain('スタックから開く');
    expect(
      pickRows().map((r) => r.getAttribute('data-pkc-lid')),
      '一覧が帯と違う並び / 載せていない物が混ざっている',
    ).toEqual(['b', 'a']);
    pickRows()[1]!.click();
    await tick();
    expect(sent).toContainEqual({ type: 'PIN_SPLIT_ENTRY', lid: 'a' });
    expect(d.getState().splitLids, '選んだ物が一番上に来ていない').toEqual(['a', 'b']);
  });

  it('🔴 鍵 Alt+Shift+O でも同じ器が開く', async () => {
    const { d } = setup();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'c' });
    key({ key: 'O', code: 'KeyO', altKey: true, shiftKey: true });
    await tick();
    expect(dialog()?.open, '鍵で開いていない').toBe(true);
    expect(pickRows().map((r) => r.getAttribute('data-pkc-lid'))).toEqual(['c']);
  });

  it('🔴 スタックが空なら、理由を言って終わる / パレットでは押せない', () => {
    const { root, d, store } = setup();
    expect(runGlobalCommand('stack-open', root, d, store, noop, noop, true), 'dry').toBe(false);
    const told: string[] = [];
    expect(runGlobalCommand('stack-open', root, d, store, noop, (t) => told.push(t))).toBe(true);
    expect(told.join(''), '理由が出ていない').toContain('載せてあるノートがありません');
    expect(dialog()?.open ?? false, '空なのに一覧を開いた').toBe(false);
  });

  /**
   * ⚠ **消えた lid だけが残っているスタックは「空」である** ── 帯と同じ口
   *   (`knownSplitLids`)で数えないと、札が 1 枚も無いのに一覧が開いて 0 行になる。
   */
  it('⚠ 消えたノートしか載っていなければ空として扱う(帯と同じ数え方)', () => {
    const { root, d, store } = setup();
    d.dispatch({ type: 'SPLIT_RESTORED', lids: ['ghost'] });
    expect(d.getState().splitLids, '前提: 復元は知らない lid を落とさない').toEqual(['ghost']);
    expect(runGlobalCommand('stack-open', root, d, store, noop, noop, true)).toBe(false);
  });
});

describe('スタックを全部降ろす(stack-clear)', () => {
  it('🔴 CLEAR_SPLIT で並びも本文も空になる(ノートは消えない)', () => {
    const d = new Dispatcher();
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('a', 'A'), meta('b', 'B')] as never,
      relations: [],
    });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    d.dispatch({ type: 'SPLIT_BODY_LOADED', lid: 'a', body: 'x' });
    d.dispatch({ type: 'CLEAR_SPLIT' });
    expect(d.getState().splitLids).toEqual([]);
    expect(d.getState().splitBodies.size).toBe(0);
    expect(d.getState().entryMetas.has('a'), 'ノートまで消している').toBe(true);
    // ⚠ 空のときは同じ state(描き直しの指紋を動かさない)
    const before = d.getState();
    d.dispatch({ type: 'CLEAR_SPLIT' });
    expect(d.getState()).toBe(before);
  });

  it('🔴 鍵 Alt+Shift+D で全部降り、何件降ろしたかを言う', () => {
    const { d, said } = setup();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'b' });
    key({ key: 'D', code: 'KeyD', altKey: true, shiftKey: true });
    expect(d.getState().splitLids).toEqual([]);
    expect(said.join(''), '何件降ろしたかが出ていない').toContain('2 件');
  });

  it('🔴 空なら理由を言って終わる / パレットでは押せない', () => {
    const { root, d, store } = setup();
    expect(runGlobalCommand('stack-clear', root, d, store, noop, noop, true)).toBe(false);
    const told: string[] = [];
    expect(runGlobalCommand('stack-clear', root, d, store, noop, (t) => told.push(t))).toBe(true);
    expect(told.join('')).toContain('載せてあるノートがありません');
  });
});

describe('操作を名前で探す(パレット)に 3 行出る', () => {
  it('🔴 3 行とも出て、空のときは「いまは押せません」の理由が付く / 載せると押せる', async () => {
    const { root, d } = setup();
    root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
    await tick();
    for (const id of ['stack-push', 'stack-open', 'stack-clear']) {
      expect(paletteRowOf(id), `${id} の行がパレットに無い`).toBeDefined();
    }
    // 何も選んでいない・何も載せていない ── 3 つとも押せない、理由は読める
    for (const id of ['stack-push', 'stack-open', 'stack-clear']) {
      expect(paletteRowOf(id)!.disabled, `${id} が押せる顔をしている`).toBe(true);
      expect(whyOf(id), `${id} の理由が無い`).toMatch(new RegExp(`^${NOT_READY_PREFIX}`));
    }
    dialog()!.close();
    await tick();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'a' });
    root.querySelector<HTMLElement>('[data-pkc-action="open-palette"]')!.click();
    await tick();
    for (const id of ['stack-push', 'stack-open', 'stack-clear']) {
      expect(paletteRowOf(id)!.disabled, `${id} が押せない顔のまま`).toBe(false);
      expect(whyOf(id), `${id} に押せない理由が残っている`).not.toContain(NOT_READY_PREFIX);
    }
  });
});
