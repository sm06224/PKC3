/** @vitest-environment happy-dom */
/**
 * 打つ欄の Esc(#274 レビュー ── 裁定: シェルの入力欄にフォーカスがあるときの Esc は、シェルが必ず受け止める)。
 *
 * 3 段: ①一覧が開いていれば一覧だけ閉じる ②入力が残っていれば空にする ③空ならフォーカスを外すだけ。
 * どの段も `preventDefault` + `stopPropagation` ── 全域の Esc(読んでいるノートを閉じる)へ届かせない。
 */
import { describe, expect, it, vi } from 'vitest';
import { handleShellKeydown } from '../../src/adapter/ui/actions/shell-input';
import { ShellSession, buildShellPrompt, paintCompletion } from '../../src/adapter/ui/render/cmdshell';
import { ShellHistoryStore } from '../../src/adapter/ui/render/shell-history-store';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

function setup() {
  const region = buildShellPrompt('shell');
  document.body.append(region);
  const input = region.querySelector<HTMLInputElement>('[data-pkc-field="shell-input"]')!;
  const host = region.querySelector<HTMLElement>('[data-pkc-region="shell-complete"]')!;
  const session = new ShellSession('shell', new ShellHistoryStore(memoryStorage()));
  input.focus();
  const esc = (): { result: ReturnType<typeof handleShellKeydown>; ev: KeyboardEvent; stop: ReturnType<typeof vi.fn> } => {
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const stop = vi.fn();
    ev.stopPropagation = stop as never;
    const result = handleShellKeydown(ev, input, session, () => ({ from: 0, to: 0, items: [] }));
    return { result, ev, stop };
  };
  return { region, input, host, session, esc };
}

describe('Esc の 3 段', () => {
  it('①一覧が開いていれば一覧だけを閉じる(入力はそのまま・フォーカスも入力欄のまま)', () => {
    const s = setup();
    s.input.value = 'mv 資';
    paintCompletion(s.host, { from: 0, to: 0, items: [{ insert: 'x', label: 'x', hint: '' }] });
    expect(s.host.hidden).toBe(false);
    const r = s.esc();
    expect(r.result).toBe('handled');
    expect(r.ev.defaultPrevented).toBe(true);
    expect(r.stop).toHaveBeenCalled();
    expect(s.host.hidden).toBe(true);
    expect(s.input.value).toBe('mv 資');
    expect(document.activeElement).toBe(s.input);
  });

  it('②入力が残っていれば空にする(フォーカスは入力欄のまま)', () => {
    const s = setup();
    s.input.value = 'ls';
    const r = s.esc();
    expect(r.result).toBe('handled');
    expect(r.ev.defaultPrevented).toBe(true);
    expect(r.stop).toHaveBeenCalled();
    expect(s.input.value).toBe('');
    expect(document.activeElement).toBe(s.input);
  });

  it('③空ならフォーカスを外すだけ。それでも全域の Esc へは流さない', () => {
    const s = setup();
    s.input.value = '';
    const r = s.esc();
    expect(r.result).toBe('handled');
    expect(r.ev.defaultPrevented).toBe(true);
    expect(r.stop).toHaveBeenCalled();
    expect(document.activeElement).not.toBe(s.input);
  });

  it('対照群: Ctrl を押しながらの Esc は握らない', () => {
    const s = setup();
    const ev = new KeyboardEvent('keydown', { key: 'Escape', ctrlKey: true, bubbles: true, cancelable: true });
    expect(handleShellKeydown(ev, s.input, s.session, () => ({ from: 0, to: 0, items: [] }))).toBeNull();
    expect(ev.defaultPrevented).toBe(false);
  });
});
