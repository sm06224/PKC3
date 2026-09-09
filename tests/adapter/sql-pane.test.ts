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
  SQL_MAX_MS,
  SQL_MAX_ROWS,
  SQL_MAX_STEPS,
} from '../../src/adapter/state/store-effects';
import { REQUEST_TIMEOUT_MS } from '../../src/adapter/platform/storage/store-proxy';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { isAsidePane, viewModeLabel } from '../../src/adapter/state/app-state';
import { homeTabOf } from '../../src/adapter/ui/render/browse-mode';
import { readFileSync } from 'node:fs';
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
  const persisted: Array<{ lid: string; body: string }> = [];
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
    // 🔑 **書いた本文を控える**(#681 段③ ── 「ノートへ」が何を書いたかを見るため)
    persistEntry: async (e: { lid: string; body: string }) => {
      persisted.push(e);
      return stubStamps();
    },
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
  const saveBtn = pane.querySelector<HTMLButtonElement>('[data-pkc-field="sql-to-note"]')!;
  return {
    root,
    d,
    pane,
    box,
    runBtn,
    saveBtn,
    type,
    key,
    note,
    heads,
    cells,
    runReadOnlySql,
    persisted,
  };
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

  /**
   * 🔴 **開いたら、そのまま打てる**(2026-09-09 の動線レビュー)。
   * ⚠ 打つためだけに開く窓なので、まず欄を 1 回押させるのは手数が 1 つ多い
   *   (探す面は既にそうしている)。⚠ **1 回だけ** ── 答えが届くたびに奪い直さない。
   */
  it('🔴 開いた最初の 1 回だけ、欄へ焦点が入る', async () => {
    const { box, type, runBtn } = setup();
    expect(document.activeElement, '開いたのに欄へ焦点が入っていない').toBe(box);
    box.blur();
    type('SELECT 1');
    runBtn.click();
    await settle();
    expect(document.activeElement, '答えが届いた瞬間に焦点を奪った').not.toBe(box);
  });

  /**
   * 🔴 **注意書きは「何が調べられるか」から始める**(2026-09-09 の動線レビュー)。
   * ⚠ 落とし穴だけを並べると、**表の名前が 1 つも出ていない**画面になる ──
   *   唯一の手掛かりだった薄字の例文は、**1 文字打った瞬間に消える**。
   */
  it('🔴 注意書きが、調べられる表の名前を出している', () => {
    const { pane } = setup();
    const tip = pane.querySelector('[data-pkc-field="sql-tip"]')?.textContent ?? '';
    for (const table of ['entries', 'relations', 'revisions', 'assets'])
      expect(tip, `${table} の名前が画面に無い`).toContain(table);
  });

  /**
   * 🔴 **断った回も、直した字を欄へ返す**(2026-09-09 の着地前レビュー)。
   * ⚠ 返さないと、断り文には半角の `DELETE` と出るのに欄は全角のまま ──
   *   **画面の中で辻褄が合わない**(`sql-guard.ts` はそう返す約束を書いている)。
   */
  it('🔴 断られた回も、欄の字は走らせる形に直る', () => {
    const { box, type, runBtn, note } = setup();
    type('ＤＥＬＥＴＥ　ＦＲＯＭ　entries');
    runBtn.click();
    expect(note(), '断っていない(前提が崩れている)').toContain('DELETE');
    expect(box.value, '断り文と欄の字が食い違っている').toBe('DELETE FROM entries');
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
      maxMs: SQL_MAX_MS,
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
    expect(note(), '0 件だと黙る').toBe('0 行(2 ミリ秒) ── 条件に当たるものがありませんでした');
  });

  /**
   * 🔴 **0 行のとき、いちばん多い外し方を名指しする**(2026-09-09 の動線レビュー)。
   *
   * ⚠ 日本語入力のまま `LIKE '％請求％'` と打つと、門は通り(引用符の中は直さないのが
   *   正しい)、走り、**0 行**で返る ── 実測で半角なら 1 行、全角なら 0 行。
   * 🔑 失敗ではなく 0 行なので、user は「そのノートは無い」と読む。だから画面が言う。
   */
  it('🔴 全角の ％ で 0 行になった回は、その理由を名指しする', async () => {
    const { type, runBtn, note } = setup(async () => answer(['title'], [], { ms: 1 }));
    type("SELECT title FROM entries WHERE body LIKE '％請求％'");
    runBtn.click();
    await settle();
    expect(note(), '全角の記号だと気づける字が無い').toContain('全角の ％');
  });

  it('⚠ 対照群 ── 半角で打って 0 行だったときは、その注記を出さない', async () => {
    const { type, runBtn, note } = setup(async () => answer(['title'], [], { ms: 1 }));
    type("SELECT title FROM entries WHERE body LIKE '%請求%'");
    runBtn.click();
    await settle();
    expect(note(), '半角で打った人にまで全角の話をしている').not.toContain('全角の ％');
  });

  /**
   * 🔴 **上限は、画面の外の約束と噛み合っていること**(2026-09-09 の着地前レビュー)。
   * ⚠ 期待値を同じ定数から作ると**両辺が同じ盲点を共有する**ので、
   *   **別の観測**(follower が諦める時刻 / マニュアルの字)と突き合わせる。
   */
  it('🔴 実時間の上限は、別窓が諦めるより先に来る', () => {
    expect(
      SQL_MAX_MS,
      '別窓は先に諦める ── 面には「本体タブと通信できません」という嘘が出る',
    ).toBeLessThan(REQUEST_TIMEOUT_MS);
    expect(SQL_MAX_MS, '短すぎて普通の問い合わせが止まる').toBeGreaterThan(3_000);
  });

  it('🔴 行の上限は、マニュアルが書いている数と同じ', () => {
    // ⚠ 相対 path で読む(`docs-parity.test.ts` と同じ作法 ── cwd はリポジトリの根)
    const manual = readFileSync('docs/manual.md', 'utf-8');
    expect(manual, 'マニュアルの数と実装が食い違っている').toContain(
      `答えは ${String(SQL_MAX_ROWS)} 行まで`,
    );
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

/**
 * 🔴 **答えをノートへ書き出す**(#681 段③ の 3 つ目)。
 *
 * ⚠ この面は**別の窓**で開くので、ノートを作っても**その窓には何も起きない** ──
 *   だから「作った」と画面で言う。言わないと、押した user には
 *   **押せなかった**ように見える(CLAUDE.md「押した後どうなるか」)。
 *
 * 守る主張:
 * 1. 答えが無いうちは**押せない**(押せるのに何も起きない口を作らない)
 * 2. 押すとノートが 1 件できて、本文に打った SQL と表が入る
 * 3. 🔴 できたことを**画面が言う**(題名つき)
 * 4. 走らせ直したら知らせは消える(古い知らせを次の答えの上に残さない)
 */
describe('答えをノートへ書き出す(#681 段③ の 3 つ目)', () => {
  it('🔴 まだ走らせていないうちは押せない', () => {
    const { saveBtn } = setup();
    expect(saveBtn, '「ノートへ」の口が無い').not.toBeNull();
    expect(saveBtn.disabled, '答えが無いのに押せる').toBe(true);
  });

  it('🔴 押すとノートが 1 件でき、打った SQL と表が本文に入る', async () => {
    const { d, type, runBtn, saveBtn, persisted } = setup(async () =>
      answer(['title', 'n'], [['あ', 1]]),
    );
    type('SELECT title, n FROM entries');
    runBtn.click();
    await settle();
    expect(saveBtn.disabled, '答えが出たのに押せない').toBe(false);

    const before = d.getState().entryMetas.size;
    saveBtn.click();
    const metas = [...d.getState().entryMetas.values()];
    expect(metas.length, 'ノートが増えていない').toBe(before + 1);
    const made = metas.find((m) => m.title.startsWith('SQL の答え'));
    expect(made, '題名が「SQL の答え …」になっていない').toBeDefined();

    /**
     * 🔴 **disk へ渡った本文で見る**(state の下書きではない)── ここを見ないと、
     *   「ノートは増えたが中身が空」でも緑になる(CLAUDE.md §4「下流まで通す」)。
     */
    await settle();
    const wrote = persisted.find((e) => e.lid === made?.lid);
    expect(wrote, '本文が disk へ渡っていない').toBeDefined();
    expect(wrote?.body, '打った SQL が本文に無い').toContain('SELECT title, n FROM entries');
    expect(wrote?.body, '見出しが本文に無い').toContain('title,n');
    expect(wrote?.body, '行が本文に無い').toContain('あ,1');
  });

  it('🔴 書き出したことを画面が言う(別の窓なので、言わないと押せなかったように見える)', async () => {
    const { type, runBtn, saveBtn, note } = setup(async () => answer(['a'], [[1]]));
    type('SELECT 1 AS a');
    runBtn.click();
    await settle();
    expect(note(), '押す前から書き出したと言っている').not.toContain('書き出しました');
    saveBtn.click();
    expect(note(), '書き出したことを言っていない').toContain('書き出しました');
    expect(note(), '題名を言っていない').toContain('SQL の答え');
  });

  /**
   * 🔴 **知らせを消す門は 2 つある**(打ち直した / 走らせ直した)。
   * ⚠ **1 つずつ鳴る場面を作る**(CLAUDE.md §1「門を N 個置いたら、N 個目だけが
   *   鳴る場面を N 通り作る」)── まとめて 1 本の test にすると、
   *   **片方を壊してももう片方が救って落ちない**(変異試験 A1/A2 が SURVIVED で教えた)。
   */
  it('⚠ 打ち直しただけで、前の知らせは消える(走らせなくても)', async () => {
    const { type, runBtn, saveBtn, note } = setup(async () => answer(['a'], [[1]]));
    type('SELECT 1 AS a');
    runBtn.click();
    await settle();
    saveBtn.click();
    expect(note()).toContain('書き出しました');
    // ⚠ **走らせない** ── 打っただけで消えることを見る
    type('SELECT 2 AS a');
    expect(note(), '打ち直したのに前の知らせが残っている').not.toContain('書き出しました');
  });

  it('⚠ 同じ字のまま走らせ直しても、前の知らせは消える', async () => {
    const { type, runBtn, saveBtn, note } = setup(async () => answer(['a'], [[1]]));
    type('SELECT 1 AS a');
    runBtn.click();
    await settle();
    saveBtn.click();
    expect(note()).toContain('書き出しました');
    // ⚠ **打ち直さない** ── 走らせ直しただけで消えることを見る
    runBtn.click();
    await settle();
    expect(note(), '走らせ直したのに前の知らせが残っている').not.toContain('書き出しました');
  });

  /**
   * 🔴 **押せる印を外しても、何も起きない**(2 つ目の網)。
   *
   * ⚠ ふだんは画面が押させない(`disabled`)が、それは**見た目の側の門**である ──
   *   別の道(鍵・拡張・作り直しの途中)から同じ action が来ても、答えが無ければ
   *   **ノートを作ってはいけない**(空のノートが増えるのがいちばん困る)。
   * ⚠ この test が無いと、受け側の門を外しても誰も落ちない(変異試験 B1 が SURVIVED)。
   */
  it('🔴 答えが無いまま呼ばれても、ノートは作らない', () => {
    const { d, saveBtn, note } = setup();
    const before = d.getState().entryMetas.size;
    saveBtn.disabled = false; // ⚠ 画面の門を外して、受け側の門だけを見る
    saveBtn.click();
    expect(d.getState().entryMetas.size, '答えが無いのにノートを作った').toBe(before);
    expect(note(), '作っていないのに書き出したと言った').not.toContain('書き出しました');
  });

  it('⚠ 走っている最中は押せない(二重に作らせない)', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));
    const { type, runBtn, saveBtn } = setup(async () => {
      await gate;
      return answer(['a'], [[1]]);
    });
    type('SELECT 1 AS a');
    runBtn.click();
    expect(saveBtn.disabled, '走っている最中に押せる').toBe(true);
    release();
    await settle();
  });
});
