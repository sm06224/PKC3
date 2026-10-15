/** @vitest-environment happy-dom */
/**
 * 🔴 **別のタブ・窓が編集中のノートへは、板(付箋)の書換と、表の行・列を足す口も断る**(#1087。追記と同じ門)。
 *
 * 対象(binder.ts の受け手): 板を置く(`add-place`)/ 前へ出す(`raise-place`)/ 形(`place-shape-*`)/
 * 色を外す(`place-color-clear`)/ 線の太さ(`place-line-width`)/ 矢じり(`place-line-arrow`)/
 * 文字の大きさ(`place-size`)/ グループを解く(`place-ungroup`)/ 回す(`place-rotate`)/
 * 色を選ぶ(`place-color`。窓で選び終えた時点で確かめる)/ 表の行・列を足す(`shape-cell` の足す回)。
 * 窓で選ぶ 3 つ(`place-rect` / `place-group` / `add-place-template`)は、選び終えて書く直前に同じ 1 本
 * (`placeEditedElsewhereGate`)を通す ── 受け手の全数は末尾の「全数」で数える。
 * ⚠ 通すと、編集中のタブの保存で上書きされ、書換は履歴にだけ残る。**断って理由を出し、何も撃たない**。
 * 観測点は「受け手が dispatch した action の型」と「出た断りの字」。各口に、錠が取れたとき(対照群)は撃つことを置く。
 * ⚠ 型は `rewrite-edited-elsewhere.test.ts` の台と同じ(実物の binder に錠の口を渡す)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { EDIT_ELSEWHERE_ERROR } from '../../src/features/message/caution-events';

const meta = (lid: string): never =>
  ({
    lid,
    title: lid,
    archetype: 'text',
    created_at: null,
    updated_at: null,
    entry_order: 1,
    status: null,
    date: null,
    archived: 0,
  }) as never;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

const BOARD = ':::format{#a .pkc-place x=10 y=20 w=100 h=60}\n付箋\n:::\n';
const TABLE = '| a | b |\n|---|---|\n| 1 | 2 |\n';

function rig(services: Partial<BinderServices>, body: string) {
  document.body.textContent = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const dispatched: string[] = [];
  const real = d.dispatch.bind(d);
  d.dispatch = ((a: { type: string }) => {
    dispatched.push(a.type);
    return real(a as never);
  }) as typeof d.dispatch;
  bindActions(root, d, { showStatus: () => {}, ...services });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  expect(d.getState().openBody?.lid, '台の前提: ノートを開いていない').toBe('n1');
  dispatched.length = 0;
  const press = (action: string, attrs: Record<string, string> = {}): void => {
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', action);
    for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
    root.append(b);
    b.click();
  };
  return { d, dispatched, press };
}

const denied = () => ({ acquireEditLock: vi.fn(async () => 'denied' as const), releaseEditLock: vi.fn() });
const granted = () => ({ acquireEditLock: vi.fn(async () => 'granted' as const), releaseEditLock: vi.fn() });

/** 押し方(受け手が読む属性)と、撃つ action の型。 */
const BLOCK = { 'data-pkc-menu-block': '0' };
const CASES: ReadonlyArray<{
  action: string;
  attrs: Record<string, string>;
  fires: string;
  /** 断った回の「もう一度」の字(問い合わせが落ちたとき) */
  failed: string;
}> = [
  { action: 'add-place', attrs: { 'data-pkc-menu-x': '5', 'data-pkc-menu-y': '6' }, fires: 'ADD_PLACE', failed: '板を置けませんでした' },
  { action: 'raise-place', attrs: BLOCK, fires: 'RAISE_PLACE', failed: '板を前へ出せませんでした' },
  { action: 'place-shape-diamond', attrs: BLOCK, fires: 'SET_PLACE_SHAPE', failed: '形を変えられませんでした' },
  { action: 'place-color-clear', attrs: { ...BLOCK, 'data-pkc-style-keys': 'fill stroke' }, fires: 'SET_PLACE_STYLE', failed: '色を直せませんでした' },
  { action: 'place-line-width', attrs: { ...BLOCK, 'data-pkc-style-width': '3' }, fires: 'SET_PLACE_STYLE', failed: '線の太さを直せませんでした' },
  { action: 'place-line-arrow', attrs: { ...BLOCK, 'data-pkc-style-arrow': 'end' }, fires: 'SET_PLACE_STYLE', failed: '矢じりを直せませんでした' },
  { action: 'place-size', attrs: { ...BLOCK, 'data-pkc-style-size': 'large' }, fires: 'SET_PLACE_STYLE', failed: '文字の大きさを直せませんでした' },
  { action: 'place-rotate', attrs: { ...BLOCK, 'data-pkc-style-rotate': '90' }, fires: 'SET_PLACE_STYLE', failed: '付箋を回せませんでした' },
  { action: 'place-ungroup', attrs: BLOCK, fires: 'UNGROUP_PLACE', failed: 'グループを解けませんでした' },
];

