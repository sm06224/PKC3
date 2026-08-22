/** @vitest-environment happy-dom */
/**
 * 🔴 **予定が増えても、日のセルの高さが変わらない**(#303)。
 *
 * ## 何が起きていたか
 *
 * cowork 実機レポート #15「同じ座標を 2 回押すと**別の日**に当たる」。
 * ⚠ 報告は「**列幅**が変わる」と書いていたが、列幅は #293 の `table-layout: fixed`
 * で既に固定済み ── **動いていたのは行の高さ**だった。
 *
 * | 段 | なぜ動くか |
 * |---|---|
 * | 予定を `td` の**直下**に積む | 1 件入るごとに、その週の内在高が増える |
 * | 表は `flex-grow: 1` で器いっぱいに伸ばされる | 伸びた週の**下の行が押し下がる** |
 *
 * 実測(1440×900、予定 **1 件**):週の上端が
 * `0.0 / 53.2 / 42.8 / 32.4 / 20.8 / 10.4px` ずれる。
 * しかも `binder.ts` の分岐は `meta.date === date ? null : date` なので、
 * **2 打目は「外れる」ではなく「その日へ移る」** ── 報告の見え方と一致する。
 *
 * ## 直しの形
 *
 * 予定を**器 1 枚**(`day-events`)に入れ、CSS で絶対配置にする。
 * セルの内在高が「日の数字の帯」だけになるので、**何件入れても行は動かない**。
 *
 * ## ここで見るもの / 見ないもの
 *
 * | 層 | どこで見るか |
 * |---|---|
 * | **DOM の形**(器・件数)| 🟢 ここ(happy-dom) |
 * | **実際に何 px 動いたか** | `tests/smoke/calendar.smoke.spec.ts`(happy-dom は表の高さを配分しない) |
 * | **規則が在るか**(画面 / 紙) | 🟢 ここ(構文で読む) |
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { CalendarRenderer } from '../../src/adapter/ui/render/calendar';
import {
  stripComments,
  blocksFor,
  withoutMedia,
  mediaBlock,
  decl,
} from '../helpers/css-blocks';

function meta(lid: string, date: string | null): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: Number(lid.slice(1)) || 0,
    status: null,
    date,
    archived: false,
    bodyChars: null,
  };
}

/** 2026-08 を描く。⚠ `now` を注入して実行月に依存させない。 */
function draw(metas: EntryMeta[]): HTMLElement {
  const region = document.createElement('div');
  document.body.append(region);
  const state: AppState = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas,
    relations: [],
  }).state;
  new CalendarRenderer(region, () => new Date(2026, 7, 15)).render(state);
  return region;
}

const cell = (region: HTMLElement, key: string): HTMLElement =>
  region.querySelector<HTMLElement>(`[data-pkc-date="${key}"]`)!;

beforeEach(() => {
  document.body.textContent = '';
});

describe('予定は器に入る ── td の直下に積まない(#303)', () => {
  it('🔴 予定は day-events の中に居る(td の直下ではない)', () => {
    const region = draw([meta('e1', '2026-08-03'), meta('e2', '2026-08-03')]);
    const td = cell(region, '2026-08-03');
    const items = [...td.querySelectorAll('[data-pkc-entry]')];
    expect(items.length, '予定が描かれていない(この検査は空振り)').toBe(2);
    for (const el of items) {
      expect(
        el.parentElement?.getAttribute('data-pkc-field'),
        '予定が td の直下に積まれている(行が中身で伸びる)',
      ).toBe('day-events');
    }
    // ⚠ 「器の中に居る」だけでは足りない ── **td の直下に 1 件も無い**ことを見る
    expect(
      [...td.children].filter((c) => c.hasAttribute('data-pkc-entry')).length,
      'td の直下にも予定が残っている',
    ).toBe(0);
  });

  /**
   * 🔴 **器は 0 件でも作る**(ゼロ件の次元を作らない)。
   * ⚠ 1 件目で DOM の形が変わると、**そこでまた行が動く** ── 直したはずの症状が
   *   「最初の 1 件だけ」戻る、いちばん見分けにくい形になる。
   */
  it('🔴 予定が 0 件の日にも器が在る(1 件目で形が変わらない)', () => {
    const region = draw([]);
    const td = cell(region, '2026-08-03');
    expect(
      td.querySelector('[data-pkc-field="day-events"]'),
      '予定が無い日に器が無い(1 件目で行が動く)',
    ).not.toBeNull();
  });

  /** ⚠ 月外のセルは押せない ── 器も日の数字も持たない(直す前からの約束)。 */
  it('月外のセルは器を持たない', () => {
    const region = draw([]);
    const outside = region.querySelectorAll('[data-pkc-outside]');
    expect(outside.length, '2026-08 は 1 日が土曜なので月外のセルが在るはず').toBeGreaterThan(0);
    for (const td of outside) {
      expect(td.querySelector('[data-pkc-field="day-events"]'), '月外に器が在る').toBeNull();
    }
  });
});

