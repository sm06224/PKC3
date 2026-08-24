/** @vitest-environment happy-dom */
/**
 * 集計の面(#184)の end-to-end:
 * **実クリック**(面の切替ボタン / 束ね方の `<select>`)→ dispatcher → effect →
 * fake store → CenterRouter。「state mutation → consumer 観測点」まで通す。
 *
 * 🔴 PKC2 の同等の面は**空フォルダの smoke 1 本**しか無く、フィルタの test は
 * 0 件、group の test は `<select>` の value しか見ていなかった(実地調査
 * 2026-08-15)。ここは**行が在る状態**で、画面に出た数字と行まで見る。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { collectKeys, groupByKey } from '../../src/features/query/group-by';

function meta(lid: string, title: string, order: number): EntryMeta {
  return {
    lid,
    title,
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

const BODIES: Record<string, string> = {
  e1: '---\nauthor: 佐藤\ntags: [設計, 実装]\n---\n\n本文 1\n',
  e2: '---\nauthor: 佐藤\n---\n\n本文 2\n',
  e3: '---\nauthor: 田中\ntags: [設計]\n---\n\n本文 3\n',
  e4: '前置きの無い本文\n',
};
const METAS = [
  meta('e1', 'ノート 1', 1),
  meta('e2', 'ノート 2', 2),
  meta('e3', 'ノート 3', 3),
  meta('e4', 'ノート 4', 4),
];

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * ⚠ **fake store も本物の意味論を真似る**(stub が実装より賢いとバグが隠れる)。
 * 束ね方の規則は features の純関数**そのもの**を呼ぶ ── worker と同じ関数である。
 */
function setup(opts: { withQuery?: boolean } = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const center = new CenterRouter(regions.detail);
  d.onState((s) => center.render(s));
  bindActions(root, d);
  const store = { ...BODIES };
  const rows = () => METAS.map((m) => ({ lid: m.lid, head: store[m.lid] ?? '' }));
  /** ⚠ **走査の回数**を数える(op の回数ではない ── そこを取り違えたのが 1 稿目)。 */
  const calls = { scans: [] as Array<string | null> };
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => store[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    /**
     * ⚠ **題名だけの口**(#178)── 本物は本文に触らない。
     *   だから fake も本文を持たない(触らないものは持たない)。
     */
    renameEntry: async () => stubStamps(),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      store[e.lid] = e.body;
      return stubStamps();
    },
    ...(opts.withQuery === false
      ? {}
      : {
          queryScan: async (key: string | null) => {
            calls.scans.push(key);
            return { keys: collectKeys(rows()), groups: key === null ? null : groupByKey(rows(), key) };
          },
        }),
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const qa = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
  return { root, d, q, qa, calls, store };
}

/** 面の切替ボタンを**実際に押す**(dispatch で近道しない)。 */
function openQuery(qa: (s: string) => HTMLElement[]): void {
  const btn = qa('[data-pkc-action="set-view"][data-pkc-view="query"]')[0];
  expect(btn, '集計の導線が画面に無い').toBeDefined();
  btn!.click();
}

