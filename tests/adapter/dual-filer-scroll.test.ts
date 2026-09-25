/** @vitest-environment happy-dom */
/**
 * C10(#1045): **2 ペインの表を送って見てから離れ、戻ると同じ所**。
 *
 * > user 指示 2026-08-03「**サイドバーも同じ、スクロールが発生するすべての画面が
 * > 対象だよ**」
 *
 * 🔴 `[data-pkc-region='dual-table']` は**自分で転がる箱**(`app.css` の
 * `overflow: auto`)。外側の `dual-pane` は転がらない。⚠ `renderTable` は
 * `frame.table.textContent = ''` で**丸ごと作り直す**ので、この面のどこかで
 * `entryMetas` が動いて表の指紋が変わるたび(スコープを移していなくても)、
 * 実ブラウザは中身が一瞬 0 になった `scrollTop` を 0 へ丸める。
 *
 * ⚠ ここは happy-dom が丸めを真似ないので、`scroll-memory.test.ts` と同じ作法で
 * 「中身が無ければ 0」を**自分で**再現する(でなければ「順番の間違い」が素通りする)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { DualFilerRenderer } from '../../src/adapter/ui/render/dual-filer';

function meta(lid: string, order: number, title = 't-' + lid, archetype = 'text'): EntryMeta {
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

function rel(id: string, fromLid: string, toLid: string): Relation {
  return { id, fromLid, toLid, kind: 'structural', createdAt: null, updatedAt: null };
}

/** ルート直下に folder f1 と平置き a〜c。f1 の中に x / y(#241 段⑥-a の fixture と同型)。 */
const METAS = [
  meta('f1', 1, 'はこ1', 'folder'),
  meta('a', 2, 'あ'),
  meta('b', 3, 'い'),
  meta('c', 4, 'う'),
  meta('x', 5, 'えっくす'),
  meta('y', 6, 'わい'),
];
const RELS = [rel('r1', 'f1', 'x'), rel('r2', 'f1', 'y')];

function booted(): AppState {
  return reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS })
    .state;
}

/**
 * happy-dom は`scrollTop`が素の数値で、実ブラウザの丸めを一切しない ──
 * `scroll-memory.test.ts` / `detail-scroll.test.ts` と同じ理由で自分で真似る。
 *
 * ⚠ **`scrollTop` を読んだ / 書いたときに丸める(lazy)だけでは足りない**
 * ── `renderTable` は `frame.table.textContent = ''` で中身を空にするだけで、
 * その場では誰も `scrollTop` に触らない。実ブラウザは**中身が空になった
 * その瞬間**に(誰も読み書きしなくても)値を 0 へ丸めるので、ここも
 * `textContent` の書き込みそのものへ割り込んで丸める(でなければ `park()` /
 * `use()` を丸ごと外しても、この test の器は 300 を持ち続けてしまう ──
 * 実際に 1 度それで空振りした)。
 */
function clampToChildren(table: HTMLElement): void {
  let top = 0;
  let owner: object | null = table;
  let desc: PropertyDescriptor | undefined;
  while (owner !== null && desc === undefined) {
    desc = Object.getOwnPropertyDescriptor(owner, 'textContent');
    owner = Object.getPrototypeOf(owner);
  }
  const origGet = desc?.get;
  const origSet = desc?.set;
  Object.defineProperty(table, 'textContent', {
    get(): string | null {
      return origGet?.call(this) ?? null;
    },
    set(this: HTMLElement, v: string) {
      origSet?.call(this, v);
      // 🔴 中身が空になった瞬間、本物のブラウザは scrollTop を 0 へ丸める
      if (this.childElementCount === 0) top = 0;
    },
    configurable: true,
  });
  Object.defineProperty(table, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      top = v;
    },
    configurable: true,
  });
}

function tableOf(region: HTMLElement, side: 'left' | 'right'): HTMLElement {
  return region.querySelector<HTMLElement>(
    `[data-pkc-region="dual-pane"][data-pkc-side="${side}"] [data-pkc-region="dual-table"]`,
  )!;
}

