/** @vitest-environment happy-dom */
/**
 * #1087 キーボードだけで使うときの取りこぼし(3 つ)。
 *
 * 1. 2 ペインの表を組み直したあとも、焦点が行に残る(<body> へ落ちると矢印・Delete・F 系が死ぬ)
 * 2. 確認の小窓の入力欄で、変換を確定する Enter(Safari は `isComposing=false` + keyCode 229)で決めてしまわない
 * 3. 右クリックのメニューは、Tab で焦点が外へ出たら閉じる(Esc の挙動はそのまま)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { DualFilerRenderer } from '../../src/adapter/ui/render/dual-filer';
import {
  pickCommandInApp,
  pickEntryInApp,
  pickPlaceGroupInApp,
  pickPlaceRectInApp,
  promptInApp,
  resetAppDialogForTest,
} from '../../src/adapter/ui/render/app-dialog';
import {
  closeContextMenu,
  contextMenuOpen,
  openContextMenu,
} from '../../src/adapter/ui/render/context-menu';

function meta(lid: string, order: number, title: string): EntryMeta {
  return {
    lid, title, archetype: 'text', createdAt: null, updatedAt: null, entryOrder: order,
    status: null, date: null, archived: false, bodyChars: null,
  };
}
const METAS = [meta('a', 1, 'あ'), meta('b', 2, 'い'), meta('c', 3, 'う')];

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

describe('① 2 ペインの再描画で焦点を戻す', () => {
  let region: HTMLElement;
  let r: DualFilerRenderer;
  let s: AppState;
  const left = (sel: string): HTMLElement | null =>
    region.querySelector<HTMLElement>(
      `[data-pkc-region="dual-pane"][data-pkc-side="left"]${sel === '' ? '' : ` ${sel}`}`,
    );

  beforeEach(() => {
    document.body.innerHTML = '';
    region = document.createElement('div');
    document.body.append(region);
    r = new DualFilerRenderer(region);
    s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] }).state;
    s = reduce(s, { type: 'DUAL_SELECT', side: 'left', lid: 'b', mode: 'set' }).state;
    r.render(s);
  });

  /** 題名を変えて、表を組み直させる(指紋に題名が入っている)。 */
  const rebuild = (): void => {
    const metas = new Map(s.entryMetas);
    metas.set('c', meta('c', 3, 'う(改名)'));
    s = { ...s, entryMetas: metas };
    r.render(s);
  };

  it('🔴 行に焦点があるまま組み直しても、同じ lid の新しい行に焦点が戻る', () => {
    const before = left('tbody tr[data-pkc-entry="c"]')!;
    before.focus();
    expect(document.activeElement, '前提: 行に焦点がある').toBe(before);
    rebuild();
    const after = left('tbody tr[data-pkc-entry="c"]')!;
    expect(after, '前提: 行が作り直されている').not.toBe(before);
    expect(after.textContent, '前提: 組み直しが起きた').toContain('う(改名)');
    expect(document.activeElement, '焦点が新しい同じ行に戻っていない').toBe(after);
  });

  it('🔴 行が消えたときは、焦点を <body> へ落とさず、ペインの中に置く', () => {
    left('tbody tr[data-pkc-entry="c"]')!.focus();
    const metas = new Map(s.entryMetas);
    metas.delete('c');
    s = { ...s, entryMetas: metas };
    r.render(s);
    expect(left('tbody tr[data-pkc-entry="c"]'), '前提: c の行が消えている').toBeNull();
    const active = document.activeElement as HTMLElement;
    expect(active, '焦点が <body> へ落ちた').not.toBe(document.body);
    expect(left('')!.contains(active), '焦点がペインの中に無い').toBe(true);
  });

  it('🔴 表の外に焦点があるときは奪わない(対照群)', () => {
    const outside = document.createElement('input');
    document.body.append(outside);
    outside.focus();
    rebuild();
    expect(left('tbody tr[data-pkc-entry="c"]')!.textContent, '前提: 組み直しが起きた').toContain('う(改名)');
    expect(document.activeElement, '表の外の焦点を奪った').toBe(outside);
  });
});