/**
 * 🔴 **その日に何件あるかを、畳まれない所に出す**(#303)。
 *
 * ⚠ **理由づけを直した**(着地前レビュー B-6)── 1 稿目は「入り切らない分の
 *   手がかり」とだけ書いていたが、閾値は「2 件以上」であって「溢れているとき」
 *   ではない。1440×900 では 3 件まで器に収まるので、**全部見えている日にも数字が出る**
 *   ── 理由と実装が食い違っていた。
 * 🔑 出しているのは「**その日に何件あるか**」である(業務画面の密度)。
 *   溢れている日ではそれがそのまま「畳まれた分が在る」手がかりになる。
 * ⚠ 1 件のときは出さない ── 見えている 1 つに「1」と添えるのは飾りである。
 * ⚠ 溢れているかで出し分けない ── 描画のたびに実寸を読むことになり、
 *   「放っておいても変わる観測点」を製品コードに持ち込む(CLAUDE.md §4)。
 */
describe('入り切らない手がかり ── 件数(#303)', () => {
  const countOf = (region: HTMLElement, key: string): string | null =>
    cell(region, key).querySelector('[data-pkc-field="day-count"]')?.textContent ?? null;

  it('🔴 2 件以上のときだけ出て、数が一致する', () => {
    const region = draw([
      meta('e1', '2026-08-03'),
      meta('e2', '2026-08-03'),
      meta('e3', '2026-08-04'),
      meta('e4', '2026-08-04'),
      meta('e5', '2026-08-04'),
    ]);
    expect(countOf(region, '2026-08-03'), '2 件の日に件数が出ていない').toBe('2');
    expect(countOf(region, '2026-08-04'), '3 件の日の件数が違う').toBe('3');
  });

  it('🔴 0 件・1 件の日には出ない(見えている物の数を書かない)', () => {
    const region = draw([meta('e1', '2026-08-03')]);
    expect(countOf(region, '2026-08-03'), '1 件しかないのに件数が出ている').toBeNull();
    expect(countOf(region, '2026-08-05'), '予定の無い日に件数が出ている').toBeNull();
  });

  /**
   * ⚠ **数えるのは「その日に出ている予定」である**(片付けたものを含めない)。
   * 🔑 出ている数と件数がずれると、**在るはずの予定を探して user がスクロールする**。
   */
  it('🔴 片付けたものを隠しているときは、その分を数えない', () => {
    const archived = { ...meta('e2', '2026-08-03'), archived: true };
    const region = draw([meta('e1', '2026-08-03'), meta('e3', '2026-08-03'), archived]);
    const td = cell(region, '2026-08-03');
    expect(td.querySelectorAll('[data-pkc-entry]').length, '前提が崩れている').toBe(2);
    expect(countOf(region, '2026-08-03'), '出ている数と件数が食い違っている').toBe('2');
  });

  /**
   * 🔴 **絞り込みで消えたものも数えない**(着地前レビュー A-3)。
   *
   * ⚠ 1 稿目は `showArchived` の次元しか pin しておらず、**絞り込みの次元を
   *   1 度も通っていなかった** ── 既存の絞り込み test も予定を別々の日に置くので、
   *   `day-count`(2 件以上で出る)は**そちらでも 1 度も描かれない**。
   *   つまり「件数だけ絞り込み前の数を数える」変異が、全 test 緑のまま通った。
   * 🔑 これは「同じ値を複数の経路へ渡すものは、経路ごとに pin する」(§7)の
   *   **数える側**の顔である ── 数える元と描く元が同じ配列であることを見る。
   */
  it('🔴 絞り込みで消えたものは数えない(出ている数と一致する)', () => {
    const region = document.createElement('div');
    document.body.append(region);
    let st = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        { ...meta('e1', '2026-08-03'), title: 'りんご' },
        { ...meta('e2', '2026-08-03'), title: 'りんご' },
        { ...meta('e3', '2026-08-03'), title: 'みかん' },
      ],
      relations: [],
    }).state;
    st = reduce(st, { type: 'SET_ENTRY_FILTER', query: 'りんご' }).state;
    expect(st.filterQuery, '前提が崩れている(絞り込みが入っていない)').toBe('りんご');
    new CalendarRenderer(region, () => new Date(2026, 7, 15)).render(st);

    const td = cell(region, '2026-08-03');
    expect(td.querySelectorAll('[data-pkc-entry]').length, '絞り込みが効いていない').toBe(2);
    expect(
      countOf(region, '2026-08-03'),
      '件数が絞り込み前の数を数えている(在るはずの予定を探させる)',
    ).toBe('2');
  });
});

