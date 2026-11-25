/** @vitest-environment happy-dom */
/**
 * 🔴 **帯の「書き出す ▾」「その他 ▾」(1 段奥のメニュー)と、5 つの画面の並び**(#1442 S3-2。user 指示 2026-11-24)。
 *
 * SQL 画面(段②)と同じ方針 ── 常用は帯に出し、たまにしか使わない操作は「その他 ▾」の 1 段奥へ、主は 1 画面に 1 つ ──
 * を、集計・差分マージ・計算・テキスト整形・2 ペイン(`dual-filer.test.ts` が見る)へ広げた。
 *
 * ## 守る主張
 * 1. メニューは**押したら閉じる / 外を押したら閉じる / `Esc` で閉じて焦点を戻す(背後へ流さない)** ── native が持っていた性質を落とさない
 * 2. 各画面の**押し口(`data-pkc-action`)は 1 つも消えていない**(奥へ移しただけ)・**主は 1 つ以下**・消す操作は**危険**の型
 * 3. ⚠ 空振り防止: 奥へ回した口が**メニューの中**に居て、帯の直下には**居ない**(対照群 = 出している物は直下に居る)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { makeBarMenu, makeBarSpacer } from '../../src/adapter/ui/render/bar-menu';
import { QueryRenderer } from '../../src/adapter/ui/render/query';
import { DiffMergeRenderer } from '../../src/adapter/ui/render/diffmerge';
import { CalcRenderer } from '../../src/adapter/ui/render/calc';
import { TextLabRenderer } from '../../src/adapter/ui/render/textlab';

beforeEach(() => {
  document.body.textContent = '';
  vi.useRealTimers();
});

/** 起動直後の本物の state(作り物の `as never` にしない ── 各画面が読む欄が揃っている)。 */
function booted() {
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  return d.getState();
}

function btn(action: string, label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('data-pkc-action', action);
  b.textContent = label;
  return b;
}

