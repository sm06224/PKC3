/** @vitest-environment happy-dom */
/**
 * 🔴 **アプリのタイルを右クリックして、その 1 回だけ開き方を選ぶ**(#884 段②。
 * user 要望 2026-09-13「デフォルト選択の他に右クリックからの起動が選べるとなお良い」)。
 *
 * ## なぜ専用の test が要るか
 *
 * `launch-tile.test.ts` は「その場の指定が `launchTile` に効くこと」を見ており、
 * `entry-actions.test.ts` は「メニューに出す項目に受け手があること」を見ている。
 * ⚠ **その間の配線**(右クリック → メニューの項目 → `open-tile-as` →
 * `services.openTileAs`)は、どちらの test も通らない
 * (CLAUDE.md §7「A と B が合意していることは、どちらの test にも書けない」)。
 *
 * 🔑 ここで守るのは 3 つ:
 * ① 右クリックすると、いまの設定に印が付いた 2 項目が出る
 * ② 選ぶと `services.openTileAs` が呼ばれる(`services.openTile` ではない)
 * ③ **選んだ 1 回だけ効いて、設定は変わらない** ── 選んだ後にふつうに 2 回押すと、
 *   `services.setAppOpenTarget` を経由せず `services.openTile` が呼ばれる
 *   (= 保存された設定は 1 バイトも変わっておらず、いつもどおり動く)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { LauncherRenderer } from '../../src/adapter/ui/render/launcher';
import { withBuiltinTiles, type LauncherTile } from '../../src/features/launcher/tiles';
import { chooseAppOpenTarget } from '../../src/adapter/ui/render/app-open-target';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: lid,
    archetype: 'attachment',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

/** 動かせるタイル(kind: 'url')1 枚 + 組み込み。 */
const TILES = (): LauncherTile[] =>
  withBuiltinTiles(
    [{ lid: 'a1', title: '電卓', group: '', kind: 'url', url: 'https://a.test/' }],
    { office: false },
  );

let root: HTMLElement;
let region: HTMLElement;
let d: Dispatcher;
let openTileCalls: string[];
let openTileAsCalls: Array<{ lid: string; target: string }>;
let setAppOpenTargetCalls: string[];
let detach: () => void;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);
  region = document.createElement('div');
  root.append(region);
  const r = new LauncherRenderer(region);
  d = new Dispatcher();
  openTileCalls = [];
  openTileAsCalls = [];
  setAppOpenTargetCalls = [];
  detach = bindActions(root, d, {
    openTile: (lid) => void openTileCalls.push(lid),
    openTileAs: (lid, target) => void openTileAsCalls.push({ lid, target }),
    setAppOpenTarget: (target) => void setAppOpenTargetCalls.push(target),
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a1')], relations: [] });
  d.dispatch({ type: 'LAUNCHER_TILES_LOADED', tiles: TILES() });
  d.onState(() => r.render(d.getState()));
  r.render(d.getState());
});

afterEach(() => {
  detach();
});

const tileEl = (lid: string): HTMLElement => {
  const el = region.querySelector<HTMLElement>(`[data-pkc-tile="${lid}"]`);
  expect(el, `タイル ${lid} が描かれていない(空振り防止)`).not.toBeNull();
  return el!;
};
const rightClick = (lid: string): void => {
  tileEl(lid).dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }),
  );
};
const menuItem = (target: 'tab' | 'window'): HTMLElement | null =>
  root.querySelector<HTMLElement>(
    `[data-pkc-region="context-menu"] [data-pkc-action="open-tile-as"][data-pkc-open-target="${target}"]`,
  );
const press = (lid: string): void => void tileEl(lid).click();