/**
 * 🔴 **器のスクロール位置を返す**(#303、着地前レビュー B-1)。
 *
 * この面は指紋が変わると格子ごと作り直す。⚠ 指紋には `selectedLid` が入っているので、
 * **予定を 1 つ押しただけで全部作り直される** ── 控えておかないと、器が先頭へ戻って
 * **押した予定が視界から消える**(押した手応えが画面から失われる)。
 * 🔑 これは「置き換えの作法」の③**後始末**(CLAUDE.md §10)── 直す前は器そのものが
 *   無かったので、**この直しで新しく落ちた性質**である。
 *
 * ⚠ happy-dom は実寸を持たないので `scrollTop` は素の property として振る舞う。
 *   ここで見るのは「**控えて戻す配線が在るか**」であって、実際の見え方ではない。
 */
describe('作り直しても、器のスクロール位置は戻る(#303)', () => {
  it('🔴 選び直して作り直しても、器は先頭へ戻らない', () => {
    const region = document.createElement('div');
    document.body.append(region);
    const metas = Array.from({ length: 6 }, (_, i) => meta(`e${i + 1}`, '2026-08-03'));
    const base = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas,
      relations: [],
    }).state;
    const r = new CalendarRenderer(region, () => new Date(2026, 7, 15));
    r.render(base);

    const box = () =>
      cell(region, '2026-08-03').querySelector<HTMLElement>('[data-pkc-field="day-events"]')!;
    box().scrollTop = 40;
    expect(box().scrollTop, '前提が崩れている(スクロール位置を作れない)').toBe(40);

    // 予定を 1 つ選ぶ = 指紋が変わる = 格子ごと作り直し
    const after = reduce(base, { type: 'SELECT_ENTRY', lid: 'e3' }).state;
    r.render(after);
    expect(
      cell(region, '2026-08-03').querySelector('[data-pkc-field="day-events"]'),
      '作り直されていない(この検査は空振り)',
    ).not.toBe(null);
    expect(box().scrollTop, '器が先頭へ戻った(押した予定が視界から消える)').toBe(40);
  });

  /** 🔴 **対照群** ── 触っていない日は 0 のまま(全部に代入していない)。 */
  it('対照群: 触っていない日の器は 0 のまま', () => {
    const region = document.createElement('div');
    document.body.append(region);
    const metas = Array.from({ length: 6 }, (_, i) => meta(`e${i + 1}`, '2026-08-03'));
    const base = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] })
      .state;
    const r = new CalendarRenderer(region, () => new Date(2026, 7, 15));
    r.render(base);
    cell(region, '2026-08-03').querySelector<HTMLElement>(
      '[data-pkc-field="day-events"]',
    )!.scrollTop = 40;
    r.render(reduce(base, { type: 'SELECT_ENTRY', lid: 'e3' }).state);
    expect(
      cell(region, '2026-08-04').querySelector<HTMLElement>('[data-pkc-field="day-events"]')!
        .scrollTop,
      '触っていない日にも位置を書き戻している',
    ).toBe(0);
  });
});


/* ── CSS(構文で読む。happy-dom は描画しない)──────────────── */