describe('① makeBarMenu の振る舞い(native `<details>` + 足した 3 つ)', () => {
  it('🔴 項目は元の action のまま入り、押すと次のイベントで閉じる(同じ押しで開く物が位置を読める)', async () => {
    const a = btn('x-a', 'あ');
    const d = makeBarMenu('t-menu', 'その他', 'ヒント', [a]);
    document.body.append(d);
    expect(d.querySelector('summary')?.textContent).toBe('その他');
    expect(d.querySelector('[data-pkc-bar-menu-list] [data-pkc-action="x-a"]')).toBe(a);
    d.open = true;
    a.click();
    // ⚠ 押した瞬間は閉じない(`setTimeout 0` ── 同じ押しで開く別の一覧が、押した項目の位置を読む)
    expect(d.open, '押した瞬間に閉じている').toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(d.open, '押したのに閉じない').toBe(false);
  });

  it('🔴 keepOpenActions の項目は押しても開いたまま(別の一覧の錨)/ 対照群の項目は閉じる', async () => {
    const keep = btn('x-keep', '形');
    const other = btn('x-other', '他');
    const d = makeBarMenu('t-menu', '書き出す', 'h', [keep, other], { keepOpenActions: ['x-keep'] });
    document.body.append(d);
    d.open = true;
    keep.click();
    await new Promise((r) => setTimeout(r, 5));
    expect(d.open, '錨の項目で閉じている').toBe(true);
    other.click();
    await new Promise((r) => setTimeout(r, 5));
    expect(d.open, '対照群の項目で閉じない').toBe(false);
  });

  it('🔴 外を押すと閉じる(中を押しても閉じない)/ 聞き手は文書に 1 本だけ / 作り直した器の分は溜まらない', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const d1 = makeBarMenu('m1', 'その他', 'h', [btn('x-1', '1')]);
    const d2 = makeBarMenu('m2', 'その他', 'h', [btn('x-2', '2')]);
    // 2 つ作っても、pointerdown の聞き手を増やさない(最初の 1 本は別の test で張り済みでもよい ── 増えないことを見る)
    expect(add.mock.calls.filter((c) => c[0] === 'pointerdown').length, '聞き手が作るたびに増える').toBeLessThanOrEqual(1);
    add.mockRestore();
    document.body.append(d1, d2);
    d1.open = true;
    d2.open = true;
    d1.querySelector('summary')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(d1.open, '中を押して閉じた').toBe(true);
    expect(d2.open, '外を押したのに閉じない').toBe(false);
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(d1.open).toBe(false);
    // 器ごと捨てた物は引かれない(外れた details に触れず、落ちもしない)
    const gone = makeBarMenu('m3', 'その他', 'h', [btn('x-3', '3')]);
    gone.open = true;
    expect(() => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))).not.toThrow();
  });

  it('🔴 Esc で閉じて焦点を「その他 ▾」へ戻す。⚠ 背後へ流さない(ノート選択解除などを巻き込まない)', () => {
    const d = makeBarMenu('t-menu', 'その他', 'h', [btn('x-a', 'あ')]);
    const outer = vi.fn();
    const wrap = document.createElement('div');
    wrap.addEventListener('keydown', outer);
    wrap.append(d);
    document.body.append(wrap);
    d.open = true;
    d.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(d.open).toBe(false);
    expect(document.activeElement).toBe(d.querySelector('summary'));
    expect(outer, 'Esc が背後へ流れている').not.toHaveBeenCalled();
    // 対照群: 閉じているときの Esc は握らない(背後の Esc を奪わない)
    d.querySelector('summary')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(outer, '閉じているのに Esc を握った').toHaveBeenCalledTimes(1);
  });

  it('🔴 焦点がメニューの外(Tab で出た等)でも Esc で閉じ、背後へ流さない / ダイアログが開いているときは握らない', () => {
    for (const old of document.querySelectorAll('details[data-pkc-bar-menu]')) old.remove();
    const d = makeBarMenu('t-out', 'その他', 'h', [btn('x-o', 'お')]);
    const outside = document.createElement('input');
    const outer = vi.fn();
    document.body.append(d, outside);
    document.body.addEventListener('keydown', outer);
    try {
      d.open = true;
      outside.focus();
      outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(d.open, '外に焦点があると閉じない').toBe(false);
      expect(document.activeElement).toBe(d.querySelector('summary'));
      expect(outer, 'Esc が背後へ流れている').not.toHaveBeenCalled();
      // 対照群: 開いたダイアログが在るときは、ダイアログの Esc を奪わない
      const dlg = document.createElement('dialog');
      dlg.setAttribute('open', '');
      document.body.append(dlg);
      d.open = true;
      outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(d.open, 'ダイアログの Esc を奪った').toBe(true);
      expect(outer).toHaveBeenCalledTimes(1);
      dlg.remove();
    } finally {
      document.body.removeEventListener('keydown', outer);
      d.remove();
      outside.remove();
    }
  });

  it('上へ開く指定は印に出る / 既定は下 / 詰め物は幅を持たない印の物', () => {
    expect(makeBarMenu('a', 'その他', 'h', [btn('x', 'x')], { up: true }).querySelector('[data-pkc-bar-menu-list]')?.getAttribute('data-pkc-bar-menu-list')).toBe('up');
    expect(makeBarMenu('b', 'その他', 'h', [btn('x', 'x')]).querySelector('[data-pkc-bar-menu-list]')?.getAttribute('data-pkc-bar-menu-list')).toBe('down');
    expect(makeBarSpacer().getAttribute('aria-hidden')).toBe('true');
    // 左寄せの帯の中のメニューは左の端から開く(既定は右端 = 印なし)
    expect(makeBarMenu('c', 'その他', 'h', [btn('x', 'x')], { align: 'start' }).querySelector('[data-pkc-bar-menu-list]')?.getAttribute('data-pkc-bar-menu-align')).toBe('start');
    expect(makeBarMenu('d', 'その他', 'h', [btn('x', 'x')]).querySelector('[data-pkc-bar-menu-list]')?.hasAttribute('data-pkc-bar-menu-align')).toBe(false);
  });
});

/** その帯の直下の押し口(メニューの中は含めない)と、メニューの中の押し口。 */
function split(bar: Element): { direct: string[]; inMenu: string[]; menus: string[] } {
  const actions = (root: Element): string[] =>
    [...root.querySelectorAll('button')].map((b) => b.getAttribute('data-pkc-action') ?? '');
  const menus = [...bar.querySelectorAll('details[data-pkc-bar-menu]')];
  const inMenu = menus.flatMap((m) => actions(m));
  const direct = [...bar.querySelectorAll(':scope > button')].map((b) => b.getAttribute('data-pkc-action') ?? '');
  return { direct, inMenu, menus: menus.map((m) => m.getAttribute('data-pkc-field') ?? '') };
}
const primaries = (root: Element): string[] =>
  [...root.querySelectorAll('button[data-pkc-variant="primary"]')].map((b) => b.getAttribute('data-pkc-action') ?? '');