describe('その 1 回だけの開き方(#884 段②)', () => {
  it('🔴 ① 右クリックすると、いまの設定に「(既定)」の印が付いた 2 項目が出る', () => {
    // 前提: 設定は既定(ブラウザのタブ)のまま
    rightClick('a1');
    const tab = menuItem('tab');
    const win = menuItem('window');
    expect(tab, 'タブの項目が出ていない').not.toBeNull();
    expect(win, '窓の項目が出ていない').not.toBeNull();
    expect(tab!.textContent, '既定の印が無い').toContain('(既定)');
    expect(win!.textContent, '既定でないほうにまで印が付いている').not.toContain('(既定)');
    // ⚠ 動詞で書く(設定画面の札をそのまま出さない)── 押すと何が起きるかで読める
    expect(tab!.textContent).toContain('ブラウザのタブで開く');
    expect(win!.textContent).toContain('別のウィンドウで開く');
  });

  it('🔴 ①b 「別の窓」を設定にしていれば、印はそちらへ移る(対照群)', () => {
    chooseAppOpenTarget('window');
    rightClick('a1');
    expect(menuItem('window')!.textContent, '設定を変えても印が動かない').toContain('(既定)');
    expect(menuItem('tab')!.textContent).not.toContain('(既定)');
  });

  it('🔴 ② 選ぶと openTileAs が呼ばれる(openTile は呼ばれない)', () => {
    rightClick('a1');
    menuItem('window')!.click();
    expect(openTileAsCalls, 'openTileAs が呼ばれていない').toEqual([{ lid: 'a1', target: 'window' }]);
    expect(openTileCalls, '普段の起動口まで呼んでしまっている(二重に開く)').toEqual([]);
  });

  /**
   * 🔴 ③ **守っているのは「1 回だけ効いて、設定は変わらないこと」である。**
   * ⚠ ここで確かめられるのは binder の配線までで、「設定が本当に書き換わって
   *   いないか」は `chooseAppOpenTarget` を経由したかどうかで見る ──
   *   `setAppOpenTargetCalls` が空のままなら、`main.ts` の `setAppOpenTarget` を
   *   1 度も経由していない(保存する口を通っていない)。
   */
  it('🔴 ③ 選んだ後、設定を保存する口(setAppOpenTarget)は 1 度も通らない', () => {
    rightClick('a1');
    menuItem('window')!.click();
    expect(
      setAppOpenTargetCalls,
      '右クリックのメニューが設定の保存口を経由している(= 恒久に変わる)',
    ).toEqual([]);
  });

  /**
   * 🔴 ③b **選んだ後、ふつうに押すと `openTile`(設定どおり)へ戻る。**
   * ⚠ これが無いと「その場だけ」を主張する assert が無いのと同じ ──
   *   `openTileAs` が呼べることだけを見ても、「次から `openTile` も
   *   `openTileAs` のふりをして開く」ような取り違えは検出できない。
   */
  it('🔴 ③b 選んだ後にふつうに 2 回押すと、いつもどおり openTile が開く', () => {
    rightClick('a1');
    menuItem('window')!.click();
    // ⚠ 1 回目は印を付けるだけ(#857 段①b)、2 回目で開く
    press('a1');
    press('a1');
    expect(openTileCalls, 'ふつうの起動口(設定どおり)が呼ばれていない').toEqual(['a1']);
    // ⚠ 直前にメニューから選んだ回数の**ぶんだけ増えていない**こと
    //   (= その 1 回に閉じている。積み残しが無い)
    expect(openTileAsCalls, 'メニューの選択がふつうの起動にも紛れ込んでいる').toEqual([
      { lid: 'a1', target: 'window' },
    ]);
  });

  /**
   * 🔴 **組み込みアプリのタイルも、開き方の 2 項目だけは出す**(依頼 69-B4。Gemini 裁定 = #1163 への依頼 69 の回答)。
   * ⚠ 並べ替えの項目は出さない(組み込みは動かせない)。⚠ 開き方が効くのは別のウィンドウで開く面のタイルだけ
   *   ── マニュアル・Office・「自分のパソコンで動かす」は押しても何も変わらないので出さない。
   */
  it('🔴 組み込みの面のタイル(予定表など)は、開き方の 2 項目だけが出る(並べ替えは出ない)', () => {
    chooseAppOpenTarget('window'); // 設定を窓にしても、組み込みの面の印はタブのまま
    const dual = region.querySelector<HTMLElement>('[data-pkc-tile="builtin:dual"]');
    expect(dual, '前提が崩れている(組み込みタイルが描かれていない)').not.toBeNull();
    dual!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }),
    );
    expect(menuItem('tab'), 'タブの項目が出ていない').not.toBeNull();
    expect(menuItem('window'), '窓の項目が出ていない').not.toBeNull();
    // 組み込みの面は設定に従わず、ふだんはいつもタブで開く ── 印はタブに付く(設定を窓にしても動かさない)
    expect(menuItem('tab')!.textContent).toContain('(既定)');
    expect(menuItem('window')!.textContent).not.toContain('(既定)');
    expect(
      root.querySelectorAll('[data-pkc-region="context-menu"] [data-pkc-action]').length,
      '開き方の 2 項目以外が混ざっている(並べ替えなど)',
    ).toBe(2);
    menuItem('window')!.click();
    expect(openTileAsCalls, '選んだ開き方が配線に届いていない').toEqual([{ lid: 'builtin:dual', target: 'window' }]);
  });

  it('⚠ 開き方を持たない組み込みタイル(マニュアル・自分のパソコンで動かす)には出さない(対照群)', () => {
    for (const lid of ['builtin:manual', 'builtin:selfhost']) {
      const el = region.querySelector<HTMLElement>(`[data-pkc-tile="${lid}"]`);
      expect(el, `前提が崩れている(${lid} が描かれていない)`).not.toBeNull();
      el!.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }),
      );
      expect(menuItem('tab'), `${lid} に効かない選択肢を出している`).toBeNull();
      expect(menuItem('window'), `${lid} に効かない選択肢を出している`).toBeNull();
    }
  });

  it('🔴 「自分のパソコンで動かす」にマウスを載せると、押すと何が起きるかが出る(依頼 69-B3)', () => {
    const el = region.querySelector<HTMLElement>('[data-pkc-tile="builtin:selfhost"]');
    expect(el, '前提が崩れている').not.toBeNull();
    expect(el!.title).toBe('押すと、自分のパソコンで PKC3 を動かすための zip を作って保存します');
    // 対照群:ほかの組み込みタイルには、この説明が付いていない
    expect(region.querySelector<HTMLElement>('[data-pkc-tile="builtin:manual"]')!.title).not.toContain('zip');
  });

  /**
   * 🔴 **左の絞り込み中も、PKC の右クリックメニューが出る**(#1087)。
   * ⚠ 絞り込み中は掴ませない(`draggable` を付けない)ので、以前は `[draggable]` で探す右クリックの枝が外れ、
   *   ブラウザのメニューが出ていた。開き方の 2 項目は出し、並べ替えの項目は(掴めないので)出さない。
   */
  it('🔴 絞り込み中でも、アプリのタイルに開き方の 2 項目が出る(並べ替えは出ない)', () => {
    // 前提(対照群): 絞り込んでいないときは掴めて、並べ替えの項目も出る
    expect(tileEl('a1').getAttribute('draggable')).toBe('true');
    rightClick('a1');
    expect(
      root.querySelector('[data-pkc-region="context-menu"] [data-pkc-action="start-tile-reorder"]'),
      '前提が崩れている(絞り込み前に並べ替えの項目が無い)',
    ).not.toBeNull();
    root.querySelector('[data-pkc-region="context-menu"]')?.remove();

    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '電卓' });
    expect(tileEl('a1').hasAttribute('draggable'), '前提が崩れている(絞り込み中も掴める)').toBe(false);
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1, clientY: 1 });
    tileEl('a1').dispatchEvent(ev);
    expect(ev.defaultPrevented, 'ブラウザのメニューが出る(PKC のメニューに差し替わっていない)').toBe(true);
    expect(menuItem('tab'), 'タブの項目が出ていない').not.toBeNull();
    expect(menuItem('window'), '窓の項目が出ていない').not.toBeNull();
    expect(
      root.querySelectorAll('[data-pkc-region="context-menu"] [data-pkc-action]').length,
      '開き方の 2 項目以外(並べ替え)が絞り込み中に出ている',
    ).toBe(2);
    menuItem('window')!.click();
    expect(openTileAsCalls).toEqual([{ lid: 'a1', target: 'window' }]);
  });
});
