/** @vitest-environment happy-dom */
/**
 * 🔴 **左端の縦のバー**(#1982 ③-a-1。user 裁定 2026-11-22)。旧い #582 の「畳んだ縁」(`collapsed-edge`)を一本化した。
 *
 * 守る主張:
 * 1. PC の版面では、探し方のタブとアプリ全体の操作が**バーに居る**(左のペインには居ない)。ボタンは **1 組だけ**
 * 2. 左のペインを畳んでもバーは残る(#197)/ スマホ用画面ではバーを出さず、元の場所(左のペイン)へ戻す ── 往復できる
 * 3. 何度呼んでも作り直さない・動かさない(押しているボタンの焦点を飛ばさない)
 * 4. 図案だけのボタンも名前を持つ(`aria-label` + `title`)── 組み立て側の説明(鍵の綴り)は上書きしない
 * 5. バーのタブ: 畳んでいたら開いて切り替える / いま開いているタブをもう一度押すと畳む(`appPanes` 1 つを通す)
 * 6. CSS: 7 つの版面すべての 1 列目がバー / 上の群だけが縦に送る / 下の群は縮まない / スマホでは出さない
 *
 * ⚠ happy-dom は CSS を組まない ── 描いた位置・高さ・押せること・畳み / 開きは `tests/smoke/layout.smoke.spec.ts`(「設定は左端の縦のバーから押せる」の ⑦⑧)と `pane-resize.smoke.spec.ts` が見る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { appPanes, applyPaneVisibility } from '../../src/adapter/ui/render/pane-visibility';
import { collectionBarItems, markCollectionView } from '../../src/adapter/ui/render/collection-bar';
import { markBrowseTabs } from '../../src/adapter/ui/render/tabs-a11y';
import { appPhone } from '../../src/adapter/ui/render/phone-layout';
import { BROWSE_TABS } from '../../src/adapter/ui/render/browse';
import { codeOnly } from '../helpers/code-only';
import { blocksFor, mediaBlock, stripComments, withoutMedia } from '../helpers/css-blocks';

const RAIL = '[data-pkc-region="rail"]';
const TABS = '[data-pkc-region="browse-tabs"]';
const BAR = '[data-pkc-region="collection-bar"]';

function mounted(setBrowse = vi.fn()) {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  buildShell(root);
  bindActions(root, d, { setBrowse });
  applyPaneVisibility(root, appPanes.getHidden());
  return { root, d, setBrowse };
}
const rail = (root: HTMLElement): HTMLElement => root.querySelector<HTMLElement>(RAIL)!;
const sidebar = (root: HTMLElement): HTMLElement => root.querySelector<HTMLElement>('[data-pkc-region="sidebar"]')!;
const tab = (root: HTMLElement, mode: string): HTMLButtonElement =>
  root.querySelector<HTMLButtonElement>(`${TABS} [data-pkc-browse="${mode}"]`)!;
const hiddenAttr = (root: HTMLElement): string =>
  root.querySelector('[data-pkc-region="shell"]')!.getAttribute('data-pkc-hidden-panes') ?? '';

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  appPanes.setHidden([]);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('PC の版面: バーに載る(ボタンは 1 組だけ)', () => {
  it('🔴 タブと操作はバーに居て、左のペインには居ない', () => {
    const { root } = mounted();
    const r = rail(root);
    expect(r.parentElement?.getAttribute('data-pkc-region'), 'バーが shell の直下に無い').toBe('shell');
    expect(r.hidden, 'PC でバーが隠れている').toBe(false);
    expect(r.querySelector(TABS), 'タブがバーに居ない').not.toBeNull();
    expect(r.querySelector(BAR), '操作がバーに居ない').not.toBeNull();
    expect(sidebar(root).querySelector(TABS), 'タブが左のペインにも居る').toBeNull();
    expect(sidebar(root).querySelector(BAR), '操作が左のペインにも居る').toBeNull();
    // 上 = タブ、下 = 操作(並び順)
    expect(r.firstElementChild?.getAttribute('data-pkc-region')).toBe('browse-tabs');
    expect(r.lastElementChild?.getAttribute('data-pkc-region')).toBe('collection-bar');
  });

  it('🔴 同じ操作のボタンは DOM に 1 つだけ(登記簿を 2 つにしない)', () => {
    const { root } = mounted();
    const items = collectionBarItems();
    expect(items.length, '一覧が空(台の空振り)').toBeGreaterThan(5);
    for (const item of items) {
      const sel = item.view
        ? `[data-pkc-action="${item.action}"][data-pkc-view="${item.view}"]`
        : `[data-pkc-action="${item.action}"]`;
      // ⚠ 同じ action の別の押し所(情報ペインの「バックアップ(このノート)」など)は別物 ── 帯のタイルだけを数える
      const n = root.querySelectorAll(`${sel}[data-pkc-bar-tile]`).length;
      expect(n, `${sel} のタイルが ${n} 個ある`).toBe(1);
    }
    expect(root.querySelectorAll(`${TABS}`).length).toBe(1);
    expect(root.querySelectorAll(`${TABS} [data-pkc-browse="filer"]`).length).toBe(1);
    expect(root.querySelector('[data-pkc-region="collapsed-edge"]'), '旧い畳んだ縁が残っている').toBeNull();
  });

  it('🔴 左のペインを畳んでもバーは残り、戻しても同じ物のまま', () => {
    const { root } = mounted();
    const tabs = root.querySelector(TABS);
    const bar = root.querySelector(BAR);
    applyPaneVisibility(root, appPanes.setHidden(['sidebar']));
    expect(rail(root).hidden).toBe(false);
    expect(rail(root).contains(tabs) && rail(root).contains(bar), '畳んだらバーから消えた').toBe(true);
    expect(root.querySelector('[data-pkc-region="collapsed-edge"]'), '畳んだら旧い縁が出た').toBeNull();
    applyPaneVisibility(root, appPanes.setHidden([]));
    expect(root.querySelector(TABS), '作り直された').toBe(tabs);
    expect(root.querySelector(BAR), '作り直された').toBe(bar);
  });

  it('🔴 何度呼んでも動かさない(押しているボタンの焦点が飛ばない)', () => {
    const { root } = mounted();
    // ⚠ happy-dom は移しても焦点を落とさない ── 「動かしていない」はバーへの差し込み(prepend / append)の回数で見る
    const r = rail(root);
    const pre = vi.spyOn(r, 'prepend');
    const app = vi.spyOn(r, 'append');
    applyPaneVisibility(root, appPanes.getHidden());
    applyPaneVisibility(root, appPanes.getHidden());
    expect(pre.mock.calls.length + app.mock.calls.length, '描き直しでタブ / 操作の器を移し直した').toBe(0);
    const btn = tab(root, 'launcher');
    btn.focus();
    expect(document.activeElement, '前提: 焦点が当たらない').toBe(btn);
    applyPaneVisibility(root, appPanes.getHidden());
    applyPaneVisibility(root, appPanes.getHidden());
    expect(document.activeElement, '描き直しで焦点が飛んだ').toBe(btn);
    expect(tab(root, 'launcher')).toBe(btn);
  });
});

describe('スマホ用画面: バーを出さず、左のペインの元の場所へ戻す(往復)', () => {
  it('🔴 スマホ ⇄ PC を往復しても、ボタンは 1 組のまま元の場所へ戻る', () => {
    const { root } = mounted();
    const tabs = root.querySelector<HTMLElement>(TABS)!;
    const bar = root.querySelector<HTMLElement>(BAR)!;
    vi.spyOn(appPhone, 'isPhone').mockReturnValue(true);
    applyPaneVisibility(root, appPanes.getHidden());
    const side = sidebar(root);
    expect(rail(root).hidden, 'スマホでバーが出ている').toBe(true);
    expect(side.contains(tabs), 'タブが左のペインへ戻らない').toBe(true);
    expect(side.contains(bar), '操作が左のペインへ戻らない').toBe(true);
    // 元の並び: タブは探す欄のすぐ前、操作は最後
    expect(tabs.nextElementSibling?.getAttribute('data-pkc-region'), 'タブの位置が違う').toBe('find-bar');
    expect(side.lastElementChild, '操作が左のペインの最後に居ない').toBe(bar);
    expect(bar.getAttribute('role'), 'スマホでも縦のツールバーを名乗っている').toBeNull();
    expect(tabs.getAttribute('aria-orientation')).toBeNull();
    vi.mocked(appPhone.isPhone).mockReturnValue(false);
    applyPaneVisibility(root, appPanes.getHidden());
    expect(rail(root).contains(tabs) && rail(root).contains(bar), 'PC へ戻してもバーへ戻らない').toBe(true);
    expect(root.querySelectorAll(BAR).length).toBe(1);
  });
});

describe('名前(図案だけでも読める・hover で説明が出る)', () => {
  it('🔴 バーのボタンは 1 つ残らず `aria-label` と `title` を持つ', () => {
    const { root } = mounted();
    const btns = [...rail(root).querySelectorAll<HTMLButtonElement>('button')];
    // タブ(手書きは描いている間だけ ── 隠れていても名前は付ける)+ 操作 7 つ
    expect(btns.length, 'バーのボタンが少なすぎる(台の空振り)').toBeGreaterThanOrEqual(BROWSE_TABS.length + 7);
    for (const b of btns) {
      const who = `${b.getAttribute('data-pkc-action')}|${b.getAttribute('data-pkc-browse') ?? b.getAttribute('data-pkc-view') ?? ''}`;
      expect(b.getAttribute('aria-label') ?? '', `${who}: 読み上げの名前が無い`).not.toBe('');
      expect(b.title, `${who}: hover の説明が無い`).not.toBe('');
    }
    // タブの名前は画面の字(`BROWSE_TABS` の label)と同じ
    for (const { mode, label } of BROWSE_TABS) expect(tab(root, mode).getAttribute('aria-label'), mode).toBe(label);
    expect(rail(root).querySelector(TABS)!.getAttribute('aria-orientation')).toBe('vertical');
    expect(rail(root).querySelector(BAR)!.getAttribute('role')).toBe('toolbar');
  });

  it('🔴 組み立て側の説明(鍵の綴り)を名前で上書きしない', () => {
    const { root } = mounted();
    const palette = rail(root).querySelector<HTMLButtonElement>('[data-pkc-action="open-palette"]')!;
    expect(palette.title, '「操作を探す」の鍵の綴りが消えた').toContain('Ctrl + Shift + P');
  });
});

describe('押したときの振る舞い', () => {
  it('🔴 バーの「システム」を押すと、システムの面が開く(受け手は今までどおり)', () => {
    const { root, d } = mounted();
    expect(d.getState().viewMode, '前提: 押す前から開いている').not.toBe('settings');
    rail(root).querySelector<HTMLElement>('[data-pkc-action="set-view"][data-pkc-view="settings"]')!.click();
    expect(d.getState().viewMode).toBe('settings');
  });

  it('🔴 いま開いているタブをもう一度押すと左のペインを畳み、もう一度押すと開く(片道にしない)', () => {
    const { root, setBrowse } = mounted();
    markBrowseTabs(root.querySelector(TABS)!, 'filer');
    // 対照群: 開いていないタブは切り替えるだけ
    tab(root, 'launcher').click();
    expect(setBrowse).toHaveBeenLastCalledWith('launcher');
    expect(appPanes.getHidden(), '別のタブで畳んだ').not.toContain('sidebar');
    setBrowse.mockClear();
    tab(root, 'filer').click();
    expect(appPanes.getHidden(), 'いまのタブを押しても畳まない').toContain('sidebar');
    expect(hiddenAttr(root), '畳んだ事実が画面に写っていない').toContain('sidebar');
    expect(setBrowse, '畳むときに切り替えまで走った').not.toHaveBeenCalled();
    tab(root, 'filer').click();
    expect(appPanes.getHidden(), 'もう一度押しても開かない').not.toContain('sidebar');
    expect(hiddenAttr(root)).not.toContain('sidebar');
    expect(setBrowse).toHaveBeenLastCalledWith('filer');
  });

  it('🔴 わきの面(システム等)が開いている間は、いまのタブを押しても畳まず「閉じて本文へ戻る」(帰り道を消さない)', () => {
    const { root, d, setBrowse } = mounted();
    markBrowseTabs(root.querySelector(TABS)!, 'filer');
    rail(root).querySelector<HTMLElement>('[data-pkc-action="set-view"][data-pkc-view="settings"]')!.click();
    expect(d.getState().viewMode, '前提: システムが開かない').toBe('settings');
    tab(root, 'filer').click();
    expect(appPanes.getHidden(), 'わきの面が開いているのに畳んだ').not.toContain('sidebar');
    expect(setBrowse, '帰り道(setBrowse → わきの面を閉じる)が走らない').toHaveBeenLastCalledWith('filer');
  });

  it('🔴 畳んでいる間に別のタブを押すと、開いてからそのタブへ', () => {
    const { root, setBrowse } = mounted();
    markBrowseTabs(root.querySelector(TABS)!, 'filer');
    applyPaneVisibility(root, appPanes.setHidden(['sidebar', 'inspector']));
    tab(root, 'schedule').click();
    expect(appPanes.getHidden(), '畳んだまま切り替えた').not.toContain('sidebar');
    expect(appPanes.getHidden(), '右のペインまで開いた').toContain('inspector');
    expect(setBrowse).toHaveBeenLastCalledWith('schedule');
  });

  it('🔴 バーの外の「探し方」ボタン(本文の中など)とスマホでは畳まない', () => {
    const { root, setBrowse } = mounted();
    markBrowseTabs(root.querySelector(TABS)!, 'launcher');
    const outside = document.createElement('button');
    outside.setAttribute('data-pkc-action', 'set-browse');
    outside.setAttribute('data-pkc-browse', 'launcher');
    root.querySelector('[data-pkc-region="center"]')!.append(outside);
    outside.click();
    expect(appPanes.getHidden(), 'バーの外のボタンで畳んだ').not.toContain('sidebar');
    expect(setBrowse).toHaveBeenLastCalledWith('launcher');
    vi.spyOn(appPhone, 'isPhone').mockReturnValue(true);
    applyPaneVisibility(root, appPanes.getHidden());
    tab(root, 'launcher').click();
    expect(appPanes.getHidden(), 'スマホで畳んだ').not.toContain('sidebar');
  });

  it('🔴 いま開いている面の印はバーのボタンに付く(1 組なので、そこにしか付かない)', () => {
    const { root } = mounted();
    markCollectionView(root, 'help');
    const active = [...root.querySelectorAll('[data-pkc-active][data-pkc-view]')].map((b) => b.getAttribute('data-pkc-view'));
    expect(active).toEqual(['help']);
    expect(rail(root).querySelector('[data-pkc-view="help"]')!.hasAttribute('data-pkc-active')).toBe(true);
  });
});

describe('🔴 バーを組む file は、操作の字・action を 1 つも自分では書いていない(器を移すだけ)', () => {
  it('一覧の字・action が `rail.ts` に無い', () => {
    const code = codeOnly(readFileSync(join(__dirname, '../../src/adapter/ui/render/rail.ts'), 'utf-8'));
    expect(code.length, 'コメント落としが本体まで消した').toBeGreaterThan(500);
    const words = [
      ...collectionBarItems().flatMap((i) => [i.action, i.label]),
      ...BROWSE_TABS.flatMap((t) => [t.mode, t.label]),
    ];
    for (const word of words) expect(code, `rail.ts に「${word}」を手で書いている`).not.toContain(`'${word}'`);
  });
});

describe('CSS(原文)', () => {
  const css = stripComments(readFileSync(join(__dirname, '../../src/styles/app.css'), 'utf-8'));
  const desktop = withoutMedia(css);
  const tablet = mediaBlock(css, '(max-width: 1100px)').body;

  it('🔴 バーの幅は 40px = タイル 32px + 左右 4px', () => {
    const shell = blocksFor(desktop, "[data-pkc-region='shell']").join('\n');
    const w = Number(/--pkc-rail-w:\s*(\d+)px/.exec(shell)?.[1]);
    expect(w, '`--pkc-rail-w` が読めない').toBe(40);
    const tile = Number(/width:\s*(\d+)px/.exec(blocksFor(desktop, '[data-pkc-bar-tile]').join('\n'))?.[1]);
    expect(tile).toBe(32);
    expect(css, '旧い縁の変数が残っている').not.toContain('--pkc-edge-w');
    expect(css, '旧い縁の規則が残っている').not.toContain('collapsed-edge');
  });

  it('🔴 7 つの版面すべてで、1 列目がバー・1 行目の頭が `rail`', () => {
    const sels = [
      [desktop, "[data-pkc-region='shell']"],
      [desktop, "[data-pkc-region='shell'][data-pkc-hidden-panes~='inspector']"],
      [desktop, "[data-pkc-region='shell'][data-pkc-hidden-panes~='sidebar']"],
      [desktop, "[data-pkc-region='shell'][data-pkc-hidden-panes~='sidebar'][data-pkc-hidden-panes~='inspector']"],
      [tablet, "[data-pkc-region='shell']"],
      [tablet, "[data-pkc-region='shell'][data-pkc-hidden-panes~='inspector']"],
      [tablet, "[data-pkc-region='shell'][data-pkc-hidden-panes~='sidebar']"],
    ] as const;
    let n = 0;
    for (const [src, sel] of sels) {
      for (const b of blocksFor(src, sel).filter((x) => /grid-template-columns/.test(x))) {
        n++;
        const cols = /grid-template-columns:\s*([^;]+);/.exec(b)![1]!.trim();
        expect(cols.startsWith('var(--pkc-rail-w) '), `${sel}: 1 列目がバーでない: ${cols}`).toBe(true);
        const rows = [...(/grid-template-areas:([^;]+);/.exec(b)?.[1] ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1]!.trim().split(/\s+/));
        expect(rows.length, `${sel}: 区画が読めない`).toBeGreaterThan(5);
        // 括弧の外の空白で切る(`var(--x, minmax(1px, 2vw))` は 1 列)。⚠ 改行と字下げを 1 つの空白へ寄せてから数える
        const flat = cols.replace(/\s+/g, ' ');
        let depth = 0;
        let width = 1;
        for (const ch of flat) {
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
          else if (ch === ' ' && depth === 0) width++;
        }
        expect(rows[0]![0], `${sel}: 1 行目の頭がバーでない`).toBe('rail');
        for (const r of rows) expect(r.length, `${sel}: 列の数と区画の数が違う: ${r.join(' ')}`).toBe(width);
      }
    }
    expect(n, '版面が読めない(空振り)').toBe(7);
  });

  it('🔴 紙(印刷)にはバーを出さない(常設なので、落とさないと紙の頭にボタンが並ぶ)', () => {
    const print = mediaBlock(css, 'print').body;
    const hidden = blocksFor(print, "[data-pkc-region='rail']").filter((b) => /display:\s*none/.test(b));
    expect(hidden.length, '印刷の「紙に要らない面」にバーが無い').toBeGreaterThan(0);
  });

  it('🔴 上の群(タブ)だけが縦に送る・下の群(操作)は縮まない・スマホでは出さない', () => {
    const tabs = blocksFor(desktop, "[data-pkc-region='rail'] [data-pkc-region='browse-tabs']").join('\n');
    expect(tabs).toMatch(/overflow-y:\s*auto/);
    expect(tabs).toMatch(/min-height:\s*0/);
    expect(tabs).toMatch(/flex:\s*1 1 auto/);
    const bar = blocksFor(desktop, "[data-pkc-region='rail'] [data-pkc-region='collection-bar']").join('\n');
    expect(bar, '下の群が縮む(押せない物が出る)').toMatch(/flex:\s*none/);
    const railRule = blocksFor(desktop, "[data-pkc-region='rail']").join('\n');
    expect(railRule).toMatch(/grid-area:\s*rail/);
    expect(railRule, 'バー自身が送ると下の群が隠れる').toMatch(/overflow:\s*hidden/);
    const phone = blocksFor(desktop, "[data-pkc-region='shell'][data-pkc-layout='phone'] [data-pkc-region='rail']").join('\n');
    expect(phone).toMatch(/display:\s*none/);
  });
});
