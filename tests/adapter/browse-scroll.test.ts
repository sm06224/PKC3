/** @vitest-environment happy-dom */
/**
 * C10(#1045): **フォルダ表(左の列)を送って見てから離れ、戻ると同じ所**。
 *
 * > user 指示 2026-08-03「**サイドバーも同じ、スクロールが発生するすべての画面が
 * > 対象だよ**」
 *
 * 🔴 転がるのは `[data-pkc-region='browse-host']` 自身であって、
 * `[data-pkc-browse-pane]`(一覧 / フォルダ / アプリ …)は転がらない
 * (`app.css`: `browse-host` が `overflow: auto`、`browse-pane` は無い)。
 * `BrowseRouter.render()` は**毎回**(タブが変わっていない回も含めて)
 * `ScrollMemory.park()` → 中身の描画 → `ScrollMemory.use()` の順で
 * `browse-host` を挟む(`src/adapter/ui/render/browse.ts`)。
 *
 * ⚠ ここは「filer.ts 自身に ScrollMemory を持たせる」形にしていない ──
 * `browse-host` を転がしているのは `BrowseRouter` 側で、`FilerRenderer` は
 * その**子**(転がらない箱)しか持たないので、同じ箱を 2 つの `ScrollMemory` で
 * 取り合うと**後から呼んだ側が勝つ**(`use()` を 2 回呼べば後者だけが効く)。
 * 実際に検めた結果、**この面は既に `browse.ts` の 1 本で守られている**
 * (壊すと下の test が落ちる ── 検算は README に書いた)。ここは「壊れていないか」
 * を pin する回帰 test である。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter, type BrowseMode } from '../../src/adapter/ui/render/browse';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';

function meta(lid: string, order: number): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

/**
 * happy-dom の `scrollTop` は素の数値で丸めない ── `dual-filer-scroll.test.ts` と
 * 同じ理由で、`textContent` の書き込みへ割り込んで「中身が空になった瞬間 0」を
 * 自分で再現する。⚠ ここで観るのは `region`(フォルダの pane、転がらない)ではなく
 * **`host` の scrollTop**(転がる側)── `region` が空になったことを検めて、
 * `host` 側を丸める。
 */
function clampHostOnPaneClear(host: HTMLElement, pane: HTMLElement): void {
  let top = 0;
  let owner: object | null = pane;
  let desc: PropertyDescriptor | undefined;
  while (owner !== null && desc === undefined) {
    desc = Object.getOwnPropertyDescriptor(owner, 'textContent');
    owner = Object.getPrototypeOf(owner);
  }
  const origGet = desc?.get;
  const origSet = desc?.set;
  Object.defineProperty(pane, 'textContent', {
    get(): string | null {
      return origGet?.call(this) ?? null;
    },
    set(this: HTMLElement, v: string) {
      origSet?.call(this, v);
      // 🔴 本物のブラウザは、転がる箱の中身が空になった瞬間 scrollTop を 0 へ丸める
      if (this.childElementCount === 0) top = 0;
    },
    configurable: true,
  });
  Object.defineProperty(host, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      top = v;
    },
    configurable: true,
  });
}

function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  let mode: BrowseMode = 'filer';
  d.onState((s) => browse.render(s, mode));
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '',
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => stubStamps(),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  const metas: EntryMeta[] = [];
  for (let i = 0; i < 20; i++) metas.push(meta(`n${i}`, i));
  const relations: Relation[] = [];
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations });
  const setMode = (m: BrowseMode) => {
    mode = m;
    browse.render(d.getState(), mode);
  };
  const pane = root.querySelector<HTMLElement>('[data-pkc-browse-pane="filer"]')!;
  return { d, regions, setMode, pane };
}

describe('フォルダ表(左の列)のスクロール位置を覚える(C10 / #1045)', () => {
  /**
   * 🔴 **本体**: スコープを動かさずに表が作り直っても、位置を失わない。
   * `SET_ENTRY_SORT` は `filer.ts` の `listChanged` を真にする(並び順が指紋の
   * 一部)ので、フォルダを移らなくても `region.textContent = ''` が走る。
   */
  it('🔴 並べ替えでフォルダの表が作り直っても、送り位置を保つ', () => {
    const { d, regions, pane } = setup();
    clampHostOnPaneClear(regions.browseHost, pane);
    regions.browseHost.scrollTop = 500;
    expect(regions.browseHost.scrollTop, '前提: 500 まで送れる').toBe(500);

    d.dispatch({ type: 'SET_ENTRY_SORT', sort: 'title' });
    expect(d.getState().entrySort, '前提: 並びが動いた').toBe('title');

    expect(regions.browseHost.scrollTop, '並べ替えで送り位置を忘れた').toBe(500);
  });

  /**
   * 🔴 **本体その 2**: 別のタブ(アプリ)へ行って戻ると、フォルダの送り位置が残る
   * (task の文言そのまま「別の画面(…別のタブ…)へ行き、また戻ってくる」)。
   * ⚠ happy-dom は版面を持たないので、host の scrollTop 自体は clamp しない ──
   *   ここで見るのは「`use()` が最後に書いた値が残っているか」であり、
   *   `use()` を外すと**前のタブで書かれた値がそのまま残る**ことで検算する
   *   (下の kill 手順で確認済み)。
   */
  it('🔴 別のタブへ切り替えて戻ると、フォルダの送り位置を保つ', () => {
    const { setMode, regions } = setup();
    regions.browseHost.scrollTop = 500;

    setMode('launcher');
    // ⚠ アプリタブは中身が少ない ── 実ブラウザなら送れる位置も違う。ここでは
    //   「違う値を書く」ことで、フォルダのタブへ戻った回に**上書きされずに残る**か
    //   を見分けられるようにする
    regions.browseHost.scrollTop = 10;

    setMode('filer');
    expect(regions.browseHost.scrollTop, 'フォルダタブへ戻って送り位置を忘れた').toBe(500);
  });

  /**
   * ⚠ **対照群**: 表を作り直さない回(選択だけの変化)は、そもそも
   * `region.textContent = ''` を通らない ── 空振り防止(§2「未実行の経路」)。
   */
  it('選択だけの変化(表を作り直さない)では、そもそも scrollTop に触れない', () => {
    const { d, regions, pane } = setup();
    clampHostOnPaneClear(regions.browseHost, pane);
    regions.browseHost.scrollTop = 500;
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n0' });
    expect(regions.browseHost.scrollTop, '選択だけの変化で送り位置が動いた').toBe(500);
  });
});
