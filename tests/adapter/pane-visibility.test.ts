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
import { mediaBlock, stripComments } from '../helpers/css-blocks';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions, SHORTCUT_BUTTON } from '../../src/adapter/ui/actions/binder';

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
 *
 * 🔴 **`@media` の飛ばし方を変えた**(#609 / #607。2026-08-30)。
 *
 * ⚠ 直す前は `css.indexOf('@media')` で**そこから先を丸ごと捨てて**いた ──
 *   だから **`@media` の中に在る規則を 1 つも読めなかった**。#609 は
 *   「幅の版面を**原理的に見ていない**」とこの行を名指ししており、実際 #607 で
 *   狭い 2 帯に畳み版面を足したとき、この test は**何も見ていなかった**。
 * 🔑 いまは**入れ子を数えて at-rule のブロックだけを飛ばす** ── 画面の規則は
 *   file の最後まで読み、`@media` の中は読まない(元の意図はそのまま守る)。
 */
describe('CSS(畳んだ列が本当に消えるか)', () => {
  // ⚠ **注釈を先に剥ぐ** ── 剥がないと直前の注釈が選択子の一部として拾われ、
  //    丸ごと一致が 1 件も当たらない(この test 自身が 1 度そうなった)
  const css = readFileSync('src/styles/app.css', 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');

  /** `選択子 { 宣言 }` を、at-rule のブロックを飛ばしながら全部読む。 */
  function topLevelRules(): { sels: string[]; body: string }[] {
    const out: { sels: string[]; body: string }[] = [];
    let i = 0;
    while (i < css.length) {
      const open = css.indexOf('{', i);
      if (open === -1) break;
      const head = css.slice(i, open).trim();
      if (head.startsWith('@')) {
        let depth = 1;
        let j = open + 1;
        for (; j < css.length && depth > 0; j += 1) {
          if (css[j] === '{') depth += 1;
          else if (css[j] === '}') depth -= 1;
        }
        i = j;
        continue;
      }
      const close = css.indexOf('}', open);
      if (close === -1) break;
      out.push({
        sels: head.split(',').map((x) => x.trim().replace(/\s+/g, ' ')),
        body: css.slice(open + 1, close),
      });
      i = close + 1;
    }
    return out;
  }

  const TOP = topLevelRules();

  function rulesFor(selector: string): string[] {
    return TOP.filter((r) => r.sels.includes(selector)).map((r) => r.body);
  }

  /**
   * 🔴 **読み方そのものを検める**(#609。2026-08-30)。
   *
   * ⚠ この 2 件が無いと、上の `topLevelRules` を「最初の `@media` で切る」形へ
   *   戻す変更が**誰にも気づかれない** ── 戻した瞬間、下の検査は全部
   *   「規則が無い」ではなく「**読まなかった**」で緑になりうる。
   * 🔑 見るのは 2 方向:①`@media` の**後ろ**に在る画面の規則が読めること
   *   ②`@media` の**中**の規則は読まないこと。
   */
  it('🔴 @media の後ろに在る画面の規則も読む(切り捨てていない)', () => {
    // 枠を横に並べる規則(`app.css` の 5,100 行台 = 最初の `@media` より後ろ)
    const hit = rulesFor(
      "[data-pkc-view-pane='detail'][data-pkc-split='on'] [data-pkc-region='split-row']",
    );
    expect(hit.length, '@media より後ろの画面の規則を読めていない').toBeGreaterThan(0);
    expect(hit.join(''), '読めた規則の中身が空(拾い方が壊れている)').toContain('display: flex');
  });

  it('🔴 @media の中の規則は読まない(狭い版面で画面の規則を消しても緑、を作らない)', () => {
    /**
     * 錨は `@media` の中に**しか無い**もの。
     *
     * ⚠ 1 稿目は `[data-pkc-pane='inspector']` を錨にしたが、それは
     *   **top-level にも在った**(`grid-area: gripr`)ので、この test 自身が
     *   落ちて教えてくれた ── 「中にしか無い」を確かめずに錨を選んでいた。
     * 🔴 **2026-09-02 に錨を差し替えた**(#632 段①)。前の錨
     *   (`[data-pkc-region='pane-grip']:not([data-pkc-axis='y'])`)は
     *   `@media (max-width: 720px)` の中に在ったが、その版面は**スマホ用画面へ
     *   置き換えて消えた** ── 同じ綴りは top-level のスマホ規則の中に
     *   **より長い選択子の一部として**残るので、`rulesFor` は丸ごと一致で
     *   `[]` を返し続ける。⚠ つまり**錨が死んでも緑のまま**で、
     *   「@media を読み始めた」を二度と検出できなくなっていた(§1 の空振り)。
     * 🔑 いまの錨は**印刷の中にしかない**もの(全数で確かめた ── 画面の規則に
     *   同じ綴りは 1 つも無い)。
     */
    const MEDIA_ONLY = '.pkc-csv-shape';
    expect(rulesFor(MEDIA_ONLY), '@media の中まで読んでいる').toEqual([]);
    /**
     * ⚠ **空振り防止も「丸ごと一致」で取る**(2026-09-02 の着地前レビュー 8)。
     *   直す前は `toContain`(部分一致)だったが、`.pkc-csv-shape` は top-level に
     *   **`.pkc-md-rendered .pkc-csv-shape` の形で 7 本**在る ── つまり
     *   **印刷から錨を消しても両方の assert が緑**で、「@media を読み始めた」を
     *   二度と検出できなくなる(判定側は丸ごと一致なので、長い選択子は拾わない)。
     * 🔑 印刷の中に**その綴りだけの規則**が在ることを、判定と同じ読み方で確かめる。
     */
    const inPrint = mediaBlock(stripComments(readFileSync('src/styles/app.css', 'utf-8')), 'print')
      .body.match(/([^{}]+)\{[^{}]*\}/g)
      ?.flatMap((r) => r.slice(0, r.indexOf('{')).split(','))
      .map((sel) => sel.trim().replace(/\s+/g, ' '));
    expect(
      inPrint,
      '錨にした選択子が印刷の中に(その綴りのまま)無い ── この test の前提が崩れた',
    ).toContain(MEDIA_ONLY);
  });

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

  /**
   * 🔴 **畳んでも、鍵の押し先が DOM から消えない**(#582 §6 の 4 つ目)。
   *
   * ⚠ いまこれが成り立っているのは **CSS で列を落として DOM に残す**実装の
   *   おかげ ── **偶然である**。「畳んだペインを unmount する」最適化が入ると
   *   **鍵が静かに全部死ぬ**(押しても無反応。⚠ しかも**どの test も鳴らない**)。
   *
   * ⚠ **「全 selector が解決する」では書けない**(#582 の doc の言い方は強すぎた)──
   *   `insert-date` / `insert-snippet` / `start-edit` などは**編集中にしか無い**ので、
   *   素の shell では畳む前から 0 件である。
   * 🔑 だから見るのは差分:**開いているときに解決するものは、畳んでも解決する**。
   */
  it('🔴 全部畳んでも、鍵の押し先が DOM から消えない (#582)', () => {
    // ⚠ `mounted()` は別の describe の中に在る ── ここで組む(器は同じ形)
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    buildShell(root);
    bindActions(root, new Dispatcher());

    const resolves = (): string[] =>
      Object.entries(SHORTCUT_BUTTON)
        .filter(([, sel]) => root.querySelector(sel) !== null)
        .map(([cmd]) => cmd)
        .sort();

    const open = resolves();
    // ⚠ 空振り防止 ── 開いた状態で十分な数が解決している(0 件なら差分は常に一致する)
    expect(open.length, '開いた状態で 1 つも解決しない(台の空振り)').toBeGreaterThanOrEqual(8);

    applyPaneVisibility(root, [...PANES]);
    expect(
      resolves(),
      '畳んだら押し先が消えた ── 鍵が無反応になる(DOM から外す最適化が入った合図)',
    ).toEqual(open);
  });
});
