/** @vitest-environment happy-dom */
/**
 * 全文検索の配線(#181)── 打鍵 → SQL → 一覧に出る、までを end-to-end で。
 *
 * 🔴 守る主張:
 * 1. 絞り込みを打つと **REQUEST_SEARCH が出る**(出なければ本文は永久に引かれない)
 * 2. 返ってきた lid が **サイドバーの行として見える**(state だけ動いても意味が無い)
 * 3. **遅れて返った古い結果は捨てる**(打鍵は結果より速い ── 混ざると別の語の
 *    当たりが出たままになる)
 * 4. 問い合わせを変えたら**前の当たりは消える**
 * 5. **絞り込みを描く 4 面が全部**本文の当たりを見る(§7 ── 1 面でも題名だけの
 *    ままだと、その面でだけ「探しても出ない」)
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { SidebarRenderer } from '../../src/adapter/ui/render/sidebar';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import { matchesEntry, NO_KINDS } from '../../src/features/filter/title-filter';

function meta(lid: string, title: string): EntryMeta {
  return {
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: Number(lid.replace(/\D/g, '')) || 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** @param hitsFor 問い合わせ → 当たる lid。⚠ **問い合わせに応じる** stub にする
 *   ── どの語でも同じ結果を返す stub だと、語を変えた test が自分の仕込みを
 *   上書きして「消えた」に見える(実際に踏んだ)。 */
function setup(
  hitsFor: (q: string) => string[] = () => [],
  // ⚠ 切ったか(#680)── 既定は「切っていない」(直す前の全 test の前提そのまま)
  truncatedFor: (q: string) => boolean = () => false,
) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const sidebar = new SidebarRenderer(regions.sidebar);
  d.onState((s) => sidebar.render(s));
  const searchEntries = vi.fn(async (q: string) => ({ lids: hitsFor(q), truncated: truncatedFor(q) }));
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '',
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    /**
     * ⚠ **題名だけの口**(#178)── 本物は本文に触らない。
     *   だから fake も本文を持たない(触らないものは持たない)。
     */
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () =>
      Promise.reject(new Error('この test では添付の差し替えを使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => stubStamps(),
    searchEntries,
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('n1', '会議メモ'), meta('n2', '買い物')],
    relations: [],
  });
  const rows = () =>
    [...root.querySelectorAll('[data-pkc-region="entry-list"] [data-pkc-entry]')].map(
      (e) => e.getAttribute('data-pkc-entry'),
    );
  // 「ほかにもあります」の字(#680)。⚠ 左の列(sidebar の器)に絞って読む
  const more = () =>
    regions.sidebar.querySelector('[data-pkc-field="entry-list-more"]')?.textContent ?? null;
  return { d, rows, searchEntries, more };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('全文検索の配線(#181)', () => {
  it('🔴 絞り込みを打つと SQL へ問い合わせが飛ぶ', async () => {
    const { d, searchEntries } = setup();
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'りんご' });
    await tick();
    expect(searchEntries, '本文が永久に引かれない').toHaveBeenCalledWith('りんご');
  });

  it('🔴 本文が当たった行が一覧に出る(題名に無い語で)', async () => {
    // 'n2'(買い物)の**本文**が当たった、という応答
    const { d, rows } = setup(() => ['n2']);
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'みかん' });
    await tick();
    expect(rows(), '本文で当たった行が一覧に出ていない').toEqual(['n2']);
  });

  it('題名の当たりは SQL を待たずに出る(打った瞬間に反応する)', () => {
    const { d, rows } = setup(() => []);
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '会議' });
    // ⚠ await しない ── 題名の絞り込みは同期で効く
    expect(rows()).toEqual(['n1']);
  });

  it('🔴 遅れて返った古い結果は捨てる', async () => {
    const { d, rows } = setup(() => []);
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'みかん' });
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '存在しない' });
    // 「みかん」の結果が遅れて返ってきた
    d.dispatch({ type: 'SET_SEARCH_HITS', query: 'みかん', lids: ['n2'], truncated: false });
    await tick();
    expect(rows(), '別の語の当たりが混ざっている').toEqual([]);
  });

  it('問い合わせを変えたら前の当たりは消える', async () => {
    const { d, rows } = setup((q) => (q === 'みかん' ? ['n2'] : []));
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'みかん' });
    await tick();
    expect(rows()).toEqual(['n2']);
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'ばなな' });
    await tick();
    expect(rows(), '前の語の当たりが残っている').toEqual([]);
  });

  /**
   * 🔴 **200 件で切ったことが、state と一覧の字に届く**(#680)。
   * ⚠ worker は最初から返していたが、`store-port.ts` が `.lids` だけ取って捨てていた ──
   *   だから「届く」を端から端まで 1 本で見る(state だけ見ると配線の穴は見えない)。
   */
  it('🔴 200 件で切れたら、state に立ち「ほかにもあります」の字が一覧の後ろに出る', async () => {
    const { d, more } = setup(() => ['n2'], () => true);
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'みかん' });
    await tick();
    expect(d.getState().searchHitsTruncated, 'state に届いていない(配線が捨てている)').toBe(true);
    expect(more(), '切ったのに一覧が黙っている').toContain('200 件より多く');
  });

  it('⚠ 対照群 ── 切れていなければ字は出ない', async () => {
    const { d, more } = setup(() => ['n2'], () => false);
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'みかん' });
    await tick();
    expect(d.getState().searchHitsTruncated).toBe(false);
    expect(more(), '切れていないのに「ほかにもあります」が出た').toBeNull();
  });

  it('🔴 語を変えた瞬間に「ほかにもあります」は消える(前の語の断りを持ち越さない)', async () => {
    const { d, more } = setup((q) => (q === 'みかん' ? ['n2'] : []), (q) => q === 'みかん');
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'みかん' });
    await tick();
    expect(more(), '前提が崩れた(切れた字が出ていない)').not.toBeNull();
    // ⚠ await しない ── 結果が返る前に消えていること(返ってから消えるのでは、
    //    0 件の語に「ほかにもある」が一瞬出る)
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'ばなな' });
    expect(more(), '語を変えたのに前の語の「ほかにもあります」が残っている').toBeNull();
  });

  it('検索が失敗しても題名の絞り込みは生きる(操作を止めない)', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const sidebar = new SidebarRenderer(regions.sidebar);
    d.onState((s) => sidebar.render(s));
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => '',
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      /**
       * ⚠ **題名だけの口**(#178)── 本物は本文に触らない。
       *   だから fake も本文を持たない(触らないものは持たない)。
       */
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () =>
        Promise.reject(new Error('この test では添付の差し替えを使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async () => stubStamps(),
      searchEntries: async () => {
        throw new Error('db down');
      },
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', '会議メモ')], relations: [] });
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '会議' });
    await tick();
    expect(
      [...root.querySelectorAll('[data-pkc-region="entry-list"] [data-pkc-entry]')].length,
    ).toBe(1);
    expect(d.getState().error, '検索の失敗で帯を出している').toBeNull();
  });

  /**
   * 🔴 §7 ── **絞り込みを描く面の全数**が本文の当たりを見ること。
   * 1 面でも `matchesTitle` のままだと、その面でだけ「探しても出ない」。
   * ⚠ launcher は **タイル**(entry ではない)ので対象外 ── 意図的に除く。
   */
  it('🔴 絞り込みを描く 3 面が全部、本文の当たりも見る規則を通っている', () => {
    // ⚠ **カレンダー / かんばんは落とし、予定を足した**(#292 段⑤、2026-08-23)
    //    ── 面が入れ替わっても「1 面でも漏れるとその面でだけ探せない」は同じ
    for (const face of ['sidebar', 'schedule']) {
      const src = readFileSync(`src/adapter/ui/render/${face}.ts`, 'utf8');
      expect(src, `${face} が題名だけの絞り込みのまま`).toContain('matchesEntry(');
      expect(src, `${face} に matchesTitle が残っている`).not.toMatch(/matchesTitle\(/);
    }
    /**
     * ⚠ **フォルダ面だけ経路が変わった**(#240 段②)── 行を決める規則は
     * `features/relation/filer-list.ts` の `filerRows` 1 か所へ寄せた
     * (描く側と**範囲選択の reducer** が別の並びを持たないようにするため)。
     * 🔑 だから見るのは 2 つ: ①面がその関数を通ること ②**本文の当たりを渡すこと**
     *   ③その関数自身が `matchesEntry` を使うこと。
     */
    const filer = readFileSync('src/adapter/ui/render/filer.ts', 'utf8');
    expect(filer, 'フォルダ面が共通の規則を通っていない').toContain('filerRows(');
    expect(filer, 'フォルダ面が本文の当たりを渡していない').toContain('searchHits: state.searchHits');
    expect(filer, 'フォルダ面に題名だけの絞り込みが残っている').not.toMatch(/matchesTitle\(/);
    const rows = readFileSync('src/features/relation/filer-list.ts', 'utf8');
    expect(rows, '共通の規則が題名だけになっている').toContain('matchesEntry(');
  });

  it('matchesEntry: 本文の当たりが null(未応答)でも題名は効く', () => {
    const t = (lid: string, title: string) => ({ lid, title, archetype: 'text' });
    const f = (hits: ReadonlySet<string> | null) => ({
      query: '会議',
      bodyHits: hits,
      kinds: NO_KINDS,
    });
    expect(matchesEntry(t('n1', '会議メモ'), f(null))).toBe(true);
    expect(matchesEntry(t('n2', '買い物'), f(null))).toBe(false);
    expect(matchesEntry(t('n2', '買い物'), f(new Set(['n2'])))).toBe(true);
  });
});

