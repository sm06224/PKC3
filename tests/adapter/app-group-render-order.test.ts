/** @vitest-environment happy-dom */
/**
 * 🔴 **アプリの一覧の「グループの並び順」が画面に出ているか**(#857 段③、描画)。
 *
 * ⚠ 段③ の変異試験で、描画側の 3 件(M16 / M17 / M18)が SURVIVED した ──
 *   理由は 1 つ:**既存の test の fixture が「名前の付いたグループを 1 つしか
 *   持っていない」**ため。1 つしか無いと、並べ替えを外しても頭尾の分割を外しても
 *   **表示順が変わらない**ので、どの変異も見分けられない
 *   (CLAUDE.md §2「fixture のゼロ件次元」の、**1 通りに潰れている**顔)。
 *
 * 意味論(`sortGroupNames` の規則そのもの)は `tests/features/app-group-spec.test.ts`。
 * **ここが見るのは繋がり**である ── `state.appGroupOrders` が
 * `LauncherRenderer` の見出しの並びへ本当に届くか。
 */
import { describe, expect, it } from 'vitest';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { LauncherRenderer } from '../../src/adapter/ui/render/launcher';
import { GroupFoldStore } from '../../src/adapter/ui/render/group-fold';
import {
  BUILTIN_GROUP,
  withBuiltinTiles,
  type LauncherTile,
} from '../../src/features/launcher/tiles';
import type { AppGroupOrders } from '../../src/features/launcher/app-group-spec';

/**
 * 🔑 **名前の付いたグループを 3 つ**、しかも**取込順(raw の並び)を、
 * 番号で並べ替えた後の並びとわざとずらす**。
 *
 * ⚠ raw の順は「う → あ → い」だが、番号は **う=最小 / い=中間 / あ=最大** を
 *   割り当てる(呼び側で決める)── 並べ替えを外すと**必ず**見え方が変わる形にする。
 *   1 群しか無いと、並べ替えを外しても頭尾を外しても表示順が動かない
 *   (この file を書く理由そのもの)。
 */
const TILES = (): LauncherTile[] =>
  withBuiltinTiles(
    [
      { lid: 'u1', title: 'う の 1 件', group: 'う', kind: 'url', url: 'https://u.test/', order: 0 },
      { lid: 'a1', title: 'あ の 1 件', group: 'あ', kind: 'url', url: 'https://a.test/', order: 0 },
      { lid: 'i1', title: 'い の 1 件', group: 'い', kind: 'url', url: 'https://i.test/', order: 0 },
    ],
    { office: false },
  );

function stateWith(orders: AppGroupOrders): AppState {
  return { ...initialState, launcherTiles: TILES(), appGroupOrders: orders };
}

function renderInto(state: AppState): HTMLElement {
  const region = document.createElement('div');
  document.body.append(region);
  new LauncherRenderer(region, new GroupFoldStore(null)).render(state);
  return region;
}

/** 見出しの並び(画面に出た順)。⚠ 手本は `app-group-fold.test.ts` の `heads()`。 */
const heads = (region: HTMLElement): string[] =>
  [...region.querySelectorAll('[data-pkc-field="launcher-group"]')].map((h) => h.textContent ?? '');

describe('グループの並び順(#857 段③、描画)', () => {
  it('🔴 ① 番号の付いた群が、番号の順に出る(M16 を殺す)', () => {
    const region = renderInto(stateWith({ あ: 2, い: 1, う: 0 }));
    const names = heads(region);
    // ⚠ 前提: 名前の付いた群 3 つ + 組み込み = 4 見出し。崩れていたら下の比較は無意味
    expect(names.length, '前提が崩れている(見出しの数が想定と違う)').toBe(4);
    // 🔑 `toEqual` で厳密に比べる(`toContain` は順序を見ない)
    expect(names, '番号の順に並んでいない(並べ替えが効いていない)').toEqual([
      'う',
      'い',
      'あ',
      BUILTIN_GROUP,
    ]);
  });

  it('🔴 ② 組み込みアプリの群は、番号を付けてもいつも末尾(M17 を殺す)', () => {
    /**
     * ⚠ **組み込みにもわざと(小さい)番号を与える**。これが無いと、組み込みは
     *   「番号を持たない群」として何もしなくても最後尾へ回るので、頭尾の分割を
     *   外す変異(M17)と正しい実装が**同じ結果**を返し、見分けが付かない。
     */
    const region = renderInto(stateWith({ あ: 2, い: 1, う: 0, [BUILTIN_GROUP]: -100 }));
    const names = heads(region);
    expect(names.length, '前提が崩れている(見出しの数が想定と違う)').toBe(4);
    expect(
      names,
      '組み込みが末尾から動いた(頭尾の分割が外れ、番号の順に混ざった)',
    ).toEqual(['う', 'い', 'あ', BUILTIN_GROUP]);
  });

  it('🔴 ③ 番号だけを変えて 2 度描くと、見出しの並びが更新される(M18 を殺す)', () => {
    /**
     * ⚠ **同じ描画器のインスタンスで 2 回 `render()` する** ── 作り直すと
     *   指紋の効果そのものが消え、この主張(指紋に並び順が入っているか)が測れない。
     * ⚠ **`launcherTiles` の参照も両回で同じにする** ── 参照が変われば指紋は
     *   どのみち別物と判定されるので、`orderKey` を落とす変異(M18)が隠れてしまう。
     */
    const region = document.createElement('div');
    document.body.append(region);
    const renderer = new LauncherRenderer(region, new GroupFoldStore(null));
    const tiles = TILES();
    const base: AppState = { ...initialState, launcherTiles: tiles };

    renderer.render({ ...base, appGroupOrders: { あ: 0, い: 1, う: 2 } });
    const first = heads(region);
    expect(first.length, '前提が崩れている(1 度目で見出しが揃っていない)').toBe(4);
    expect(first, '前提が崩れている(1 度目の並びが想定と違う)').toEqual([
      'あ',
      'い',
      'う',
      BUILTIN_GROUP,
    ]);

    renderer.render({ ...base, appGroupOrders: { あ: 2, い: 1, う: 0 } });
    const second = heads(region);
    expect(
      second,
      '番号を変えて描き直しても見出しの並びが動かない(指紋に並び順が入っていない)',
    ).toEqual(['う', 'い', 'あ', BUILTIN_GROUP]);
  });

  it('⚠ ④ 番号が 1 つも無ければ名前順(対照群 ── 規則そのものが生きている)', () => {
    const region = renderInto(stateWith({}));
    const names = heads(region);
    expect(names.length, '前提が崩れている(見出しの数が想定と違う)').toBe(4);
    expect(names, '番号が無いのに名前順になっていない').toEqual([
      'あ',
      'い',
      'う',
      BUILTIN_GROUP,
    ]);
  });
});
