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
import type { SqlGuestSource } from '../../src/features/query/sql-guest-source';
// 🔴 手持ちのファイルを開く(#854 段②)── main.ts と**同じ実物**を配線する
import { registerSqlLocalFile, takeSqlLocalFileBytes } from '../../src/adapter/state/sql-local-file';
import { SQL_PICK_LOCAL_FILE_VALUE } from '../../src/features/query/sql-local-file';

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
  opts: {
    withOp?: boolean;
    /**
     * 🔴 **`readLocalSqlFile` だけを外す**(#854 段②)。⚠ `withOp: false` とは別 ──
     *   あちらは worker の口ごと無い版、こちらは**手持ちのファイルの口だけ無い版**
     *   (添付の `.sqlite` / `.csv` は今までどおり開ける)。
     */
    withLocal?: boolean;
  } = {},
) {
  const root = document.createElement('div');
  document.body.append(root);
  const persisted: Array<{ lid: string; body: string }> = [];
  const d = new Dispatcher();
  const center = new CenterRouter(root);
  d.onState((s) => center.render(s));
  // ⚠ 上限は**捨てない**(呼び側が渡しているかを `mock.calls` で見るため)
  const runReadOnlySql = vi.fn(
    async (sql: string, limits: { maxRows: number; maxSteps: number; guest?: boolean }) => {
      void limits;
      return reply(sql);
    },
  );
  /** 取り込んだ `.sqlite` / `.csv` / `.tsv` の口(#681 段③ の 2 つ目、#854 段①)。
   *  ⚠ 実物は worker の別接続 ── ここは**渡された引数**だけを見る fake である。 */
  /** 開くのを**手で止められる**門(遅れて届く答えを作るため)。 */
  let holdOpen: null | (() => void) = null;
  const openSqlGuest = vi.fn(async (image: Uint8Array, source?: SqlGuestSource) => {
    if (image.byteLength === 0) {
      throw new Error(
        source === undefined
          ? 'この file は sqlite の DB として読めませんでした'
          : `この file は ${source.kind} として読めませんでした(空か、区切りの見つかる行が 1 つもありません)`,
      );
    }
    if (holdOpen !== null) {
      const gate = new Promise<void>((r) => (holdOpen = r as unknown as () => void));
      await gate;
    }
    if (source !== undefined) {
      // 🔑 「大きい.tsv」だけ打ち切ったことにする(#854 段①ノート行の test 用)
      // ⚠ `.xlsx` は**枚ごとに表が増える**ので、名前も枚の数だけ返す(#854 段③)
      const tables = source.kind === 'xlsx' ? ['sheet1', 'sheet2'] : ['csv'];
      return { tables, bytes: image.byteLength, truncated: source.lid === 'db6' };
    }
    return { tables: ['売上', '客'], bytes: image.byteLength, truncated: false };
  });
  const closeSqlGuest = vi.fn(async () => null);
  const readAssetBytes = vi.fn(async (key: string) =>
    key === 'ast-ng' ? null : key === 'ast-csv-broken' ? new Uint8Array([]) : new Uint8Array([1, 2, 3, 4]),
  );
  connectStoreEffects(d, {
    ...stubRevisionOps(),
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
    // ⚠ 添付の本文は frontmatter に key を持つ(実物と同じ形で読ませる)
    getBody: async (lid: string) =>
      lid === 'db1'
        ? '---\nattachment.name: 売上.sqlite\nattachment.asset_key: ast-ok\n---\n'
        : lid === 'db2'
          ? '---\nattachment.name: 壊れ.sqlite\nattachment.asset_key: ast-ng\n---\n'
          : lid === 'db3'
            ? // ⚠ **key を持たない添付**(本文が壊れている / 取り込みが途中で終わった)
              '---\nattachment.name: 中身なし.sqlite\n---\n'
            : lid === 'db4'
              ? '---\nattachment.name: 売上.csv\nattachment.asset_key: ast-csv-ok\n---\n'
              : lid === 'db5'
                ? '---\nattachment.name: 壊れ.csv\nattachment.asset_key: ast-csv-broken\n---\n'
                : lid === 'db6'
                  ? '---\nattachment.name: 大きい.tsv\nattachment.asset_key: ast-tsv-ok\n---\n'
                  : '',
    ...(opts.withOp === false ? {} : { runReadOnlySql, openSqlGuest, closeSqlGuest }),
  }, opts.withOp === false
    ? {}
    : {
        readAssetBytes,
        // 🔴 手持ちのファイル(#854 段②)── 実物の控えをそのまま繋ぐ
        //    (⚠ `withLocal: false` のときは**この口だけ**外す)
        ...(opts.withLocal === false ? {} : { readLocalSqlFile: (lid: string) => takeSqlLocalFileBytes(lid) }),
      });
  bindActions(root, d, {
    // 🔴 main.ts と**同じ実物の配線**(#854 段②)── ここだけ fake にしない
    pickSqlLocalFile: (file: File) => {
      const lid = registerSqlLocalFile(file);
      d.dispatch({ type: 'SET_SQL_SOURCE', lid, name: file.name });
    },
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [
      meta('n1', '会議メモ'),
      // 🔑 取り込んだ `.sqlite`(添付のノート)── 選び所に並ぶ相手
      { ...meta('db1', '売上.sqlite'), archetype: 'attachment' },
      { ...meta('db2', '壊れ.sqlite'), archetype: 'attachment' },
      { ...meta('db3', '中身なし.sqlite'), archetype: 'attachment' },
      // 🔑 取り込んだ `.csv` / `.tsv`(#854 段①)── `.sqlite` の下に並ぶはず
      { ...meta('db4', '売上.csv'), archetype: 'attachment' },
      { ...meta('db5', '壊れ.csv'), archetype: 'attachment' },
      { ...meta('db6', '大きい.tsv'), archetype: 'attachment' },
      // ⚠ **対照群** ── 添付でも `.sqlite` / `.csv` / `.tsv` でないものは並ばない
      { ...meta('png1', 'ねこ.png'), archetype: 'attachment' },
    ],
    relations: [],
  });
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
  // 🔑 **構造をノートへ**(#918 段①)── 答えが無くても押せる側
  const schemaBtn = pane.querySelector<HTMLButtonElement>('[data-pkc-field="sql-schema-to-note"]')!;
  const sourceSel = pane.querySelector<HTMLSelectElement>('[data-pkc-field="sql-source"]')!;
  const pick = (lid: string): void => {
    sourceSel.value = lid;
    sourceSel.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const fileInput = pane.querySelector<HTMLInputElement>('[data-pkc-field="sql-file-input"]')!;
  /**
   * 🔴 **「手持ちのファイルを開く…」を選んで、file を選ぶところまで**(#854 段②)。
   * ⚠ **2 段で行う**(選び所を「開く…」にしてから、隠した `<input>` へ file を渡す)
   *   ── 実機で user が辿る 2 段と同じ形にする(1 段にまとめると、選び所が
   *   `binder.ts` の `set-sql-source` を実際に通るかを見落とす)。
   */
  const pickLocalFile = (file: File): void => {
    sourceSel.value = SQL_PICK_LOCAL_FILE_VALUE;
    sourceSel.dispatchEvent(new Event('change', { bubbles: true }));
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  };
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
    schemaBtn,
    runReadOnlySql,
    persisted,
    sourceSel,
    pick,
    fileInput,
    pickLocalFile,
    openSqlGuest,
    closeSqlGuest,
    readAssetBytes,
    /** 次に開く 1 回を止める(遅れて届く答えを作る)。 */
    holdNextOpen: (): void => {
      holdOpen = () => undefined;
    },
    /** 止めていた 1 回を進める。 */
    releaseOpen: (): void => {
      const go = holdOpen;
      holdOpen = null;
      go?.();
    },
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
    /**
     * ⚠ **2026-09-09(#837 K1)に 3 行へ割った** ── 案内(何が調べられるか)/
     *   約束(読むだけ・引用符・REGEXP)/ 消えない手本。
     * 🔑 **主張は変えていない**:「画面に出ている」ことを見るので、
     *   3 つを合わせて読む(どの要素に書いてあるかは主張ではない)。
     */
    const tip =
      (pane.querySelector('[data-pkc-field="sql-tip"]')?.textContent ?? '') +
      (pane.querySelector('[data-pkc-field="sql-rules"]')?.textContent ?? '');
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

/**
 * 🔴 **取り込んだ `.sqlite` を調べる**(#681 段③ の 2 つ目)。
 *
 * user の言葉(2026-09-03)の「**csv や sqliteDB のクエリアプリ**」の sqliteDB の側。
 *
 * 守る主張:
 * 1. 選び所に**添付の `.sqlite` だけ**が並ぶ(写真は並ばない)
 * 2. 選ぶと開いて、**どちらを調べているか**が画面の上の行に出る
 * 3. 🔴 打つ先が**客の DB へ切り替わる**(`guest: true` が渡る)
 * 4. 🔴 開けなかったら**理由を言って、この PKC へ戻る**(黙って戻らない)
 * 5. 🔴 選び直すと**前の相手を手放す**(常駐メモリを返す)
 * 6. 相手を変えたら**前の答えは消す**(別の DB の話が残らない)
 */
describe('取り込んだ .sqlite を調べる(#681 段③ の 2 つ目)', () => {
  it('🔴 選び所に、添付の .sqlite が並ぶ(対照群 ── #854 段① で拾い方を広げても壊れていない)', () => {
    const { sourceSel } = setup();
    const names = [...sourceSel.options].map((o) => o.textContent);
    expect(names[0], '既定が「この PKC」でない').toBe('この PKC のノート');
    expect(names, '取り込んだ DB が並んでいない').toContain('売上.sqlite');
    // ⚠ **対照群** ── 添付でも DB / csv / tsv でないものは並ばない
    expect(names, '写真まで並んでいる').not.toContain('ねこ.png');
  });

  it('🔴 選ぶと開いて、どちらを調べているかが画面に出る', async () => {
    const { pick, note, openSqlGuest, readAssetBytes } = setup();
    pick('db1');
    await settle();
    expect(readAssetBytes).toHaveBeenCalledWith('ast-ok');
    expect(openSqlGuest, '客の DB を開いていない').toHaveBeenCalledTimes(1);
    expect(note(), 'どちらを調べているか言っていない').toContain('売上.sqlite');
    expect(note(), '中に何が在るか言っていない').toContain('表 2 個');
  });

  it('🔴 打つ先が客の DB へ切り替わる', async () => {
    const { pick, type, runBtn, runReadOnlySql } = setup();
    pick('db1');
    await settle();
    type('SELECT 1 AS a');
    runBtn.click();
    await settle();
    const limits = runReadOnlySql.mock.calls[0]?.[1];
    expect(limits?.guest, '客へ打っていない(この PKC を数えている)').toBe(true);
  });

  it('⚠ この PKC のままなら、客のフラグは渡さない(対照群)', async () => {
    const { type, runBtn, runReadOnlySql } = setup();
    type('SELECT 1 AS a');
    runBtn.click();
    await settle();
    expect(runReadOnlySql.mock.calls[0]?.[1]?.guest).toBeUndefined();
  });

  it('🔴 開けなかったら理由を言って、この PKC へ戻る', async () => {
    const { pick, note, sourceSel, type, runBtn, runReadOnlySql } = setup();
    pick('db2'); // ⚠ bytes が取れない添付
    await settle();
    expect(note(), '理由を言っていない').toContain('開けませんでした');
    expect(sourceSel.value, '開けていないのに、その相手を選んだ顔をしている').toBe('');
    // 🔴 **打つ先も戻っている**(字だけ戻して中身は客のまま、を作らない)
    type('SELECT 1 AS a');
    runBtn.click();
    await settle();
    expect(runReadOnlySql.mock.calls[0]?.[1]?.guest).toBeUndefined();
  });

  it('🔴 添付に中身が無いときは、理由を言う(黙って何も起きない形を作らない)', async () => {
    const { pick, note } = setup();
    pick('db3'); // ⚠ key を持たない添付
    await settle();
    expect(note(), '理由が「中身が見つかりません」になっていない').toContain(
      '添付の中身が見つかりません',
    );
  });

  it('🔴 bytes が取れないときも、同じ理由を言う', async () => {
    const { pick, note } = setup();
    pick('db2'); // ⚠ IDB に bytes が無い
    await settle();
    expect(note(), '理由が「中身が見つかりません」になっていない').toContain(
      '添付の中身が見つかりません',
    );
  });

  /**
   * 🔴 **遅れて届いた「開けました」は捨てる**(#681 段③ の 2 つ目)。
   *
   * ⚠ 受けてしまうと、**選んでいない DB を「調べています」と出す** ── そして
   *   打った SQL はそちらへ飛ぶ(いちばん気づけない外し方)。
   */
  it('🔴 選び直した後に前の相手が開けても、そちらへ切り替わらない', async () => {
    const { pick, note, holdNextOpen, releaseOpen, sourceSel } = setup();
    holdNextOpen();
    pick('db1'); // ⚠ 開くのを止めておく
    await settle();
    pick(''); // この PKC へ戻す
    await settle();
    releaseOpen(); // ⚠ ここで「db1 が開けました」が遅れて届く
    await settle();
    expect(sourceSel.value, '選んでいない相手へ切り替わった').toBe('');
    expect(note(), '選んでいない相手を「調べています」と出した').not.toContain('売上.sqlite');
  });

  it('🔴 選び直すと、前の相手を手放す', async () => {
    const { pick, closeSqlGuest } = setup();
    pick('db1');
    await settle();
    const before = closeSqlGuest.mock.calls.length;
    pick('');
    await settle();
    expect(closeSqlGuest.mock.calls.length, '手放していない(常駐メモリが残る)').toBe(before + 1);
  });

  it('🔴 相手を変えたら、前の答えは消える(別の DB の話が残らない)', async () => {
    const { type, runBtn, pick, cells, note } = setup(async () => answer(['a'], [[1]]));
    type('SELECT 1 AS a');
    runBtn.click();
    await settle();
    expect(cells(), '前提が崩れている(答えが出ていない)').toEqual([['1']]);
    pick('db1');
    await settle();
    expect(cells(), '別の DB を選んだのに、前の答えが残っている').toEqual([]);
    expect(note(), '前の件数が残っている').not.toContain('1 行');
  });
});

/**
 * 🔴 **添付の `.csv` / `.tsv` を調べる**(#854 段①)。
 *
 * user の言葉(2026-09-12)の「csv や sqliteDB のクエリアプリ」の csv の側 ──
 * 段①② は本文に書いた csv の囲みだけを引けた。ここでは**添付として取り込んだ
 * `.csv` / `.tsv` そのもの**を、上の `.sqlite` と同じ選び所から選べるようにする。
 *
 * 守る主張:
 * 1. 選び所に、`.sqlite` の**下に** `.csv` / `.tsv` が並ぶ
 * 2. 選ぶと `openSqlGuest` に**拡張子から見分けた `csv` 引数**が渡る
 *   (`.sqlite` を選んだときは渡らない ── 対照群)
 * 3. 空 / 読めない file を選んだら、理由が画面に出る(黙って終わらない)
 * 4. 上限で打ち切ったら、選んでいる間ずっと画面の字で言う(黙って一部だけ返さない)
 */
describe('添付の csv / tsv を調べる(#854 段①)', () => {
  it('🔴 選び所に、.sqlite の下に .csv / .tsv が並ぶ', () => {
    const { sourceSel } = setup();
    const names = [...sourceSel.options].map((o) => o.textContent);
    const at = (n: string): number => names.indexOf(n);
    expect(at('売上.csv'), '.csv が並んでいない').toBeGreaterThan(-1);
    expect(at('大きい.tsv'), '.tsv が並んでいない').toBeGreaterThan(-1);
    expect(at('売上.csv'), '.sqlite より上に出ている').toBeGreaterThan(at('売上.sqlite'));
  });

  it('🔴 選ぶと、拡張子から見分けた csv 引数が openSqlGuest へ渡る', async () => {
    const { pick, openSqlGuest, readAssetBytes } = setup();
    pick('db4'); // 売上.csv
    await settle();
    expect(readAssetBytes).toHaveBeenCalledWith('ast-csv-ok');
    const call = openSqlGuest.mock.calls[0];
    expect(call?.[1], '.csv なのに csv として名乗っていない').toEqual({
      kind: 'csv',
      lang: 'csv',
      lid: 'db4',
      name: '売上.csv',
    });
  });

  it('⚠ .tsv も同様に見分けられる(対照群)', async () => {
    const { pick, openSqlGuest } = setup();
    pick('db6'); // 大きい.tsv
    await settle();
    const got = openSqlGuest.mock.calls[0]?.[1];
    expect(got?.kind === 'csv' ? got.lang : null, '.tsv を .csv と取り違えている').toBe('tsv');
  });

  it('⚠ .sqlite を選んだときは何も名乗らない(対照群 ── 既存の口を壊していない)', async () => {
    const { pick, openSqlGuest } = setup();
    pick('db1'); // 売上.sqlite
    await settle();
    expect(openSqlGuest.mock.calls[0]?.[1], '.sqlite なのに、別の読み方を名乗っている').toBeUndefined();
  });

  it('🔴 空 / 読めない csv を選ぶと、理由が画面に出る(黙って終わらない)', async () => {
    const { pick, note, sourceSel } = setup();
    pick('db5'); // 壊れ.csv(bytes が空)
    await settle();
    expect(note(), '理由を言っていない').toContain('開けませんでした');
    // 🔴 開けなかったので、選び所も「この PKC」へ戻る(sqlite と同じ作法)
    expect(sourceSel.value, '開けていないのに選んだ顔をしている').toBe('');
  });

  it('🔴 上限で打ち切ったら、選んでいる間ずっと画面の字で言う', async () => {
    const { pick, note } = setup();
    pick('db6'); // 大きい.tsv(fake が truncated: true を返す)
    await settle();
    expect(note(), '打ち切ったことを言っていない(開いた直後)').toContain(
      '行が多いので、先頭だけを表にしています',
    );
  });
});

/**
 * 🔴 **着地前レビュー(動線)が出した 5 件**(#681、2026-09-09)。
 *
 * ⚠ どれも「押した user から見て、起きたことが読めない」形である ──
 *   5 件とも**読んで確かめてから**直した(行番号は在り処であって、証拠ではない)。
 */
describe('着地前レビューの直し(#681)', () => {
  /**
   * 🔴 **F1: 編集中に「ノートへ」を押すと、画面が 1 ドットも動かなかった。**
   * ⚠ この面は aside なので編集中でも開けるが、`CREATE_ENTRY` は
   *   `phase !== 'ready'` を**黙って捨てる** ── 押した人には「壊れている」と
   *   「押せていない」の区別が付かない。
   */
  it('🔴 F1 編集中に押したら、理由を言う(黙って捨てない)', async () => {
    const { d, pane, type, runBtn, saveBtn, note } = setup(async () => answer(['a'], [[1]]));
    type('SELECT 1 AS a');
    runBtn.click();
    await settle();
    /**
     * ⚠ **編集に入ると、面は本文へ戻る**(実測 ── `START_EDIT` は `viewMode` を
     *   `detail` にする)。だから「編集中に SQL の面が見えている」形は、
     *   **編集中に `Alt+7` を押した**ときにできる(そのとき `phase` は `editing` のまま)。
     * 🔑 レビューの筋書きは正しかったが、**そこへ至る道は 1 本だけ**である ──
     *   確かめずに `START_EDIT` だけで組むと、面が隠れていて何も見えない。
     */
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '' });
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'sql' });
    expect(d.getState().phase, '前提が崩れている(編集に入っていない)').toBe('editing');
    expect(pane.hidden, '前提が崩れている(SQL の面が見えていない)').toBe(false);

    const before = d.getState().entryMetas.size;
    saveBtn.click();
    expect(d.getState().entryMetas.size, '編集中なのにノートを作った').toBe(before);
    expect(note(), '黙って捨てている(理由が画面に出ない)').toContain('編集中は書き出せません');
  });

  /**
   * 🔴 **F4: 一度 file を開き損ねると、以後の知らせを全部食っていた。**
   * ⚠ `guestError` を消すのが `SET_SQL_SOURCE` と成功時だけで、`noteLine` は
   *   その行を**いちばん先に返す** ── 切った / 0 行 / 書き出した、が出なくなる。
   */
  it('🔴 F4 開き損ねた断りは、打ち直すと消える', async () => {
    const { pick, type, note } = setup();
    pick('db2');
    await settle();
    expect(note(), '前提が崩れている(断りが出ていない)').toContain('開けませんでした');
    type('SELECT 1 AS a');
    expect(note(), '打ち直しても断りが居座っている').not.toContain('開けませんでした');
  });

  it('🔴 F4 走らせても消える(打ち直さずに走らせた回)', async () => {
    const { pick, type, runBtn, note } = setup(async () => answer(['a'], [[1]]));
    type('SELECT 1 AS a');
    pick('db2');
    await settle();
    expect(note()).toContain('開けませんでした');
    runBtn.click();
    await settle();
    expect(note(), '走らせても断りが居座っている').not.toContain('開けませんでした');
    expect(note(), '答えの行が出ていない').toContain('1 行');
  });

  /**
   * 🔴 **F5(元): `.sqlite` を 1 つも取り込んでいない人に、中身が空の選び所が出ていた。**
   * ⚠ 「選べる相手が 1 つも無いときは出さない」と**書いてある行**が、
   *   初回だけ走っていなかった(指紋の初期値が空文字で、0 件の指紋と同じ)。
   *
   * 🔴 **#854 段②でこの前提が変わった**:添付が 1 つも無くても
   *   **「手持ちのファイルを開く…」だけは常に押せる**ので、選び所そのものは
   *   もう「押しても何も無い口」ではない ── だから隠さない。
   */
  it('⚠ 取り込んだ DB が 1 つも無くても、選び所は出る(#854 段②。手持ちのファイルは常に開ける)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const center = new CenterRouter(root);
    d.onState((s) => center.render(s));
    bindActions(root, d, {});
    // ⚠ 添付を 1 つも持たない器(いちばん多い形)
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', '会議メモ')], relations: [] });
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'sql' });
    const sel = root.querySelector<HTMLSelectElement>('[data-pkc-field="sql-source"]')!;
    expect(sel.hidden, '押しても何も無いのに隠している(F5 の裏返し)').toBe(false);
    const names = [...sel.options].map((o) => o.textContent);
    expect(names, '手持ちのファイルを開く口が無い').toContain('手持ちのファイルを開く…');
    // ⚠ 対照群 ── 添付は 0 件のまま(取り込んでいない DB 名は出ない)
    expect(names, '前提が崩れている(添付を持たせていないのに何か並んでいる)').toEqual([
      'この PKC のノート',
      '手持ちのファイルを開く…',
    ]);
  });

  /**
   * 🔴 **F3-A: 走っている最中に相手を変えると、古い DB の答えが新しい名札で出ていた。**
   * ⚠ 数字は本物なので、user には**間違いに気づく手がかりが 1 つも無い**。
   */
  it('🔴 F3-A 走っている最中に相手を変えたら、古い答えは捨てる', async () => {
    let release!: (v: SqlAnswer) => void;
    const gate = new Promise<SqlAnswer>((r) => (release = r));
    const { type, runBtn, pick, cells, note } = setup(async () => gate);
    type('SELECT title FROM entries');
    runBtn.click();
    await settle();
    expect(note(), '前提が崩れている(走っていない)').toContain('走らせています');

    pick('db1'); // ⚠ 走っている最中に相手を変える
    await settle();
    release(answer(['title'], [['ノートの答え']])); // ⚠ 古い相手の答えが遅れて届く
    await settle();

    expect(cells(), '古い DB の答えが、新しい名札のまま出た').toEqual([]);
    expect(note(), '走らせていますが消えていない').not.toContain('走らせています');
  });

  /**
   * 🔴 **答えだけでなく、断りにも同じ門が要る**(#681 F3-A の 2 つ目)。
   *
   * ⚠ 変異試験 F3b が **SURVIVED** で教えた ── `SET_SQL_RESULT` の門は上の test が
   *   守っていたが、`SQL_RUN_FAILED` の門は**誰も通っていなかった**
   *   (CLAUDE.md §「門を N 個置いたら、N 個目だけが鳴る場面を N 通り作る」)。
   * 🔴 外れると、**よその DB を調べていて出た英語の断りが、新しい名札のまま**残る
   *   ── 選び直した人には「この file が壊れている」と読める(いちばん誤解を招く形)。
   */
  it('🔴 F3-A 走っている最中に相手を変えたら、古い断りも捨てる', async () => {
    let fail!: (e: Error) => void;
    let gate = new Promise<SqlAnswer>((_ok, rej) => (fail = rej));
    const { type, runBtn, pick, note } = setup(async () => gate);
    type('SELECT title FROM entries');
    runBtn.click();
    await settle();
    expect(note(), '前提が崩れている(走っていない)').toContain('走らせています');

    pick('db1'); // ⚠ 走っている最中に相手を変える
    await settle();
    expect(note(), '前提が崩れている(相手が変わっていない)').toContain('売上.sqlite');
    fail(new Error('no such table: entries')); // ⚠ 古い相手の断りが遅れて届く
    await settle();

    expect(note(), '古い DB の断りが、新しい名札のまま出た').not.toContain('no such table');
    expect(note(), '走らせていますが消えていない').not.toContain('走らせています');

    /**
     * 🔑 **対照群 ── いま選んでいる相手の断りは、ちゃんと出る**(門ごと死んでいない)。
     * ⚠ これが無いと「断りが 1 つも出ない」に壊しても上の 2 行が通る。
     */
    gate = Promise.reject(new Error('no such table: 客先'));
    // ⚠ 誰も掴んでいない reject を作らない(happy-dom が unhandled で騒ぐ)
    gate.catch(() => {});
    type('SELECT * FROM 客先');
    runBtn.click();
    await settle();
    expect(note(), 'いま選んでいる相手の断りまで消えている').toContain('no such table: 客先');
  });

  /**
   * 🔴 **F2: 相手を選んでも、案内文と手本が「entries…」のままだった。**
   * ⚠ 書いてあるとおり打つと `no such table: entries` という英語が返る。
   *   そのうえ**その file に在る表の名前は画面のどこにも出ていなかった**
   *   (state には届いているのに、描画器は個数だけを使っていた)。
   */
  it('🔴 F2 相手を選んだら、案内も手本もその DB のものになる', async () => {
    const { pane, box, pick } = setup();
    const tip = (): string => pane.querySelector('[data-pkc-field="sql-tip"]')?.textContent ?? '';
    expect(tip(), '前提が崩れている(既定の案内が出ていない)').toContain('entries');

    pick('db1');
    await settle();
    expect(tip(), 'その file に在る表の名前が出ていない').toContain('売上');
    expect(tip(), 'ノートの表が出ないことを言っていない').toContain('出てきません');
    expect(box.placeholder, '手本が entries のまま(打てない字を手本にしている)').not.toContain(
      'entries',
    );
    expect(box.placeholder, '手本がその DB の表になっていない').toContain('売上');
  });

  it('🔴 F2 断りが出た回も、どちらを調べているかが消えない', async () => {
    const { pick, type, runBtn, note } = setup(async () => {
      throw new Error('SQLITE_READONLY: attempt to write a readonly database');
    });
    pick('db1');
    await settle();
    type('UPDATE t SET a = 1');
    runBtn.click();
    await settle();
    /**
     * ⚠ **断るのは字の門である**(`sql-guard`)── worker まで行かないので、
     *   出る字は engine の言い直しではなく門の字である(実測して合わせた)。
     */
    expect(note(), '断りが出ていない(前提が崩れている)').toContain('読み取り専用です');
    expect(note(), '断りの行で名札が消えた').toContain('売上.sqlite');
  });
});
/**
 * 🔴 **#837 の改善 3 件**(2026-09-09。user 裁定 2026-09-02「推奨で実装を許可」)。
 */