/**
 * 🔴 **本文だけが当たったノートを消しても、選択が消えない**(2026-08-15)。
 *
 * ⚠ サブエージェントのレビューが見つけた、#181 の取りこぼし。
 *   後継選択は `visibleOrder` を使うが、そちらは**題名しか見ていなかった** ──
 *   一覧(`matchesEntry`)と答えが食い違い、`indexOf` が -1 になって
 *   選択が `null` へ飛ぶ(一覧には行が見えているのに中央が空になる)。
 */
describe('本文の当たりと削除の後継', () => {
  function meta(lid: string, title: string): EntryMeta {
    return {
      lid,
      title,
      archetype: 'text',
      createdAt: null,
      updatedAt: null,
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
      bodyChars: null,
    };
  }

  it('🔴 消したあと、見えている隣が選ばれる(null へ飛ばない)', () => {
    const d = new Dispatcher();
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('n1', 'りんご'), meta('n2', 'みかん'), meta('n3', 'ぶどう')],
      relations: [],
    });
    // 「りんご」で絞る ── n2 は**本文だけ**が当たっている
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'りんご' });
    d.dispatch({ type: 'SET_SEARCH_HITS', query: 'りんご', lids: ['n2'], truncated: false });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    expect(d.getState().selectedLid).toBe('n2');

    d.dispatch({ type: 'DELETE_ENTRY', lid: 'n2' });
    expect(
      d.getState().selectedLid,
      '本文だけ当たっていたノートを消したら選択が消えた',
    ).not.toBeNull();
    expect(d.getState().selectedLid).toBe('n1');
  });
});
