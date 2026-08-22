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
 * 🔴 **件数を地の上に出す**(#303)。器に入り切らない予定はスクロールの向こうへ
 * 行くので、数だけは畳まれない所に出す ── 出さないと「**無言で消えた**」に見える。
 * ⚠ 1 件のときは出さない ── 見えている物の数を書くのは飾りである。
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
});

/* ── CSS(構文で読む。happy-dom は描画しない)──────────────── */

/** 注釈を剥ぐ ── 剥がないと直前の注釈が選択子の一部として拾われる。 */
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** `選択子 { 宣言 }` を全部読み、選択子リストに `sel` を**丸ごと**含むブロックを返す。 */
function blocksFor(css: string, sel: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1]!.split(',').map((x) => x.trim().replace(/\s+/g, ' '));
    if (sels.includes(sel)) out.push(m[2]!);
  }
  return out;
}

/**
 * `@media` ブロックを**構文で**取り除く(brace を数えて対応する閉じまで)。
 * ⚠ 「最初の `@media` で切る」では足りない ── app.css は `@media` 群の**後にも**
 *   素の規則が続く(`dual-hover-css.test.ts` の 1 稿目がそれで誤答した)。
 */
function withoutMedia(css: string): string {
  let out = css;
  for (let at = out.indexOf('@media'); at !== -1; at = out.indexOf('@media')) {
    const open = out.indexOf('{', at);
    expect(open, '@media に { が無い(構文が壊れている)').toBeGreaterThan(-1);
    let depth = 1;
    let i = open + 1;
    for (; i < out.length && depth > 0; i++) {
      if (out[i] === '{') depth++;
      else if (out[i] === '}') depth--;
    }
    expect(depth, '@media の閉じ } が無い(構文が壊れている)').toBe(0);
    out = out.slice(0, at) + out.slice(i);
  }
  return out;
}

/** `@media print { … }` の**中だけ**を返す(位置も返す ── 順序を pin するため)。 */
function printBlock(css: string): { body: string; at: number } {
  const at = css.indexOf('@media print');
  expect(at, '@media print が無い').toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  let depth = 1;
  let i = open + 1;
  for (; i < css.length && depth > 0; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
  }
  expect(depth, '@media print の閉じ } が無い').toBe(0);
  return { body: css.slice(open + 1, i - 1), at };
}