describe('#837 の改善(K1 / K2 / K3)', () => {
  it('🔴 K1 打ち始めても消えない手本が、画面に字として在る', () => {
    const { pane, box } = setup();
    const ex = pane.querySelector('[data-pkc-field="sql-example"]')?.textContent ?? '';
    expect(ex, '消えない手本が画面に無い').not.toBe('');
    // 🔑 薄字と**同じ字**である(手本を 2 通り持たない)
    expect(ex, '薄字と別の字を出している').toContain(box.placeholder);
    // ⚠ 打ち始めても消えない(薄字と違って値ではないので、そもそも消えようがない)
    box.value = 'SELECT 1';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(
      pane.querySelector('[data-pkc-field="sql-example"]')?.textContent ?? '',
      '打ったら手本が消えた',
    ).toBe(ex);
  });

  it('🔴 K1 相手を選ぶと、消えない手本もその file のものになる', async () => {
    const { pane, pick } = setup();
    const before = pane.querySelector('[data-pkc-field="sql-example"]')?.textContent ?? '';
    pick('db1');
    await settle();
    const after = pane.querySelector('[data-pkc-field="sql-example"]')?.textContent ?? '';
    expect(after, 'その file の表が手本になっていない').toContain('売上');
    expect(after, '相手を変えても手本が変わらない').not.toBe(before);
  });

  it('🔴 K1 打ち方の約束が、案内とは別の行に在る', () => {
    const { pane } = setup();
    const rules = pane.querySelector('[data-pkc-field="sql-rules"]')?.textContent ?? '';
    expect(rules, '約束の行が無い').toContain('読むだけ');
    const tip = pane.querySelector('[data-pkc-field="sql-tip"]')?.textContent ?? '';
    expect(tip, '案内へ戻っている(1 段落に 6 文が並ぶ)').not.toContain('読むだけ');
  });

  it('🔴 K3 書き出したノートに、どこを調べたかが残る', async () => {
    const { type, runBtn, saveBtn, persisted, pick } = setup(async () =>
      answer(['a'], [[1]]),
    );
    pick('db1');
    await settle();
    type('SELECT 1');
    runBtn.click();
    await settle();
    saveBtn.click();
    await settle();
    const body = persisted.at(-1)?.body ?? '';
    expect(body, 'どこを調べたか書いていない').toContain('売上.sqlite を調べました');
  });
});