describe('板(付箋)の書換 ── 別のタブが編集中なら断る(#1087)', () => {
  it.each(CASES)('🔴 $action: 別のタブが握っていたら何も撃たず、理由を出す', async ({ action, attrs, fires }) => {
    const lock = denied();
    const t = rig(lock, BOARD);
    t.press(action, attrs);
    await flush();
    expect(lock.acquireEditLock, '問い合わせていない(門が掛かっていない)').toHaveBeenCalledWith('n1');
    expect(t.dispatched, '断られたのに書換を撃った').not.toContain(fires);
    expect(t.d.getState().error).toBe(EDIT_ELSEWHERE_ERROR);
  });

  it.each(CASES)('対照群: $action は取れたら撃つ(錠は握り続けず返す)', async ({ action, attrs, fires }) => {
    const lock = granted();
    const t = rig(lock, BOARD);
    t.press(action, attrs);
    await flush();
    expect(t.dispatched, '取れたのに撃たなかった(押しても何も起きない)').toContain(fires);
    expect(lock.releaseEditLock).toHaveBeenCalledWith('n1');
  });

  it.each(CASES)('$action: 問い合わせが落ちたら、次にすることを言って撃たない', async ({ action, attrs, fires, failed }) => {
    const t = rig(
      {
        acquireEditLock: async () => {
          throw new Error('x');
        },
        releaseEditLock: vi.fn(),
      },
      BOARD,
    );
    t.press(action, attrs);
    await flush();
    expect(t.dispatched).not.toContain(fires);
    expect(t.d.getState().error ?? '').toContain(failed);
    expect(t.d.getState().error ?? '').toContain('もう一度押してください');
  });

  it('🔴 place-color: 窓で色を選び終えた時点で確かめ、断られたら撃たない(対照群: 取れたら撃つ)', async () => {
    const pick = (): HTMLInputElement => {
      const p = document.querySelector<HTMLInputElement>('input[data-pkc-field="color-pick"]');
      expect(p, '前提: 色の窓が開いていない').not.toBeNull();
      p!.value = '#ff0000';
      p!.dispatchEvent(new Event('change', { bubbles: true }));
      return p!;
    };
    const lock = denied();
    const t = rig(lock, BOARD);
    t.press('place-color', { ...BLOCK, 'data-pkc-style-keys': 'fill' });
    pick();
    await flush();
    expect(lock.acquireEditLock).toHaveBeenCalledWith('n1');
    expect(t.dispatched, '断られたのに塗った').not.toContain('SET_PLACE_STYLE');
    expect(t.d.getState().error).toBe(EDIT_ELSEWHERE_ERROR);

    const ok = granted();
    const u = rig(ok, BOARD);
    u.press('place-color', { ...BLOCK, 'data-pkc-style-keys': 'fill' });
    pick();
    await flush();
    expect(u.dispatched).toContain('SET_PLACE_STYLE');
  });
});

describe('表の行・列を足す(shape-cell の足す回)── 別のタブが編集中なら断る(#1087)', () => {
  const attrs = (mode: 'add' | 'remove'): Record<string, string> => ({
    'data-pkc-cell-line': '2',
    'data-pkc-cell-col': '0',
    'data-pkc-cell-what': 'row',
    'data-pkc-cell-mode': mode,
  });

  it('🔑 台の前提: 押し所の属性が受け手に読まれている(取れたら足す側も消す側も撃つ)', async () => {
    for (const mode of ['add', 'remove'] as const) {
      const t = rig(granted(), TABLE);
      t.press('shape-cell', attrs(mode));
      await flush();
      expect(t.dispatched, `${mode}: 台が受け手に届いていない(この検査は空振り)`).toContain('SET_CSV_SHAPE');
    }
  });

  it.each(['add', 'remove'] as const)('🔴 %s: 別のタブが握っていたら何も撃たず、理由を出す', async (mode) => {
    const lock = denied();
    const t = rig(lock, TABLE);
    t.press('shape-cell', attrs(mode));
    await flush();
    expect(lock.acquireEditLock).toHaveBeenCalledWith('n1');
    expect(t.dispatched, '断られたのに行・列を変えた').not.toContain('SET_CSV_SHAPE');
    expect(t.d.getState().error).toBe(EDIT_ELSEWHERE_ERROR);
  });
});

describe('全数: 板の受け手は 1 本の門を通る(#1087)', () => {
  const code = readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const bodyOf = (name: string): string => {
    const i = code.indexOf(`'${name}':`);
    expect(i, `${name} の受け手が見つからない`).toBeGreaterThan(-1);
    const j = code.indexOf('\n  \'', i + 10);
    return code.slice(i, j === -1 ? undefined : j);
  };

  it.each([
    'add-place',
    'add-place-template',
    'place-rect',
    'raise-place',
    'place-color',
    'place-color-clear',
    'place-line-width',
    'place-line-arrow',
    'place-size',
    'place-group',
    'place-ungroup',
    'place-rotate',
  ])('🔴 %s は placeEditedElsewhereGate を通る', (name) => {
    expect(bodyOf(name)).toContain('placeEditedElsewhereGate(');
  });

  it('🔴 形の受け手(placeShapeHandler)も通る', () => {
    const i = code.indexOf('function placeShapeHandler');
    expect(i).toBeGreaterThan(-1);
    expect(code.slice(i, i + 900)).toContain('placeEditedElsewhereGate(');
  });

  it('⚠ ドラッグ移動・付箋 / 線を消す口は、見え方の判断待ちなので通していない(通したらこの注記を直す)', () => {
    expect(bodyOf('remove-place')).not.toContain('placeEditedElsewhereGate(');
    expect(bodyOf('remove-place-line')).not.toContain('placeEditedElsewhereGate(');
  });
});
