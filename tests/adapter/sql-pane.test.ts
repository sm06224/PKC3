/** @vitest-environment happy-dom */
/**
 * 🔴 **SQL を調べる面**(#681 段②)── 打つ → 押す → worker → 表、を端から端まで。
 *
 * > user の言葉 2026-09-03:「**内蔵の sqlite を最大限活用したインスタントな
 * > csv や sqliteDB のクエリアプリ**」
 *
 * 守る主張:
 * 1. 中央の器(`view=sql`)に、打つ欄・押し所・注意書きが出て、本文の面は畳まれる
 * 2. 打っただけでは**走らない**(重い問い合わせを打鍵ごとに投げない)
 * 3. 押すと走る ── 渡すのは**全角を直した後の字**と上限の 2 つ
 * 4. `Ctrl`+`Enter` でも走る。⚠ **素の `Enter` では走らない**(改行を奪わない)
 * 5. 答えは表になる。`null` は「(なし)」で**印つき**、HTML は注入しない
 * 6. 走っている間は押し所が死んでいて、二重には走らない
 * 7. 書き込みは**字の門**で断る ── worker を **1 度も叩かない**
 * 8. engine が断った字は**読める字**へ直す(readonly / interrupt)
 * 9. 口が無い版(古い worker)は**断る** ── 押して無反応にしない
 * 10. 切ったことを言う / 前の表は消さない
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import {
  connectStoreEffects,
  SQL_MAX_ROWS,
  SQL_MAX_STEPS,
} from '../../src/adapter/state/store-effects';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { isAsidePane, viewModeLabel } from '../../src/adapter/state/app-state';
import { homeTabOf } from '../../src/adapter/ui/render/browse-mode';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';

type SqlAnswer = {
  columns: string[];
  rows: Array<Array<string | number | null>>;
  truncated: boolean;
  ms: number;
};

const answer = (
  columns: string[],
  rows: Array<Array<string | number | null>>,
  extra: Partial<SqlAnswer> = {},
): SqlAnswer => ({ columns, rows, truncated: false, ms: 1, ...extra });

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

/**
 * 面 + binder + effect を**実物で**繋ぐ。⚠ fake は worker の口 1 つだけ ──
 * ここを stub にしないと、渡す字と上限が正しいかを見る場所が無くなる。
 */