/**
 * 🔴 **SQL の面から、手持ちのファイルを開く**(#854 段②)。
 *
 * user 裁定 2026-09-12(こちらの解釈):**開いたファイルは憶えない。毎回選び直す。**
 *
 * 守る主張:
 * 1. 選ぶと開いて、添付のときと**同じ経路**(`openSqlGuest` / 拡張子の見分け)を通る
 * 2. `.sqlite` と `.csv`、両方で通る道が成立する
 * 3. 開けない file を選んだら、理由が画面に出る(黙って終わらない)
 * 4. **憶えない** ── もう一度「開く…」を選ぶと file 選択が**また**開き、
 *    前に開いた file が自動で選ばれ直すことはない
 */
describe('SQL の面から、手持ちのファイルを開く(#854 段②)', () => {
  it('🔴 選び所に「手持ちのファイルを開く…」が、いつも一番下に在る', () => {
    const { sourceSel } = setup();
    const names = [...sourceSel.options].map((o) => o.textContent);
    expect(names.at(-1), '常に押せる項目が末尾に無い').toBe('手持ちのファイルを開く…');
  });

  it('🔴 .sqlite を選ぶと、添付と同じ経路(openSqlGuest)で開いて、SELECT が引ける', async () => {
    const { pickLocalFile, note, openSqlGuest, runReadOnlySql, type, runBtn, d } = setup();
    const file = new File(['dummy .sqlite bytes'], '自分の帳簿.sqlite', {
      type: 'application/octet-stream',
    });
    pickLocalFile(file);
    await settle();
    // 🔴 「通る道」1: 表ができる前提(開けたこと)が画面に出ている
    expect(note(), 'どちらを調べているか言っていない').toContain('自分の帳簿.sqlite');
    expect(note(), '中に何が在るか言っていない').toContain('表 2 個');
    // ⚠ 拡張子が .sqlite なので、読み方は名乗らない(添付と同じ判定 1 本)
    expect(openSqlGuest.mock.calls[0]?.[1], '.sqlite なのに、別の読み方を名乗っている').toBeUndefined();
    // 🔴 「通る道」2: SELECT が実際に客の DB へ飛ぶ
    type('SELECT 1 AS a');
    runBtn.click();
    await settle();
    expect(runReadOnlySql.mock.calls[0]?.[1]?.guest, '客へ打っていない').toBe(true);
    // ⚠ 選び所の値は、開いた file を表す合成 lid になっている(実体と画面が一致)
    const lid = d.getState().sqlPage.guest?.lid ?? '';
    expect(lid, '合成 lid が発行されていない').not.toBe('');
  });

  it('🔴 口が無い版(readLocalSqlFile 無し)では、理由を言って断る(押して無反応にしない)', async () => {
    const { pickLocalFile, note, sourceSel, openSqlGuest } = setup(undefined, { withLocal: false });
    const file = new File(['dummy'], '手元.sqlite');
    pickLocalFile(file);
    await settle();
    expect(note(), 'この版では…と言っていない').toContain('この版では手持ちのファイルを開けません');
    expect(sourceSel.value, '開けていないのに選んだ顔をしている').toBe('');
    // ⚠ 対照群 ── worker 自体は生きている(添付の .sqlite はいつもどおり開ける)
    openSqlGuest.mockClear();
    sourceSel.value = 'db1';
    sourceSel.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(openSqlGuest, '添付まで巻き添えで止めた').toHaveBeenCalledTimes(1);
  });

  it('🔴 .csv を選ぶと、拡張子から見分けて csv として名乗り、SELECT が引ける', async () => {
    const { pickLocalFile, note, openSqlGuest, d } = setup();
    const file = new File(['id,name\n1,あ\n'], '手元の一覧.csv', { type: 'text/csv' });
    pickLocalFile(file);
    await settle();
    expect(note(), 'どちらを調べているか言っていない').toContain('手元の一覧.csv');
    const lid = d.getState().sqlPage.guest?.lid ?? '';
    expect(openSqlGuest.mock.calls[0]?.[1], '.csv なのに csv として名乗っていない').toEqual({
      kind: 'csv',
      lang: 'csv',
      lid,
      name: '手元の一覧.csv',
    });
  });

  it('🔴 開けない file を選ぶと、理由が画面に出て、この PKC へ戻る(黙って終わらない)', async () => {
    const { pickLocalFile, note, sourceSel } = setup();
    // ⚠ 空(0 バイト)── fake の openSqlGuest が「読めませんでした」で断る形
    const file = new File([], '空.sqlite');
    pickLocalFile(file);
    await settle();
    expect(note(), '理由を言っていない').toContain('選んだ file を開けませんでした');
    expect(note(), 'engine の言い分が消えている').toContain('読めませんでした');
    // 🔴 添付と同じ作法 ── 開けなかったら選び所も「この PKC」へ戻る
    expect(sourceSel.value, '開けていないのに選んだ顔をしている').toBe('');
  });

  /**
   * 🔴 **「憶えない」の直接の証拠**(user 裁定 2026-09-12)。
   *
   * ⚠ 実機の file 選択ダイアログはここでは開けない(headless の unit test)ので、
   *   「隠した `<input>` が**もう一度** `click()` されること」を証拠にする ──
   *   これが無い実装(前に選んだ file を控えて自動で開き直す実装)を書くと、
   *   ここで `click` が呼ばれず、この test は落ちる。
   */
  it('🔴 もう一度「開く…」を選んでも、前に開いた file が自動で選ばれ直さない', async () => {
    const { sourceSel, fileInput, pickLocalFile, openSqlGuest, d } = setup();
    const fileA = new File(['a'.repeat(8)], '最初.sqlite');
    pickLocalFile(fileA);
    await settle();
    const lidA = d.getState().sqlPage.guest?.lid ?? '';
    expect(lidA, '前提が崩れている(1 回目が開けていない)').not.toBe('');
    expect(openSqlGuest, '1 回目で開いていない').toHaveBeenCalledTimes(1);

    const clickSpy = vi.spyOn(fileInput, 'click');
    // ⚠ ここでは file を渡さない(実機なら OS のダイアログが出ている最中に当たる)
    sourceSel.value = SQL_PICK_LOCAL_FILE_VALUE;
    sourceSel.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(clickSpy, '選び直す口(file 選択)を開いていない').toHaveBeenCalledTimes(1);
    // 🔑 file を渡していないので、何も変わっていない(自動で何かを開き直していない)
    expect(openSqlGuest, '選んだ覚えの無い file を勝手に開いた').toHaveBeenCalledTimes(1);
    expect(d.getState().sqlPage.guest?.lid, '前に開いていた相手が変わった').toBe(lidA);
    // ⚠ 選び所も、実体(まだ最初の file のまま)へ戻っている
    expect(sourceSel.value, '選び所が「開く…」のまま居座っている').toBe(lidA);

    // 🔑 別の file を**改めて**選べば、そのときは新しく開く(=控えていた物の再利用ではない)
    const fileB = new File(['b'.repeat(8)], '次.sqlite');
    pickLocalFile(fileB);
    await settle();
    expect(openSqlGuest, '2 回目に新しく開いていない').toHaveBeenCalledTimes(2);
    const lidB = d.getState().sqlPage.guest?.lid ?? '';
    expect(lidB, '合成 lid が使い回されている(別物のはず)').not.toBe(lidA);
    // ⚠ 前に開いていた file(最初.sqlite)は、選び所からもう並ばない(憶えていない)
    const names = [...sourceSel.options].map((o) => o.textContent);
    expect(names, '前に開いた file がまだ選び所に残っている').not.toContain('最初.sqlite');
    expect(names, '今開いている file が選び所に無い').toContain('次.sqlite');
  });
});

