/** @vitest-environment happy-dom */
/**
 * 🔴 **フラグの面**(P11。user 指示 2026-08-07「設定とフラグは別々で見えるように」)。
 *
 * ## この test が守るもの
 *
 * - **設定とは別の面**であること(裁定 Q3)── 同じ画面の節に戻ったら落ちる
 * - **畳む条件が画面に出る**こと ── flag の約束は「いつ消えるか隠さない」
 * - **URL で上書き中は触らせない**(押しても変わらない = 無言の操作拒否を作らない)
 * - 🔴 **器を捨てない** ── この repo が 3 度踏んだ罠(情報ペイン / ファイラ /
 *   本文の面)。押される寸前のボタンが別 node になると binder が黙って捨てる
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { FlagsRenderer } from '../../src/adapter/ui/render/flags';
import { FlagStore } from '../../src/adapter/platform/flag-store';
import { defineFlag, FLAG_BUDGET } from '../../src/features/flags';

// ⚠ この test 専用の宣言(`src` の予算には数えられない)
const A = defineFlag('test.pane.a', {
  default: false,
  foldWhen: 'この test が消えるとき',
  summary: '見本の切替 A',
});

let region: HTMLElement;
beforeEach(() => {
  localStorage.clear();
  document.body.textContent = '';
  region = document.createElement('div');
  document.body.append(region);
});

describe('フラグの面', () => {
  it('題名と、設定との違いの説明が出る', () => {
    new FlagsRenderer(region, new FlagStore('')).render();
    expect(region.querySelector('[data-pkc-field="pane-title"]')?.textContent).toBe('フラグ');
    const note = region.querySelector('[data-pkc-field="flags-note"]')?.textContent ?? '';
    // ⚠ 「開発者向け」だけだと、パワーユーザーが自分は対象外だと思う
    expect(note, '「いつか畳まれる」ことが書かれていない').toContain('畳まれます');
  });

  it('🔴 宣言した flag が一覧に出て、畳む条件も出る', () => {
    new FlagsRenderer(region, new FlagStore('')).render();
    const row = region.querySelector(`[data-pkc-flag="${A.name}"]`);
    expect(row, 'flag が一覧に出ていない').not.toBeNull();
    const folds = [...region.querySelectorAll('[data-pkc-field="flag-fold"]')].map(
      (e) => e.textContent ?? '',
    );
    // 🔑 「いつ消えるか」を隠さないのが flag の約束
    expect(folds.some((t) => t.includes(A.foldWhen)), '畳む条件が画面に出ていない').toBe(true);
  });

  it('⚠ 予算の残りが出る(15 枠のうち何個使ったか)', () => {
    new FlagsRenderer(region, new FlagStore('')).render();
    const sum = region.querySelector('[data-pkc-field="flags-summary"]')?.textContent ?? '';
    expect(sum, '予算が出ていない').toContain(`/ ${FLAG_BUDGET} 枠`);
  });

  it('切り替えると保存され、画面にも映る', () => {
    const store = new FlagStore('');
    const r = new FlagsRenderer(region, store);
    r.render();
    const box = region.querySelector<HTMLInputElement>(`[data-pkc-flag="${A.name}"]`)!;
    expect(box.checked).toBe(false);
    r.setFlag(A.name, true);
    expect(box.checked, '画面に映っていない').toBe(true);
    expect(new FlagStore('').isOn(A.name), '保存されていない').toBe(true);
  });

  it('🔴 すべて既定へ戻すと、保存も画面も戻る', () => {
    const store = new FlagStore('');
    const r = new FlagsRenderer(region, store);
    r.render();
    r.setFlag(A.name, true);
    r.resetFlags();
    expect(region.querySelector<HTMLInputElement>(`[data-pkc-flag="${A.name}"]`)!.checked).toBe(
      false,
    );
    expect(localStorage.getItem('pkc3.flags'), '保存が残っている').toBeNull();
  });

  /**
   * 🔴 **URL で上書き中は触らせない。**
   * ⚠ 触れてしまうと「押したのに変わらない」= 無言の操作拒否になる。
   *   押せない理由は `title` に出す。
   */
  it('🔴 URL で上書き中の flag は押せず、理由が出る', () => {
    const r = new FlagsRenderer(region, new FlagStore(`?pkc-flag=${A.name}`));
    r.render();
    const box = region.querySelector<HTMLInputElement>(`[data-pkc-flag="${A.name}"]`)!;
    expect(box.checked, 'URL の値が映っていない').toBe(true);
    expect(box.disabled, 'URL 上書き中なのに押せる').toBe(true);
    expect(box.title, '押せない理由が書かれていない').not.toBe('');
  });

  /**
   * 🔴 **器を捨てない**(この repo が 3 度踏んだ罠)。
   * ⚠ 再描画のたびに node が変わると、binder は `root.contains` を通らない
   *   target を黙って捨てる = 押した瞬間に消えたボタンは効かない。
   */
  it('🔴 何度描き直しても、切替とボタンは同じ node', () => {
    const r = new FlagsRenderer(region, new FlagStore(''));
    r.render();
    const box = region.querySelector(`[data-pkc-flag="${A.name}"]`);
    const reset = region.querySelector('[data-pkc-action="reset-flags"]');
    expect(box).not.toBeNull();
    expect(reset).not.toBeNull();
    r.render();
    r.render();
    expect(region.querySelector(`[data-pkc-flag="${A.name}"]`), '切替が差し替わった').toBe(box);
    expect(region.querySelector('[data-pkc-action="reset-flags"]'), 'ボタンが差し替わった').toBe(
      reset,
    );
  });

  /**
   * ⚠ **畳まない**(user 指示「主要な導線を畳まない」)。
   * `docs-parity` は shell だけを見ているので、この面は自分で見る。
   */
  it('⚠ フラグの面は `<details>` で畳まれていない', () => {
    new FlagsRenderer(region, new FlagStore('')).render();
    expect(region.querySelectorAll('details')).toHaveLength(0);
  });
});
