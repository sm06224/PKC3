/** @vitest-environment happy-dom */
/**
 * 掴んで大きさを変える配線(#497)。
 *
 * > user 指示 2026-08-27:「**この枠のサイズは可変にし、ユーザーが変更できるように
 * > して欲しい。追記メインで使う場合はわくを大きくしたいとか、閲覧メインで使う時は
 * > 消したいとかあると思う。リサイズニーズは、両サイドペインも一緒だと思う**」
 *
 * 🔴 守る主張:
 * 1. 掴んで動かすと**画面が変わり、覚える**
 * 2. 🔴 **押しただけなら畳む**(既存 #197 の動きを壊していない)
 * 3. 🔴 **動かした後の `click` を捨てる** ── 捨てないと広げた直後に畳まれる
 * 4. **鍵でも同じことができる**(掴めない人の口)
 * 5. 🔴 **測れない回は何もしない** ── 黙って面を消さない
 *
 * ## ⚠ happy-dom は寸法を持たない
 *
 * `getBoundingClientRect` は 0 を返すので、**そこを差して測れる状態を作る**。
 * ⚠ 差さないと全部「測れない回」になり、**この file 全体が空振りする**
 *   (CLAUDE.md §1)── だから「差した状態」と「差さない状態」の**両方**を見る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { installPaneResize } from '../../src/adapter/ui/render/pane-resize';
import { AppendBoxRenderer } from '../../src/adapter/ui/render/append-box';
import { appPaneSizes } from '../../src/adapter/ui/render/pane-size';
import { appPanes, applyPaneVisibility } from '../../src/adapter/ui/render/pane-visibility';
import { readFileSync } from 'node:fs';
import { blocksFor, decl, stripComments, withoutMedia } from '../helpers/css-blocks';

let detach: (() => void) | null = null;

function mounted(): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const regions = buildShell(root);
  // ⚠ **打つ欄は `buildShell` では出てこない**(器だけ)── 追記欄の高さを
  //    測る先は textarea なので、実物の描画器を通す(main.ts と同じ組み方)。
  new AppendBoxRenderer(regions.append);
  bindActions(root, new Dispatcher());
  detach = installPaneResize(root);
  return root;
}

const shellOf = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-pkc-region="shell"]')!;
const grip = (root: HTMLElement, pane: string) =>
  root.querySelector<HTMLButtonElement>(
    `[data-pkc-region="pane-grip"][data-pkc-pane="${pane}"]`,
  )!;

/** その面が「いま N px ある」ことにする(happy-dom は寸法を持たない)。 */
function measure(el: HTMLElement, box: { width?: number; height?: number }): void {
  el.getBoundingClientRect = () =>
    ({ width: box.width ?? 0, height: box.height ?? 0 }) as DOMRect;
}

/** 掴んで動かして離す。⚠ `pointerup` は **document** で受けている。 */
function drag(g: HTMLElement, dx: number, dy: number): void {
  const opts = { bubbles: true, pointerId: 1, button: 0 };
  g.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: 0, clientY: 0 }));
  document.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: dx, clientY: dy }));
  document.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: dx, clientY: dy }));
  // ⚠ 実ブラウザは離した後に `click` も撃つ ── ここを省くと③が空振りする
  g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  // ⚠ 保存は module 共有の 1 個 ── 消さないと前の test の上で動く
  appPanes.setHidden([]);
});

afterEach(() => {
  detach?.();
  detach = null;
  vi.restoreAllMocks();
});

