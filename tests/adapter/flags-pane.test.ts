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

/**
 * 🔴 **起動前に要る flag は、パラメータ付きで読み込み直す**
 * (user 指示 2026-08-07「フラグ画面から再起動した際にパラメータありで再起動する」)。
 *
 * ⚠ 保存だけして黙っていると、user には「押したのに何も起きない」に見える ──
 * しかも次の起動で急に挙動が変わる。**その場で読み込み直す**のが約束である。
 */
const BOOT = defineFlag('test.pane.boot', {
  default: false,
  foldWhen: 'この test が消えるとき',
  summary: '起動時に決まる見本',
  needsRestart: true,
});

describe('起動前に要るフラグ', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('⚠ 「読み込み直します」と先に伝える', () => {
    new FlagsRenderer(region, new FlagStore('')).render();
    const notes = [...region.querySelectorAll('[data-pkc-field="flag-restart"]')].map(
      (e) => e.textContent ?? '',
    );
    expect(notes.some((t) => t.includes('読み込み直します')), '再起動の予告が無い').toBe(true);
  });

  it('🔴 切り替えると、パラメータ付きの URL で読み込み直す', () => {
    const seen: string[] = [];
    const r = new FlagsRenderer(
      region,
      new FlagStore(''),
      (url) => seen.push(url),
      () => 'https://example.com/app/',
    );
    r.render();
    r.setFlag(BOOT.name, true);
    expect(seen, '読み込み直していない').toHaveLength(1);
    expect(seen[0], 'パラメータが載っていない').toContain(`pkc-flag=${BOOT.name}`);
  });

  /**
   * ⚠ **起動後に効くものは読み込み直さない** ── 無用な再読込は、書きかけを
   * 失う恐れがあるうえ「なぜ今?」が分からない。
   */
  it('⚠ 起動後に効くフラグでは読み込み直さない', () => {
    const seen: string[] = [];
    const r = new FlagsRenderer(region, new FlagStore(''), (url) => seen.push(url), () => 'https://e/');
    r.render();
    r.setFlag(A.name, true); // needsRestart なし
    expect(seen, '要らない再読込をした').toHaveLength(0);
  });

  /**
   * 🔴 **他のクエリを消さない**(パーマリンクで開いている最中でも見失わない)。
   */
  it('🔴 再起動の URL が、他のクエリを保つ', () => {
    const store = new FlagStore('');
    store.set(BOOT.name, true);
    const url = store.restartUrl('https://example.com/app/?e=abc#h');
    expect(url, 'パーマリンクのクエリが消えた').toContain('e=abc');
    expect(url, 'flag が載っていない').toContain(`pkc-flag=${BOOT.name}`);
  });

  it('⚠ 既定へ戻したら、URL からも消える', () => {
    const store = new FlagStore('');
    store.set(BOOT.name, true);
    store.set(BOOT.name, false);
    expect(store.restartUrl('https://example.com/app/')).not.toContain('pkc-flag');
  });
});