describe('集計の面(#184)', () => {
  beforeEach(() => {
    document.body.textContent = '';
    try {
      localStorage.clear();
    } catch {
      /* 保存が無い環境でも動く */
    }
  });

  it('🔴 導線を押すと面が出て、束ねられる項目の目録が届く', async () => {
    const { q, qa, calls } = setup();
    openQuery(qa);
    await tick();
    const pane = q('[data-pkc-view-pane="query"]');
    expect(pane, '集計の器が無い').not.toBeNull();
    expect(pane!.hidden, '集計を押したのに面が出ていない').toBe(false);
    // ⚠ **走査は 1 回**(目録と表を別々に頼まない ── DB を 2 度舐めない)
    expect(calls.scans, '走査の回数が 1 回ではない').toEqual([null]);
    const picker = q<HTMLSelectElement>('[data-pkc-field="query-key"]')!;
    // ⚠ 目録は**実際に書かれている項目**だけ(件数つき)
    expect([...picker.options].map((o) => o.value)).toEqual(['', 'author', 'tags']);
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      '(選んでください)',
      'author(3 件)',
      'tags(2 件)',
    ]);
    expect(picker.disabled).toBe(false);
    expect(q('[data-pkc-field="query-note"]')!.textContent).toContain('4 件のノートを見ました');
  });

  it('🔴 項目を選ぶと、値ごとに束ねた表が出る(件数と行まで)', async () => {
    const { q, qa, calls } = setup();
    openQuery(qa);
    await tick();
    const picker = q<HTMLSelectElement>('[data-pkc-field="query-key"]')!;
    picker.value = 'author';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(calls.scans, '選ぶと 1 回だけ走査し直す').toEqual([null, 'author']);
    const groups = qa('[data-pkc-region="query-group"]');
    expect(groups.map((g) => g.getAttribute('data-pkc-group'))).toEqual(['佐藤', '田中', '']);
    expect(
      groups.map((g) => g.querySelector('[data-pkc-field="query-group-count"]')?.textContent),
    ).toEqual(['2 件', '1 件', '1 件']);
    // 未設定は**いちばん下**で、表示名は「(未設定)」
    expect(
      groups[2]!.querySelector('[data-pkc-field="query-group-name"]')!.textContent,
    ).toBe('(未設定)');
    // 組の中の行は**題名**(本文は 1 バイトも主スレッドへ来ていない)
    expect(
      [...groups[0]!.querySelectorAll('[data-pkc-entry]')].map((e) => e.textContent),
    ).toEqual(['ノート 1', 'ノート 2']);
  });

  it('🔑 並べて書いた値は、どちらの組にも入る(タグで束ねる)', async () => {
    const { q, qa } = setup();
    openQuery(qa);
    await tick();
    const picker = q<HTMLSelectElement>('[data-pkc-field="query-key"]')!;
    picker.value = 'tags';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    const groups = qa('[data-pkc-region="query-group"]');
    const byName = new Map(
      groups.map((g) => [
        g.getAttribute('data-pkc-group'),
        [...g.querySelectorAll('[data-pkc-entry]')].map((e) => e.getAttribute('data-pkc-entry')),
      ]),
    );
    expect(byName.get('設計')).toEqual(['e1', 'e3']);
    expect(byName.get('実装')).toEqual(['e1']);
  });

  it('🔴 行を押すと選択が動き、面はここに留まる(かんばんと同じ規約)', async () => {
    const { d, q, qa } = setup();
    openQuery(qa);
    await tick();
    const picker = q<HTMLSelectElement>('[data-pkc-field="query-key"]')!;
    picker.value = 'author';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    const row = qa('[data-pkc-region="query-rows"] [data-pkc-entry="e3"]')[0]!;
    row.click();
    await tick();
    expect(d.getState().selectedLid).toBe('e3');
    expect(d.getState().viewMode, '押したら面から出てしまった').toBe('query');
    // 観測点は**画面**(state だけ見て「効いた」と言わない)
    expect(
      qa('[data-pkc-region="query-rows"] [data-pkc-selected]').map((e) =>
        e.getAttribute('data-pkc-entry'),
      ),
    ).toEqual(['e3']);
    expect(q('[data-pkc-view-pane="query"]')!.hidden).toBe(false);
  });

  it('🔑 選択が動いただけなら、表は作り直されない(押した行が消えない)', async () => {
    const { q, qa } = setup();
    openQuery(qa);
    await tick();
    const picker = q<HTMLSelectElement>('[data-pkc-field="query-key"]')!;
    picker.value = 'author';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    const before = qa('[data-pkc-region="query-rows"] [data-pkc-entry="e1"]')[0]!;
    qa('[data-pkc-region="query-rows"] [data-pkc-entry="e2"]')[0]!.click();
    await tick();
    const after = qa('[data-pkc-region="query-rows"] [data-pkc-entry="e1"]')[0]!;
    expect(after, '行のノードが作り直されている').toBe(before);
  });

  it('🔴 選び直すと前の表を捨てて、必ず問い合わせ直す', async () => {
    const { d, q, qa, calls } = setup();
    openQuery(qa);
    await tick();
    const picker = q<HTMLSelectElement>('[data-pkc-field="query-key"]')!;
    picker.value = 'author';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    picker.value = 'tags';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    expect(d.getState().queryGroups, '選び直した瞬間に古い表が残っている').toBeNull();
    await tick();
    expect(calls.scans).toEqual([null, 'author', 'tags']);
  });

  it('🔴 遅れて返った古い結果は捨てる(選び直しは結果より速い)', async () => {
    const { d } = setup();
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'query' });
    d.dispatch({ type: 'SET_QUERY_KEY', key: 'tags' });
    // author の答えが**後から**届く場面を作る
    d.dispatch({
      type: 'SET_QUERY_SCAN',
      key: 'author',
      keys: { keys: [], omittedKeys: 0, scanned: 4 },
      groups: { groups: [{ value: '佐藤', total: 2, lids: ['e1', 'e2'] }], omittedGroups: 0, scanned: 4 },
    });
    expect(d.getState().queryGroups, '別の束ね方の答えを受け入れてしまった').toBeNull();
  });

  it('🔴 集計を持たない store は「数えています…」で止まらず、断りを出す', async () => {
    /**
     * ⚠ 1 稿目は黙って break していたので、**面は「数えています…」を出したまま
     * 永久に止まって見えた**(古い worker が残っている端末で実際に起きる形)。
     * 落ち方は「機能が減る」でなければならない。
     */
    const { d, q, qa } = setup({ withQuery: false });
    openQuery(qa);
    await tick();
    expect(d.getState().queryFailed, '失敗が state に届いていない').toBe(true);
    const note = q('[data-pkc-field="query-note"]')!.textContent ?? '';
    expect(note, 'まだ「数えています…」と言っている').not.toContain('数えています');
    expect(note).toContain('数えられませんでした');
    expect(q<HTMLSelectElement>('[data-pkc-field="query-key"]')!.disabled).toBe(true);
  });

  it('🔴 目録を切ったら「あと N 個」と画面に出す(keys 側 ── 1 稿目は誰も通っていなかった)', async () => {
    const { d, q, qa } = setup({ withQuery: false });
    openQuery(qa);
    await tick();
    d.dispatch({
      type: 'SET_QUERY_SCAN',
      key: null,
      keys: { keys: [{ key: 'author', count: 3 }], omittedKeys: 7, scanned: 100 },
      groups: null,
    });
    await tick();
    const note = q('[data-pkc-field="query-note"]')!.textContent ?? '';
    expect(note, '切ったのに画面へ出ていない').toContain('あと 7 個');
    expect(note).toContain('100 件のノートを見ました');
  });

  it('🔴 束ね方は覚えていて、次に開いたときに戻る(端末側に覚える)', async () => {
    const first = setup();
    openQuery(first.qa);
    await tick();
    const picker = first.q<HTMLSelectElement>('[data-pkc-field="query-key"]')!;
    picker.value = 'author';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(localStorage.getItem('pkc3.query-key')).toBe('author');

    // 別の起動(器ごと作り直す)
    document.body.textContent = '';
    const second = setup();
    openQuery(second.qa);
    await tick();
    expect(second.d.getState().queryKey, '覚えた束ね方が戻っていない').toBe('author');
    // ⚠ **同じ走査を 2 回頼まない**(目録 1 回 + 表 1 回)
    // ⚠ 思い出したときも**走査は 2 回まで**(目録 → 覚えた key で 1 回)
    expect(second.calls.scans).toEqual([null, 'author']);
    expect(
      second.qa('[data-pkc-region="query-group"]').map((g) => g.getAttribute('data-pkc-group')),
    ).toEqual(['佐藤', '田中', '']);
  });

  /**
   * 🔴 **切ったことを画面に出す**(変異試験 M12 / M13 で判明した穴)。
   * ⚠ features 側で `omittedGroups` を数えていても、**画面に出さなければ user には
   * 「無い」と読める** ── PKC2 の Inventory はまさにそれで黙って切っていた。
   * ここは state を作って**描画の観測点**を見る(数えた値ではなく、出た文字)。
   */
  it('🔴 組を切ったら「あと N 組」と画面に出す', async () => {
    // ⚠ 集計を持たない store にする ── 持たせると**本物の答えが後から届いて**
    //    こちらが作った「切れた表」を上書きする(1 稿目はそれで落ちた)
    const { d, q, qa } = setup({ withQuery: false });
    openQuery(qa);
    await tick();
    d.dispatch({ type: 'SET_QUERY_KEY', key: 'author' });
    d.dispatch({
      type: 'SET_QUERY_SCAN',
      key: 'author',
      keys: { keys: [{ key: 'author', count: 2 }], omittedKeys: 0, scanned: 4 },
      groups: {
        groups: [{ value: '佐藤', total: 2, lids: ['e1', 'e2'] }],
        omittedGroups: 7,
        scanned: 4,
      },
    });
    await tick();
    expect(q('[data-pkc-field="query-note"]')!.textContent).toContain('あと 7 組');
  });

  it('🔴 1 組の中を切ったら「N 件(先頭 M 件)」と出す', async () => {
    const { d, q, qa } = setup({ withQuery: false });
    openQuery(qa);
    await tick();
    d.dispatch({ type: 'SET_QUERY_KEY', key: 'author' });
    d.dispatch({
      type: 'SET_QUERY_SCAN',
      key: 'author',
      keys: { keys: [{ key: 'author', count: 2 }], omittedKeys: 0, scanned: 4 },
      groups: {
        // ⚠ 抱えている lid(2 件)より total(9 件)が多い = 切った状態
        groups: [{ value: '佐藤', total: 9, lids: ['e1', 'e2'] }],
        omittedGroups: 0,
        scanned: 4,
      },
    });
    await tick();
    expect(q('[data-pkc-field="query-group-count"]')!.textContent).toBe('9 件(先頭 2 件)');
  });

  it('🔴 編集中は開けない(ノートを並べる面なので aside ではない)', async () => {
    const { d, q, qa } = setup();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    d.dispatch({ type: 'START_EDIT' });
    await tick();
    expect(d.getState().phase).toBe('editing');
    openQuery(qa);
    await tick();
    expect(d.getState().viewMode, '編集中なのに面が変わった').not.toBe('query');
    expect(q('[data-pkc-view-pane="query"]')!.hidden).toBe(true);
  });

  it('🔴 編集中に押しても、走査を頼まない(面が開かないのに DB を舐めない)', async () => {
    /**
     * ⚠ 1 稿目は「押した先が query か」で見ていたので、**編集中は面が開かないのに
     * 走査だけ飛んで**いた(`SET_VIEW_MODE` は編集中に捨てられるが、
     * `SET_QUERY_KEY` にはその門が無い)。⚠ 覚えた束ね方を**仕込んでから**測る ──
     * 仕込まないとこの行に入らず、空振りのまま緑になる。
     */
    localStorage.setItem('pkc3.query-key', 'author');
    const { d, qa, calls } = setup();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    d.dispatch({ type: 'START_EDIT' });
    await tick();
    expect(d.getState().phase).toBe('editing');
    openQuery(qa);
    await tick();
    expect(d.getState().viewMode).not.toBe('query');
    expect(calls.scans, '面が開かないのに走査を頼んだ').toEqual([]);
    expect(d.getState().queryKey, '開いていないのに束ね方を思い出した').toBeNull();
  });

  it('🔴 「数え直す」でゴミ箱・履歴が畳まれない(面の切替を借りない)', async () => {
    /**
     * ⚠ `SET_VIEW_MODE` を借りると `revisionPanel` / `trashPanel` が畳まれる ──
     * ゴミ箱を開いたまま数え直すと**理由なく閉じる**(P8 段⑤ と同じ形の事故)。
     */
    const { d, q, qa } = setup();
    openQuery(qa);
    await tick();
    // ⚠ 開くのは 2 段(要求 → 一覧が届く)── 実装どおりに踏む
    d.dispatch({ type: 'SHOW_TRASH' });
    d.dispatch({
      type: 'TRASH_LIST_LOADED',
      items: [{ revId: 'r1', entryLid: 'gone', createdAt: null, title: '消したノート', archetype: 'text' }],
    });
    expect(d.getState().trashPanel, '前提が崩れている(ゴミ箱が開いていない)').not.toBeNull();
    q<HTMLElement>('[data-pkc-action="refresh-query"]')!.click();
    /**
     * ⚠ **押した直後に見る**(`await` しない)── ゴミ箱は effect が非同期に
     * 読み直すので、待つと**畳まれたことが埋め戻されて偽の緑になる**
     * (1 稿目はこれで変異が生き延びた:観測点が「放っておいても戻る」もの
     * だった ── CLAUDE.md §4)。
     */
    expect(d.getState().trashPanel, '数え直したらゴミ箱が閉じた').not.toBeNull();
    expect(d.getState().viewMode).toBe('query');
    await tick();
    // 走査は頼んでいる(数え直しそのものは効いている)
    expect(d.getState().queryKeys).not.toBeNull();
  });

  it('🔴 覚えた束ね方は、選ぶ欄にも映る(表だけ合っていて欄が空を指さない)', async () => {
    const first = setup();
    openQuery(first.qa);
    await tick();
    const picker = first.q<HTMLSelectElement>('[data-pkc-field="query-key"]')!;
    picker.value = 'author';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    document.body.textContent = '';
    const second = setup();
    openQuery(second.qa);
    await tick();
    // ⚠ **画面の値**を見る(state だけ見ると、欄に映していない実装が素通りする)
    expect(
      second.q<HTMLSelectElement>('[data-pkc-field="query-key"]')!.value,
      '表は束ねられているのに、選ぶ欄が古い値を指している',
    ).toBe('author');
  });

  it('🔴 畳んだ組は、数え直しても畳んだまま', async () => {
    const { q, qa } = setup();
    openQuery(qa);
    await tick();
    const picker = q<HTMLSelectElement>('[data-pkc-field="query-key"]')!;
    picker.value = 'author';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    const box = qa('[data-pkc-region="query-group"]')[0]! as HTMLDetailsElement;
    expect(box.open, '既定は開いている').toBe(true);
    box.open = false;
    box.dispatchEvent(new Event('toggle'));
    q<HTMLElement>('[data-pkc-action="refresh-query"]')!.click();
    await tick();
    const again = qa('[data-pkc-region="query-group"]')[0]! as HTMLDetailsElement;
    expect(again.open, '数え直したら畳んだ組が開いた').toBe(false);
  });

  it('🔴 ノートが消えたら、表からも消える(一覧の変化を見ている)', async () => {
    const { d, qa } = setup();
    openQuery(qa);
    await tick();
    const picker = qa('[data-pkc-field="query-key"]')[0]! as HTMLSelectElement;
    picker.value = 'author';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(qa('[data-pkc-region="query-rows"] [data-pkc-entry="e1"]')).toHaveLength(1);
    d.dispatch({ type: 'DELETE_ENTRY', lid: 'e1' });
    await tick();
    expect(
      qa('[data-pkc-region="query-rows"] [data-pkc-entry="e1"]'),
      '消したノートの行が残っている(押すと無言の dead click になる)',
    ).toHaveLength(0);
  });

  it('🔴 取り込み(再読込)のあと、古い数字を出し続けない', async () => {
    /**
     * ⚠ 取込は `SYS_BOOTED` を通る ── 集計の数字を残すと「N 件のノートを見ました」が
     * **古い数のまま**出続ける。⚠ 捨てるだけでは「数えています…」で止まるので、
     * **面を開いていれば数え直しも頼む**(捨てる側と頼む側は対で要る)。
     */
    const { d, qa, calls } = setup();
    openQuery(qa);
    await tick();
    const picker = qa('[data-pkc-field="query-key"]')[0]! as HTMLSelectElement;
    picker.value = 'author';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(d.getState().queryKeys).not.toBeNull();
    const before = calls.scans.length;
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
    // ⚠ 捨てたことを**その場で**見る(await すると数え直しが埋め戻す)
    expect(d.getState().queryKeys, '再読込のあとも古い目録が残っている').toBeNull();
    expect(d.getState().queryGroups, '再読込のあとも古い表が残っている').toBeNull();
    expect(d.getState().queryKey, '束ね方(端末の設定)まで捨てている').toBe('author');
    await tick();
    expect(calls.scans.length, '捨てただけで数え直しを頼んでいない').toBeGreaterThan(before);
    expect(d.getState().queryKeys, '数え直しが届いていない').not.toBeNull();
  });

  it('🔑 「数え直す」は同じ経路で数え直す(保存のたびに自動では走らせない)', async () => {
    const { q, qa, calls, store } = setup();
    openQuery(qa);
    await tick();
    const picker = q<HTMLSelectElement>('[data-pkc-field="query-key"]')!;
    picker.value = 'author';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    // 本文を書き換えても、押すまでは数え直さない
    store.e4 = '---\nauthor: 鈴木\n---\n\n書き足した\n';
    await tick();
    expect(
      qa('[data-pkc-region="query-group"]').map((g) => g.getAttribute('data-pkc-group')),
    ).toEqual(['佐藤', '田中', '']);
    q<HTMLElement>('[data-pkc-action="refresh-query"]')!.click();
    await tick();
    expect(calls.scans).toEqual([null, 'author', 'author']);
    expect(
      qa('[data-pkc-region="query-group"]').map((g) => g.getAttribute('data-pkc-group')),
    ).toEqual(['佐藤', '田中', '鈴木']);
  });
});
