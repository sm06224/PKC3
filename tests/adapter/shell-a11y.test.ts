/** @vitest-environment happy-dom */
/**
 * 🔴 **読み上げと鍵だけで使う人への手当て**(#720。cowork 評価レポート)。
 *
 * ## この面が守っているもの
 *
 * ① タブの帯が、読み上げにも**タブの列**として届く(`role` / `aria-selected`)
 * ④ 列を飛ばして本題へ行く近道が在り、**アドレスの断片を書き換えない**
 * ⑤ `<nav>` / `<aside>` / `<dialog>` に**名前**が付いている
 *
 * ⚠ **`aria-selected` は「立っているか」だけ見ても足りない** ── 建てるときに
 *   1 枚だけ `true` を焼けば通ってしまう。🔑 だから**探し方を変えると印が移る**
 *   ところまで見る(CLAUDE.md §1「1 回だけ効いて固まる形」)。
 *
 * ⚠ **見えているかどうかは、ここでは見られない** ── happy-dom は版面を組まないので、
 *   近道が「焦点のときだけ出る」ことは実ブラウザにしか無い(規則は `app.css`。
 *   `:focus-within` で引き戻す形は、この test の範囲外である)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { markBrowseTabs } from '../../src/adapter/ui/render/tabs-a11y';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { appPanes } from '../../src/adapter/ui/render/pane-visibility';
import {
  DIALOG_REGION,
  confirmInApp,
  resetAppDialogForTest,
} from '../../src/adapter/ui/render/app-dialog';
import { codeOnly } from '../helpers/code-only';

let root: HTMLElement;

function mount(): HTMLElement {
  document.body.innerHTML = '';
  root = document.createElement('div');
  // ⚠ `toggle-pane` は `closest('[data-pkc-slot="root"]')` で器を探す
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  buildShell(root);
  bindActions(root, new Dispatcher());
  return root;
}

const q = <T extends HTMLElement>(s: string): T | null => root.querySelector<T>(s);
const all = (s: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(s)];

beforeEach(() => {
  appPanes.setHidden([]);
  resetAppDialogForTest();
  mount();
});

describe('① タブの帯が、読み上げにもタブとして届く(#720)', () => {
  it('🔴 帯は tablist、1 枚 1 枚は tab を名乗る', () => {
    const tabs = q('[data-pkc-region="browse-tabs"]')!;
    expect(tabs.getAttribute('role'), 'タブの帯が「押しボタンの群れ」に聞こえる').toBe('tablist');
    const btns = all('[data-pkc-region="browse-tabs"] [data-pkc-browse]');
    // 空振り防止 ── タブが 0 枚なら、下の全数検査は「全部通った」と言ってしまう
    expect(btns.length, 'タブが 1 枚も無い').toBeGreaterThan(1);
    for (const b of btns) {
      expect(b.getAttribute('role'), `${b.getAttribute('data-pkc-browse')} が tab を名乗らない`)
        .toBe('tab');
      /**
       * ⚠ **選んでいない側にも書く** ── 属性ごと落とすと「選べるもの」ではなく
       *   「ただの押しボタン」として読まれる。
       */
      expect(
        b.hasAttribute('aria-selected'),
        `${b.getAttribute('data-pkc-browse')} に aria-selected が無い`,
      ).toBe(true);
    }
  });

  /**
   * 🔴 **印が「移る」ことまで見る**(#720)。
   * ⚠ 建てるときに 1 枚だけ `true` を焼く実装でも、上の test は通る ──
   *   それだと**探し方を切り替えても耳には古いまま**になる(目には正しい、という
   *   いちばん気づけない食い違い)。
   */
  it('🔴 探し方を変えると、選んでいる印が移る(目と耳が同時に動く)', () => {
    const sel = (): string[] =>
      all('[data-pkc-region="browse-tabs"] [aria-selected="true"]').map(
        (b) => b.getAttribute('data-pkc-browse') ?? '',
      );
    const marked = (): string[] =>
      all('[data-pkc-region="browse-tabs"] [data-pkc-active]').map(
        (b) => b.getAttribute('data-pkc-browse') ?? '',
      );

    markBrowseTabs(root, 'filer');
    expect(sel(), '耳の印が 1 枚に定まらない').toEqual(['filer']);
    expect(marked(), '目の印が 1 枚に定まらない').toEqual(['filer']);

    markBrowseTabs(root, 'launcher');
    expect(sel(), '探し方を変えても耳の印が動かない').toEqual(['launcher']);
    // 🔑 目と耳が**同じ 1 回で**動く(片方だけ更新する経路を作らない)
    expect(marked(), '探し方を変えても目の印が動かない').toEqual(['launcher']);
  });

  /**
   * 🔑 **綴りは 1 か所から出す**(CLAUDE.md §7)── タブの帯はこの repo に 2 つ
   *   (左の列と 2 ペイン)在り、直す前は **2 ペインの側にだけ**名乗りが在った。
   * ⚠ 片方だけ直す形に戻ったら、ここが落ちる。
   */
  it('🔴 2 つのタブの帯が、同じ関数を通っている', () => {
    for (const f of ['src/adapter/ui/render/shell.ts', 'src/adapter/ui/render/dual-filer.ts']) {
      const src = codeOnly(readFileSync(f, 'utf-8'));
      expect(src, `${f} が tab の role を直書きしている`).not.toMatch(
        /setAttribute\(\s*'role',\s*'tab(list)?'\s*\)/,
      );
      expect(src, `${f} が tabs-a11y を通っていない`).toContain("from './tabs-a11y'");
    }
  });
});

