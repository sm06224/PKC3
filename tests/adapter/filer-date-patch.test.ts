/** @vitest-environment happy-dom */
/**
 * 🔴 **日付が入っただけで表を建て直さない**(#270 の真因)。
 *
 * ## 何が起きていたか
 *
 * 1. `CREATE_ENTRY` は `updatedAt: null` を置く(実時刻を刻むのは worker)
 * 2. 保存が済むと **`ENTRY_STAMPED`** という**非同期の ack** が返り、実時刻が入る
 * 3. ファイラの指紋に日付が混ざっていたので `''` → `MM/DD` で指紋が変わり、
 *    **`region.textContent = ''` で表が丸ごと建て直されて**いた
 *
 * ## ⚠ 実害は「掴もうとしている手の下で表が動く」こと(実ブラウザで測った)
 *
 * `organize` spec 全体を **30 回**走らせ、event と DOM の trail を採った結果:
 *
 * | 回数 | trail | 何が起きたか |
 * |---|---|---|
 * | 2 | `掴む合図 → rows-detached → dragstart` | **押下ごと奪われ** `drop` が来ない |
 * | 約 3 | `rows-detached → mousedown → … → drop` | 落とせたが**狙った行が動いていて**別の所へ入る |
 * | 残り | 組み直しは `drop` の**後**だけ | 正常 |
 *
 * ⚠ **成功した回にも組み直しは起きている** ── 効いているのは「組み直した」ことでは
 *   なく「**手を伸ばしている最中に**組み直した」ことである(両者を混ぜない)。
 *
 * ## 🔑 直し
 *
 * 指紋から日付を外し(`metaSignature`)、日付だけの変化は**セルの字を差し替える**
 * (`patchDates`)。⚠ 「更新」で並べているときは日付が**並びを変えうる**ので除く。
 *
 * ⚠ 日付を外したら、**並び順が指紋から抜けていたこと**が露見した ── 直す前は
 *   「並べ替えると日付も変わる」ことに間接的に頼っていた(`folder-organize` の
 *   回帰 test が即座に捕まえた)。並び順は指紋に明示した。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BrowseRouter } from '../../src/adapter/ui/render/browse';
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

const rel = (id: string, fromLid: string, toLid: string): Relation => ({
  id,
  fromLid,
  toLid,
  kind: 'structural',
  createdAt: null,
  updatedAt: null,
});

const METAS = [meta('f1', 1, 'はこ', 'folder'), meta('a', 2, 'あ'), meta('b', 3, 'い')];
const RELS = [rel('r1', 'f1', 'b')];

const booted = (): AppState =>
  reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: RELS }).state;

/** worker の刻みが返ってきた形。⚠ 年は「今年」にする(`MM/DD` で出る側に倒す)。 */
function stamped(s: AppState, lid: string): AppState {
  const at = `${new Date().getFullYear()}-01-02 03:04:05`;
  return reduce(s, { type: 'ENTRY_STAMPED', lid, createdAt: at, updatedAt: at }).state;
}

function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  const pane = root.querySelector<HTMLElement>('[data-pkc-browse-pane="filer"]')!;
  const row = (lid: string) => pane.querySelector<HTMLElement>(`tbody [data-pkc-entry="${lid}"]`);
  const dateOf = (lid: string) =>
    row(lid)?.querySelector<HTMLElement>('[data-pkc-field="updated"]')?.textContent ?? null;
  return { render: (s: AppState) => browse.render(s, 'filer'), row, dateOf, pane };
}

beforeEach(() => {
  document.body.textContent = '';
});