describe('② 確認の小窓: 変換確定の Enter(keyCode 229)で決めない', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetAppDialogForTest();
  });

  const imeEnter = (): KeyboardEvent => {
    const ev = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true });
    // 前提: happy-dom が keyCode を持たせない版でも、Safari の形(isComposing=false, 229)を作る
    if (ev.keyCode !== 229) Object.defineProperty(ev, 'keyCode', { value: 229 });
    expect(ev.isComposing, '前提: Safari の形(isComposing=false)').toBe(false);
    expect(ev.keyCode, '前提: keyCode 229').toBe(229);
    return ev;
  };
  const plainEnter = (): KeyboardEvent =>
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  const track = <T>(p: Promise<T>): { done: () => boolean; value: () => Promise<T> } => {
    let done = false;
    void p.then(() => {
      done = true;
    });
    return { done: () => done, value: () => p };
  };
  const host = (): HTMLElement => {
    const h = document.createElement('div');
    document.body.append(h);
    return h;
  };
  const q = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

  it('🔴 promptInApp', async () => {
    const t = track(promptInApp(host(), { title: 't', label: 'l', initial: 'x' }));
    const input = q<HTMLInputElement>('[data-pkc-field="prompt-input"]');
    input.dispatchEvent(imeEnter());
    await settle();
    expect(t.done(), '変換確定の Enter で決まってしまった').toBe(false);
    input.dispatchEvent(plainEnter());
    await settle();
    expect(t.done(), '対照群: 普通の Enter で決まらない(台の空振り)').toBe(true);
    expect(await t.value()).toBe('x');
  });

  it('🔴 pickPlaceRectInApp', async () => {
    const t = track(pickPlaceRectInApp(host(), { x: '1', y: '2', w: '3', h: '4' }));
    const input = q<HTMLInputElement>('[data-pkc-field="place-rect-input"]');
    input.dispatchEvent(imeEnter());
    await settle();
    expect(t.done(), '変換確定の Enter で決まってしまった').toBe(false);
    input.dispatchEvent(plainEnter());
    await settle();
    expect(t.done(), '対照群: 普通の Enter で決まらない').toBe(true);
  });

  it('🔴 pickPlaceGroupInApp', async () => {
    const t = track(
      pickPlaceGroupInApp(host(), [{ line: 1, label: 'あ' }, { line: 2, label: 'い' }] as never, 1),
    );
    const boxes = [...document.querySelectorAll<HTMLInputElement>('[data-pkc-field="place-group-check"]')];
    boxes[1]!.checked = true;
    boxes[0]!.dispatchEvent(imeEnter());
    await settle();
    expect(t.done(), '変換確定の Enter で決まってしまった').toBe(false);
    boxes[0]!.dispatchEvent(plainEnter());
    await settle();
    expect(t.done(), '対照群: 普通の Enter で決まらない').toBe(true);
  });

  it('🔴 pickCommandInApp', async () => {
    const row = { id: 'x', label: 'えっくす', keys: [], ready: true, why: '' };
    const t = track(pickCommandInApp(host(), () => [row] as never));
    const input = q<HTMLInputElement>('[data-pkc-field="palette-filter"]');
    input.dispatchEvent(imeEnter());
    await settle();
    expect(t.done(), '変換確定の Enter で実行してしまった').toBe(false);
    input.dispatchEvent(plainEnter());
    await settle();
    expect(t.done(), '対照群: 普通の Enter で実行されない').toBe(true);
    expect(await t.value()).toBe('x');
  });

  it('🔴 pickEntryInApp', async () => {
    const t = track(
      pickEntryInApp(host(), () => ({ items: [{ lid: 'n1', title: 'ノート', kind: 'ノート' }], note: '' })),
    );
    const input = q<HTMLInputElement>('[data-pkc-field="entry-pick-filter"]');
    input.dispatchEvent(imeEnter());
    await settle();
    expect(t.done(), '変換確定の Enter で選んでしまった').toBe(false);
    input.dispatchEvent(plainEnter());
    await settle();
    expect(t.done(), '対照群: 普通の Enter で選ばれない').toBe(true);
    expect(await t.value()).toBe('n1');
  });
});

describe('③ 右クリックのメニュー: 焦点が外へ出たら閉じる', () => {
  let root: HTMLElement;
  let outside: HTMLButtonElement;
  beforeEach(() => {
    document.body.innerHTML = '';
    root = document.createElement('div');
    outside = document.createElement('button');
    document.body.append(root, outside);
  });
  const open = (): ReturnType<typeof openContextMenu> =>
    openContextMenu(
      root,
      { x: 0, y: 0 },
      [{ action: 'a', label: 'あ' }, { action: 'b', label: 'い' }],
      outside,
    );

  it('🔴 最後の項目から外へ焦点が出たら閉じ、出た先の焦点は奪わない', () => {
    open();
    const items = root.querySelectorAll<HTMLElement>('button[data-pkc-action]');
    items[1]!.focus();
    expect(contextMenuOpen(root), '前提: 開いている').toBe(true);
    outside.focus(); // Tab で抜けた形
    expect(contextMenuOpen(root), '外へ出たのに開いたまま').toBe(false);
    expect(document.activeElement, '行き先の焦点を奪い返した').toBe(outside);
  });

  it('対照群: メニューの中での焦点の移動では閉じない / 閉じる口は今までどおり焦点を返す', () => {
    open();
    const items = root.querySelectorAll<HTMLElement>('button[data-pkc-action]');
    items[0]!.focus();
    items[1]!.focus();
    expect(contextMenuOpen(root), '中での移動で閉じた').toBe(true);
    closeContextMenu(root);
    expect(contextMenuOpen(root)).toBe(false);
    expect(document.activeElement, '閉じたら開く前の所へ焦点が戻る').toBe(outside);
  });
});
