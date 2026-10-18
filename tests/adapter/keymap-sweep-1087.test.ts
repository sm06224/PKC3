/** @vitest-environment happy-dom */
/**
 * #1087: ショートカットキーの割り当ての見直し(Tab / 変換中 / 既定の重複 / 読めない保存)。
 *
 * 守る主張:
 * 1. 割り当ての待ち受け中に素の Tab(Shift+Tab も)を押しても割り当てない ── 待ち受けを終えるだけで、Tab 本来のフォーカス移動は止めない
 * 2. 変換を確定した打鍵(`keyCode` 229、`isComposing` は false)は割り当ての材料にしない
 * 3. 前のコマンドが後のコマンドの既定のキーを先に取って、後の既定が黙って効かなくなる、を作らない
 * 4. 1 件以上在るのに 1 件も読めない保存(将来の版の修飾名など)は「割当なし」ではない ── 既定を効かせ、保存の生の値は残す
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { buildKeymapPanel } from '../../src/adapter/ui/render/keymap-panel';
import {
  KEY_COMMANDS,
  resolveBindings,
  resolveUsableBindings,
  validateBinding,
} from '../../src/features/keymap';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}
const KEY = 'pkc3.keymap';

beforeEach(() => {
  document.body.textContent = '';
});

function startCapture(id: string) {
  const st = fakeStorage();
  const store = new KeymapStore(st);
  const panel = buildKeymapPanel(store, document);
  document.body.append(panel.root);
  panel.root
    .querySelector<HTMLButtonElement>(`[data-pkc-field="keymap-assign"][data-pkc-command="${id}"]`)!
    .click();
  return { st, store, panel };
}

describe('1. 待ち受け中の素の Tab は割り当てない', () => {
  it.each([
    ['Tab', false],
    ['Shift+Tab', true],
  ])('🔴 %s: 割り当てず、待ち受けを終え、Tab の既定の動きは止めない', (_label, shiftKey) => {
    const { st, store, panel } = startCapture('deselect-entry');
    const before = store.getBindings()['deselect-entry'];
    const ev = new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', shiftKey, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented, 'Tab のフォーカス移動を止めた').toBe(false);
    expect(store.getBindings()['deselect-entry']).toEqual(before);
    expect(st.map.has(KEY), '保存に書いた').toBe(false);
    // 待ち受けは終わっている ── 次の打鍵は割り当てにならない
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', altKey: true, bubbles: true, cancelable: true }),
    );
    expect(store.getBindings()['deselect-entry']).toEqual(before);
    panel.dispose();
  });

  it('対照群: Alt が付いた Tab は、これまでどおり握って割り当てる経路を通る', () => {
    const { panel } = startCapture('deselect-entry');
    const ev = new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', altKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    panel.dispose();
  });
});

describe('2. 変換を確定した打鍵は割り当ての材料にしない', () => {
  it('🔴 keyCode 229(isComposing は false)の打鍵では、待ち受けを続ける', () => {
    const { store, panel } = startCapture('create-entry');
    const before = store.getBindings()['create-entry'];
    const ev = new KeyboardEvent('keydown', {
      key: 'm',
      code: 'KeyM',
      altKey: true,
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(store.getBindings()['create-entry']).toEqual(before);
    // 待ち受けは続いている ── 次の普通の打鍵で割り当たる
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', altKey: true, bubbles: true, cancelable: true }),
    );
    expect(store.getBindings()['create-entry']).toContain('Alt+M');
    panel.dispose();
  });
});

describe('3. 前のコマンドが後のコマンドの既定を先に取らない', () => {
  // 表の前 A と後 B で、B の既定 d が(B が上書きを持つ状態でも)A にも割り当てられる組 ── 旧実装で A が先に取れた組
  function findPair() {
    for (let i = 0; i < KEY_COMMANDS.length; i++) {
      for (let j = i + 1; j < KEY_COMMANDS.length; j++) {
        const a = KEY_COMMANDS[i]!;
        const b = KEY_COMMANDS[j]!;
        for (const d of b.defaults) {
          const cur: Record<string, readonly string[]> = {};
          for (const c of KEY_COMMANDS) cur[c.id] = c.id === b.id ? [] : c.defaults;
          if (validateBinding(a.id, d, cur) === null) return { a, b, d };
        }
      }
    }
    return null;
  }

  it('🔴 A が B の既定 d を保存に持っていても、B の既定が勝つ(d は B だけに付く)', () => {
    const pair = findPair();
    expect(pair, '検査できる組が表に無い').not.toBeNull();
    const { a, b, d } = pair!;
    const r = resolveUsableBindings({ [a.id]: [d], [b.id]: [...b.defaults] });
    expect(r.bindings[b.id], 'B 自身の既定が効いていない').toContain(d);
    expect(r.bindings[a.id], 'A が B の既定を取った(重複)').not.toContain(d);
    expect(r.unusable.map((u) => `${u.commandId}:${u.chord}`)).toContain(`${a.id}:${d}`);
  });

  it('対照群: B が上書きを持たなければ(既定のまま)従来どおり A の d は断られる', () => {
    const { a, b, d } = findPair()!;
    const r = resolveUsableBindings({ [a.id]: [d] });
    expect(r.bindings[b.id]).toEqual(b.defaults);
    expect(r.bindings[a.id]).not.toContain(d);
  });
});

describe('4. 1 件も読めない保存は「割当なし」ではない', () => {
  const cmd = KEY_COMMANDS.find((c) => c.id === 'edit-entry')!;
  it('🔴 resolveBindings: 読めない物だけの配列は既定へ。空配列は「割当なし」のまま', () => {
    expect(resolveBindings({ 'edit-entry': ['Hyper+E'] })['edit-entry']).toEqual(cmd.defaults);
    expect(resolveBindings({ 'edit-entry': [] })['edit-entry']).toEqual([]);
    expect(resolveUsableBindings({ 'edit-entry': ['Hyper+E'] }).bindings['edit-entry']).toEqual(cmd.defaults);
  });

  it('🔴 KeymapStore: 既定が効き、別のコマンドを割り当てても読めない生の値が保存に残る', () => {
    const st = fakeStorage();
    st.map.set(KEY, JSON.stringify({ 'edit-entry': ['Hyper+E'] }));
    const s = new KeymapStore(st);
    expect(s.getBindings()['edit-entry']).toEqual(cmd.defaults);
    expect(s.isDefault('edit-entry')).toBe(true);
    expect(s.addBinding('create-entry', 'Alt+M')).toBeNull();
    const saved = JSON.parse(st.map.get(KEY)!) as Record<string, unknown>;
    expect(saved['edit-entry'], '読めない生の値が保存から消えた').toEqual(['Hyper+E']);
    expect(saved['create-entry']).toEqual(['Alt+N', 'Alt+M']);
  });
});