/**
 * 🔴 **構造 1 枚をノートへ**(#918 段①。user 要望 2026-09-14「ai向けに構造吐き出したり」)。
 *
 * 守る主張:
 * 1. **打つ前でも押せる**(答えが無くても構造は採れる ── 「ノートへ」との違い)
 * 2. 🔴 **門を 1 ミリも緩めない** ── 打つのは `select` 3 本だけ
 * 3. 🔴 **2 回押しても 1 枚**(走っている間は受けない)
 * 4. 行数が採れなくても**構造は出る**(採れなかったと**言う**)
 * 5. 編集中は**断って理由を出す**
 */
describe('構造をノートへ(#918 段①)', () => {
  /**
   * ⚠ **3 本を順に打つので、`settle()` の 3 巡では足りない**(1 稿目はここで
   *   5 件とも落ちた ── `persisted` が 0 のままだった)。
   * 🔑 余裕を持って回す ── **待ちの回数を増やしても、遅い実装は速くならない**ので、
   *   これで通ったなら「届いている」と言ってよい。
   */
  const settleAll = async (): Promise<void> => {
    for (let i = 0; i < 16; i += 1) await Promise.resolve();
  };

  /** 3 本の `select` に、それぞれの形で答える fake。 */
  const schemaReply = (opts: { countsFail?: boolean } = {}) => {
    const seen: string[] = [];
    const reply = async (sql: string): Promise<SqlAnswer> => {
      seen.push(sql);
      if (sql.includes('pragma_table_info')) {
        return answer(
          ['kind', 'tbl', 'cid', 'col', 'typ', 'nn', 'pk'],
          [
            ['table', 'entries', 0, 'lid', 'TEXT', 1, 1],
            ['table', 'entries', 1, 'title', 'TEXT', 0, 0],
          ],
        );
      }
      if (sql.includes('pragma_foreign_key_list')) return answer(['tbl', 'ref', 'col', 'refcol'], []);
      if (sql.includes('count(*)')) {
        if (opts.countsFail === true) throw new Error('数えられない');
        return answer(['tbl', 'n'], [['entries', 7]]);
      }
      return answer(['a'], [[1]]);
    };
    return { reply, seen };
  };

  it('🔴 打つ前でも押せて、構造 1 枚がノートになる', async () => {
    const { reply, seen } = schemaReply();
    const { schemaBtn, persisted, d } = setup(reply);
    expect(schemaBtn.disabled, '答えが無いと押せない(構造は打つ前に要る)').toBe(false);
    schemaBtn.click();
    await settleAll();
    expect(persisted.length, 'ノートが 1 枚も作られていない').toBe(1);
    const body = persisted[0]?.body ?? '';
    expect(body, '表が出ていない').toContain('## entries(表・7 行)');
    expect(body, '列が出ていない').toContain('| lid | TEXT | 不可 | 主キー |');
    expect(body, '中身を出していないと言っていない').toContain('中身は 1 行も含まれていません');
    expect(d.getState().sqlPage.saved, '書き出したと言っていない').toContain('DB の構造');
    // 🔴 **門を緩めていない** ── 打ったのは `select` だけ
    expect(seen.length, '打った数が違う(列 / 繋がり / 行数の 3 本のはず)').toBe(3);
    for (const q of seen) expect(q.trimStart().slice(0, 6).toLowerCase()).toBe('select');
  });

  it('🔴 2 回押しても 1 枚(同じノートを 2 つ作らない)', async () => {
    const { reply } = schemaReply();
    const { schemaBtn, persisted } = setup(reply);
    schemaBtn.click();
    schemaBtn.click();
    await settleAll();
    expect(persisted.length, '2 回押したら 2 枚できた').toBe(1);
  });

  it('🔴 行数が採れなくても構造は出る(採れなかったと言う)', async () => {
    const { reply } = schemaReply({ countsFail: true });
    const { schemaBtn, persisted } = setup(reply);
    schemaBtn.click();
    await settleAll();
    const body = persisted[0]?.body ?? '';
    expect(body, '構造ごと落ちている').toContain('## entries(表)');
    expect(body, '採れなかったと言っていない').toContain('行数は採れませんでした');
    expect(body, '採れていない行数を書いている').not.toContain('7 行');
  });

  /**
   * 🔴 **錠は必ず降りる**(押した後にまた押せる状態へ戻る)。
   * ⚠ 降りないと、**以後ずっと押せない**(押しても無反応)という最悪の形になる。
   */
  it('🔴 書き出した後、錠が降りている', async () => {
    const { reply } = schemaReply();
    const { schemaBtn, d } = setup(reply);
    schemaBtn.click();
    await settleAll();
    expect(d.getState().sqlPage.running, '錠が降りていない(以後ずっと押せなくなる)').toBe(false);
    expect(d.getState().sqlPage.error, '成功したのに断り文が出ている').toBe('');
  });

  /**
   * 🔴 **編集中は断って、理由を画面に出す**。
   * 🔑 わざわざ作らなくても、**1 回押せばその状態になる** ── `CREATE_ENTRY` は
   *   作ったノートを開くので、押した直後は `editing` である(`sql-to-note` と同じ)。
   * ⚠ **黙って捨てない**ことがこの test の主張である(`CREATE_ENTRY` は
   *   `phase !== 'ready'` を無言で落とすので、断り文が無いと「壊れている」と読まれる)。
   */
  /**
   * 🔴 **調べている相手の名前が、題名にも本文にも載る**(変異試験 M9 が SURVIVED で教えた)。
   *
   * ⚠ この describe の他の test は**どれも相手を選んでいない**ので、
   *   `where` を**常に `null`** に固定しても 1 件も落ちなかった ──
   *   つまり「選んだ相手の名前が載る」という軸を**1 度も通っていなかった**
   *   (CLAUDE.md §2「fixture のゼロ件の次元は、測っていない次元」)。
   */
  it('🔴 調べる相手を選んでいるとき、その名前が題名と本文に出る', async () => {
    const { reply } = schemaReply();
    const { schemaBtn, persisted, pick, d } = setup(reply);
    pick('db1');
    await settleAll();
    const where = d.getState().sqlPage.guest?.name ?? '';
    expect(where, '前提が崩れている(相手を選べていない)').not.toBe('');
    schemaBtn.click();
    await settleAll();
    expect(persisted.length).toBe(1);
    expect(persisted[0]?.body ?? '', '本文に相手の名前が無い').toContain(where);
    expect(d.getState().sqlPage.saved, '題名に相手の名前が無い').toContain(where);
  });

  /**
   * 🔴 **reducer 自身も、走っている間は受けない**(変異試験 M5 が SURVIVED で教えた)。
   *
   * ⚠ 上の「2 回押しても 1 枚」は **binder の門だけで通ってしまう** ──
   *   押し所から来る道には門が 2 つ在り、**手前の 1 つで止まる**ので、
   *   奥の門(reducer)を**1 度も試していなかった**(CLAUDE.md §1「救い手が変わっただけ」)。
   * 🔑 だから**押し所を通さずに**、reducer へ直に当てる。
   */
  it('🔴 押し所を通さずに 2 度当てても、2 本目は出さない(奥の門)', async () => {
    const { reply } = schemaReply();
    const { d } = setup(reply);
    /**
     * ⚠ **見るのは state ではなく、出た依頼の数**(1 稿目はここで外した)。
     * 🔑 門が消えても **state は同じ**(2 度目も `running: true` を置くだけ)なので、
     *   state を見比べる assert は**門が在っても無くても通る**(§1 の空振り)。
     *   実際に出る違いは「**依頼が 2 本飛ぶ**」ことだけである。
     */
    let asks = 0;
    const off = d.onEvent((e) => {
      if (e.type === 'REQUEST_SQL_SCHEMA') asks += 1;
    });
    try {
      d.dispatch({ type: 'SQL_SCHEMA_TO_NOTE', lid: 'a1', relationId: 'r1' });
      expect(d.getState().sqlPage.running, '前提が崩れている(1 本目で走っていない)').toBe(true);
      d.dispatch({ type: 'SQL_SCHEMA_TO_NOTE', lid: 'a2', relationId: 'r2' });
      expect(asks, '走っている間に 2 本目の依頼が飛んだ').toBe(1);
    } finally {
      off();
      await settleAll();
    }
  });

  it('🔴 編集中は断って、理由を画面に出す', async () => {
    const { reply } = schemaReply();
    const { schemaBtn, persisted, d } = setup(reply);
    schemaBtn.click();
    await settleAll();
    expect(d.getState().phase, '前提が崩れている(作った後は編集中のはず)').toBe('editing');
    schemaBtn.click();
    await settleAll();
    expect(persisted.length, '編集中なのに 2 枚目を作った').toBe(1);
    expect(d.getState().sqlPage.error, '理由を言っていない').toContain('編集中');
  });
});

