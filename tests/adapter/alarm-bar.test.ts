/** @vitest-environment happy-dom */
/**
 * 🔴 **鳴っている予定の帯**(#280)。
 *
 * ⚠ 見るのは **user が押す物が消えないか** ── 行を作り直す実装だと、
 *   押している最中に「開く」が指の下から消える(タイマーの帯と同じ罠)。
 */
import { describe, expect, it } from 'vitest';
import { buildShell, paintAlarmBar } from '../../src/adapter/ui/render/shell';
import type { AlarmDue } from '../../src/features/alarm/alarm-due';

const due = (key: string, time: string, text: string): AlarmDue => ({
  key,
  lid: 'a',
  line: 3,
  text,
  time,
});

function shell(): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  return root;
}

const bar = (root: HTMLElement): HTMLElement =>
  root.querySelector<HTMLElement>('[data-pkc-region="alarm-bar"]')!;
const rows = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('[data-pkc-field="alarm-list"] > li')];

describe('鳴っている予定の帯(#280)', () => {
  it('🔴 鳴っていなければ畳まれている(押せる物を置かない)', () => {
    const root = shell();
    paintAlarmBar(root, []);
    expect(bar(root).hidden, '鳴っていないのに帯が出ている').toBe(true);
    expect(rows(root)).toHaveLength(0);
  });

  it('🔴 時刻と用事が出て、開く / 閉じるが対で在る', () => {
    const root = shell();
    paintAlarmBar(root, [due('k1', '14:00', '打ち合わせ')]);
    expect(bar(root).hidden).toBe(false);
    expect(rows(root)).toHaveLength(1);
    expect(rows(root)[0]!.textContent).toContain('14:00 打ち合わせ');
    // ⚠ **片道の操作を作らない**(user 指示 2026-08-23)
    expect(rows(root)[0]!.querySelector('[data-pkc-action="open-alarm"]')).not.toBeNull();
    expect(rows(root)[0]!.querySelector('[data-pkc-action="dismiss-alarm"]')).not.toBeNull();
  });

  it('🔴 描き直しても、押す物は同じ node のまま(指の下から消えない)', () => {
    const root = shell();
    paintAlarmBar(root, [due('k1', '14:00', '打ち合わせ')]);
    const before = rows(root)[0]!.querySelector('[data-pkc-action="open-alarm"]');
    // ⚠ 2 件目が増えても、1 件目の行は**そのまま**でなければならない
    paintAlarmBar(root, [due('k1', '14:00', '打ち合わせ'), due('k2', '14:30', 'レビュー')]);
    expect(rows(root)).toHaveLength(2);
    expect(
      rows(root)[0]!.querySelector('[data-pkc-action="open-alarm"]'),
      '描き直しで行を作り直している',
    ).toBe(before);
  });

  it('🔴 片付けた行は消える(残ると「押しても消えない」に見える)', () => {
    const root = shell();
    paintAlarmBar(root, [due('k1', '14:00', 'a'), due('k2', '14:30', 'b')]);
    paintAlarmBar(root, [due('k2', '14:30', 'b')]);
    expect(rows(root).map((r) => r.getAttribute('data-pkc-alarm'))).toEqual(['k2']);
  });

  it('🔴 開く には行き先(lid)が付いている(押しても飛べない口を出さない)', () => {
    const root = shell();
    paintAlarmBar(root, [due('k1', '14:00', 'a')]);
    expect(
      rows(root)[0]!.querySelector('[data-pkc-action="open-alarm"]')!.getAttribute('data-pkc-entry'),
    ).toBe('a');
  });

  it('⚠ 鍵に引用符が入っても落ちない(取り込んだ lid は何が入っているか分からない)', () => {
    const root = shell();
    const odd = 'a"b\\c';
    expect(() => paintAlarmBar(root, [{ key: odd, lid: odd, line: 1, text: 'x', time: '09:00' }])).not.toThrow();
    expect(rows(root)).toHaveLength(1);
  });
});
