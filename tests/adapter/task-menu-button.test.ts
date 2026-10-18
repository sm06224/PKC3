/** @vitest-environment happy-dom */
/**
 * 🔴 **予定の札の「⋯」と、スマホの長押し**(台帳 #1852 束 S1、依頼 128-2 A)。
 *
 * 画面の起きること: Android で予定を長押しすると、行のメニューが開くのと同時にドラッグが始まり、
 * 「メニューが開いて一覧が押せないまま、ドラッグした予定をどこへも置けない」状態になっていた。
 * 長押しは**ドラッグだけ**にして、予定のメニューは札の「⋯」から開く。
 *
 * ## 守る主張
 * 1. 札に「⋯」が在り、押すと右クリックと同じメニュー(「繰り返す…」を含む)が開く(押しても何も出ない dead click にしない)
 * 2. 指の長押し(`pointerType: 'touch'` の contextmenu)ではメニューを出さない。マウスの右クリックは従来どおり出す(対照群)
 * 3. 「⋯」の無い面(週・月の升)では、従来どおり長押しでメニューが出る(メニューへ入る道を消さない)
 * 4. 「⋯」は掴みの対象にならない(押してもドラッグが始まらない)
 *
 * ⚠ 実機の Android で長押しの `contextmenu` が `pointerType: 'touch'` で来ることは、ここでは確かめていない
 *   (依頼文の約束どおり、入れる前に cowork の Android 実機で確かめる)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { createTaskCard, patchTaskCard } from '../../src/adapter/ui/render/task-card';
import { itemOfCard } from '../../src/features/schedule/agenda';
import { taskCardsOf } from '../../src/features/schedule/task-cards';

const MENU = '[data-pkc-region="context-menu"]';
const BODY = '- [ ] 会議 @2026-10-20 毎週\n';

function metasOf(lids: readonly string[]): AppState['entryMetas'] {
  const m = new Map<string, AppState['entryMetas'] extends Map<string, infer V> ? V : never>();
  for (const [i, lid] of lids.entries()) {
    m.set(lid, {
      lid,
      title: lid,
      archetype: 'text',
      createdAt: null,
      updatedAt: null,
      entryOrder: i + 1,
      status: null,
      date: null,
      archived: false,
    } as never);
  }
  return m as AppState['entryMetas'];
}

/** 札を `container`(既定は一覧の器)の中に置いた面を組む。 */
function setup(containerAttr: string = 'data-pkc-region="schedule-cards"') {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  root.innerHTML = `<div data-pkc-region="schedule"><div ${containerAttr}></div></div>`;
  document.body.append(root);
  const box = root.querySelector<HTMLElement>(`[${containerAttr}]`)!;
  const c = taskCardsOf('n1', BODY)[0]!;
  const card = createTaskCard(itemOfCard(c));
  patchTaskCard(card, itemOfCard(c), 'n1', 2026, false);
  box.append(card);
  const d = new Dispatcher({
    ...initialState,
    cid: 'c1',
    phase: 'ready',
    selectedLid: 'n1',
    entryMetas: metasOf(['n1']),
    openBody: { lid: 'n1', body: BODY, baseline: BODY, persisted: BODY, diskAhead: false },
  });
  const unbind = bindActions(root, d, {});
  const contextmenu = (pointerType: string | null): void => {
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    if (pointerType !== null) Object.defineProperty(e, 'pointerType', { value: pointerType });
    card.dispatchEvent(e);
  };
  const menuLabels = (): string[] =>
    [...root.querySelectorAll(`${MENU} button[data-pkc-action]`)].map((b) => b.textContent ?? '');
  return { root, card, d, unbind, contextmenu, menuLabels };
}

describe('予定の札の「⋯」(依頼 128-2 A)', () => {
  it('🔴 札に「⋯」が在り、名前(aria-label)が付いている', () => {
    const s = setup();
    const b = s.card.querySelector<HTMLElement>('[data-pkc-field="task-menu"]');
    expect(b, '「⋯」が札に無い').not.toBeNull();
    expect(b!.getAttribute('data-pkc-action')).toBe('open-task-menu');
    expect(b!.getAttribute('aria-label'), 'スクリーンリーダー向けの名前が無い').toBe('この予定のメニューを開く');
    expect(b!.textContent, '絵は CSS の ::before ── 字を持たない').toBe('');
    s.unbind();
  });

  it('🔴 「⋯」を押すとメニューが開き、「繰り返す…」を含む(開いた直後に閉じない)', () => {
    const s = setup();
    s.card.querySelector<HTMLElement>('[data-pkc-field="task-menu"]')!.click();
    const labels = s.menuLabels();
    expect(labels.length, '押してもメニューが出ない(dead click)').toBeGreaterThan(0);
    expect(labels.some((l) => l.includes('繰り返')), '予定の札のメニュー(繰り返す…)が出ていない').toBe(true);
    s.unbind();
  });

  it('🔴 指の長押し(touch の contextmenu)ではメニューを出さず、ブラウザ既定も止める', () => {
    const s = setup();
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    Object.defineProperty(e, 'pointerType', { value: 'touch' });
    s.card.dispatchEvent(e);
    expect(s.menuLabels(), '指の長押しでメニューが出た(ドラッグと同時に始まる)').toEqual([]);
    expect(e.defaultPrevented, 'ブラウザ既定のメニューを残している').toBe(true);
    s.unbind();
  });

  it('対照群: マウスの右クリックは従来どおりメニューを出す', () => {
    const s = setup();
    s.contextmenu('mouse');
    expect(s.menuLabels().length, 'マウスの右クリックまで止めている').toBeGreaterThan(0);
    s.unbind();
  });

  it('対照群: 「⋯」を押した直後の指の長押し抑止は残らない(印は同期の 1 回だけ)', () => {
    const s = setup();
    s.card.querySelector<HTMLElement>('[data-pkc-field="task-menu"]')!.click();
    document.querySelector(MENU)?.remove();
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    Object.defineProperty(e, 'pointerType', { value: 'touch' });
    s.card.dispatchEvent(e);
    expect(s.menuLabels(), '印が立ったまま残っている(以後の長押しが止まらない)').toEqual([]);
    s.unbind();
  });

  it('🔴 「⋯」の無い面(週の升)では、指の長押しでも従来どおりメニューが出る(入る道を消さない)', () => {
    const s = setup('data-pkc-field="schedule-weekview-lane"');
    s.contextmenu('touch');
    expect(s.menuLabels().length, '週の升のメニューへ入る道が無くなった').toBeGreaterThan(0);
    s.unbind();
  });
});

describe('「⋯」は掴みの対象にならない', () => {
  it('🔴 2 つの掴み(HTML5 の落とし・目盛りの引き)とも、「⋯」を除外している', () => {
    for (const f of ['schedule-drag.ts', 'schedule-grid-drag.ts']) {
      const src = readFileSync(`src/adapter/ui/render/${f}`, 'utf8');
      const sel = /const NO_GRAB_SELECTOR =\s*([^;]+);/.exec(src);
      expect(sel, `${f}: 除外の一覧が読めない`).not.toBeNull();
      expect(sel![1], `${f}: 「⋯」を押してもドラッグが始まる`).toContain('task-menu');
    }
  });
});
