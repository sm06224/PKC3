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
import { GRID_ROW_THRESHOLD, ROW_CHUNK } from '../../src/adapter/ui/render/filer';

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

  it('🔴 塊(tbody)ごとに content-visibility: auto、行は閉じ込めだけ(行ごとの見張りを張らせない)', () => {
    const chunk = ruleOf(`${G} tbody`);
    expect(chunk, '空振り防止: 規則が読めていない').not.toBe('');
    expect(chunk).toMatch(/content-visibility:\s*auto/);
    expect(chunk).toMatch(/contain-intrinsic-size:\s*auto 1300px/);
    const row = ruleOf(`${G} tbody tr`);
    expect(row, '空振り防止: 行の規則が読めていない').not.toBe('');
    // ⚠ 行に付けると、行の数だけ見張りが張られる(3,000 件で 200 字に約 1.2 秒)
    expect(row).not.toMatch(/content-visibility/);
    // ⚠ 外すと文字が 1px 上へずれる(行の content-visibility が暗に付けていた閉じ込め)
    expect(row).toMatch(/contain:\s*layout paint style/);
    expect(ruleOf(`${G} tr`)).toMatch(/height:\s*26px/);
    expect(ruleOf(`${G} tr`)).toMatch(/display:\s*grid/);
    // 0.5px の足しは表全体の最初と最後だけ(塊ごとに足すと伸びる)
    expect(ruleOf(`${G} tbody:first-of-type tr:first-child`)).toMatch(/height:\s*26\.5px/);
    expect(ruleOf(`${G} tbody:last-of-type`)).toMatch(/padding-bottom:\s*0\.5px/);
    expect(ruleOf(`${G} tbody tr:first-child`), '塊ごとに 0.5px 足す規則が残っている').toBe('');
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

describe('格子のとき、行を 50 行ずつの塊に分ける(#1087)', () => {
  const lidsOf = (t: HTMLElement) =>
    [...t.querySelectorAll('tbody tr')].map((tr) => tr.getAttribute('data-pkc-entry'));

  it('🔴 3,001 行は 61 個の塊に、順番どおり、塊ごとに 50 行まで入る', () => {
    const { render, table } = setup();
    const n = 3001;
    render(booted(metas(n)));
    const t = table();
    const bodies = [...t.querySelectorAll('tbody')];
    expect(bodies.length).toBe(Math.ceil(n / ROW_CHUNK));
    for (const b of bodies.slice(0, -1)) expect(b.children.length).toBe(ROW_CHUNK);
    expect(bodies[bodies.length - 1]!.children.length).toBe(n % ROW_CHUNK || ROW_CHUNK);
    expect(lidsOf(t)).toEqual(metas(n).map((m) => m.lid));
    // 仮の高さは塊の行数ぶん
    expect(bodies[0]!.style.getPropertyValue('contain-intrinsic-size')).toBe(`auto ${ROW_CHUNK * 26}px`);
    expect(bodies[bodies.length - 1]!.style.getPropertyValue('contain-intrinsic-size')).toBe('auto 26px');
  });

  it('🔴 並びが塊をまたいで変わっても、行の node を持ち越して正しい塊・順番へ入る', () => {
    const { render, table } = setup();
    const n = 400;
    const s0 = booted(metas(n));
    render(s0);
    const t = table();
    const before = t.querySelector('tr[data-pkc-entry="n0"]');
    // 逆順にする(先頭の行が最後の塊へ移る)
    const reversed = metas(n).map((m) => ({ ...m, entryOrder: n - m.entryOrder }));
    render(withMetas(s0, reversed));
    expect(lidsOf(t)).toEqual([...metas(n)].reverse().map((m) => m.lid));
    const bodies = [...t.querySelectorAll('tbody')];
    expect(bodies.length).toBe(n / ROW_CHUNK);
    for (const b of bodies) expect(b.children.length).toBe(ROW_CHUNK);
    expect(t.querySelector('tr[data-pkc-entry="n0"]'), '行を作り直した').toBe(before);
    expect(bodies[bodies.length - 1]!.lastElementChild).toBe(before);
  });

  it('🔴 境より少なくなったら、塊は 1 つに戻り、仮の高さも外れる ── 空の塊を残さない', () => {
    const { render, table } = setup();
    const s0 = booted(metas(GRID_ROW_THRESHOLD + 120));
    render(s0);
    expect(table().querySelectorAll('tbody').length, '前提: 塊に分かれていない').toBeGreaterThan(1);
    render(withMetas(s0, metas(10)));
    const bodies = [...table().querySelectorAll('tbody')];
    expect(bodies.length).toBe(1);
    expect(bodies[0]!.children.length).toBe(10);
    expect(bodies[0]!.style.getPropertyValue('contain-intrinsic-size')).toBe('');
  });
});

/**
 * 🔑 **検索で打つたびに、全件の指紋を作り直さない**(#1087)。
 * ⚠ ノートの一覧(entryMetas)が同じなら、前に作った指紋がそのまま使える ──
 *   直す前は 1 字ごとに 3,000 件ぶん作り直していた(実測で 1 字ごとの JS の上位)。
 */
describe('#1087 一覧の指紋を作り直さない', () => {
  it('🔑 絞りの字だけが変わる描画では、指紋を作らない ── 対照群: 題名が変われば作る', async () => {
    const { vi } = await import('vitest');
    const { FilerRenderer } = await import('../../src/adapter/ui/render/filer');
    const { render, table } = setup();
    let s = booted(metas(500));
    render(s);
    const spy = vi.spyOn(FilerRenderer.prototype as unknown as { metaSignature: () => string }, 'metaSignature');
    try {
      for (const q of ['t', 't1', 't12']) {
        s = reduce(s, { type: 'SET_ENTRY_FILTER', query: q }).state;
        render(s);
      }
      expect(s.filterQuery, '前提: 絞りの字が state に入っていない').toBe('t12');
      expect(table().querySelectorAll('tbody tr').length, '前提: 絞っても行が減っていない(描き直していない)').toBeLessThan(500);
      expect(spy, '絞りの字だけで指紋を作り直した').not.toHaveBeenCalled();
      const changed = metas(500).map((m) => (m.lid === 'n1' ? { ...m, title: '新しい名前' } : m));
      render(withMetas(s, changed));
      expect(spy, '対照群: 一覧が変わったのに指紋を作っていない').toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