describe('app.css: 行の高さを中身から切り離す規則(#303)', () => {
  const css = strip(readFileSync('src/styles/app.css', 'utf-8'));
  const screen = withoutMedia(css);
  const decls = (sel: string): string => {
    const hit = blocksFor(screen, sel);
    expect(hit.length, `${sel} の規則が無い(選択子を変えたならこの test も追随する)`).toBe(1);
    return hit[0]!;
  };

  it('🔴 日のセルが位置の基準になり、下限を持つ', () => {
    const td = decls("[data-pkc-region='calendar-grid'] tbody td");
    // ⚠ これが無いと器の基準が**表**まで遡り、予定が月ごと 1 か所へ積み上がる
    expect(td, 'td が位置の基準になっていない').toMatch(/position:\s*relative/);
    // 🔴 下限 ── 器が低い版面でセルが 30〜40px まで潰れると、日の地を狙えない
    expect(td, 'セルの下限が無い(狭い版面で潰れる)').toMatch(/height:\s*5em/);
  });

  it('🔴 予定の器が絶対配置で、中でスクロールする', () => {
    const box = decls("[data-pkc-region='calendar-grid'] [data-pkc-field='day-events']");
    expect(box, '器が流れの中に居る(中身で行が伸びる = 直す前の症状)').toMatch(
      /position:\s*absolute/,
    );
    expect(box, '入り切らない予定に触れない(切り取ったまま)').toMatch(/overflow:\s*auto/);
    // ⚠ 内側スクロールを新設したので、ホイールが本文の面へ流れないようにする
    expect(box, 'ホイールが背後の面へ流れる').toMatch(/overscroll-behavior:\s*contain/);
  });

  /**
   * 🔴 **帯の高さと器の上端は対である**(同じ数を 2 か所に書かない)。
   * ⚠ 片方だけ変えると、器が日の数字に食い込むか、無駄な隙間が空く。
   * 実測(1440×900):数字の下端 22.9px = 器の上端 22.9px。
   */
  it('🔴 日の数字の帯と器の上端が、同じ 1 つの値から出ている', () => {
    const td = decls("[data-pkc-region='calendar-grid'] tbody td");
    expect(td, '帯の値が宣言されていない').toMatch(/--day-band:/);
    expect(
      decls("[data-pkc-field='day-number']"),
      '数字の高さが帯から出ていない(今日の丸の分だけ帯が伸びる)',
    ).toMatch(/height:\s*var\(--day-band/);
    expect(
      decls("[data-pkc-region='calendar-grid'] [data-pkc-field='day-events']"),
      '器の上端が帯から出ていない(2 本目の数が生えている)',
    ).toMatch(/var\(--day-band\)/);
  });

  /**
   * 🔴 **下限と面のスクロールは対で 1 つの直し**。
   * ⚠ 下限だけ置くと、器が低い版面で**表が面の外へはみ出す** ──
   *   実測(700×640、1 カラムに畳まれた版面):器 58px に対し表 415.9px。
   *   ⚠ 表を縮ませても駄目(行が面の外へ描かれてスクロールしても届かない)。
   */
  it('🔴 入り切らない月は面ごとスクロールし、表は縮まない', () => {
    expect(
      decls("[data-pkc-view-pane='calendar']"),
      '面がスクロールしない(表が外へはみ出す)',
    ).toMatch(/overflow:\s*auto/);
    const table = decls("[data-pkc-region='calendar-grid']");
    // `flex: 1 0 auto` ── 伸びる(grow 1)が縮まない(shrink 0)
    expect(table, '表が縮む(行が面の外へ描かれる)').toMatch(/flex:\s*1\s+0\s+auto/);
  });
});

/**
 * 🔴 **紙では素通しへ戻す**(#303 の対)。紙にスクロールは無いので、
 * 器の切り取りをそのままにすると**予定が箱の高さで切られる** ── 印刷は 2 面目。
 * ⚠ この print ブロックに calendar 用の規則は、直す前 **0 件**だった。
 */
describe('app.css: 紙では日のセルが中身なりに伸びる(#303)', () => {
  const css = strip(readFileSync('src/styles/app.css', 'utf-8'));
  const { body, at } = printBlock(css);
  const decls = (sel: string): string => {
    const hit = blocksFor(body, sel);
    expect(hit.length, `紙: ${sel} の規則が無い`).toBe(1);
    return hit[0]!;
  };

  it('🔴 器の絶対配置と切り取りを、3 つとも戻す', () => {
    const box = decls("[data-pkc-region='calendar-grid'] [data-pkc-field='day-events']");
    expect(box, '紙でも絶対配置のまま(セルが伸びない)').toMatch(/position:\s*static/);
    // ⚠ `position` だけ戻すと器は流れに入るが `overflow: auto` のままなので、
    //   **高さ 0 の箱**になって予定が 1 件も出ない
    expect(box, '紙でも切り取ったまま(予定が箱の高さで切られる)').toMatch(/overflow:\s*visible/);
    expect(
      decls("[data-pkc-region='calendar-grid'] tbody td"),
      '紙でもセルに下限が残っている(中身なりに伸びない)',
    ).toMatch(/height:\s*auto/);
  });

  it('紙では件数を出さない(全部出ているのに数字だけ残ると嘘になる)', () => {
    expect(
      decls("[data-pkc-region='calendar-grid'] [data-pkc-field='day-count']"),
      '紙に件数が残る',
    ).toMatch(/display:\s*none/);
  });

  /**
   * 🔴 **print ブロックは画面の規則より後に在ること**(#303 で初めて意味を持った)。
   *
   * `@media` は詳細度を上げない ── ここで上書きしている `position` / `overflow` /
   * `height` は画面側と**同じ詳細度**なので、print ブロックを手前へ動かすと**負ける**。
   * ⚠ app.css の print 節には「この節は file のいちばん最後に置く」と書いてあるが、
   *   そこには「2026-08-07 時点では手前へ移す変異と**等価**で、変異試験では殺せない
   *   (承知のうえで残している)」とも書いてあった。**この直しでその変異が
   *   初めて殺せるようになった** ── だからここで pin する。
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