describe('保存の刻みが返っても、表を建て直さない(#270)', () => {
  it('🔴 行の node が入れ替わらない(掴んでいる手の下で消えない)', () => {
    const { render, row } = setup();
    let s = booted();
    render(s);
    const before = row('a');
    expect(before, '前提が崩れている(行が出ていない)').toBeTruthy();

    s = stamped(s, 'a');
    render(s);

    expect(row('a'), '刻みが返っただけで行を作り直した').toBe(before);
    expect(before!.isConnected, '行が document から外れた').toBe(true);
  });

  /**
   * 🔴 **対照群**(空振り防止)。⚠ これが落ちるなら、上は「そもそも日付が
   * 画面に出ていない / 刻みが state に入っていない」だけで、何も守っていない。
   */
  it('対照群: それでも日付は画面に出る(字は差し替わる)', () => {
    const { render, dateOf } = setup();
    let s = booted();
    render(s);
    expect(dateOf('a'), '前提が崩れている(日付の欄が無い)').toBe('');

    s = stamped(s, 'a');
    render(s);

    expect(dateOf('a'), '刻みが返ったのに日付が出ていない').toBe('01/02');
  });

  /**
   * 🔴 **題名が変わったら建て直す**(差し替えで済ませてはいけない側)。
   * ⚠ 「日付だけ」の判定が広すぎると、題名の変化まで飲み込んで**古い字が残る**。
   */
  it('🔴 題名が変わったときは、ちゃんと建て直す', () => {
    const { render, row, pane } = setup();
    let s = booted();
    render(s);
    const before = row('a');

    const metas = new Map(s.entryMetas);
    metas.set('a', { ...metas.get('a')!, title: 'あたらしい名前' });
    s = { ...s, entryMetas: metas };
    render(s);

    expect(row('a'), '題名が変わったのに建て直していない').not.toBe(before);
    expect(pane.textContent, '新しい題名が出ていない').toContain('あたらしい名前');
  });

  /**
   * 🔴 **「更新」で並べているときは建て直す** ── 日付が**並びを変えうる**ので、
   * 字だけ差し替えると**並びが嘘になる**(古い順のまま新しい日付が出る)。
   */
  it('🔴 更新順で並べているときは、刻みで建て直す(並びが嘘にならない)', () => {
    const { render, row } = setup();
    let s = booted();
    s = reduce(s, { type: 'SET_ENTRY_SORT', sort: 'updated' }).state;
    render(s);
    const before = row('a');
    expect(before, '前提が崩れている').toBeTruthy();

    s = stamped(s, 'a');
    render(s);

    expect(row('a'), '更新順なのに建て直していない(並びが古いまま)').not.toBe(before);
  });
});

/**
 * 🔴 **対称の反対側**(CLAUDE.md「片側を直したら、対称の反対側を必ず疑う」)。
 * 2 ペインも同じ指紋・同じ建て直しを持ち、**しかも D&D が主動線**である。
 */
describe('2 ペインでも、刻みが返っただけでは建て直さない(#270)', () => {
  function dual() {
    const region = document.createElement('div');
    document.body.append(region);
    const r = new DualFilerRenderer(region);
    const row = (side: string, lid: string) =>
      region.querySelector<HTMLElement>(
        `[data-pkc-region="dual-pane"][data-pkc-side="${side}"]` +
          ` [data-pkc-region="dual-table"] tbody [data-pkc-entry="${lid}"]`,
      );
    const dateOf = (side: string, lid: string) =>
      row(side, lid)?.querySelector<HTMLElement>('[data-pkc-field="dual-updated"]')?.textContent ??
      null;
    return { render: (s: AppState) => r.render(s), row, dateOf };
  }

  it('🔴 行の node が入れ替わらない', () => {
    const { render, row } = dual();
    let s = booted();
    render(s);
    const before = row('left', 'a');
    expect(before, '前提が崩れている(行が出ていない)').toBeTruthy();

    s = stamped(s, 'a');
    render(s);

    expect(row('left', 'a'), '刻みが返っただけで 2 ペインの行を作り直した').toBe(before);
  });

  it('対照群: それでも日付は画面に出る(字は差し替わる)', () => {
    const { render, dateOf } = dual();
    let s = booted();
    render(s);
    expect(dateOf('left', 'a'), '前提が崩れている(日付の欄が無い)').toBe('');

    s = stamped(s, 'a');
    render(s);

    expect(dateOf('left', 'a'), '刻みが返ったのに日付が出ていない').toBe('01/02');
  });

  it('🔴 更新順で並べているときは建て直す(並びが嘘にならない)', () => {
    const { render, row } = dual();
    let s = booted();
    s = reduce(s, { type: 'SET_ENTRY_SORT', sort: 'updated' }).state;
    render(s);
    const before = row('left', 'a');
    expect(before, '前提が崩れている').toBeTruthy();

    s = stamped(s, 'a');
    render(s);

    expect(row('left', 'a'), '更新順なのに建て直していない').not.toBe(before);
  });
});