describe('④ 列を飛ばす近道(#720)', () => {
  it('🔴 近道は root の先頭に在り、2 本ある', () => {
    const skip = root.firstElementChild;
    expect(
      skip?.getAttribute('data-pkc-region'),
      '近道が先頭に無い(Tab の 1 回目で当たらない)',
    ).toBe('skip-links');
    expect([...skip!.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      '本文へ',
      '情報へ',
    ]);
  });

  /**
   * 🔴 **アドレスの断片を書き換えない**(#720)。
   *
   * ⚠ PKC3 は hash を**ディープリンク**に使っている(`#pkc?entry=…`)ので、
   *   `<a href="#…">` にすると押した瞬間に**いま開いているノートの住所が消える** ──
   *   読み込み直すと別のものが開き、栞も壊れる(いちばん気づけない壊れ方)。
   * 🔑 だから**器の型**(`<a href="#">` でないこと)と**実際に hash が動かないこと**の
   *   両方を見る ── 型だけ見ると `location.hash = …` を書く実装が素通りする。
   */
  it('🔴 押してもアドレスの断片を書き換えない', () => {
    const skip = q('[data-pkc-region="skip-links"]')!;
    expect(skip.querySelector('a[href^="#"]'), 'hash を踏む <a> が居る').toBeNull();
    location.hash = '#pkc?entry=abc';
    for (const b of skip.querySelectorAll<HTMLElement>('button')) b.click();
    expect(location.hash, '近道がディープリンクを踏み潰した').toBe('#pkc?entry=abc');
  });

  it('🔴 押すと、その面へ焦点が移る', () => {
    q<HTMLElement>('[data-pkc-skip="detail"]')!.click();
    expect(
      document.activeElement?.getAttribute('data-pkc-region'),
      '本文へ移れていない(無言の dead click)',
    ).toBe('detail');

    q<HTMLElement>('[data-pkc-skip="inspector"]')!.click();
    expect(document.activeElement?.getAttribute('data-pkc-region')).toBe('inspector');
  });

  /**
   * 🔴 **畳まれている列へは、開けてから移る**(#720)。
   * ⚠ ここが無いと、情報の列を畳んでいる user にとって「情報へ」は**無言の
   *   dead click** になる(押しても何も起きず、理由も出ない)。
   * 🔑 開けるのは**畳み帯の同じボタン**を押すことで行う ── 畳みの規則を
   *   ここに書き写さない(§7)。
   */
  it('🔴 畳んでいる列へも移れる(押すと開いてから焦点が入る)', () => {
    appPanes.setHidden(['inspector']);
    const shell = q('[data-pkc-region="shell"]')!;
    shell.setAttribute('data-pkc-hidden-panes', 'inspector');
    // 前提の検算 ── 台が本当に「畳んでいる」か
    expect(shell.getAttribute('data-pkc-hidden-panes'), '台が畳めていない').toContain('inspector');

    q<HTMLElement>('[data-pkc-skip="inspector"]')!.click();
    expect(appPanes.getHidden(), '畳んだままにされた(押しても何も起きない)').not.toContain(
      'inspector',
    );
    expect(document.activeElement?.getAttribute('data-pkc-region')).toBe('inspector');
  });

  /**
   * 🔑 **対照群** ── 畳んでいない列を押しても、畳みの状態は 1 ドットも動かさない
   *   (「押すたびに開け閉めする」実装と区別する)。
   */
  it('畳んでいない列を押しても、畳みの状態は動かない', () => {
    appPanes.setHidden(['sidebar']);
    q<HTMLElement>('[data-pkc-skip="inspector"]')!.click();
    expect(appPanes.getHidden()).toEqual(['sidebar']);
  });
});