describe('② 5 つの画面の帯の振り分け(常用は直下 / たまには奥 / 主は 1 つ以下)', () => {
  it('🔴 集計: 数え直しは唯一の操作なので奥へ回さない(右端に固定)/ 主は無い', () => {
    const region = document.createElement('div');
    document.body.append(region);
    const r = new QueryRenderer(region);
    r.render(booted());
    const bar = region.querySelector('[data-pkc-region="query-bar"]')!;
    expect(split(bar).direct).toEqual(['refresh-query']);
    expect(split(bar).menus, '中身 1 件の空のメニューを作っている').toEqual([]);
    const kids = [...bar.children].map((c) => c.getAttribute('data-pkc-field') ?? c.tagName);
    expect(kids.indexOf('bar-spacer'), '数え直しの前に詰め物が無い(右端に寄らない)').toBeGreaterThan(-1);
    expect(kids.indexOf('bar-spacer')).toBeLessThan(kids.length - 1);
    expect(primaries(bar)).toEqual([]);
  });

  it('🔴 差分マージ: 元に戻す・やり直す・同じ行も出す・保存(主)は直下 / 全部戻す・全部そろえる 2 つは奥', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const r = new DiffMergeRenderer(host);
    r.render(booted());
    const bar = host.querySelector('[data-pkc-field="diff-tools"]')!;
    const s = split(bar);
    expect(s.direct).toEqual(['diff-undo', 'diff-redo', 'diff-toggle-all', 'diff-save']);
    expect(s.inMenu).toEqual(['diff-reset', 'diff-take-all', 'diff-take-all']);
    // ⚠ 奥の 2 つの `diff-take-all` は向き(`data-pkc-from`)で別物 ── 両方残っている
    expect([...bar.querySelectorAll('[data-pkc-action="diff-take-all"]')].map((b) => b.getAttribute('data-pkc-from')).sort()).toEqual(['a', 'b']);
    expect(primaries(bar)).toEqual(['diff-save']);
    // 保存は右端(その他の次)── 並びが固定
    expect(bar.lastElementChild?.getAttribute('data-pkc-action')).toBe('diff-save');
  });

  it('🔴 計算: 結果をコピー(主)は直下 / ノートにする 2 つは「書き出す ▾」/ 消す(危険)は「その他 ▾」', () => {
    const host = document.createElement('div');
    document.body.append(host);
    new CalcRenderer(host).render();
    const bar = host.querySelector('[data-pkc-field="calc-tools"]')!;
    const s = split(bar);
    expect(s.direct).toEqual(['calc-copy']);
    expect(s.menus).toEqual(['calc-out', 'calc-more']);
    expect(bar.querySelector('[data-pkc-field="calc-out"]')!.querySelectorAll('button').length).toBe(2);
    expect([...bar.querySelector('[data-pkc-field="calc-out"]')!.querySelectorAll('button')].map((b) => b.getAttribute('data-pkc-action'))).toEqual(['calc-to-table', 'calc-to-text']);
    expect([...bar.querySelector('[data-pkc-field="calc-more"]')!.querySelectorAll('button')].map((b) => b.getAttribute('data-pkc-action'))).toEqual(['calc-clear']);
    expect(primaries(bar)).toEqual(['calc-copy']);
    expect(bar.querySelector('[data-pkc-action="calc-clear"]')?.getAttribute('data-pkc-variant'), '消すが危険の型でない').toBe('danger');
  });

  it('🔴 テキスト整形: 読み込む / コピー(主)は直下 / 消す(危険)は「その他 ▾」/ ノートにする・置き換えるは「書き出す ▾」', () => {
    const host = document.createElement('div');
    document.body.append(host);
    new TextLabRenderer(host).render(booted());
    const inBar = host.querySelector('[data-pkc-field="textlab-in-tools"]')!;
    const outBar = host.querySelector('[data-pkc-field="textlab-out-tools"]')!;
    expect(split(inBar).direct).toEqual(['textlab-load-note']);
    expect(split(inBar).inMenu).toEqual(['textlab-clear']);
    expect(split(outBar).direct).toEqual(['textlab-copy']);
    expect(split(outBar).inMenu).toEqual(['textlab-to-note', 'textlab-apply-note']);
    expect(primaries(host)).toEqual(['textlab-copy']);
    expect(host.querySelector('[data-pkc-action="textlab-clear"]')?.getAttribute('data-pkc-variant')).toBe('danger');
    // ⚠ 整え方・表の変換の切り替え(aria-pressed の群)は帯ではなく**選ぶ物**なので、そのまま出ている
    expect(host.querySelectorAll('[data-pkc-action="textlab-toggle"]').length).toBeGreaterThan(3);
  });
});
