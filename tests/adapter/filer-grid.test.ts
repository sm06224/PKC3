/** @vitest-environment happy-dom */
/**
 * 🔴 **行が多いフォルダの表は、画面の外の行を組まない**(#1087。Gemini 裁定 = 案 1)。
 *
 * ## 何が起きていたか
 *
 * 「中まで全部出す」で 3,000 行が並ぶと、ノートを 1 件選ぶだけで 237〜250ms、
 * 平置きに切り替えると 170〜244ms かかった。実体は**画面の外の行まで毎回 style / layout /
 * paint に載る**こと(実ブラウザの trace で UpdateLayoutTree + Layout + PrePaint + Paint が
 * 選ぶたびに約 290ms)。`content-visibility` は `<tr>` に効かないので、行が多いときだけ
 * 表を格子(`display: grid`)で組み、行ごとに `content-visibility: auto` を掛ける。
 *
 * ## 守るもの
 *
 * - ① 行数が境を越えたら表に `data-pkc-grid` が付き、戻れば外れる(**表を持ち越しても**
 *   毎回合わせる ── 表は作り直さない `reconcileRows` の側にある)
 * - ② CSS の 3 点:行ごとの `content-visibility: auto` / 行の高さの固定 / 格子が
 *   `data-pkc-grid` の下でだけ効く(少ない行の見た目を変えない)
 * ⚠ 見た目の画素(列の幅・行の高さ・文字の位置)は実ブラウザの検査 ── happy-dom は
 *   layout を持たないので、ここでは見ない。
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
import { GRID_ROW_THRESHOLD } from '../../src/adapter/ui/render/filer';

function meta(i: number): EntryMeta {
  return {
    lid: 'n' + i,
    title: 't' + i,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: i,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}
const metas = (n: number): EntryMeta[] => Array.from({ length: n }, (_, i) => meta(i));
const booted = (m: EntryMeta[]): AppState =>
  reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: m, relations: [] }).state;
const withMetas = (s: AppState, m: EntryMeta[]): AppState => ({
  ...s,
  entryMetas: new Map(m.map((x) => [x.lid, x])),
});

function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  const pane = root.querySelector<HTMLElement>('[data-pkc-browse-pane="filer"]')!;
  return {
    render: (s: AppState) => browse.render(s, 'filer'),
    table: () => pane.querySelector<HTMLElement>('[data-pkc-region="filer-table"]')!,
  };
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('行数が境を越えたら、表が格子になる(#1087)', () => {
  it('🔴 境ちょうどは今までの表、1 行超えたら格子 ── 同じ表のまま印だけ変わる', () => {
    const { render, table } = setup();
    const s0 = booted(metas(GRID_ROW_THRESHOLD));
    render(s0);
    const t = table();
    expect(t.querySelectorAll('tbody tr').length, '前提が崩れている(行が境ちょうどで出ていない)').toBe(
      GRID_ROW_THRESHOLD,
    );
    expect(t.hasAttribute('data-pkc-grid'), '境ちょうどで格子になっている').toBe(false);

    render(withMetas(s0, metas(GRID_ROW_THRESHOLD + 1)));
    expect(table(), '表を作り直した(持ち越していない)').toBe(t);
    expect(t.querySelectorAll('tbody tr').length).toBe(GRID_ROW_THRESHOLD + 1);
    expect(t.hasAttribute('data-pkc-grid'), '境を越えても格子にならない').toBe(true);
  });

  it('🔴 行が減って境に戻れば、格子が外れる(付けっぱなしにしない)', () => {
    const { render, table } = setup();
    const s0 = booted(metas(GRID_ROW_THRESHOLD + 5));
    render(s0);
    expect(table().hasAttribute('data-pkc-grid'), '前提が崩れている(格子になっていない)').toBe(true);
    render(withMetas(s0, metas(3)));
    expect(table().querySelectorAll('tbody tr').length).toBe(3);
    expect(table().hasAttribute('data-pkc-grid'), '少ない行になっても格子のまま').toBe(false);
  });
});

/** 注釈を落として、`選択子 { 宣言 }` を全部読む(選択子リストは `,` で割る)。 */
function cssRules(css: string): Array<{ sels: string[]; body: string }> {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Array<{ sels: string[]; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    out.push({ sels: m[1]!.split(',').map((x) => x.trim().replace(/\s+/g, ' ')), body: m[2]! });
  }
  return out;
}
const CSS = cssRules(readFileSync('src/styles/app.css', 'utf8'));
const ruleOf = (sel: string) => CSS.filter((r) => r.sels.includes(sel)).map((r) => r.body).join(';');

describe('格子の CSS(#1087)', () => {
  const G = "[data-pkc-region='filer-table'][data-pkc-grid]";

  it('🔴 行ごとに content-visibility: auto と、固定の高さの見積もり', () => {
    const body = ruleOf(`${G} tbody tr`);
    expect(body, '空振り防止: 規則が読めていない').not.toBe('');
    expect(body).toMatch(/content-visibility:\s*auto/);
    // 見積もりの高さ = 行の高さ(外れると、スクロールの長さが動く)
    expect(body).toMatch(/contain-intrinsic-size:\s*auto 26px/);
    expect(ruleOf(`${G} tr`)).toMatch(/height:\s*26px/);
    expect(ruleOf(`${G} tr`)).toMatch(/display:\s*grid/);
  });

  it('🔴 格子は data-pkc-grid の下でだけ ── 少ない行の表(display: table)を奪わない', () => {
    // 表の行・表そのものを grid / block にする規則が、`data-pkc-grid` なしで書かれていない
    const bare = CSS.filter(
      (r) =>
        r.sels.some((s) => s.startsWith("[data-pkc-region='filer-table']") && !s.includes('data-pkc-grid')) &&
        /display:\s*(grid|block)|content-visibility/.test(r.body),
    );
    expect(bare.map((r) => r.sels.join(', '))).toEqual([]);
  });
});