describe('⑤ 面とダイアログに名前が付いている(#720)', () => {
  it('🔴 一覧と情報の列が、画面の字と同じ名前で読まれる', () => {
    expect(q('[data-pkc-region="sidebar"]')!.tagName).toBe('NAV');
    expect(q('[data-pkc-region="sidebar"]')!.getAttribute('aria-label')).toBe('一覧');
    expect(q('[data-pkc-region="inspector"]')!.tagName).toBe('ASIDE');
    expect(q('[data-pkc-region="inspector"]')!.getAttribute('aria-label')).toBe('情報');
  });

  /**
   * 🔴 **指している先が実在すること**まで見る(CLAUDE.md §1)。
   * ⚠ `aria-labelledby` が在るだけの検査は、**壊れた id を指していても通る** ──
   *   そのとき読み上げは名前を 1 文字も得られない(付けていないのと同じ)。
   */
  it('🔴 ダイアログの名前が、実在する題名を指している', async () => {
    const host = document.createElement('div');
    root.append(host);
    const p = confirmInApp(host, '3 件を削除しますか?');
    const dialog = document.querySelector<HTMLElement>(`[data-pkc-region="${DIALOG_REGION}"]`)!;
    const id = dialog.getAttribute('aria-labelledby');
    expect(id, 'ダイアログに名前が無い(「やめる、ボタン」から読み始まる)').toBeTruthy();
    const labelled = document.getElementById(id!);
    expect(labelled, `aria-labelledby が実在しない id(${id})を指している`).not.toBeNull();
    expect(labelled!.textContent, '名前が空(何のダイアログか読めない)').toBe('確認');
    dialog.querySelector<HTMLElement>('[data-pkc-field="dialog-cancel"]')!.click();
    await p;
  });

  /**
   * 🔴 **開いている題名は `h1`**(#720)。⚠ 直す前、アプリの document には
   *   `h1` が 1 つも無く、読み上げの見出し一覧から「いま何を開いているか」が
   *   読めなかった。⚠ 見た目は変わらない(`font-size` は CSS が明示している)。
   */
  it('🔴 開いているノートの題名は h1 で描かれる', async () => {
    // ⚠ **描いた DOM を見る**(source の字面ではなく)── 題名を組み立てる所は
    //    2 か所あるので、片方だけ直した形をここで落とす
    const host = document.createElement('div');
    host.setAttribute('data-pkc-region', 'detail');
    document.body.append(host);
    const center = new CenterRouter(host, undefined, null, undefined, undefined);
    const d = new Dispatcher();
    d.onState((s) => center.render(s));
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [{ lid: 'a', title: '資料 A', archetype: 'text' }] as never,
      relations: [],
    });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '# 中の見出し' });
    for (let i = 0; i < 12; i += 1) await Promise.resolve();

    const title = host.querySelector('[data-pkc-field="detail-title"]');
    // 空振り防止 ── 題名が描かれていなければ、下の段の検査は何も見ていない
    expect(title, '題名が描かれていない(台が崩れている)').not.toBeNull();
    expect(title!.textContent).toBe('資料 A');
    expect(title!.tagName, '題名の段が h1 でない(見出し一覧の最上段が欠ける)').toBe('H1');
  });
});
