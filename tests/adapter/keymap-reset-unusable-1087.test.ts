/** @vitest-environment happy-dom */
/**
 * #1087 K3 / K4 / K6: ショートカットキーの設定の穴。
 *
 * 守る主張:
 * 1. (K3) 保存されているのに使っていない鍵は、その操作の行で「どの鍵が・なぜ」を言う(「割当なし」だけにしない)
 * 2. (K4) 「既定に戻す」で、別の操作が使っている既定の鍵を黙って奪わない。向こうの割当を残し、断りに操作名を出す
 * 3. (K6) 外した既定を別の並びで足し直しても、「既定のまま」(上書きを持たない)に戻る
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { buildKeymapPanel } from '../../src/adapter/ui/render/keymap-panel';
import { chordLabel, findCommand, KEY_COMMANDS } from '../../src/features/keymap';

function fakeStorage(initial?: Record<string, unknown>) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set('pkc3.keymap', JSON.stringify(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

beforeEach(() => {
  document.body.textContent = '';
});

const rowOf = (root: HTMLElement, id: string): HTMLElement =>
  root.querySelector<HTMLElement>(`[data-pkc-field="keymap-row"][data-pkc-command="${id}"]`)!;

describe('K3. 使っていない鍵を、行で言う', () => {
  it('🔴 保存されている F5 が open-today で使えないとき、その行に「F5 は使っていません」と理由が出る', () => {
    const st = fakeStorage({ 'open-today': ['F5'] });
    const k = new KeymapStore(st);
    const unusable = k.getUnusable().find((u) => u.commandId === 'open-today');
    expect(unusable, '前提: F5 が使えない鍵として拾われていない').toBeDefined();
    const p = buildKeymapPanel(k, document);
    document.body.append(p.root);
    const line = rowOf(p.root, 'open-today').querySelector<HTMLElement>('[data-pkc-field="keymap-unusable"]')!;
    expect(line.textContent).toContain(chordLabel('F5'));
    expect(line.textContent, '理由(割り当てるときの断り文)が付いていない').toContain(unusable!.problem.message);
    expect(line.hidden).toBe(false);
    // 対照群: 使えない鍵の無い行には出ない
    const other = rowOf(p.root, 'open-help').querySelector<HTMLElement>('[data-pkc-field="keymap-unusable"]')!;
    expect(other.textContent).toBe('');
    expect(other.hidden).toBe(true);
    p.dispose();
  });
});

describe('K4. 「既定に戻す」が他の操作の割当を奪わない', () => {
  function rig() {
    const st = fakeStorage();
    const k = new KeymapStore(st);
    // open-palette の既定 Mod+Shift+P を外して open-today に渡す
    k.removeBinding('open-palette', 'Mod+Shift+P');
    expect(k.addBinding('open-today', 'Mod+Shift+P')).toBeNull();
    return { st, k };
  }

  it('🔴 戻しても open-today の割当は残り、open-palette には Mod+Shift+P を戻さない', () => {
    const { k, st } = rig();
    k.resetCommand('open-palette');
    const b = k.getBindings();
    expect(b['open-today'], '向こうの割当が奪われた').toContain('Mod+Shift+P');
    expect(b['open-palette'], '同じ鍵が 2 つの操作に付いた').not.toContain('Mod+Shift+P');
    // 再読み込みしても向こうは使えるまま
    const k2 = new KeymapStore(st);
    expect(k2.getBindings()['open-today']).toContain('Mod+Shift+P');
    expect(k2.getUnusable().filter((u) => u.commandId === 'open-today')).toEqual([]);
  });

  it('🔴 画面の「割り当てを既定に戻す」は、戻していない鍵と持っている操作の名前を言う', () => {
    const { k } = rig();
    const p = buildKeymapPanel(k, document);
    document.body.append(p.root);
    const row = rowOf(p.root, 'open-palette');
    row.querySelector<HTMLButtonElement>('[data-pkc-field="keymap-reset"]')!.click();
    const note = row.querySelector<HTMLElement>('[data-pkc-field="settings-note"]')!.textContent ?? '';
    expect(note).toContain(chordLabel('Mod+Shift+P'));
    expect(note, '持っている操作の名前が出ていない').toContain(findCommand('open-today')!.label);
    p.dispose();
  });

  it('対照群: 誰も使っていない既定なら、そのまま全部戻る(上書きが消える)', () => {
    const st = fakeStorage();
    const k = new KeymapStore(st);
    k.removeBinding('open-palette', 'Mod+Shift+P');
    expect(k.resetConflicts('open-palette')).toEqual([]);
    k.resetCommand('open-palette');
    expect(k.getBindings()['open-palette']).toContain('Mod+Shift+P');
    expect(k.isDefault('open-palette')).toBe(true);
  });
});

describe('K6. 外した既定を足し直したら「既定のまま」', () => {
  it('🔴 2 つ目の既定を持つ操作で、先頭を外して足し直す(並びが入れ替わる)と isDefault', () => {
    const multi = KEY_COMMANDS.find((c) => c.defaults.length >= 2 && c.defaults[0] === 'Alt+1');
    expect(multi, '前提: 既定が 2 つ以上ある操作が無い').toBeDefined();
    const st = fakeStorage();
    const k = new KeymapStore(st);
    const first = multi!.defaults[0]!;
    k.removeBinding(multi!.id, first);
    expect(k.addBinding(multi!.id, first)).toBeNull();
    expect(k.isDefault(multi!.id), '並びが違うだけで既定でなくなっている').toBe(true);
    expect(k.getBindings()[multi!.id]).toEqual(multi!.defaults); // 説明に出る第 1 割当は既定の並び
  });
});