/**
 * ⚠ **道具は `tests/helpers/css-blocks.ts` に在る**(着地前レビュー B-4)──
 *   1 稿目は `dual-hover-css.test.ts` から丸ごとコピーしていた。CLAUDE.md §1 に
 *   「CSS を読む test で 5 回踏んだ」と記録がある種類の道具なので、
 *   2 か所に置くと**次に直したとき片方だけ直る**(§7)。
 *
 * 🔴 **`decl()` を使う**(素の `/height:\s*5em/` を書かない)── プロパティ名の
 *   先頭に固定しないと **`max-height` / `min-height` / `line-height`** に当たる。
 *   1 稿目は実際にそれで、`height: var(--day-band)` を消す変異が
 *   隣の `line-height: var(--day-band)` に満たされて**生き延びた**。
 */
describe('app.css: 行の高さを中身から切り離す規則(#303)', () => {
  const css = stripComments(readFileSync('src/styles/app.css', 'utf-8'));
  const screen = withoutMedia(css);
  const decls = (sel: string): string => {
    const hit = blocksFor(screen, sel);
    expect(hit.length, `${sel} の規則が無い(選択子を変えたならこの test も追随する)`).toBe(1);
    return hit[0]!;
  };

  it('🔴 日のセルが位置の基準になり、下限を持つ', () => {
    const td = decls("[data-pkc-region='calendar-grid'] tbody td");
    // ⚠ これが無いと器の基準が**表**まで遡り、予定が月ごと 1 か所へ積み上がる
    expect(td, 'td が位置の基準になっていない').toMatch(decl('position', 'relative'));
    // 🔴 下限 ── 器が低い版面でセルが 30〜40px まで潰れて狙えない
    //    ⚠ `max-height` / `min-height` では**この主張にならない**ので先頭に固定する
    expect(td, 'セルの下限が無い(狭い版面で潰れる)').toMatch(decl('height', '5em'));
  });

  it('🔴 予定の器が絶対配置で、中でスクロールする', () => {
    const box = decls("[data-pkc-region='calendar-grid'] [data-pkc-field='day-events']");
    expect(box, '器が流れの中に居る(中身で行が伸びる = 直す前の症状)').toMatch(
      decl('position', 'absolute'),
    );
    expect(box, '入り切らない予定に触れない(切り取ったまま)').toMatch(decl('overflow', 'auto'));
    /**
     * ⚠ **これは「無いと壊れる」の主張ではない**(着地前レビュー B-2)。
     *   実測(700×640・混んだ日の上でホイール 2 回):`contain` 有りで面の
     *   `scrollTop` は **0**、`auto` に上書きしても **0** ── **差が出なかった**
     *   (ホイールの latch で連鎖しない)。帯の上で回せば 408 まで動く。
     * 🔑 だから守っているのは「入れ子のスクロールに連鎖の宣言が在る」ことだけで、
     *   落とした結果を実測で示せてはいない ── そう分かる文言にしておく。
     */
    expect(box, '内側スクロールの連鎖の宣言が無い').toMatch(
      decl('overscroll-behavior', 'contain'),
    );
  });

  /**
   * 🔴 **帯の高さと器の上端は対である**(同じ数を 2 か所に書かない)。
   * ⚠ 噛み合っているかは **smoke が実寸で見る**(数字の下端 == 器の上端)──
   *   ここで見るのは「2 本目の数が生えていないか」だけである。
   */
  it('🔴 日の数字の帯と器の上端が、同じ 1 つの値から出ている', () => {
    const td = decls("[data-pkc-region='calendar-grid'] tbody td");
    expect(td, '帯の値が宣言されていない').toMatch(/--day-band:/);
    expect(
      decls("[data-pkc-field='day-number']"),
      '数字の帯が --day-band から出ていない',
    ).toMatch(decl('line-height', 'var\\(--day-band'));
    expect(
      decls("[data-pkc-region='calendar-grid'] [data-pkc-field='day-events']"),
      '器の上端が帯から出ていない(2 本目の数が生えている)',
    ).toMatch(/var\(--day-band\)/);
  });

  /**
   * 🔴 **下限と面のスクロールは対で 1 つの直し**。
   * ⚠ 下限だけ置くと、器が低い版面で**表が面の外へはみ出す** ──
   *   実測(700×640、1 カラムに畳まれた版面):器 58px に対し表 415.9px。
   * 🔑 実際に届くかは **smoke が狭い版面で見る**(着地前レビュー A-2 ──
   *   1 稿目はこの 2 本を**どちらも通る test が 0 本**だった)。
   *
   * ⚠ **`flex-shrink: 0` は pin しない**(変異試験 M14 / M15 で判明)。
   *   1 稿目は `flex: 1 0 auto` にして「縮むと行が面の外へ描かれて届かない」と
   *   書いたが、`flex: 1` / `flex: 1 + min-height: 0` へ戻しても
   *   **smoke は落ちなかった**(スクロールし切って最下段が器に入るところまで
   *   見ても同じ)── 届くことを担保しているのは**面の `overflow: auto`** である。
   *   だから宣言ごと戻し、pin もしない(効いていない物を pin すると、
   *   次に読む人が「これが要る」と信じて動かせなくなる)。
   */
  it('🔴 入り切らない月は、面ごとスクロールして届く', () => {
    expect(
      decls("[data-pkc-view-pane='calendar']"),
      '面がスクロールしない(表が外へはみ出す)',
    ).toMatch(decl('overflow', 'auto'));
  });
});