describe('掴んで大きさを変える(#497)', () => {
  it('🔴 一覧を右へ引くと広がり、覚える', () => {
    const root = mounted();
    measure(root.querySelector<HTMLElement>('[data-pkc-region="sidebar"]')!, { width: 240 });
    drag(grip(root, 'sidebar'), 60, 0);
    expect(
      shellOf(root).style.getPropertyValue('--pkc-pane-sidebar'),
      '画面に反映されていない',
    ).toBe('clamp(0px, 300px, 45vw)');
    expect(appPaneSizes.get().sidebar, '覚えていない').toBe(300);
  });

  /**
   * 🔴 **向きは面ごとに違う**(右の面は左へ引くと広がる)。
   * ⚠ 一覧と同じ向きで書くと、**掴んだ向きと逆に動く**ものが出荷される。
   */
  it('🔴 情報を**左**へ引くと広がる', () => {
    const root = mounted();
    measure(root.querySelector<HTMLElement>('[data-pkc-region="inspector"]')!, { width: 300 });
    drag(grip(root, 'inspector'), -60, 0);
    expect(appPaneSizes.get().inspector, '左へ引いたのに狭くなった').toBe(360);
  });

  it('🔴 追記欄を**上**へ引くと高くなる', () => {
    const root = mounted();
    measure(root.querySelector<HTMLElement>('[data-pkc-field="append-input"]')!, { height: 60 });
    drag(grip(root, 'append'), 0, -40);
    expect(appPaneSizes.get().append, '上へ引いたのに低くなった').toBe(100);
    expect(shellOf(root).style.getPropertyValue('--pkc-pane-append')).toBe(
      'clamp(0px, 100px, 60vh)',
    );
  });

  /**
   * ⚠ **`undefined` を「捨てていない証拠」に使わない**(変異 M9 が生き延びて判明)。
   *   保存は 0 以下を捨てるので、`set(id, 0)` してもやはり `undefined` に見える ──
   *   つまり「捨てた」と「もともと無い」が**同じ顔**になる(§1 の空振り)。
   * 🔑 だから**先に幅を決めてから**畳み、**その値が残っている**ことを見る。
   */
  it('🔴 下限より小さくしたら畳む ── 決めた大きさは覚えたまま', () => {
    const root = mounted();
    const side = root.querySelector<HTMLElement>('[data-pkc-region="sidebar"]')!;
    measure(side, { width: 240 });
    drag(grip(root, 'sidebar'), 60, 0); // まず 300px に決める
    expect(appPaneSizes.get().sidebar, '前提が崩れている(幅を決められていない)').toBe(300);

    measure(side, { width: 300 });
    drag(grip(root, 'sidebar'), -260, 0);
    expect(shellOf(root).getAttribute('data-pkc-hidden-panes'), '畳んでいない').toBe('sidebar');
    // 🔑 **戻したときに元の幅で開く** ── ここが 0 や undefined になると既定へ戻る
    expect(appPaneSizes.get().sidebar, '畳んだときに大きさまで捨てた').toBe(300);
    expect(
      shellOf(root).style.getPropertyValue('--pkc-pane-sidebar'),
      '畳んだときに画面の値まで捨てた',
    ).toBe('clamp(0px, 300px, 45vw)');
  });

  /**
   * ⚠ **前提を画面に作る**(変異 M8 が生き延びて判明)。`appPanes.setHidden` は
   *   **保存を書くだけ**で器の属性は付かない ── そのまま assert すると
   *   「畳まれていない」が最初から真で、**引き出す配線を消しても緑**になる。
   */
  it('🔴 畳んである面を掴んで引き出せる(戻す口が 2 本ある)', () => {
    const root = mounted();
    applyPaneVisibility(root, appPanes.setHidden(['sidebar']));
    expect(
      shellOf(root).getAttribute('data-pkc-hidden-panes'),
      '前提が崩れている(畳めていない)',
    ).toBe('sidebar');
    measure(root.querySelector<HTMLElement>('[data-pkc-region="sidebar"]')!, { width: 0 });
    drag(grip(root, 'sidebar'), 260, 0);
    expect(shellOf(root).hasAttribute('data-pkc-hidden-panes'), '戻っていない').toBe(false);
    expect(appPaneSizes.get().sidebar).toBe(260);
  });
});

/**
 * 🔴 **畳んだ面には、必ず戻し口が残っている**(2026-08-29。#582 の全数調査)。
 *
 * ⚠ 追記欄は **鍵を持っていない**(`KEY_COMMANDS` に `toggle-append` は無く、
 *   `SHORTCUT_BUTTON` にも一覧と情報の 2 つしか無い)── つまり
 *   **戻し口は掴む帯 1 本だけ**である。ところが `@media (max-width: 720px)` が
 *   `[data-pkc-region='pane-grip']` を**面の区別なく**畳んでいたので、
 *   🔴 **畳んだまま窓を狭めると、二度と戻せなかった**
 *   (畳んだ事実は `pkc3.panes` に残るので、窓を広げるまで永久に戻らない)。
 *
 * 🔑 消してよい理由(「縦に畳むので**境目が無い**」)は**左右の帯にしか
 *   当たらない** ── 追記欄の帯は横向き(`data-pkc-axis='y'`)で、1 列に折れても
 *   本文との境目は縦に残っている。
 *
 * ⚠ CSS は**構文で**読む(CLAUDE.md §1 ── 5 回踏んでいる)。
 */
