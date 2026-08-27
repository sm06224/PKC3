/** @vitest-environment happy-dom */
/**
 * 🔴 **計っているものの帯**(#279)。
 *
 * ⚠ **対称の反対側**である(CLAUDE.md「A を直したら B はどうかを grep する」)──
 *   #280 でアラートの帯を書いたときに、**行の引き方が引用符で落ちる**ことが
 *   分かった。⚠ タイマーの帯は**同じ関数を共有している**ので、同じ穴があった。
 *   🔑 直したなら、**両側で見る**。
 */
import { describe, expect, it } from 'vitest';
import { buildShell, paintTimerBar } from '../../src/adapter/ui/render/shell';
import type { TimerRun } from '../../src/features/timer/timer-run';

const run = (lid: string, title: string, startedAtMs = 0): TimerRun => ({
  lid,
  title,
  startedAtMs,
});

function shell(): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  return root;
}

const bar = (root: HTMLElement): HTMLElement =>
  root.querySelector<HTMLElement>('[data-pkc-region="timer-bar"]')!;
const rows = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('[data-pkc-field="timer-list"] > li')];

describe('計っているものの帯(#279)', () => {
  it('🔴 計っていなければ畳まれている', () => {
    const root = shell();
    paintTimerBar(root, [], 0);
    expect(bar(root).hidden, '計っていないのに帯が出ている').toBe(true);
  });

  it('🔴 名前と経過が出て、止める / 捨てるが対で在る', () => {
    const root = shell();
    paintTimerBar(root, [run('a', '設計メモ')], 754_000);
    expect(bar(root).hidden).toBe(false);
    expect(rows(root)[0]!.textContent).toContain('設計メモ 12:34');
    // ⚠ **片道の操作を作らない**(user 指示 2026-08-23)
    expect(rows(root)[0]!.querySelector('[data-pkc-action="stop-timer"]')).not.toBeNull();
    expect(rows(root)[0]!.querySelector('[data-pkc-action="discard-timer"]')).not.toBeNull();
  });

  it('🔴 刻むたびに描き直しても、押す物は同じ node のまま', () => {
    const root = shell();
    paintTimerBar(root, [run('a', '設計メモ')], 1_000);
    const before = rows(root)[0]!.querySelector('[data-pkc-action="stop-timer"]');
    paintTimerBar(root, [run('a', '設計メモ')], 2_000);
    expect(rows(root)[0]!.textContent, '字が動いていない').toContain('0:02');
    expect(
      rows(root)[0]!.querySelector('[data-pkc-action="stop-timer"]'),
      '1 秒ごとに行を作り直している(押している最中に「止める」が消える)',
    ).toBe(before);
  });

  it('⚠ lid に引用符が入っても落ちない(取り込んだ lid は何が入っているか分からない)', () => {
    const root = shell();
    const odd = 'a"b\\c';
    expect(() => paintTimerBar(root, [run(odd, 'x')], 0), '選択子を組み立てている').not.toThrow();
    expect(rows(root)).toHaveLength(1);
  });
});