/**
 * 🔴 **紙では素通しへ戻す**(#303 の対)。紙にスクロールは無いので、
 * 器の切り取りをそのままにすると**予定が箱の高さで切られる** ── 印刷は 2 面目。
 * ⚠ この print ブロックに calendar 用の規則は、直す前 **0 件**だった。
 */
describe('app.css: 紙では日のセルが中身なりに伸びる(#303)', () => {
  const css = stripComments(readFileSync('src/styles/app.css', 'utf-8'));
  const { body, at } = mediaBlock(css, 'print');
  const decls = (sel: string): string => {
    const hit = blocksFor(body, sel);
    expect(hit.length, `紙: ${sel} の規則が無い`).toBe(1);
    return hit[0]!;
  };

  it('🔴 器の絶対配置と切り取りを、3 つとも戻す', () => {
    const box = decls("[data-pkc-region='calendar-grid'] [data-pkc-field='day-events']");
    expect(box, '紙でも絶対配置のまま(セルが伸びない)').toMatch(decl('position', 'static'));
    // ⚠ `position` だけ戻すと器は流れに入るが `overflow: auto` のままなので、
    //   **高さ 0 の箱**になって予定が 1 件も出ない
    expect(box, '紙でも切り取ったまま(予定が箱の高さで切られる)').toMatch(
      decl('overflow', 'visible'),
    );
    expect(
      decls("[data-pkc-region='calendar-grid'] tbody td"),
      '紙でもセルに下限が残っている(中身なりに伸びない)',
    ).toMatch(decl('height', 'auto'));
  });

  it('紙では件数を出さない(全部出ているので数字は要らない)', () => {
    expect(
      decls("[data-pkc-region='calendar-grid'] [data-pkc-field='day-count']"),
      '紙に件数が残る',
    ).toMatch(decl('display', 'none'));
  });

  /**
   * 🔴 **print ブロックは画面の規則より後に在ること**(#303 で初めて意味を持った)。
   *
   * `@media` は詳細度を上げない ── ここで上書きしている `position` / `overflow` /
   * `height` は画面側と**同じ詳細度**なので、print ブロックを手前へ動かすと**負ける**。
   * ⚠ app.css の print 節には「この節は file のいちばん最後に置く」と書いてあるが、
   *   そこには「2026-08-07 時点では手前へ移す変異と**等価**で、変異試験では殺せない
   *   (承知のうえで残している)」とも書いてあった。**この直しでその変異が
   *   初めて殺せるようになった**(実測 M9: 箱 38px / 中身 120px で smoke が落ちる)。
   */
  it('🔴 print ブロックが、上書き対象の画面規則より後ろに在る', () => {
    for (const sel of [
      "[data-pkc-region='calendar-grid'] [data-pkc-field='day-events'] {",
      "[data-pkc-region='calendar-grid'] tbody td {",
    ]) {
      const first = css.indexOf(sel);
      expect(first, `画面側の ${sel} が無い(この検査は空振り)`).toBeGreaterThan(-1);
      expect(
        first,
        `print ブロックが ${sel} より前に在る(同じ詳細度なので紙で負ける)`,
      ).toBeLessThan(at);
    }
  });
});