function setup(
  reply: (sql: string) => Promise<SqlAnswer> = async () => answer(['a'], [[1]]),
  opts: { withOp?: boolean } = {},
) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const center = new CenterRouter(root);
  d.onState((s) => center.render(s));
  // ⚠ 上限は**捨てない**(呼び側が渡しているかを `mock.calls` で見るため)
  const runReadOnlySql = vi.fn(
    async (sql: string, limits: { maxRows: number; maxSteps: number }) => {
      void limits;
      return reply(sql);
    },
  );
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => '',
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では添付の差し替えを使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => stubStamps(),
    ...(opts.withOp === false ? {} : { runReadOnlySql }),
  });
  bindActions(root, d, {});
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', '会議メモ')], relations: [] });
  d.dispatch({ type: 'SET_VIEW_MODE', mode: 'sql' });
  const pane = root.querySelector<HTMLElement>('[data-pkc-view-pane="sql"]')!;
  const box = pane.querySelector<HTMLTextAreaElement>('[data-pkc-field="sql-input"]')!;
  const runBtn = pane.querySelector<HTMLButtonElement>('[data-pkc-field="sql-run"]')!;
  const type = (sql: string): void => {
    box.value = sql;
    box.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const key = (init: KeyboardEventInit): void => {
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init }));
  };
  const note = (): string => pane.querySelector('[data-pkc-field="sql-note"]')?.textContent ?? '';
  const heads = (): string[] =>
    [...pane.querySelectorAll('[data-pkc-field="sql-table"] thead th')].map(
      (e) => e.textContent ?? '',
    );
  const cells = (): string[][] =>
    [...pane.querySelectorAll('[data-pkc-field="sql-table"] tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent ?? ''),
    );
  return { root, d, pane, box, runBtn, type, key, note, heads, cells, runReadOnlySql };
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

/** worker の答えが state を通って画面へ届くまで待つ。 */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('SQL を調べる面(#681 段②)', () => {
  it('🔴 中央の器に欄と押し所と注意書きが出て、本文の面は畳まれる', () => {
    const { root, pane, box, runBtn } = setup();
    expect(pane.hidden, 'SQL の面が隠れている').toBe(false);
    expect(box, '打つ欄が無い').not.toBeNull();
    expect(runBtn.textContent, '押し所の字').toBe('走らせる');
    expect(root.querySelector<HTMLElement>('[data-pkc-view-pane="detail"]')!.hidden).toBe(true);
    expect(viewModeLabel('sql'), '面の呼び名').toBe('SQL で調べる');
    // ⚠ ノートを映さない**道具**なので aside(左の一覧を押したら中央はノートへ戻る)
    expect(isAsidePane('sql'), 'ノートを映す面に数えられている').toBe(true);
    // ⚠ 左の列に同じ面は無い(2 ペインと同じ ── 退避は中央になる)
    expect(homeTabOf('sql')).toBeNull();
    /**
     * 🔴 **実測したことだけ書く**(`sqlite-capabilities.test.ts` が pin)。
     * ⚠ これが消えると、打つ人は同梱 sqlite の 3 つの癖に**必ず 1 度はぶつかる**。
     */
    const tip = pane.querySelector('[data-pkc-field="sql-tip"]')?.textContent ?? '';
    expect(tip, '読むだけだと言っていない').toContain('読むだけ');
    expect(tip, '単引用符の話が無い').toContain('単引用符');
    expect(tip, 'REGEXP が無いことを言っていない').toContain('REGEXP');
  });

  it('🔴 打っただけでは走らない(打鍵ごとに worker を叩かない)', () => {
    const { d, type, runReadOnlySql } = setup();
    type('SELECT 1');
    expect(d.getState().sqlPage.sql, '欄の字が state に写らない').toBe('SELECT 1');
    expect(runReadOnlySql, '打っただけで走った').not.toHaveBeenCalled();
  });

  it('🔴 押すと走る ── 渡すのは全角を直した字と上限', async () => {
    const { d, type, runBtn, runReadOnlySql, box } = setup();
    // ⚠ **日本語入力のまま打つ**(#764 と同じ ── ASCII だけの fixture は user の道を通らない)
    type('ＳＥＬＥＣＴ　１');
    runBtn.click();
    expect(runReadOnlySql, '押しても走らない').toHaveBeenCalledTimes(1);
    expect(runReadOnlySql.mock.calls[0]?.[0], '全角のまま worker へ渡した').toBe('SELECT 1');
    expect(runReadOnlySql.mock.calls[0]?.[1], '上限を渡していない').toEqual({
      maxRows: SQL_MAX_ROWS,
      maxSteps: SQL_MAX_STEPS,
    });
    // 🔑 **直した字を欄へ返す**(実際に走った字を見せる ── 打った字と違うので)
    expect(box.value, '直した字が欄へ戻っていない').toBe('SELECT 1');
    await settle();
    expect(d.getState().sqlPage.running).toBe(false);
  });

  it('🔴 Ctrl+Enter でも走る。⚠ 素の Enter では走らない(改行を奪わない)', async () => {
    const { type, key, runReadOnlySql } = setup();
    type('SELECT 1');
    key({});
    expect(runReadOnlySql, '素の Enter で走った(改行が打てなくなる)').not.toHaveBeenCalled();
    key({ ctrlKey: true });
    expect(runReadOnlySql, 'Ctrl+Enter で走らない').toHaveBeenCalledTimes(1);
    // ⚠ 走り終わるまで待つ ── 走っている間は二重に受けない(上の it が見ている)
    await settle();
    key({ metaKey: true });
    expect(runReadOnlySql, 'mac の Command+Enter で走らない').toHaveBeenCalledTimes(2);
  });

  it('🔴 答えは表になる ── null は印つき、HTML は注入しない', async () => {
    const { type, runBtn, heads, cells, note, pane } = setup(async () =>
      answer(['title', 'n'], [['<b>太字</b>', null]], { ms: 7 }),
    );
    type('SELECT title, n FROM entries');
    runBtn.click();
    await settle();
    expect(heads(), '列の名前が出ない').toEqual(['title', 'n']);
    expect(cells(), '値が字として出ない').toEqual([['<b>太字</b>', '(なし)']]);
    expect(pane.querySelector('[data-pkc-field="sql-table"] b'), 'HTML を注入した').toBeNull();
    expect(
      pane.querySelector('[data-pkc-field="sql-table"] td[data-pkc-sql-null="yes"]'),
      '値が無いことの印が無い(空の字と見分けられない)',
    ).not.toBeNull();
    expect(note(), '件数と時間を言わない').toBe('1 行(7 ミリ秒)');
  });

  /**
   * 🔴 **1 件も当たらなかった回も、当たらなかったと分かる**(#681 段②)。
   *
   * ⚠ **門を置かなかった軸**である ── 打つ人がいちばん困るのは「押したのに
   *   何も出ない」で、そのとき**走ったのか / 当たらなかったのか**が分からない。
   * 🔑 列の名前だけの表 + 「0 行」の 1 行 = **走った証拠**である
   *   (worker が 0 件でも列名を返すことは `storage-worker.test.ts` が pin している)。
   */
  it('🔴 1 件も当たらなくても、列の名前と「0 行」が出る', async () => {
    const { type, runBtn, heads, cells, note } = setup(async () =>
      answer(['title'], [], { ms: 2 }),
    );
    type("SELECT title FROM entries WHERE 1 = 0");
    runBtn.click();
    await settle();
    expect(heads(), '当たらないと列の名前まで消える(走ったのか分からない)').toEqual(['title']);
    expect(cells()).toEqual([]);
    expect(note(), '0 件だと黙る').toBe('0 行(2 ミリ秒)');
  });

  it('🔴 走っている間は押せず、二重には走らない', async () => {
    let release: ((a: SqlAnswer) => void) | null = null;
    const { type, runBtn, runReadOnlySql, note, d } = setup(
      async () => new Promise<SqlAnswer>((r) => (release = r)),
    );
    type('SELECT 1');
    runBtn.click();
    expect(runBtn.disabled, '走っている最中なのに押せる').toBe(true);
    expect(note(), '走っていることを言わない').toBe('走らせています…');
    // ⚠ **押し所を経由しない道**(近道)でも二重には走らない ── 門は reducer に在る
    d.dispatch({ type: 'RUN_SQL' });
    expect(runReadOnlySql, '二重に走った').toHaveBeenCalledTimes(1);
    release!(answer(['a'], [[1]]));
    await settle();
    expect(runBtn.disabled, '終わったのに押せないまま').toBe(false);
  });

  it('🔴 書き込みは字の門で断る ── worker を 1 度も叩かない', () => {
    const { type, runBtn, runReadOnlySql, note, pane } = setup();
    type('DELETE FROM entries');
    runBtn.click();
    expect(runReadOnlySql, '書き込みを worker まで通した').not.toHaveBeenCalled();
    expect(note(), '断る理由を言わない').toContain('DELETE');
    expect(
      pane.querySelector('[data-pkc-field="sql-note"]')?.getAttribute('data-pkc-sql-error'),
      '断りだと分かる印が無い',
    ).toBe('yes');
    // ⚠ **対照群** ── 読むだけの字なら通る(門そのものが生きている)
    type('SELECT 1');
    runBtn.click();
    expect(runReadOnlySql, '読むだけの字まで止めた').toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 **打ち直したら、前の断りは消える**(#681 段②。変異試験 M6 が SURVIVED で教えた)。
   *
   * ⚠ 消えないと「直したのに、まだ怒られている」に見える ── user は**直した所を
   *   もう一度疑う**(実際には直っているのに)。
   */
  it('🔴 打ち直すと、前の断りは消える', () => {
    const { type, runBtn, note, pane } = setup();
    type('DELETE FROM entries');
    runBtn.click();
    expect(note(), '断りが出ていない(前提が崩れている)').toContain('DELETE');
    type('SELECT 1');
    expect(note(), '打ち直したのに前の断りが残っている').toBe('');
    expect(
      pane.querySelector('[data-pkc-field="sql-note"]')?.getAttribute('data-pkc-sql-error'),
      '断りの印が残っている',
    ).toBe('no');
  });

  it('🔴 engine が断った字は、読める字へ直す', async () => {
    for (const [raw, want] of [
      ['SQLITE_READONLY: attempt to write a readonly database', '書き込みはできません'],
      ['sqlite3 result code 9: interrupted', '時間がかかりすぎた'],
    ] as const) {
      document.body.innerHTML = '';
      const { type, runBtn, note } = setup(async () => {
        throw new Error(raw);
      });
      type('SELECT 1');
      runBtn.click();
      await settle();
      expect(note(), `engine の字がそのまま出た: ${raw}`).toContain(want);
    }
  });

  it('⚠ 知らない断りは、字を捨てずにそのまま見せる(手がかりを消さない)', async () => {
    const { type, runBtn, note } = setup(async () => {
      throw new Error('no such column: いろは');
    });
    type('SELECT いろは FROM entries');
    runBtn.click();
    await settle();
    expect(note(), '打ち間違いの手がかりが消えた').toContain('no such column');
  });

  it('🔴 口が無い版では断る(押して無反応にしない)', async () => {
    const { type, runBtn, note, d } = setup(undefined, { withOp: false });
    type('SELECT 1');
    runBtn.click();
    await settle();
    expect(note(), '押しても何も起きない').toContain('この版では');
    expect(d.getState().sqlPage.running, '走ったままになった').toBe(false);
  });

  it('🔴 切ったことは言う。⚠ 次に失敗しても前の表は消さない', async () => {
    let fail = false;
    const { type, runBtn, note, cells } = setup(async () => {
      if (fail) throw new Error('no such table: x');
      return answer(['a'], [[1], [2]], { truncated: true, ms: 3 });
    });
    type('SELECT a FROM t');
    runBtn.click();
    await settle();
    expect(note(), '切ったことを黙っている').toContain('途中まで');
    fail = true;
    type('SELECT a FROM x');
    runBtn.click();
    await settle();
    expect(note(), '断りが出ていない').toContain('no such table');
    expect(cells(), '失敗した瞬間に前の表が消えた(0 件だったように見える)').toEqual([
      ['1'],
      ['2'],
    ]);
  });

  /**
   * 🔴 **同じ字をもう一度走らせたら、表は新しい答えになる**(#681 段②)。
   *
   * ⚠ 描画器は「字・件数・時間が同じなら描き直さない」で無駄を省いている ──
   *   だから**件数が同じまま中身だけ変わった**回(題名を直してからもう一度走らせる、
   *   別の窓が 1 行直した後にもう一度走らせる)が**いちばん危ない**:
   *   画面は前の答えのままなのに、上の行は「1 行(1 ミリ秒)」と言う。
   * ⚠ ここは**わざと全部同じにしてある**(字も件数も時間も)── 揃えないと
   *   別の項目で描き直されてしまい、この検査は空振りする。
   */
  it('🔴 同じ字をもう一度走らせると、表が新しい答えに入れ替わる', async () => {
    let value = 'ふるい';
    const { type, runBtn, cells, note } = setup(async () => answer(['t'], [[value]], { ms: 1 }));
    type('SELECT t FROM x');
    runBtn.click();
    await settle();
    expect(cells()).toEqual([['ふるい']]);
    value = 'あたらしい';
    runBtn.click();
    await settle();
    expect(cells(), '同じ字・同じ件数・同じ時間だと、前の表が残る').toEqual([['あたらしい']]);
    // ⚠ **対照群** ── 上の行は前も後も同じことを言う(表だけが変わるはずである)
    expect(note()).toBe('1 行(1 ミリ秒)');
  });

  it('⚠ 面を閉じて戻っても、打ちかけの字は消えない', () => {
    const { d, type, root } = setup();
    type('SELECT 1 -- 書きかけ');
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'detail' });
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'sql' });
    const box = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="sql-input"]')!;
    expect(box.value, '戻ったら打ちかけが消えていた').toBe('SELECT 1 -- 書きかけ');
  });
});
