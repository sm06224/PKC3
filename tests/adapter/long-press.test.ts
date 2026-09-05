/** @vitest-environment happy-dom */
/**
 * 長押しで印を足す(#687 D-1。user 裁定 2026-09-04)。実体は
 * `src/adapter/ui/actions/long-press.ts` と `binder.ts` の 4 か所。
 *
 * 🔴 守る主張:
 * 1. **指で 500ms 押し続けると、その行の印が足される**(`toggle` ── 前の印は残る)
 * 2. 🔴 **直後の `click` を捨てる** ── 捨てないと `set` で印が 1 件に戻る
 * 3. **10px 動いたら長押しではない**(スクロールし始めた指を印にしない)
 * 4. **マウスでは発火しない**(対照群 ── マウスには Ctrl クリックが在る)
 * 5. 🔴 **捨てた `click` は「2 回押した」にも数えない** ── 数えると次のタップで
 *    フォルダへ入る
 * 6. 長押し中 / 直後の行では**メニューを出さない**、待っている間は**掴ませない**
 *
 * ⚠ happy-dom は `PointerEvent` を持つが**時計は進めない** ── `vi.useFakeTimers()`
 *   で `setTimeout` と `Date.now()` を一緒に進める(`binder.ts` の 2 回押しの判定も
 *   `Date.now()` を読むので、両方が同じ時計で動く)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { DualFilerRenderer } from '../../src/adapter/ui/render/dual-filer';
import { contextMenuOpen } from '../../src/adapter/ui/render/context-menu';
import { paneOf, paneScope } from '../../src/features/relation/dual-pane';
import {
  LONG_PRESS_CONSUME_MS,
  LONG_PRESS_MS,
  LONG_PRESS_SLOP_PX,
} from '../../src/adapter/ui/actions/long-press';
import { blocksFor, decl, stripComments, withoutMedia } from '../helpers/css-blocks';
import { readFileSync } from 'node:fs';

function meta(lid: string, order: number, title: string, archetype = 'text'): EntryMeta {
  return {
    lid,
    title,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}
const METAS = [meta('f1', 1, 'はこ1', 'folder'), meta('a', 2, 'あ'), meta('b', 3, 'い')];
const RELS: Relation[] = [];

let root: HTMLElement;
let d: Dispatcher;
let region: HTMLElement;
let detach: () => void;
let vibrated: number[];

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  vibrated = [];
  // ⚠ happy-dom の navigator に `vibrate` は無い ── 在る端末を模す(呼ばれた値を採る)
  Object.defineProperty(navigator, 'vibrate', {
    configurable: true,
    value: (ms: number) => {
      vibrated.push(ms);
      return true;
    },
  });
  root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  d = new Dispatcher();
  buildShell(root);
  detach = bindActions(root, d);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS });
  region = document.createElement('div');
  root.append(region);
  const r = new DualFilerRenderer(region);
  d.onState((st) => r.render(st));
  r.render(d.getState());
});

afterEach(() => {
  detach();
  vi.useRealTimers();
});

/** ⚠ 表へスコープする(パンくずも `data-pkc-entry` を持つ)。 */
const row = (side: string, lid: string): HTMLElement =>
  region.querySelector<HTMLElement>(
    `[data-pkc-region="dual-pane"][data-pkc-side="${side}"] [data-pkc-region="dual-table"] [data-pkc-entry="${lid}"]`,
  )!;
const marks = (side: 'left' | 'right'): readonly string[] => paneOf(d.getState().dual, side).selection;

type Pointer = 'touch' | 'mouse' | 'pen';
const pointer = (
  el: HTMLElement,
  type: string,
  kind: Pointer,
  x = 0,
  y = 0,
  init: PointerEventInit = {},
): void => {
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerType: kind,
      button: 0,
      clientX: x,
      clientY: y,
      ...init,
    }),
  );
};
/** 押して(pointerdown)、離す前に時計を進める。 */
const pressFor = (el: HTMLElement, ms: number, kind: Pointer = 'touch'): void => {
  pointer(el, 'pointerdown', kind);
  vi.advanceTimersByTime(ms);
};
const click = (el: HTMLElement): Event => {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
};

