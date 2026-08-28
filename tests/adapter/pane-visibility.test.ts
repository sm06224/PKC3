/** @vitest-environment happy-dom */
/**
 * ペインの表示・非表示(#197 / 台帳 #180 の D-1)。
 *
 * 🔴 守る主張:
 * 1. 中央は**畳めない**(操作子の置き場であり、1 画面完結の本体)
 * 2. 押すと**列が実際に消える**(属性だけ動いて見た目が変わらない、を作らない)
 * 3. **畳んだ状態を覚える**(user 指示「同じものが常に同じ場所にある」)
 * 4. 畳んでも**戻す導線が画面に残る** ── 左を畳んだら戻せない、を作らない
 * 5. 近道(`Alt+[` / `Alt+]`)がボタンと同じ経路を通る
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  COLUMN_PANES,
  PANES,
  decodeHidden,
  encodeHidden,
  isPaneId,
  togglePane,
} from '../../src/features/pane-visibility';
import {
  PaneVisibilityStore,
  applyPaneVisibility,
} from '../../src/adapter/ui/render/pane-visibility';
import { readFileSync } from 'node:fs';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';

describe('畳める面の規則', () => {
  /**
   * ⚠ **`append` が増えたのは #497**(user 指示「閲覧メインで使う時は消したい」)。
   * 🔑 守る主張は変わっていない ── **本文そのものは畳めない**。
   */
  it('🔴 本文は畳めない ── 一覧に無い', () => {
    expect([...PANES]).toEqual(['sidebar', 'inspector', 'append']);
    expect(isPaneId('center'), '中央が畳める側に入っている').toBe(false);
    expect(isPaneId('detail')).toBe(false);
  });

  /**
   * 🔴 **列の帯は 2 本だけ**(#497)。⚠ `append` を `COLUMN_PANES` へ混ぜると
   * `shell` が列の境目に**3 本目の縦帯**を立てる(追記欄は中央の中に在るのに)。
   * ⚠ そして「両側を一度に畳む」鍵が**追記欄まで消す**ようになる ──
   *   どちらも画面を見るまで気づけない形で壊れる。
   */
  it('🔴 列の境目に立つのは左右だけ ── 追記欄は混ざらない', () => {
    expect([...COLUMN_PANES]).toEqual(['sidebar', 'inspector']);
    expect(
      (COLUMN_PANES as readonly string[]).includes('append'),
      '追記欄が列の帯に混ざっている',
    ).toBe(false);
  });

  it('押すたびに畳む・戻すが入れ替わる', () => {
    expect(togglePane([], 'sidebar')).toEqual(['sidebar']);
    expect(togglePane(['sidebar'], 'sidebar')).toEqual([]);
  });

  it('🔴 並びは正規化する(同じ状態が 2 通りの文字列にならない)', () => {
    expect(encodeHidden(['inspector', 'sidebar'])).toBe(encodeHidden(['sidebar', 'inspector']));
    expect(togglePane(['inspector'], 'sidebar')).toEqual(['sidebar', 'inspector']);
  });

  it('知らない名前は捨てる(面の名前が変わった後の古い保存で壊れない)', () => {
    expect(decodeHidden('sidebar ghost')).toEqual(['sidebar']);
    expect(decodeHidden('')).toEqual([]);
    expect(decodeHidden(null)).toEqual([]);
  });
});

describe('保存', () => {
  function fakeStorage() {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      map,
    };
  }

  it('🔴 畳んだ状態を覚え、次の起動で同じ配置になる', () => {
    const st = fakeStorage();
    const a = new PaneVisibilityStore(st);
    a.toggle('inspector');
    const b = new PaneVisibilityStore(st); // 次の起動
    expect(b.getHidden(), '畳んだのに覚えていない').toEqual(['inspector']);
  });

  it('保存が使えない環境でも落ちず、この session では効く', () => {
    const dead = {
      getItem: () => {
        throw new Error('private mode');
      },
      setItem: () => {
        throw new Error('private mode');
      },
    };
    const s = new PaneVisibilityStore(dead);
    expect(s.getHidden()).toEqual([]);
    expect(() => s.toggle('sidebar')).not.toThrow();
    expect(s.getHidden(), 'この session でも効いていない').toEqual(['sidebar']);
  });
});