describe('2 ペインのスクロール位置を覚える(C10 / #1045)', () => {
  let region: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '';
    region = document.createElement('div');
    document.body.append(region);
  });

  /**
   * 🔴 **本体**: スコープを動かさずに表が作り直っても、位置を失わない。
   *
   * ⚠ 「別の画面へ行って戻る」の実体はこれである ── 2 ペインを見たまま
   * どこか別の場所(別窓・別のノート)で保存が起きると `entryMetas` が新しい
   * 参照になり、`DualFilerRenderer` の門(#421 前段の R4 と同じ形)を通り抜けて
   * **並べ替えの見出しが動くたびに**両ペインの表が丸ごと作り直る。
   * ここでは並べ替え(`SET_ENTRY_SORT`)でその形を再現する ── 起きることは同じ
   * (指紋が変わって `renderTable` が走る)で、既存の実装済みの入口を使える。
   */
  it('🔴 並べ替えで表が作り直っても、左右それぞれの送り位置を保つ', () => {
    const r = new DualFilerRenderer(region);
    const s0 = booted();
    r.render(s0);

    const left = tableOf(region, 'left');
    const right = tableOf(region, 'right');
    clampToChildren(left);
    clampToChildren(right);
    left.scrollTop = 300;
    right.scrollTop = 150;
    // 空振り防止 ── clamp が中身在るうちは丸めていないことを確かめる
    expect(left.scrollTop, '前提: 300 まで送れる').toBe(300);
    expect(right.scrollTop, '前提: 150 まで送れる').toBe(150);

    // 🔑 スコープは動かさない ── 「別の画面へ行って戻る」を、指紋だけ変える形で作る
    const s1 = reduce(s0, { type: 'SET_ENTRY_SORT', sort: 'title' }).state;
    expect(s1.entrySort, '前提: 並びが動いた').toBe('title');
    r.render(s1);

    expect(tableOf(region, 'left').scrollTop, '左の送り位置を忘れた').toBe(300);
    expect(tableOf(region, 'right').scrollTop, '右の送り位置を忘れた').toBe(150);
  });

  /**
   * ⚠ **対照群**: 表そのものを作り直さない回(印だけ変える)は、そもそも
   * `frame.table.textContent = ''` を通らない ── clamp を使わなくても保たれる
   * (`renderTable` を通す変異でなければ落ちないことを確かめる ── §2「未実行の経路」)。
   */
  it('印だけの変化(表を作り直さない)では、そもそも scrollTop に触れない', () => {
    const r = new DualFilerRenderer(region);
    const s0 = booted();
    r.render(s0);
    const left = tableOf(region, 'left');
    left.scrollTop = 300;
    const s1 = reduce(s0, { type: 'DUAL_SELECT', side: 'left', lid: 'a', mode: 'set' }).state;
    r.render(s1);
    expect(tableOf(region, 'left').scrollTop, '印だけの変化で送り位置が動いた').toBe(300);
  });

  /**
   * 🔴 **左右は別の箱**であることの検算 + **フォルダごとに覚える**こと。
   * 片方だけ動かした変化(左だけフォルダを移る)では、右の指紋は動かないので
   * `renderTable` を通らない ── 右は値を保つ。
   * 🔑 左は**入ったフォルダを先頭から**見せ、**上へ戻ったら元の位置**へ戻す
   *   (鍵 = フォルダ × 絞り込みの有無)。⚠ 鍵が絞り込みの有無だけだと、
   *   入ったフォルダが**前のフォルダの位置から**出る(1 稿目はそうだった)。
   */
  it('🔴 片方のペインだけフォルダへ入ると、入った先は先頭から・戻ると元の位置、もう片方は動かない', () => {
    const r = new DualFilerRenderer(region);
    const s0 = booted();
    r.render(s0);
    const left = tableOf(region, 'left');
    const right = tableOf(region, 'right');
    clampToChildren(left);
    right.scrollTop = 400; // 右は動かさない(clamp 無しでも素の数値のまま保たれるはず)
    left.scrollTop = 300;

    const s1 = reduce(s0, { type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' }).state;
    r.render(s1);
    expect(tableOf(region, 'right').scrollTop, '触っていない右が動いた').toBe(400);
    expect(tableOf(region, 'left').scrollTop, '入ったフォルダが前のフォルダの位置から出た').toBe(0);

    // 入った先で少し送ってから、上へ戻る
    left.scrollTop = 40;
    const s2 = reduce(s1, { type: 'DUAL_SET_SCOPE', side: 'left', lid: null }).state;
    r.render(s2);
    expect(tableOf(region, 'left').scrollTop, '上へ戻ったのに元の位置へ戻らない').toBe(300);

    // もう一度入ると、そのフォルダで見ていた位置へ
    const s3 = reduce(s2, { type: 'DUAL_SET_SCOPE', side: 'left', lid: 'f1' }).state;
    r.render(s3);
    expect(tableOf(region, 'left').scrollTop, '入り直したフォルダの位置を忘れた').toBe(40);
  });
});