describe('長押しで印を足す(#687 D-1)', () => {
  it('🔴 ① 指で 500ms 押し続けると、その行の印が足される(前の印は残る)', () => {
    click(row('left', 'a'));
    expect(marks('left'), '前提が崩れている(素のクリックで 1 件)').toEqual(['a']);
    pressFor(row('left', 'b'), LONG_PRESS_MS - 1);
    expect(marks('left'), '500ms 前に発火した').toEqual(['a']);
    vi.advanceTimersByTime(1);
    expect(marks('left'), '長押しで足されていない').toEqual(['a', 'b']);
    // 🔑 指に返事をする(在る端末では震える)
    expect(vibrated, '震えていない').toEqual([10]);
    // ⚠ 反対側は動かない(側は押した行から辿る)
    expect(marks('right')).toEqual([]);
  });

  it('🔴 ② 離した直後の click は捨てる ── 印が 1 件に戻らない', () => {
    click(row('left', 'a'));
    pressFor(row('left', 'b'), LONG_PRESS_MS);
    expect(marks('left')).toEqual(['a', 'b']);
    pointer(row('left', 'b'), 'pointerup', 'touch');
    const ev = click(row('left', 'b'));
    expect(ev.defaultPrevented, '捨てた click の既定を止めていない').toBe(true);
    expect(marks('left'), '直後の click が set で印を 1 件に戻した').toEqual(['a', 'b']);
    /**
     * 対照群 ── **窓が閉じた後の click は普通に効く**(捨て続けたら印が付け替えられない)。
     */
    vi.advanceTimersByTime(LONG_PRESS_CONSUME_MS);
    click(row('left', 'a'));
    expect(marks('left'), '窓が閉じても click を捨て続けている').toEqual(['a']);
  });

  it('🔴 ③ 10px を超えて動いたら発火しない(スクロールし始めた指)', () => {
    click(row('left', 'a'));
    pointer(row('left', 'b'), 'pointerdown', 'touch', 0, 0);
    pointer(row('left', 'b'), 'pointermove', 'touch', 0, LONG_PRESS_SLOP_PX + 1);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(marks('left'), 'スクロールし始めたのに印が付いた').toEqual(['a']);
    // 対照群 ── 震えの範囲(10px 以内)なら発火する
    pointer(row('left', 'b'), 'pointerdown', 'touch', 0, 0);
    pointer(row('left', 'b'), 'pointermove', 'touch', 0, LONG_PRESS_SLOP_PX);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(marks('left'), '指の震えで取り消している').toEqual(['a', 'b']);
  });

  it('④ 対照群: マウスで押し続けても発火しない / 500ms 前に離せばただのタップ', () => {
    click(row('left', 'a'));
    pressFor(row('left', 'b'), LONG_PRESS_MS * 2, 'mouse');
    expect(marks('left'), 'マウスの長押しで印が付いた').toEqual(['a']);
    pointer(row('left', 'b'), 'pointerdown', 'touch');
    vi.advanceTimersByTime(LONG_PRESS_MS - 100);
    pointer(row('left', 'b'), 'pointerup', 'touch');
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(marks('left'), '離したのに発火した').toEqual(['a']);
    // ⚠ 離した後の click は**普通の**タップ(`set`)
    click(row('left', 'b'));
    expect(marks('left')).toEqual(['b']);
  });

  /**
   * 🔴 **⑤ 捨てた click は「2 回押した」にも数えない。**
   * ⚠ 数えると、長押しのあと 500ms 以内にもう 1 度触ったフォルダへ**入ってしまう**
   *   (印を付けたかっただけの指が、場所を動かす)。
   */
  it('🔴 ⑤ 捨てた click は 2 回押しの 1 回目に数えない', () => {
    pressFor(row('left', 'f1'), LONG_PRESS_MS);
    expect(marks('left'), '前提が崩れている').toEqual(['f1']);
    click(row('left', 'f1')); // 捨てられる click
    vi.advanceTimersByTime(100);
    click(row('left', 'f1')); // ⚠ 捨てた click が 1 回目に数えられていると、ここで入る
    expect(paneScope(paneOf(d.getState().dual, 'left')), '捨てた click を 1 回目に数えた').toBeNull();
    // 対照群 ── 窓が閉じてからの 2 回押しは、これまでどおり入る
    vi.advanceTimersByTime(LONG_PRESS_CONSUME_MS);
    click(row('left', 'f1'));
    click(row('left', 'f1'));
    expect(paneScope(paneOf(d.getState().dual, 'left')), '2 回押しで入れなくなった').toBe('f1');
  });

  it('🔴 ⑥ 長押し中 / 直後の行ではメニューを出さず、待っている間は掴ませない', () => {
    const b = row('left', 'b');
    pointer(b, 'pointerdown', 'touch');
    vi.advanceTimersByTime(100);
    // 待っている間の contextmenu(Android は長押しで撃つ)── OS のもこの面のも出さない
    const cm = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    b.dispatchEvent(cm);
    expect(cm.defaultPrevented, 'OS のメニューを止めていない').toBe(true);
    expect(contextMenuOpen(root), 'この面のメニューが出た').toBe(false);
    // 待っている間の dragstart ── 掴ませない
    const ds = new Event('dragstart', { bubbles: true, cancelable: true });
    b.dispatchEvent(ds);
    expect(ds.defaultPrevented, '長押し待ちの行を掴ませた').toBe(true);
    // 発火の直後も contextmenu は出さない
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(marks('left')).toEqual(['b']);
    const cm2 = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    b.dispatchEvent(cm2);
    expect(cm2.defaultPrevented, '発火の直後のメニューを止めていない').toBe(true);
    /**
     * 対照群 ── **別の行**の contextmenu はこれまでどおりこの面のメニューが出る /
     * 何も待っていない行の dragstart は止めない(マウスの drag を壊していない)。
     */
    const a = row('left', 'a');
    a.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(contextMenuOpen(root), '関係ない行のメニューまで消えた').toBe(true);
    const ds2 = new Event('dragstart', { bubbles: true, cancelable: true });
    a.dispatchEvent(ds2);
    expect(ds2.defaultPrevented, '待っていない行まで掴ませない').toBe(false);
  });

  /**
   * 🔴 **⑦ 長押しの直後に別の行を素早くタップしても、そのタップは捨てない。**
   *
   * ⚠ 実ブラウザの smoke(`phone.smoke.spec.ts` #687 D-1 の対照群)が赤で教えた:
   *   消費窓は**発火から** 700ms なので、500ms で発火 → 600ms で離す → 800ms に
   *   次のタップの `click`、という指の速さで**2 つ目のタップが黙って消えていた**
   *   (印が 2 件のまま ── user には「押したのに何も起きない」)。
   * 🔑 捨ててよいのは**同じ押下**が離れたときの `click` だけ ── 次の `pointerdown` が
   *   来たら、それは**新しい押下**なので窓を閉じる。
   */
  it('🔴 ⑦ 長押しの直後の別のタップは捨てない(次の pointerdown で消費窓を閉じる)', () => {
    click(row('left', 'a'));
    pressFor(row('left', 'b'), LONG_PRESS_MS);
    expect(marks('left'), '前提が崩れている').toEqual(['a', 'b']);
    vi.advanceTimersByTime(100);
    pointer(row('left', 'b'), 'pointerup', 'touch');
    click(row('left', 'b')); // 同じ押下の click ── これは捨てる
    expect(marks('left'), '離した直後の click を捨てていない').toEqual(['a', 'b']);
    vi.advanceTimersByTime(100);
    // ⚠ ここは発火から 200ms ── 消費窓(700ms)の内側で、次の押下が始まる
    pointer(row('left', 'a'), 'pointerdown', 'touch');
    vi.advanceTimersByTime(100);
    pointer(row('left', 'a'), 'pointerup', 'touch');
    const ev = click(row('left', 'a'));
    expect(ev.defaultPrevented, '次の押下の click まで止めた').toBe(false);
    expect(marks('left'), '長押しの直後のタップが捨てられた(set が走っていない)').toEqual(['a']);
  });

  it('配線を解いたら、長押しは何も撃たない(leak を残さない)', () => {
    detach();
    detach = () => {};
    pressFor(row('left', 'b'), LONG_PRESS_MS * 2);
    expect(marks('left')).toEqual([]);
  });

  /**
   * 🔴 **CSS: 押している間に字を選ばせない / iOS の吹き出しを出さない**。
   * ⚠ `touch-action` は**書いてはいけない**(書くと一覧のスクロールが死ぬ)──
   *   その反対側も pin する。
   */
  it('🔴 スマホの行は user-select: none で、touch-action は書かない', () => {
    const css = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));
    const sel = "[data-pkc-region='shell'][data-pkc-layout='phone'] [data-pkc-region='dual-table'] tbody tr";
    const rule = blocksFor(css, sel).join(' ');
    expect(rule, '規則が無い').toMatch(decl('user-select', 'none'));
    expect(rule, 'iOS の吹き出しを止めていない').toMatch(decl('-webkit-touch-callout', 'none'));
    expect(rule, 'touch-action を書いている(スクロールが死ぬ)').not.toMatch(/touch-action\s*:/);
  });
});