describe('画面への適用', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    // ⚠ 保存は**この file の中でも持ち越す**(module 共有の 1 個 + localStorage)──
    //    消さないと前の test の畳み具合の上で動き、期待とずれる(実際に踏んだ)
    localStorage.clear();
  });

  function mounted() {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const d = new Dispatcher();
    buildShell(root);
    bindActions(root, d);
    return { root, d };
  }

  const shellOf = (root: HTMLElement) =>
    root.querySelector<HTMLElement>('[data-pkc-region="shell"]')!;
  const btn = (root: HTMLElement, pane: string) =>
    root.querySelector<HTMLButtonElement>(
      `[data-pkc-action="toggle-pane"][data-pkc-pane="${pane}"]`,
    )!;

  it('🔴 押すと器に印が付き、もう一度押すと消える', () => {
    const { root } = mounted();
    expect(shellOf(root).hasAttribute('data-pkc-hidden-panes')).toBe(false);
    btn(root, 'sidebar').click();
    expect(shellOf(root).getAttribute('data-pkc-hidden-panes')).toBe('sidebar');
    btn(root, 'sidebar').click();
    expect(
      shellOf(root).hasAttribute('data-pkc-hidden-panes'),
      '戻したのに印が残っている(空の属性を書いている)',
    ).toBe(false);
  });

  it('🔴 左を畳んでも「戻す」ボタンは画面に残る(戻れない画面を作らない)', () => {
    const { root } = mounted();
    btn(root, 'sidebar').click();
    const back = btn(root, 'sidebar');
    expect(back, '畳んだ側のボタンごと消えた').not.toBeNull();
    /**
     * ⚠ 操作子は**畳む面の外**に在ること ── 面の中に置くと畳んだ瞬間に一緒に消える。
     * 🔴 置き場は 2026-08-15 に「中央の上の帯」から**列の境目**へ移した
     * (user 指示「センターペインの上を潰しすぎ」)。守るべき条件は変わっていない:
     * **畳む対象の中に居ないこと**。
     */
    expect(
      back.closest('[data-pkc-region="sidebar"]'),
      '開閉ボタンが畳む面の中に在る(畳むと消える置き方)',
    ).toBeNull();
    expect(
      back.closest('[data-pkc-region="inspector"]'),
      '開閉ボタンが畳む面の中に在る(畳むと消える置き方)',
    ).toBeNull();
    // 🔑 かつ **shell の直下**に在る(面を畳んでも grid から落ちない)
    expect(back.parentElement?.getAttribute('data-pkc-region'), 'shell の直下に無い').toBe('shell');
  });

  it('読み上げにも出す(aria-pressed が畳み具合と一致する)', () => {
    const { root } = mounted();
    expect(btn(root, 'inspector').getAttribute('aria-pressed')).toBe('true');
    btn(root, 'inspector').click();
    expect(btn(root, 'inspector').getAttribute('aria-pressed')).toBe('false');
  });

  it('🔴 Alt+[ / Alt+] が同じ経路を通る', () => {
    const { root } = mounted();
    const key = (k: string) =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: k, altKey: true, bubbles: true, cancelable: true }),
      );
    key('[');
    expect(shellOf(root).getAttribute('data-pkc-hidden-panes')).toBe('sidebar');
    key(']');
    expect(shellOf(root).getAttribute('data-pkc-hidden-panes')).toBe('sidebar inspector');
    key('[');
    expect(shellOf(root).getAttribute('data-pkc-hidden-panes')).toBe('inspector');
  });

  it('🔴 修飾なしの [ は畳まない(本文に打てる字である)', () => {
    // ⚠ 変異試験 M10 が生き延びて判明 ── `altKey` を見ない実装でも誰も落ちなかった。
    //    素の `[` で畳むと、**本文に括弧を打つたびに列が消える**
    const { root } = mounted();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '[', bubbles: true, cancelable: true }),
    );
    expect(
      shellOf(root).hasAttribute('data-pkc-hidden-panes'),
      '修飾なしの [ で畳んでしまった',
    ).toBe(false);
  });

  it('applyPaneVisibility は器が無くても落ちない(器の外から呼ばれる)', () => {
    const root = document.createElement('div');
    expect(() => applyPaneVisibility(root, ['sidebar'])).not.toThrow();
  });
});

/**
 * 🔴 **CSS が実際に列を落とすこと**を原文で pin する。
 * ⚠ happy-dom は grid を計算しないので、`getComputedStyle` では確かめられない ──
 *   だから**規則の在ることを構文で**見る(`announce.test.ts` と同じ作法:
 *   `選択子 { 宣言 }` を読み、選択子リストは `,` で割って丸ごと一致で探す)。
 * ⚠ `@media` の中まで拾わない ── 印刷や狭い版面だけの規則で「画面の規則を
 *   消しても緑」になる。
 */
describe('CSS(畳んだ列が本当に消えるか)', () => {
  // ⚠ **注釈を先に剥ぐ** ── 剥がないと直前の注釈が選択子の一部として拾われ、
  //    丸ごと一致が 1 件も当たらない(この test 自身が 1 度そうなった)
  const css = readFileSync('src/styles/app.css', 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
  const at = css.indexOf('@media');
  const screenOnly = css.slice(0, at === -1 ? undefined : at);

  function rulesFor(selector: string): string[] {
    const out: string[] = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    for (const m of screenOnly.matchAll(re)) {
      const sels = m[1]!.split(',').map((x) => x.trim().replace(/\s+/g, ' '));
      if (sels.includes(selector)) out.push(m[2]!);
    }
    return out;
  }

  it('🔴 畳んだ列は display:none になる(印だけ付いて見えたままにしない)', () => {
    const hit = rulesFor(
      "[data-pkc-region='shell'][data-pkc-hidden-panes~='sidebar'] [data-pkc-region='sidebar']",
    );
    expect(hit.length, '左を畳む規則が無い').toBeGreaterThan(0);
    expect(hit.join(' ')).toContain('display: none');
  });

  it('🔴 畳んだぶん grid の列も減る(空の 1 列が残らない)', () => {
    for (const pane of ['sidebar', 'inspector']) {
      const hit = rulesFor(`[data-pkc-region='shell'][data-pkc-hidden-panes~='${pane}']`);
      expect(hit.length, `${pane} を畳んだときの列の定義が無い`).toBeGreaterThan(0);
      // ⚠ **部分一致で見ない** ── `grid-template-columns-x` のような別名でも
      //    `toContain` は通る(変異試験 M8 が生き延びて判明)。宣言の形で見る
      expect(
        /(^|;|\s)grid-template-columns\s*:/.test(hit.join(' ')),
        `${pane}: 列の宣言そのものが無い(別名になっている)`,
      ).toBe(true);
    }
  });
});