describe('🔴 狭い版面でも戻し口が残る(2026-08-29)', () => {
  const css = (): string =>
    stripComments(readFileSync('src/styles/app.css', 'utf-8'));

  /**
   * 🔴 **2026-09-02 に引く先を変えた**(#632 段①)── `@media (max-width: 720px)` は
   *   **消えた**(スマホ用画面へ置き換えた)ので、`mediaBlock` で引くと
   *   「版面を引けていない」で落ちる = **主張ごと消える**。
   * 🔑 主張は 1 文字も変えない:**スマホでも追記欄の戻し口は残る**。
   *   引く先だけ「`data-pkc-layout='phone'` を含む規則」へ移す。
   * ⚠ `@media` の中は読まない(印刷や別の幅の規則で満たされない)。
   */
  const phoneCss = (): string => {
    const rules = [...withoutMedia(css()).matchAll(/([^{}]+)\{[^{}]*\}/g)].filter((m) =>
      m[1]!.includes("data-pkc-layout='phone'"),
    );
    return rules.map((m) => m[0]!).join('\n');
  };

  it('🔴 スマホ用画面でも、横向きの掴む帯(追記欄)は消さない', () => {
    const narrow = phoneCss();
    // 空振り防止 ── 版面ごと引けていないのに緑にならない
    expect(narrow, 'スマホの版面を引けていない(空振り)').toContain('grid-template-areas');
    /**
     * ⚠ **「消す規則が在るか」ではなく「何を消しているか」を見る** ──
     *   面を名指ししない `pane-grip` が 1 つでも `display: none` なら、
     *   追記欄の帯も巻き添えになる。
     *
     * 🔴 **選択子を丸ごと一致で名指ししない**(2026-08-29 の着地前レビュー W-1)。
     * ⚠ 直す前は `blocksFor(narrow, "[data-pkc-region='pane-grip']")` = **完全一致**だけを
     *   見ていたので、**別の綴りで書いた規則**が素通りした ── 実際に
     *   `[data-pkc-region='center'] [data-pkc-region='pane-grip'] { display: none }` を
     *   足す変異が**緑のまま通り、直した片道が戻る**(追記欄の帯は `center` の子である)。
     * 🔑 だから **`pane-grip` に当たる規則を全部集め、`display: none` を持つものが
     *   1 つ残らず「横向きを除く」印を持っていること**を見る。
     */
    const KEEP = "[data-pkc-axis='y']";
    const hiding = [...stripComments(narrow).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .flatMap((m) =>
        m[1]!.split(',').map((sel) => ({ sel: sel.trim().replace(/\s+/g, ' '), body: m[2]! })),
      )
      .filter((r) => r.sel.includes("[data-pkc-region='pane-grip']"))
      .filter((r) => decl('display', 'none').test(r.body));
    // 空振り防止 ── 帯を畳む規則が 1 つも無いなら、引き方が壊れている
    expect(hiding.length, '帯を畳む規則を引けていない(空振り)').toBeGreaterThan(0);
    expect(
      hiding.filter((r) => !r.sel.includes(KEEP)).map((r) => r.sel),
      '横向きを除かずに帯を消している規則がある(追記欄の戻し口が巻き添えになる)',
    ).toEqual([]);
  });

  /**
   * 🔴 **対照群** ── 左右の帯は 720px 以下で消えてよい(縦に折れて境目が無い)。
   * ⚠ これが無いと「全部消さない」へ倒した変異を見分けられない。
   */
  it('🔴 左右の帯はスマホ用画面で畳む(1 枚ずつ出るので境目が無い)', () => {
    const narrow = phoneCss();
    const scoped = blocksFor(
      narrow,
      "[data-pkc-region='shell'][data-pkc-layout='phone'] [data-pkc-region='pane-grip']:not([data-pkc-axis='y'])",
    );
    expect(scoped.length, '左右の帯を畳む規則が無い').toBeGreaterThan(0);
    expect(
      scoped.some((b) => decl('display', 'none').test(b)),
      '左右の帯が畳まれていない ── 縦に折れて境目が無いので、こちらは畳んでよい',
    ).toBe(true);
  });
});

describe('押すと掴むを取り違えない(#497)', () => {
  /** ⚠ ここが壊れると #197(押して畳む)が**丸ごと死ぬ**。 */
  it('🔴 押しただけ(動かさない)なら、従来どおり畳む', () => {
    const root = mounted();
    measure(root.querySelector<HTMLElement>('[data-pkc-region="sidebar"]')!, { width: 240 });
    drag(grip(root, 'sidebar'), 0, 0);
    expect(shellOf(root).getAttribute('data-pkc-hidden-panes'), '押しても畳めない').toBe('sidebar');
    expect(appPaneSizes.get().sidebar, '押しただけで大きさを書いた').toBeUndefined();
  });

  /**
   * 🔴 **動かした後の `click` を捨てる。** ⚠ 捨てないと、広げた指を離した瞬間に
   * **その面が畳まれる**(ブラウザが `click` も撃つため)── 画面を見れば一発で
   * 分かるのに、`click` を撃たない test では**永久に見えない**。
   */
  it('🔴 掴んで動かした後は、続く click で畳まれない', () => {
    const root = mounted();
    measure(root.querySelector<HTMLElement>('[data-pkc-region="sidebar"]')!, { width: 240 });
    drag(grip(root, 'sidebar'), 60, 0);
    expect(
      shellOf(root).hasAttribute('data-pkc-hidden-panes'),
      '広げた直後に畳まれた(click を捨てていない)',
    ).toBe(false);
  });

  /**
   * ⚠ **捨てるのは 1 回だけ。** `once` で書くと `pointercancel` の回に
   * **次の正当な押しを食う** ── その形になっていないことを見る。
   */
  it('🔴 捨てるのは 1 回だけ ── 次に押したら畳める', () => {
    const root = mounted();
    measure(root.querySelector<HTMLElement>('[data-pkc-region="sidebar"]')!, { width: 240 });
    drag(grip(root, 'sidebar'), 60, 0);
    drag(grip(root, 'sidebar'), 0, 0);
    expect(shellOf(root).getAttribute('data-pkc-hidden-panes'), '2 手目の押しまで食った').toBe(
      'sidebar',
    );
  });
});

describe('鍵でも動かせる(#497)', () => {
  function key(g: HTMLElement, k: string): boolean {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    g.dispatchEvent(e);
    return e.defaultPrevented;
  }

  it('🔴 矢印キーで同じだけ動く(掴めない人の口)', () => {
    const root = mounted();
    const side = root.querySelector<HTMLElement>('[data-pkc-region="sidebar"]')!;
    measure(side, { width: 240 });
    expect(key(grip(root, 'sidebar'), 'ArrowRight'), '画面が一緒に流れる').toBe(true);
    expect(appPaneSizes.get().sidebar, '鍵で動いていない').toBe(256);
  });

  it('🔴 右の面は**左**キーで広がる(掴んだときと同じ向き)', () => {
    const root = mounted();
    measure(root.querySelector<HTMLElement>('[data-pkc-region="inspector"]')!, { width: 300 });
    key(grip(root, 'inspector'), 'ArrowLeft');
    expect(appPaneSizes.get().inspector).toBe(316);
  });

  it('関係ないキーは素通りする(画面の流れを止めない)', () => {
    const root = mounted();
    measure(root.querySelector<HTMLElement>('[data-pkc-region="sidebar"]')!, { width: 240 });
    expect(key(grip(root, 'sidebar'), 'ArrowUp'), '幅の帯が縦キーを食った').toBe(false);
    expect(key(grip(root, 'sidebar'), 'a')).toBe(false);
    expect(appPaneSizes.get().sidebar).toBeUndefined();
  });
});

describe('🔴 測れない回は何もしない(#497)', () => {
  /**
   * 🔴 **黙って面を消さない。** 寸法が採れないとき `0` を基準にすると、
   * ちょっと掴んだだけで下限割れ = **畳む**になる。
   * ⚠ この test が守るのは「畳まないこと」であって「動かないこと」ではない。
   */
  it('🔴 寸法が採れない面は、掴んでも畳まれない', () => {
    const root = mounted();
    // ⚠ 差さない = happy-dom の既定(全部 0)。畳んでもいない
    drag(grip(root, 'sidebar'), 60, 0);
    expect(
      shellOf(root).hasAttribute('data-pkc-hidden-panes'),
      '測れないのに畳んだ(黙って面が消える)',
    ).toBe(false);
    expect(appPaneSizes.get().sidebar, '測れないのに大きさを書いた').toBeUndefined();
  });

  it('🔴 寸法が採れない面は、鍵でも畳まれない', () => {
    const root = mounted();
    const e = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
    grip(root, 'sidebar').dispatchEvent(e);
    expect(
      shellOf(root).hasAttribute('data-pkc-hidden-panes'),
      '測れないのに鍵で畳んだ',
    ).toBe(false);
  });

  /** ⚠ **対照群** ── 上が「配線が死んでいるから通った」ではないこと。 */
  it('⚠ 対照群:測れる面は同じ手順で動く', () => {
    const root = mounted();
    measure(root.querySelector<HTMLElement>('[data-pkc-region="sidebar"]')!, { width: 240 });
    drag(grip(root, 'sidebar'), 60, 0);
    expect(appPaneSizes.get().sidebar, '配線そのものが死んでいる').toBe(300);
  });
});