/**
 * 🔴 **打つ所を道具にする**(#918 段②a。user 要望 2026-09-14「打つ所がお粗末」)。
 *
 * 守る主張:
 * 1. **↑ で前に打った字が戻る**(走った字だけ・新しい順)
 * 2. 🔴 **打ちかけの字を潰さない** ── ↓ で戻ってくる
 * 3. 🔴 **複数行の中では、ふつうに上下できる**(1 行目 / 最後の行でだけ握る)
 * 4. **Tab は字下げ**。🔴 ただし **`Shift`+`Tab` と `Esc` は逃げ道**として残す
 * 5. 同じ字を 2 つ並べない / 打ちかけは積まない
 */
describe('打つ所(#918 段②a)', () => {
  const caret = (box: HTMLTextAreaElement, at: number): void => {
    box.selectionStart = at;
    box.selectionEnd = at;
  };

  it('🔴 ↑ で前に打った字が戻り、↓ で打ちかけの字へ帰る', async () => {
    const { d, type, key, runBtn, box } = setup();
    type('select 1');
    runBtn.click();
    await settle();
    type('select 2');
    runBtn.click();
    await settle();
    // ⚠ 打ちかけ(まだ走らせていない字)
    type('select 3 -- 打ちかけ');
    caret(box, 0);
    key({ key: 'ArrowUp' });
    expect(d.getState().sqlPage.sql, '前に打った字が戻らない').toBe('select 2');
    caret(box, 0);
    key({ key: 'ArrowUp' });
    expect(d.getState().sqlPage.sql, 'もう 1 つ前へ戻らない').toBe('select 1');
    // 🔴 打ちかけの字は潰れていない
    key({ key: 'ArrowDown' });
    expect(d.getState().sqlPage.sql).toBe('select 2');
    key({ key: 'ArrowDown' });
    expect(d.getState().sqlPage.sql, '打ちかけの字が消えた').toBe('select 3 -- 打ちかけ');
  });

  it('🔴 複数行の途中では握らない(ふつうに上下できる)', async () => {
    const { d, type, key, runBtn, box } = setup();
    type('select 1');
    runBtn.click();
    await settle();
    type('select a\nfrom t\nwhere b');
    // ⚠ 2 行目の頭(1 行目でも最後の行でもない)
    caret(box, 'select a\n'.length);
    key({ key: 'ArrowUp' });
    expect(d.getState().sqlPage.sql, '途中なのに履歴へ飛んだ').toBe('select a\nfrom t\nwhere b');
    key({ key: 'ArrowDown' });
    expect(d.getState().sqlPage.sql, '途中なのに履歴へ飛んだ').toBe('select a\nfrom t\nwhere b');
    // ⚠ **対照群** ── 1 行目なら握る(この test 自体が空振りでないこと)
    caret(box, 0);
    key({ key: 'ArrowUp' });
    expect(d.getState().sqlPage.sql, '1 行目でも握っていない').toBe('select 1');
  });

  it('⚠ 走った字だけを憶える / 同じ字を 2 つ並べない', async () => {
    const { d, type, key, runBtn, box } = setup();
    type('select 1');
    runBtn.click();
    await settle();
    type('select 1');
    runBtn.click();
    await settle();
    expect(d.getState().sqlPage.history, '同じ字が 2 つ並んだ').toEqual(['select 1']);
    // ⚠ 打ちかけは積まれない
    type('select 9');
    expect(d.getState().sqlPage.history).toEqual(['select 1']);
    caret(box, 0);
    key({ key: 'ArrowUp' });
    expect(d.getState().sqlPage.sql).toBe('select 1');
  });

  it('⚠ 履歴が空なら、↑ を押しても何も起きない', () => {
    const { d, type, key, box } = setup();
    type('打ちかけ');
    caret(box, 0);
    key({ key: 'ArrowUp' });
    expect(d.getState().sqlPage.sql, '空の履歴で字が消えた').toBe('打ちかけ');
  });

  /**
   * 🔴 **逃げ道を潰さない** ── `Tab` を握る欄は、鍵盤だけで使う人を
   *   閉じ込めうる。⚠ だから `Shift`+`Tab` は**握らない**(既定のまま焦点が動く)。
   */
  it('🔴 Tab は字下げ / Shift+Tab と Esc は逃げ道として残す', () => {
    const { box } = setup();
    box.value = 'select';
    caret(box, 6);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    box.dispatchEvent(tab);
    expect(tab.defaultPrevented, 'Tab を握っていない(字下げが入らない)').toBe(true);
    const back = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    box.dispatchEvent(back);
    expect(back.defaultPrevented, 'Shift+Tab を握った(この欄から出られなくなる)').toBe(false);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    box.dispatchEvent(esc);
    expect(esc.defaultPrevented, 'Esc で外れない(逃げ道が 1 つしか無い)').toBe(true);
  });
});
