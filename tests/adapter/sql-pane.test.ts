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
import { isAsidePane, SQL_HISTORY_MAX, viewModeLabel } from '../../src/adapter/state/app-state';
import { fitSqlInput } from '../../src/adapter/ui/render/sql';
import { SQL_WINDOW_MIN } from '../../src/features/query/sql-window';
import { homeTabOf } from '../../src/adapter/ui/render/browse-mode';
import { readFileSync } from 'node:fs';
import { blocksFor, stripComments, withoutMedia } from '../helpers/css-blocks';
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
    /**
     * 🔴 **DuckDB の口だけを外す**(#682 段②)。⚠ 上の 2 つと別 ──
     *   選び所には DuckDB が出るのに、押すと断る版を作るため。
     */
    withDuck?: boolean;
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
  /**
   * 🔴 **DuckDB で引く口**(#682 段②)。⚠ 実物は別ワーカーで走る ── ここは
   *   「**どんな相手で、どんな字で呼ばれたか**」と「**中身を読みに来たか**」を見る fake。
   */
  const duckSeen: Array<{ sql: string; source: { lid: string; name: string }; bytes: number | null }> = [];
  const runDuckDbSql = vi.fn(
    async (input: {
      sql: string;
      source: { lid: string; name: string };
      readBytes: () => Promise<Uint8Array | null>;
    }) => {
      const bytes = await input.readBytes();
      duckSeen.push({ sql: input.sql, source: input.source, bytes: bytes?.byteLength ?? null });
      return { columns: ['g'], rows: [['duck']] as Array<Array<string | number | null>>, truncated: false, ms: 2 };
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
        // 🔴 DuckDB の口(#682 段②)── 実物は別ワーカー。ここは**渡された引数**だけを見る
        ...(opts.withDuck === false ? {} : { runDuckDbSql }),
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
  /**
   * 相手を選ぶ。
   * 🔴 **`value` に代入するのではなく、`selected` を立てる**(2026-09-15、#682 段②)。
   * ⚠ happy-dom は `select.value = x` で `selectedOptions` を**更新しない**(実測:
   *   代入直後に読むと**前に選ばれていた項目**が返る)── `binder.ts` は
   *   そこから file の名前を採るので、**2 回目の選び直しだけが前の名前で飛ぶ**。
   * 🔑 実機の user は項目を押す = `selected` が立つ ── 台をその形へ揃える。
   */
  /**
   * 相手を選ぶ。
   * ⚠ **happy-dom の `selectedOptions` は、2 回目以降の選択に追随しない**(実測
   *   2026-09-15:`value` も `selectedIndex` も `selected` も効かず、**最初に選んだ
   *   項目を返し続ける**)。🔑 だから `binder.ts` は名前を**state から**引くようにした
   *   ── 画面の字に頼っていた頃は、**相手を選び直した回だけ前の名前が飛んでいた**
   *   (lid は正しいので、どの test も落ちない形だった)。
   */
  const pick = (lid: string): void => {
    sourceSel.selectedIndex = [...sourceSel.options].findIndex((o) => o.value === lid);
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
    sourceSel.selectedIndex = [...sourceSel.options].findIndex((o) => o.value === SQL_PICK_LOCAL_FILE_VALUE);
    sourceSel.dispatchEvent(new Event('change', { bubbles: true }));
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const engineSel = pane.querySelector<HTMLSelectElement>('[data-pkc-field="sql-engine"]')!;
  /** どのエンジンで引くかを選ぶ(実機と同じく `change` を通す)。 */
  const pickEngine = (engine: string): void => {
    // ⚠ 上の `pick` と同じ理由(happy-dom は `value` の代入で選択を更新しない)
    engineSel.selectedIndex = [...engineSel.options].findIndex((o) => o.value === engine);
    engineSel.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const rules = (): string => pane.querySelector('[data-pkc-field="sql-rules"]')?.textContent ?? '';
  const tipText = (): string => pane.querySelector('[data-pkc-field="sql-tip"]')?.textContent ?? '';
  return {
    root,
    d,
    pane,
    box,
    runBtn,
    engineSel,
    pickEngine,
    rules,
    tipText,
    runDuckDbSql,
    duckSeen,
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
/**
 * 飛んでいる非同期が落ち着くまで待つ。
 *
 * 🔴 **数を数えない**(2026-09-15、#682 段②)。⚠ 初稿は `await Promise.resolve()` を
 *   **3 回**だった ── そのため `store-effects.ts` 側に
 *   「`afterWrites` の中で余分な async 関数越しに読むな(1 層挟むと tick が 1 増える)」
 *   という**製品コードの書き方の縛り**が生まれていた。
 *   🔑 縛られていたのは**製品の側**で、直すべきはこの 1 行のほうである。
 * 🔑 **macrotask を 1 つ挟めば、積まれている microtask は全部流れる** ──
 *   何段の `await` を挟んでも数え直さなくてよい。
 * ⚠ 本物の時計で待つ物(`REQUEST_SEARCH_DETAIL` の 300ms など)はここでは流れない ──
 *   それを待つ test は、自分で時計を進める。
 */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
    const { pick, note, openSqlGuest, readAssetBytes, sourceSel } = setup();
    pick('db1');
    await settle();
    expect(readAssetBytes).toHaveBeenCalledWith('ast-ok');
    expect(openSqlGuest, '客の DB を開いていない').toHaveBeenCalledTimes(1);
    expect(note(), 'どちらを調べているか言っていない').toContain('売上.sqlite');
    expect(note(), '中に何が在るか言っていない').toContain('表 2 個');
    // 🔴 開いた後も、選び所は選んだ相手を出したまま(user 報告の再現の対照群)
    expect(sourceSel.value, '開けたのに選び所が選んだ相手を指していない').toBe('db1');
  });

  /**
   * 🔴 **user 報告の再現**:「プルダウンリストには出てくるのに、取り込み済みの
   *   csv が選択できない」。
   *
   * ⚠ **開き終わる前の一瞬を捕まえる** ── `SET_SQL_SOURCE` の reducer は
   *   `guest` を**先に `null` へ落とし**、開けた回だけ後から埋める(非同期)。
   *   直す前の描画は `guest?.lid` だけを見ていたので、選んだ**その瞬間**に
   *   選び所が「この PKC のノート」へ戻っていた ── 速い相手では一瞬で
   *   `SQL_GUEST_OPENED` が上書きして見えなくなるが、遅い相手・失敗する相手では
   *   **戻ったまま**になる。`Dispatcher.dispatch` は同期に描画まで進むので、
   *   `pick()` が返った直後(`settle()` を挟む前)がその瞬間である。
   */
  it('🔴 選んだ直後(まだ開いていない一瞬)は、選び所に選んだ相手を出したまま', async () => {
    const { pick, sourceSel } = setup();
    pick('db1'); // ⚠ ここではまだ SQL_GUEST_OPENED は 1 度も届いていない
    expect(sourceSel.value, '開いていない一瞬に「この PKC」へ戻った').toBe('db1');
    await settle();
    expect(sourceSel.value, '開き終わっても選んだ相手のまま').toBe('db1');
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

  /**
   * 🔴 **失敗しても、選び所は選んだまま**(user 報告の再現の直接の対策)。
   *
   * ⚠ 直す前は `guest` が `null` のままなので選び所も「この PKC」へ戻っていた ──
   *   戻すと、**何を選んで断られたのか**が画面から消える(推薦:「選んだまま +
   *   断り文」── 戻ると迷子になる)。⚠ **打つ先**(`guest` オブジェクト)は
   *   これまでどおり `null` のまま ── 選び所の見た目と、実際に打つ相手は別物。
   */
  it('🔴 開けなかったら理由を言う。選び所は選んだ相手を出したまま', async () => {
    const { pick, note, sourceSel, type, runBtn, runReadOnlySql } = setup();
    pick('db2'); // ⚠ bytes が取れない添付
    await settle();
    expect(note(), '理由を言っていない').toContain('開けませんでした');
    expect(sourceSel.value, '断られたら選び所が「この PKC」へ戻り、何を選んだか消えた').toBe(
      'db2',
    );
    // 🔴 **打つ先は「この PKC」のまま**(選び所の見た目を戻す/戻さないとは無関係)
    type('SELECT 1 AS a');
    runBtn.click();
    await settle();
    expect(runReadOnlySql.mock.calls[0]?.[1]?.guest).toBeUndefined();
  });

  it('⚠ 失敗した後に別の相手を選び直すと、選び所と断りはちゃんと切り替わる', async () => {
    const { pick, note, sourceSel } = setup();
    pick('db2'); // 開けない
    await settle();
    expect(sourceSel.value, '前提が崩れている(失敗した相手を出していない)').toBe('db2');
    expect(note()).toContain('開けませんでした');
    pick('db1'); // 開ける
    await settle();
    expect(sourceSel.value, '選び直したのに前の失敗した相手のまま').toBe('db1');
    expect(note(), '前の断りが消えていない').not.toContain('開けませんでした');
  });

  it('⚠ 開いた後に「この PKC」へ戻すと、選び所も「この PKC」を出す', async () => {
    const { pick, sourceSel } = setup();
    pick('db1');
    await settle();
    expect(sourceSel.value, '前提が崩れている(開けていない)').toBe('db1');
    pick('');
    await settle();
    expect(sourceSel.value, '「この PKC」へ戻したのに前の相手のまま').toBe('');
  });

  it('🔴 添付に中身が無いときは、理由を言う(黙って何も起きない形を作らない)', async () => {
    const { pick, note, sourceSel } = setup();
    pick('db3'); // ⚠ key を持たない添付
    await settle();
    expect(note(), '理由が「中身が見つかりません」になっていない').toContain(
      '添付の中身が見つかりません',
    );
    // ⚠ 対照群 ── この失敗経路でも選び所は選んだ相手のまま
    expect(sourceSel.value, '別の失敗経路では選び所が戻っている').toBe('db3');
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
    // 🔴 開けなくても、選び所は選んだ相手のまま(sqlite と同じ作法。user 報告の再現)
    expect(sourceSel.value, '開けなかったら選んだ顔が消えた').toBe('db5');
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

  it('🔴 開けない file を選ぶと、理由が画面に出る(黙って終わらない)', async () => {
    const { pickLocalFile, note, sourceSel } = setup();
    // ⚠ 空(0 バイト)── fake の openSqlGuest が「読めませんでした」で断る形
    const file = new File([], '空.sqlite');
    pickLocalFile(file);
    await settle();
    expect(note(), '理由を言っていない').toContain('選んだ file を開けませんでした');
    expect(note(), 'engine の言い分が消えている').toContain('読めませんでした');
    /**
     * ⚠ **添付とは事情が違う**(user 報告の再現の対象は添付)── 手持ちの file は
     *   選ぶたびに使い捨ての合成 lid で、開けなければその lid の `<option>` は
     *   選び所に**一度も存在しない**(足すのは開けた回だけ)。だから
     *   `sel.value` へ当てても一致する項目が無く、native の select は
     *   「戻す」規則ではなく**選べる項目が無いのでこうなる**(結果は同じ `''`)。
     */
    expect(sourceSel.value, '選べる項目が無いはずが、何か選んだ顔をしている').toBe('');
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

  /**
   * 4 本の `select` に、それぞれの形で答える fake。
   * 🔴 4 本目は**本文の名前つき csv の目録**(#918 段⑤d-2)── ここを
   *   `answer(['a'], [[1]])` の素通りに任せると、**csv の表が 1 つも出ない fixture**に
   *   なる(CLAUDE.md §2「fixture のゼロ件次元は、測っていない次元」)。
   */
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
      // 🔴 本文の csv の目録(#918 段⑤d-2)。⚠ `count(*)` より先に見る ──
      //    この問い合わせは `sum(t.rows)` を持つので、後ろに置くと取り違える
      if (sql.includes('csv_columns')) {
        return answer(
          ['tbl', 'cid', 'col', 'n'],
          [
            ['売上', 0, '_note', 3],
            ['売上', 1, '_lid', 3],
            ['売上', 2, '金額', 3],
          ],
        );
      }
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
    /**
     * 🔴 **本文の名前つき csv も 1 枚に入る**(#918 段⑤d-2)。
     * ⚠ 入っていないと、AI は「引ける表がもう 1 つ在る」ことを知らないまま
     *   問い合わせを書く(= 書いていない = 無い、と読む)。
     */
    expect(body, '本文の csv の表が出ていない').toContain('## 売上(本文の表・3 行)');
    expect(body, 'csv の列が出ていない').toContain('| 金額 |');
    expect(body, '件数が本表だけになっている').toContain('表 / ビュー / 本文の表: 2 件');
    expect(d.getState().sqlPage.saved, '書き出したと言っていない').toContain('DB の構造');
    // 🔴 **門を緩めていない** ── 打ったのは `select` だけ
    expect(seen.length, '打った数が違う(列 / 繋がり / 本文の csv / 行数の 4 本のはず)').toBe(4);
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

  /**
   * 🔴 **呼び戻した字を直してから、もう一度遡っても、直した分が消えない**
   *   (2026-09-14 の動線レビューが出した。**直す前は黙って消えていた**)。
   *
   * ⚠ 物語:`select 2` を `↑` で呼び戻す → `where id=3` を付け足す →
   *   「もう少し前のも見よう」ともう一度 `↑`。⚠ 直す前は、付け足した字が
   *   **どこにも控えられておらず**、`↓` で帰ってくるのは**直す前**の `select 2` だった。
   * 🔑 観測点は 2 つ:①**帰ってきた字に手直しが残っている**
   *   ②**打ちかけの字も別に残っている**(片方を直して、もう片方を壊していない)。
   */
  it('🔴 履歴の中で直した字が、遡っても消えない', async () => {
    const { d, type, key, runBtn, box } = setup();
    for (const sql of ['select 1', 'select 2']) {
      type(sql);
      runBtn.click();
      await settle();
    }
    type('打ちかけ');
    caret(box, 0);
    key({ key: 'ArrowUp' });
    expect(d.getState().sqlPage.sql, '前提が崩れている(↑ で戻っていない)').toBe('select 2');

    // ⚠ 呼び戻した字を**手で直す**(打鍵は `input` = `SET_SQL_TEXT` を通る)
    type('select 2 where id=3');

    caret(box, 0);
    key({ key: 'ArrowUp' });
    expect(d.getState().sqlPage.sql, 'さらに前へ遡れていない').toBe('select 1');
    // ① 🔴 本題 ── 戻ると、直した字が在る
    key({ key: 'ArrowDown' });
    expect(d.getState().sqlPage.sql, '直した字が消えた').toBe('select 2 where id=3');
    // ② 打ちかけの字も無事
    key({ key: 'ArrowDown' });
    expect(d.getState().sqlPage.sql, '打ちかけの字まで壊した').toBe('打ちかけ');
  });

  /**
   * ⚠ **手直しの控えは、走らせたら捨てる** ── 走った字は履歴に積まれるので、
   *   持ち越すと**次に同じ所を呼び戻した人に、前の回の手直しが出る**。
   */
  it('⚠ 走らせたら、前の回の手直しは残らない', async () => {
    const { d, type, key, runBtn, box } = setup();
    for (const sql of ['select 1', 'select 2']) {
      type(sql);
      runBtn.click();
      await settle();
    }
    caret(box, 0);
    key({ key: 'ArrowUp' });
    type('select 2 -- 手直し');
    // 🔑 走らせる ── ここで控えは捨てられる
    runBtn.click();
    await settle();
    expect(d.getState().sqlPage.historyEdits, '手直しの控えが残っている').toEqual([]);
    caret(box, 0);
    key({ key: 'ArrowUp' });
    expect(d.getState().sqlPage.sql, '走った字が積まれていない').toBe('select 2 -- 手直し');
    caret(box, 0);
    key({ key: 'ArrowUp' });
    expect(d.getState().sqlPage.sql, '前の回の手直しが混ざった').toBe('select 2');
  });

  /**
   * ⚠ **上限(`SQL_HISTORY_MAX`)を、誰も測っていなかった**(2026-09-14、着地前レビュー)。
   *
   * 🔑 定数は `src` に 2 か所在るだけで、**test は 1 度も参照していなかった** ──
   *   `.slice(0, SQL_HISTORY_MAX)` を丸ごと外しても全件緑だった
   *   (CLAUDE.md §2「fixture のゼロ件の次元は測っていない次元」)。
   * ⚠ 上限が外れても user には見えない(履歴が伸び続けるだけ)ので、
   *   **誰も気づかないまま打つほど重くなる**。
   * 🔑 観測点は 3 つ:①件数が頭打ち ②いちばん新しい字が頭 ③**いちばん古い字が落ちた**。
   *   ⚠ ①だけだと、`slice` が違う向き(新しいほうを捨てる)でも通る。
   */
  it('⚠ 憶えるのは上限まで ── 溢れたら古いほうから落ちる', async () => {
    const { d, type, runBtn } = setup();
    const n = SQL_HISTORY_MAX + 1;
    for (let i = 1; i <= n; i += 1) {
      type(`select ${String(i)}`);
      runBtn.click();
      await settle();
    }
    const { history } = d.getState().sqlPage;
    expect(history.length, '上限で頭打ちになっていない').toBe(SQL_HISTORY_MAX);
    expect(history[0], 'いちばん新しい字が頭に無い').toBe(`select ${String(n)}`);
    expect(history, 'いちばん古い字が落ちていない').not.toContain('select 1');
    expect(history.at(-1), '落とす向きが逆(新しいほうを捨てている)').toBe('select 2');
  });

  /**
   * 🔴 **押しても画面が 1 バイトも動かない、をやめる**(user 裁定 2026-09-14
   *   「欄の下に 2/3 と出す」)。
   *
   * ⚠ 直す前は、いちばん古い所まで来ても**無言**だった ── user には
   *   「これ以上前が無い」のか「鍵が効いていない」のか区別が付かない。
   * 🔑 観測点は**画面の行**(`sql-history-note`)である ── state だけ見ると、
   *   描画器が指紋の門で止めていても気づけない(`↑` は指紋を動かさない)。
   */
  it('🔴 いま何番目を見ているかが、欄の下に出る', async () => {
    const { d, pane, type, key, runBtn, box } = setup();
    const line = (): string =>
      pane.querySelector('[data-pkc-field="sql-history-note"]')?.textContent ?? '';
    const shown = (): boolean =>
      pane.querySelector<HTMLElement>('[data-pkc-field="sql-history-note"]')?.hidden === false;
    // ⚠ まだ 1 度も遡っていない ── 行は出さない(意味の無い行で場所を取らない)
    expect(shown(), '押していないのに行が出ている').toBe(false);
    for (const sql of ['select 1', 'select 2']) {
      type(sql);
      runBtn.click();
      await settle();
    }
    type('打ちかけ');
    expect(shown(), '走らせただけで行が出ている').toBe(false);

    caret(box, 0);
    key({ key: 'ArrowUp' });
    expect(line(), '何番目かが出ていない').toBe('前に打った字(1 / 2)');
    caret(box, 0);
    key({ key: 'ArrowUp' });
    // 🔴 **端に着いたことを字で言う**(これが無いと「鍵が効かない」と区別が付かない)
    expect(line(), '端に着いたことを言っていない').toBe(
      '前に打った字(2 / 2) ── これより前はありません',
    );
    // ⚠ もう一度押しても、字は変わらない(= 端で止まっていることが読める)
    caret(box, 0);
    key({ key: 'ArrowUp' });
    expect(line()).toBe('前に打った字(2 / 2) ── これより前はありません');

    key({ key: 'ArrowDown' });
    key({ key: 'ArrowDown' });
    expect(d.getState().sqlPage.sql, '打ちかけへ帰っていない').toBe('打ちかけ');
    expect(line(), '打ちかけへ帰ったことを言っていない').toBe('打ちかけの字を見ています');
    // ⚠ そこから打ち直したら合図は消える(戻る先はもう無いので、残すと嘘になる)
    type('打ち直し');
    expect(shown(), '打ち直しても合図が残っている').toBe(false);
  });

  /**
   * 🔴 **指で触る端末にも道を作る**(user 裁定 2026-09-14「履歴ボタンを 1 つ足す」)。
   *
   * ⚠ スマホ / タブレットには `↑` `↓` が**無い** ── 押し所が無ければ、
   *   前に打った SQL は**毎回打ち直し**になる。
   * ⚠ **憶えている字が無いうちは押せない**(押せるのに何も起きない口を作らない)。
   */
  it('🔴 履歴ボタンから、前に打った字を選べる', async () => {
    const { d, pane, root, type, runBtn } = setup();
    const btn = pane.querySelector<HTMLButtonElement>('[data-pkc-field="sql-history"]')!;
    expect(btn.disabled, '憶えている字が無いのに押せる').toBe(true);
    for (const sql of ['select 1', 'select 2\n  from t']) {
      type(sql);
      runBtn.click();
      await settle();
    }
    type('打ちかけ');
    expect(btn.disabled, '憶えているのに押せない').toBe(false);

    btn.click();
    const items = [...root.querySelectorAll<HTMLElement>('[data-pkc-region="context-menu"] button')];
    // 🔑 新しい順。⚠ 改行は行を伸ばすので 1 文字へ畳む
    expect(items.map((b) => b.textContent)).toEqual(['select 2 ⏎ from t', 'select 1']);

    items[1]!.click();
    expect(d.getState().sqlPage.sql, '選んだ字が欄に入っていない').toBe('select 1');
    // ⚠ 打ちかけの字は控えられている(↓ で帰れる)
    expect(d.getState().sqlPage.historyDraft, '打ちかけを控えていない').toBe('打ちかけ');
    expect(d.getState().sqlPage.historyAt, 'いま何番目かを持っていない').toBe(1);
    // ⚠ 2 度目の押しは閉じる(片道の操作を作らない)
    btn.click();
    btn.click();
    expect(
      root.querySelector('[data-pkc-region="context-menu"]'),
      '2 度目の押しで閉じない',
    ).toBeNull();
  });

  /**
   * 🔴 **答えが多いときは、見えている分だけ描く**(#918 段③)。
   *
   * ⚠ **この枝は、素の happy-dom では 1 度も通らない** ── 高さが全部 0 なので
   *   `sqlWindowOf` が「測れない = 全部描く」へ倒れる(CLAUDE.md §2)。
   *   🔑 だから**高さを持たせてから**通す。持たせずに書いた test は、
   *   窓の機構を丸ごと消しても緑のままである。
   * ⚠ 実際の転がり(GPU・慣性・列幅の見え方)は実ブラウザにしか無い ──
   *   ここで見るのは「**どの行を作ったか**」だけである。
   */
  it('🔴 行が多いと、窓のぶんだけ描く / 転がすと中身が入れ替わる', async () => {
    const N = SQL_WINDOW_MIN + 3000;
    const big = answer(
      ['i'],
      Array.from({ length: N }, (_, i) => [i]),
    );
    const { pane, type, runBtn, note } = setup(async () => big);
    const rowH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    const rowW = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    try {
      // 🔑 測れる所を作る(行 20px / 列 50px)
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get: () => 20,
      });
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get: () => 50,
      });
      const body = pane.querySelector<HTMLElement>('[data-pkc-field="sql-body"]')!;
      let top = 0;
      Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 400 });
      Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => top });

      type('select i from s');
      runBtn.click();
      await settle();

      const drawn = (): string[] =>
        [...pane.querySelectorAll('[data-pkc-field="sql-table"] tbody tr')]
          .filter((tr) => tr.getAttribute('data-pkc-field') !== 'sql-row-spacer')
          .map((tr) => tr.querySelector('td')?.textContent ?? '');
      const spacers = (): number =>
        pane.querySelectorAll('[data-pkc-field="sql-row-spacer"]').length;

      const first = drawn();
      expect(first.length, '窓に入っていない(全部描いている)').toBeLessThan(200);
      /**
       * 🔴 **「見えている分だけ」を画面に常に出す**(動線レビュー 2026-09-14)。
       * ⚠ 知らせているのが お知らせ と マニュアル だけだと、**読んだ人にしか届かない** ──
       *   user は `Ctrl+F` が当たらないのを「無い」と読み、**在るデータを無いと結論する**。
       * 🔑 代わり(ノートへ / ファイルへ)を**同じ文に**書く。
       */
      expect(note(), '見えている分だけ描いていることを画面が言わない').toContain(
        '見えている分だけ描いています',
      );
      expect(note(), '代わりの道を同じ文に書いていない').toContain('ファイルへ');
      expect(first[0], '上端なのに先頭から描いていない').toBe('0');
      // 🔑 上端では上に空ける物が無い(下だけ 1 本)
      expect(spacers(), '下に空けていない').toBe(1);

      const table = pane.querySelector<HTMLElement>('[data-pkc-field="sql-table"]')!;
      expect(table.style.tableLayout, '列幅を固定していない(転がすたびに列が動く)').toBe('fixed');
      const th = pane.querySelector<HTMLElement>('[data-pkc-field="sql-table"] th')!;
      expect(th.style.width, '列の幅を当てていない').toBe('50px');
      /**
       * 🔴 **表そのものの幅も決まっている**(実ブラウザが 3/3 で再現して分かった)。
       * ⚠ `table-layout: fixed` **だけでは効かない** ── 表の `width` が `auto` だと
       *   ブラウザは中身から決め直し、下端の長い値で**列が動く**(40px → 47px を実測)。
       * 🔑 ここで見えるのは「当てたか」だけ ── **効いたか**は実ブラウザ
       *   (`attach.smoke.spec.ts` の ⑪ ③)でしか言えない。
       */
      expect(table.style.width, '表そのものの幅を決めていない(固定が効かない)').toBe('50px');
      /**
       * 🔴 **升は全文を持っている**(幅で切られても読める道)。
       * ⚠ 窓に入ると幅を固定するので、長い値は「…」で切られる ── 直す前は
       *   表が広がって横に転がせた(= **この PR で読めなくなった**、CLAUDE.md §10)。
       */
      const td = pane.querySelector<HTMLElement>('[data-pkc-field="sql-table"] tbody td')!;
      expect(td.title, '切られた字を読む道が無い').toBe(td.textContent);
      expect(td.title, '空振り(升に字が入っていない)').not.toBe('');

      // 🔴 転がすと中身が入れ替わる(上下 2 本とも空く)
      top = 20_000;
      body.dispatchEvent(new Event('scroll'));
      const mid = drawn();
      expect(mid[0], '転がしたのに先頭の行が変わっていない').not.toBe('0');
      expect(Number(mid[0]), '描き始めが転がり位置と合っていない').toBeGreaterThan(900);
      expect(spacers(), '上下の両方に空けていない').toBe(2);

      // 🔑 下端まで送ると最後の行が出る(高さの計算がずれていれば足りない)
      top = N * 20;
      body.dispatchEvent(new Event('scroll'));
      expect(drawn().at(-1), '下端なのに最後の行が出ていない').toBe(String(N - 1));
    } finally {
      if (rowH) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', rowH);
      if (rowW) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', rowW);
    }
  });

  /**
   * 🔴 **器が広がったら、窓も広げる**(#918 段③。着地前レビューが出した)。
   *
   * ⚠ レビューが名指ししたのは**窓のリサイズ**だが、実体は**もっとありふれた操作**だった ──
   *   打つ欄は打つたびに高さを変える(段②b)ので、同じ列に居る `sql-body` の高さも動く。
   * 🔴 **実害は「打った字を消したとき」に出る** ── 欄が縮んで器が広がるのに、
   *   描いてある行は狭かった頃のままなので、**広がった分が白い帯**になる。
   * 🔑 直しは「`repaint()` を指紋の門より前に置く」── 門の後ろでは、
   *   答えが変わっていない回(= まさにこの場面)に **1 度も通らない**。
   */
  it('🔴 器が広がったら、描く行も増える(白い帯を残さない)', async () => {
    const N = SQL_WINDOW_MIN + 3000;
    const big = answer(
      ['i'],
      Array.from({ length: N }, (_, i) => [i]),
    );
    const { pane, type, runBtn } = setup(async () => big);
    const rowH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    const rowW = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    try {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get: () => 20,
      });
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get: () => 50,
      });
      const body = pane.querySelector<HTMLElement>('[data-pkc-field="sql-body"]')!;
      let view = 200;
      Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => view });
      Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => 0 });

      type('select i from s');
      runBtn.click();
      await settle();
      const drawn = (): number =>
        [...pane.querySelectorAll('[data-pkc-field="sql-table"] tbody tr')].filter(
          (tr) => tr.getAttribute('data-pkc-field') !== 'sql-row-spacer',
        ).length;
      const narrow = drawn();
      expect(narrow, '窓に入っていない').toBeLessThan(200);

      /**
       * 🔑 **器が 6 倍になる**(打った字を消して欄が縮んだ = よくある操作)。
       * ⚠ ここで描き直さないと、広がった分が**白い帯**のまま残る。
       */
      view = 1200;
      type('select i from s ');
      expect(drawn(), '器が広がったのに描く行が増えていない(白い帯が残る)').toBeGreaterThan(
        narrow,
      );
    } finally {
      if (rowH) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', rowH);
      if (rowW) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', rowW);
    }
  });

  /**
   * 🔴 **測れないときに、全部描いてしまわない**(#918 段③。自分の差分を読み直して見つけた)。
   *
   * ⚠ この面は `hidden` で常駐するので、**答えが届いた瞬間に画面へ出ているとは限らない**
   *   ── そのとき `offsetHeight` は **0** を返す。
   * 🔴 直す前は「まず全部描いてから測る」形だったので、**測れなかった回だけ
   *   10 万行が DOM に残った**(いちばん重い場面で、いちばん効かない)。
   * 🔑 いまは**先に上限を掛けてから**描く ── 測れなくても、残るのは
   *   「引っかかり 0 本」と実測した行数までである。
   * 🔑 そして**見えるようになった最初の転がりで測り直す** ── 指紋の門があるので
   *   `render()` はもう来ない(そこで測らないと、その答えは最後まで窓に入らない)。
   */
  it('🔴 高さが測れない回でも、境目より多くは描かない / 見えたら窓に入る', async () => {
    const N = SQL_WINDOW_MIN + 3000;
    const big = answer(
      ['i'],
      Array.from({ length: N }, (_, i) => [i]),
    );
    const { pane, type, runBtn } = setup(async () => big);
    const body = pane.querySelector<HTMLElement>('[data-pkc-field="sql-body"]')!;
    const drawn = (): number =>
      [...pane.querySelectorAll('[data-pkc-field="sql-table"] tbody tr')].filter(
        (tr) => tr.getAttribute('data-pkc-field') !== 'sql-row-spacer',
      ).length;

    // ⚠ 測れない(happy-dom の既定 = 0)ままで答えを受ける
    type('select i from s');
    runBtn.click();
    await settle();
    expect(drawn(), '測れないのに境目より多く描いた').toBe(SQL_WINDOW_MIN);

    // 🔑 見えるようになった(測れる)あと、最初の転がりで窓に入る
    const rowH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    const rowW = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    try {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get: () => 20,
      });
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get: () => 50,
      });
      Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 400 });
      Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => 0 });
      body.dispatchEvent(new Event('scroll'));
      expect(drawn(), '見えるようになっても窓に入らない').toBeLessThan(200);
    } finally {
      if (rowH) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', rowH);
      if (rowW) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', rowW);
    }
  });

  /**
   * 🔴 **境目までは、いまと 1 ドットも同じ**(#918 段③)。
   * ⚠ ここが窓に入ると、`Ctrl+F` と「全部を選んでコピー」と列幅の代償を
   *   **払う理由が無いのに払う**(CLAUDE.md §10)。
   * 🔑 上の test と**同じ高さを持たせて**回す ── 持たせないと
   *   「測れないから全部描いた」のか「境目が効いた」のか**見分けられない**。
   */
  it('🔴 境目までは窓に入らない(空け行も列幅の固定も無い)', async () => {
    const big = answer(
      ['i'],
      Array.from({ length: SQL_WINDOW_MIN }, (_, i) => [i]),
    );
    const { pane, type, runBtn, note } = setup(async () => big);
    const rowH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    try {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get: () => 20,
      });
      const body = pane.querySelector<HTMLElement>('[data-pkc-field="sql-body"]')!;
      Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 400 });
      type('select i from s');
      runBtn.click();
      await settle();
      expect(
        pane.querySelectorAll('[data-pkc-field="sql-table"] tbody tr').length,
        '境目ちょうどで窓に入れている',
      ).toBe(SQL_WINDOW_MIN);
      expect(pane.querySelectorAll('[data-pkc-field="sql-row-spacer"]').length).toBe(0);
      // 🔑 空振り防止 ── 境目以下では、その断りを**出さない**(いつも出ていたら意味が無い)
      expect(note(), '窓に入っていないのに「見えている分だけ」と言っている').not.toContain(
        '見えている分だけ',
      );
      const table = pane.querySelector<HTMLElement>('[data-pkc-field="sql-table"]')!;
      expect(table.style.tableLayout, '境目以下なのに列幅を固定している').toBe('');
    } finally {
      if (rowH) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', rowH);
    }
  });

  /**
   * 🔴 **打った行数に合わせて伸びる**(#918 段②b。user 裁定 2026-09-14)。
   *
   * ⚠ **下限と上限は CSS が持つ**(`min-height` / `max-height`)ので、ここで見るのは
   *   「**中身の高さを当てているか**」だけである。
   * 🔴 **`scrollHeight` が 0 の所では触らない**のが肝 ── happy-dom は 0 を返すので、
   *   そのまま当てると**欄が消える**。⚠ これは「unit が通る側で壊れる」型なので、
   *   実ブラウザではなく**ここで**押さえる必要がある。
   */
  it('🔴 高さを中身に合わせる / 測れない所では触らない', () => {
    const { box } = setup();
    // ⚠ happy-dom の既定(= 測れない)。触らずに返ること
    box.style.height = '';
    expect(fitSqlInput(box), '測れないのに高さを返した').toBe(0);
    expect(box.style.height, '測れないのに高さを当てた(欄が消える)').toBe('');

    /**
     * 🔑 測れる所を作って、中身の高さが当たること。
     * 🔴 **測る前に `auto` へ戻していること**も見る ── 戻さないと `scrollHeight` は
     *   **いまの高さに引きずられる**ので、**伸びる一方になって二度と戻らない**。
     * ⚠ happy-dom の `scrollHeight` は高さを映さないので、**読まれた瞬間の
     *   `style.height` を控える**ことで順番を観測する(値では見分けられない)。
     */
    box.style.height = '999px';
    const whenRead: string[] = [];
    Object.defineProperty(box, 'scrollHeight', {
      configurable: true,
      get: () => {
        whenRead.push(box.style.height);
        return 137;
      },
    });
    Object.defineProperty(box, 'offsetHeight', { configurable: true, value: 137 });
    expect(fitSqlInput(box)).toBe(137);
    expect(box.style.height, '中身の高さが当たっていない').toBe('137px');
    expect(whenRead, '測る前に auto へ戻していない(伸びる一方になる)').toEqual(['auto']);
  });

  /**
   * 🔴 **掴んで高さを変えたら、そちらが強い**(片道の操作を作らない ── user 指示 2026-08-23)。
   *
   * ⚠ 打つたびに引き戻すと、**掴んで広げた操作が毎回取り消される**。
   * 🔑 観測点は**こちらが高さを当てたか**(`style.height`)── 打った後に
   *   当たっていなければ、手で決めた高さが生きている。
   */
  it('🔴 掴んで高さを変えたら、打っても引き戻さない', () => {
    const { type, box } = setup();
    let h = 80;
    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => h });
    Object.defineProperty(box, 'offsetHeight', { configurable: true, get: () => h });

    type('select 1');
    expect(box.style.height, '打っても高さを合わせていない').toBe('80px');

    // ⚠ **掴んで引いた**(押した高さと離した高さが違う)
    box.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    h = 300;
    box.ownerDocument.dispatchEvent(new Event('pointerup', { bubbles: true }));

    box.style.height = '300px';
    /**
     * 🔴 **中身の高さを、手で決めた高さと**別の値**にする**(2026-09-14、変異試験が教えた)。
     * ⚠ 1 稿目はここを `300` のままにしていたので、**引き戻す実装でも `300px` になり**、
     *   `handSized` を丸ごと外した変異が 2 件とも生き延びた
     *   (CLAUDE.md §1「挙動を変えたのに test が前も後も通るなら、守っていない」)。
     */
    h = 90;
    type('select 1 from t');
    expect(box.style.height, '手で決めた高さを打鍵が引き戻した').toBe('300px');
  });

  /**
   * ⚠ **対照群** ── 掴んでも**動かさなかった**なら、これまでどおり合わせる
   *   (上の test が「押したら常に止まる」で通ってしまわないように)。
   */
  it('⚠ 掴んだだけで動かさなければ、これまでどおり合わせる', () => {
    const { type, box } = setup();
    let h = 80;
    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => h });
    Object.defineProperty(box, 'offsetHeight', { configurable: true, get: () => h });
    type('select 1');
    box.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    box.ownerDocument.dispatchEvent(new Event('pointerup', { bubbles: true }));
    h = 120;
    type('select 1 from t');
    expect(box.style.height, '掴んだだけで合わせなくなった').toBe('120px');
  });

  /**
   * 🔴 **答えを file へ書き出す**(#918 段④。user 要望「`copy to` 使えないし」)。
   *
   * 🔑 観測点は**下流まで**通す ── 押した(`defaultPrevented`)ではなく、
   *   **どんな名前で / どんな中身が**渡ったかまで見る。
   * ⚠ `downloadBlob` は `URL.createObjectURL` → `<a download>` → `click()` の 3 段なので、
   *   1 段目で**中身**を、3 段目で**名前**を採る。
   */
  it('🔴 ファイルへ ── 名前と中身が渡る / 答えが無いうちは押せない', async () => {
    const { pane, root, type, runBtn } = setup(async () => answer(['名前', '数'], [['りんご', 12]]));
    const btn = pane.querySelector<HTMLButtonElement>('[data-pkc-field="sql-to-file"]')!;
    expect(btn.disabled, '答えが無いのに押せる').toBe(true);

    type('select 1');
    runBtn.click();
    await settle();
    expect(btn.disabled, '答えが出たのに押せない').toBe(false);

    const blobs: Blob[] = [];
    const names: string[] = [];
    const make = vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => {
      blobs.push(b as Blob);
      return 'blob:fake';
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        names.push(this.download);
      });
    try {
      btn.click();
      const items = [
        ...root.querySelectorAll<HTMLElement>('[data-pkc-region="context-menu"] button'),
      ];
      // 🔑 3 つの形(csv / tsv / json)が並ぶ
      expect(items.length, '形の一覧が出ていない').toBe(3);
      items[0]!.click();

      expect(names, 'file の名前が渡っていない').toHaveLength(1);
      expect(names[0], '拡張子が付いていない').toMatch(/\.csv$/);
      expect(names[0], '相手の名前(この PKC)が入っていない').toContain('この PKC');
      /**
       * 🔴 **`Blob` に BOM ごと入っている**(動線レビュー 2026-09-14)。
       * 🔑 ここは**配線**を見る場所である ── 中身の規則は
       *   `tests/features/sql-export.test.ts` が形ごとに全数で見る。
       *   ⚠ だから「BOM を付ける口」を呼び忘れた変異は、**ここでだけ**死ぬ。
       */
      expect(await blobs[0]!.text(), '中身が渡っていない').toBe(
        '\uFEFF名前,数\r\nりんご,12\r\n',
      );
    } finally {
      make.mockRestore();
      revoke.mockRestore();
      click.mockRestore();
    }
    // 🔴 書き出したことを画面で言う(この面は別窓なので、言わないと「押せなかった」に見える)
    expect(
      pane.querySelector('[data-pkc-field="sql-note"]')?.textContent ?? '',
      'file へ書き出したのに、ノートの話をしている',
    ).toContain('という file に書き出しました');
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
    const { d, box } = setup();
    box.value = 'select';
    caret(box, 6);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    box.dispatchEvent(tab);
    expect(tab.defaultPrevented, 'Tab を握っていない(字下げが入らない)').toBe(true);
    /**
     * 🔴 **握ったことと、字が入ったことは別の主張である**(2026-09-14、smoke が教えた)。
     *
     * ⚠ 初稿はここで `defaultPrevented` しか見ておらず、**`insertText(ta, '  ')` を
     *   丸ごと消しても緑だった**(変異試験 SURVIVED)── つまり守っていたのは
     *   「`Tab` で焦点が飛ばないこと」だけで、**字下げは誰も見ていなかった**。
     * 🔑 観測点は**下流まで**通す(CLAUDE.md「『動く』の観測点は下流まで」)──
     *   欄の字 / caret / **state に届いたか**の 3 つ。⚠ 3 つ目が肝で、
     *   `insertText` の控えが `input` を撃たなければ**画面には見えて保存されない**。
     */
    expect(box.value, '字下げが入っていない').toBe('select  ');
    expect(box.selectionStart, 'caret が進んでいない(2 度目が前に入る)').toBe(8);
    expect(d.getState().sqlPage.sql, '字下げが state に届いていない(走らせる字に入らない)').toBe(
      'select  ',
    );
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

  /**
   * 🔴 **`Esc` は取り合いになる** ── メニューが出ている間、user が押す `Esc` は
   *   「**いま出した右クリックを取り消す**」の意味である。⚠ そこで焦点まで外すと、
   *   **打っていた所を失う**(「さっきまでやっていたことが消える」型)。
   *
   * 🔑 観測点は 2 つ:①**握っていない**(= メニューを閉じる聞き手へ届く)
   *   ②**焦点が欄に残っている**。⚠ ①だけだと、握らずに `blur()` していても通る。
   */
  it('🔴 メニューが出ている間の Esc は握らない(焦点も外さない)', () => {
    const { root, box } = setup();
    box.value = 'select';
    caret(box, 6);
    box.focus();
    // ⚠ 実物の `openContextMenu` と**同じ目印**で出す(判定は `contextMenuOpen` 1 か所)
    const menu = document.createElement('div');
    menu.setAttribute('data-pkc-region', 'context-menu');
    root.append(menu);

    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    box.dispatchEvent(esc);
    expect(esc.defaultPrevented, 'メニューが出ているのに Esc を握った').toBe(false);
    expect(document.activeElement, 'メニューを閉じるだけのつもりが焦点まで外れた').toBe(box);

    // 🔑 対照群 ── メニューを畳めば、同じ `Esc` が今度は欄から出す
    menu.remove();
    const esc2 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    box.dispatchEvent(esc2);
    expect(esc2.defaultPrevented, 'メニューが無いのに Esc が効かない').toBe(true);
    expect(document.activeElement, 'Esc を押しても欄から出ていない').not.toBe(box);
  });
});

/**
 * 🔴 **打つ欄の色分けと行番号**(#918 段②c/②d)。
 *
 * 🔑 **打つ所は `textarea` のまま** ── 後ろに層を敷き、字だけ透明にする。
 *   器を替えると IME・取り消し・選択・スマホの鍵盤、そして段②a / 段②b が落ちる
 *   (CLAUDE.md §10「置き換えの作法」)。
 * ⚠ **色が実際に見えているか**は happy-dom では測れない ── ここで見るのは
 *   **層の組み立て**と、**揃っていなければ必ず崩れる値**である。
 */
describe('打つ欄の色分けと行番号(#918 段②c/②d)', () => {
  const layerOf = (root: HTMLElement): HTMLElement =>
    root.querySelector<HTMLElement>('[data-pkc-field="sql-input-layer"]')!;

  it('🔴 論理行 1 本につき升が 1 つ出て、番号が 1 から順に付く', () => {
    const { root, box } = setup();
    box.value = 'select 1\nfrom t\nwhere a = 2';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const nos = [...layerOf(root).querySelectorAll('[data-pkc-field="sql-line-no"]')];
    expect(nos.map((n) => n.textContent), '番号が行数ぶん出ていない').toEqual(['1', '2', '3']);
    // ⚠ 対照群: 1 行に戻したら升も 1 つに戻る(増えっぱなしにしない)
    box.value = 'select 1';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(
      layerOf(root).querySelectorAll('[data-pkc-field="sql-line-no"]').length,
      '升が減っていない',
    ).toBe(1);
  });

  it('🔴 色が付いている(空振り防止)', () => {
    const { root, box } = setup();
    box.value = 'select 1';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const code = layerOf(root).querySelector('[data-pkc-field="sql-line-code"]')!;
    expect(code.innerHTML, 'keyword に色が付いていない').toContain('pkc-tok-keyword');
  });

  /**
   * 🔴 **番号は字とは別の升に置く。**
   * ⚠ 同じ升へ字で足すと、**選んで写したときに番号まで一緒に写る**
   *   (打った SQL を人へ渡せなくなる)。
   */
  it('🔴 番号は、字の升の中に入っていない', () => {
    const { root, box } = setup();
    box.value = 'select 1';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const code = layerOf(root).querySelector<HTMLElement>('[data-pkc-field="sql-line-code"]')!;
    expect(code.textContent, '字の升に番号が混ざっている').not.toContain('1	');
    expect(code.textContent?.startsWith('1'), '字の升が番号で始まっている').toBe(false);
  });

  /**
   * 🔴 **日本語入力の最中は、層を退けて字の色を戻す**(#764 の型)。
   * ⚠ 打っている途中の字は `value` に入らないので、透明のままだと**何も見えない**。
   */
  it('🔴 日本語を打っている間だけ、層が退く印が付く', () => {
    const { root, box } = setup();
    const wrap = root.querySelector<HTMLElement>('[data-pkc-field="sql-input-wrap"]')!;
    expect(wrap.hasAttribute('data-pkc-composing'), '打つ前から印が付いている').toBe(false);
    box.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    expect(wrap.hasAttribute('data-pkc-composing'), '打ち始めても印が付かない').toBe(true);
    box.dispatchEvent(new Event('compositionend', { bubbles: true }));
    expect(wrap.hasAttribute('data-pkc-composing'), '打ち終わっても印が残っている').toBe(false);
  });

  /**
   * 🔴 **層が欄を塞がない。** ⚠ 層は打つ所の**真上**に重なるので、この規則が
   *   消えると **欄がまるごと死ぬ**(#530 段③a の層と違い、逃げ場が無い)。
   */
  it('🔴 層は押しを通す(欄が死なない)', () => {
    const css = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));
    const rule = blocksFor(css, "[data-pkc-field='sql-input-layer']").join(' ');
    expect(rule, '層の規則が引けていない(この検査は空振り)').toContain('position: absolute');
    expect(rule, '層に pointer-events の規則が無い(欄が押せなくなる)').toContain(
      'pointer-events: none',
    );
  });

  /**
   * 🔴 **層と欄で、折り返しと字の形が 1 つ残らず揃っている**(§7「同じ値が 2 か所」)。
   *
   * ⚠ どれか 1 つでもずれると**色と字が重ならない** ── いちばん気づかれる壊れ方で、
   *   しかも happy-dom では**測れない**(だから字面で pin する)。
   */
  it('🔴 層と欄で、字の形・行の高さ・折り返し方が同じ値である', () => {
    const css = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));
    const layer = blocksFor(css, "[data-pkc-field='sql-input-layer']").join(' ');
    /**
     * ⚠ **欄に当たる規則は 2 本ある** ── 素の `[data-pkc-field='sql-input']`(字の形・大きさ)と、
     *   層の中だけの上書き(透明・左余白・折り返し)。**両方を足して見る**。
     * 🔑 値を片方へ写して 1 本で見る形にはしない ── それこそ §7「同じ値が 2 か所」である。
     */
    const input = [
      ...blocksFor(css, "[data-pkc-field='sql-input']"),
      ...blocksFor(css, "[data-pkc-field='sql-input-wrap'] [data-pkc-field='sql-input']"),
    ].join(' ');
    expect(input, '欄の規則が引けていない(この検査は空振り)').toContain('background: transparent');
    for (const decl of [
      'font-size: 13px',
      'line-height: 1.6',
      'white-space: pre-wrap',
      'overflow-wrap: break-word',
    ]) {
      expect(layer, `層に ${decl} が無い`).toContain(decl);
      expect(input, `欄に ${decl} が無い`).toContain(decl);
    }
    /**
     * 🔴 **欄は `display: block`**(実ブラウザで実測して足した)。
     * ⚠ `<textarea>` の UA 既定は `inline-block` なので、素のまま器へ置くと
     *   **器のほうが descender ぶん高くなり、層が下へ 6px はみ出す**
     *   (headless_shell で 3/3 再現:欄 97px / 層 103px)。
     * ⚠ happy-dom では**測れない** ── だから字面で pin する。
     *   効いていること自体は `tests/smoke/attach.smoke.spec.ts` が高さを比べて見る。
     */
    expect(input, '欄が display: block でない(層が下へはみ出す)').toContain('display: block');
    // ⚠ 字の形は**同じ変数**を読む(別の綴りにすると、片方だけ差し替えられる)
    expect(layer, '層が等幅の変数を読んでいない').toContain('font-family: var(--font-mono)');
    // 🔴 番号の幅は 1 か所で持つ ── 層の升と欄の左余白が**同じ変数**を読む
    expect(layer, '層の升が番号の幅の変数を読んでいない').toContain('var(--sql-gutter)');
    expect(input, '欄の左余白が番号の幅の変数を読んでいない').toContain('var(--sql-gutter)');
  });
});

/**
 * 🔴 **表のつながり図**(#918 段⑤。user 要望 2026-09-14「er でグラフィカルに取得する方法も
 * 欲しいな」/ 置き場の裁定 2026-09-15 = **この窓の中に畳める欄**)。
 *
 * 守る主張:
 * 1. 閉じているときは **1px も場所を取らない**(押すと開き、もう一度押すと畳む)
 * 2. 開くと**採ってくる** ── 2 度目は採り直さない(開くたびに DB を舐めない)
 * 3. 四角と線が出て、**押せる**(表 / 列 / 繋がり)
 * 4. 🔴 押した結果が**打つ欄に入る**(図を見ながら組める)
 * 5. 🔴 足せないときは**理由が出る**(無言の dead click を作らない)
 * 6. 🔴 **相手を変えたら前の図を持ち越さない**(名札は新しいのに中身が前の DB、を作らない)
 */
describe('表のつながり図(#918 段⑤)', () => {
  /**
   * ⚠ **`settle` では足りない** ── 構造は 3 本を**順に**打つので、
   *   その数だけ microtask を回さないと答えが state に届かない
   *   (1 稿目はここを外して 7 件とも落ちた ── 計器が短かっただけで、製品は無事だった)。
   */
  const settleEr = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  /** 構造を採る 3 本にだけ答える worker。⚠ それ以外は普通の答えを返す。 */
  const schemaReply = async (sql: string): Promise<SqlAnswer> => {
    if (sql.includes('pragma_table_info')) {
      return answer(
        ['kind', 'tbl', 'cid', 'col', 'typ', 'nn', 'pk'],
        [
          ['table', '売上', 0, 'id', 'INTEGER', 1, 1],
          ['table', '売上', 1, '客id', 'INTEGER', 0, 0],
          ['table', '売上', 2, '金額', 'INTEGER', 0, 0],
          ['table', '客', 0, 'id', 'INTEGER', 1, 1],
          ['table', '客', 1, '名前', 'TEXT', 0, 0],
        ],
      );
    }
    if (sql.includes('pragma_foreign_key_list')) {
      return answer(['tbl', 'ref', 'col', 'refcol'], [['売上', '客', '客id', 'id']]);
    }
    /**
     * 🔴 **本文の名前つき csv の目録**(#918 段⑤d-2)。
     * ⚠ ここを素通りさせると「**本文の表が 0 件の fixture**」になり、
     *   図に出るかどうかを**一度も測っていない**ことになる(CLAUDE.md §2)。
     */
    if (sql.includes('csv_columns')) {
      return answer(
        ['tbl', 'cid', 'col', 'n'],
        [
          ['棚卸', 0, '_note', 4],
          ['棚卸', 1, '_lid', 4],
          ['棚卸', 2, '品名', 4],
        ],
      );
    }
    if (sql.includes('count(*)')) return answer(['tbl', 'n'], [['売上', 3], ['客', 2]]);
    return answer(['a'], [[1]]);
  };

  const region = (pane: HTMLElement): HTMLElement =>
    pane.querySelector<HTMLElement>('[data-pkc-region="sql-er"]')!;
  const erBtn = (pane: HTMLElement): HTMLButtonElement =>
    pane.querySelector<HTMLButtonElement>('[data-pkc-field="sql-er-toggle"]')!;
  const tables = (pane: HTMLElement): string[] =>
    [...pane.querySelectorAll('[data-pkc-field="sql-er-table"]')].map((e) => e.textContent ?? '');
  const erNote = (pane: HTMLElement): string =>
    pane.querySelector('[data-pkc-field="sql-er-note"]')?.textContent ?? '';

  it('🔴 閉じているうちは 1px も場所を取らない(押すと開き、もう一度で畳む)', async () => {
    const { pane } = setup(schemaReply);
    expect(region(pane).hidden, '閉じているのに器が出ている').toBe(true);
    expect(erBtn(pane).textContent).toBe('構造を見る');

    erBtn(pane).click();
    await settleEr();
    expect(region(pane).hidden, '押しても開かない').toBe(false);
    expect(erBtn(pane).textContent, '帰り道が字で分からない').toBe('構造を閉じる');

    erBtn(pane).click();
    expect(region(pane).hidden, 'もう一度押しても畳めない').toBe(true);
  });

  it('🔴 四角と線と押し所が出る(指されている表が左上)', async () => {
    const { pane } = setup(schemaReply);
    erBtn(pane).click();
    await settleEr();
    // 🔑 「客」は外部キーで指されているので先頭(= 左上)
    // ⚠ 本文の csv(棚卸)は**いちばん後ろ** ── 行数は多いが、DB の構造ではない
    expect(tables(pane)).toEqual(['客(表・2 行)', '売上(表・3 行)', '棚卸(本文の表・4 行)']);
    // 🔑 中の表 5 列 + 本文の表 3 列(`_note` / `_lid` / 品名)
    expect(
      pane.querySelectorAll('[data-pkc-field="sql-er-column"]').length,
      '列の押し所が出ていない',
    ).toBe(8);
    expect(pane.querySelectorAll('[data-pkc-field="sql-er-lines"] line').length, '線が無い').toBe(1);
    const chip = pane.querySelector('[data-pkc-field="sql-er-link"]');
    expect(chip?.textContent, '繋がりの札に、どの列どうしかが書かれていない').toBe(
      '売上.客id → 客.id',
    );
  });

  it('🔴 2 度目に開くときは採り直さない(開くたびに DB を舐めない)', async () => {
    const { pane, runReadOnlySql } = setup(schemaReply);
    erBtn(pane).click();
    await settleEr();
    const first = runReadOnlySql.mock.calls.length;
    expect(first, '構造を採っていない').toBeGreaterThanOrEqual(2);
    erBtn(pane).click();
    erBtn(pane).click();
    await settleEr();
    expect(runReadOnlySql.mock.calls.length, '開くたびに採り直している').toBe(first);
  });

  it('🔴 表 → 列 → 繋がり と押すと、打つ欄に SQL が組まれる', async () => {
    const { pane, box } = setup(schemaReply);
    erBtn(pane).click();
    await settleEr();
    const press = (field: string, name: string): void => {
      const el = [...pane.querySelectorAll<HTMLElement>(`[data-pkc-field="${field}"]`)].find(
        (e) => (e.textContent ?? '').includes(name),
      );
      expect(el, `押し所が無い: ${field} / ${name}`).toBeDefined();
      el!.click();
    };
    press('sql-er-table', '売上');
    expect(box.value, '表を押しても欄に入らない').toBe('select * from 売上');
    press('sql-er-column', '金額');
    expect(box.value).toBe('select 金額 from 売上');
    press('sql-er-link', '売上.客id');
    expect(box.value).toBe('select 金額 from 売上\n  join 客 on 客.id = 売上.客id');
  });

  it('🔴 足せないときは理由が出て、打っている字は 1 文字も変わらない', async () => {
    const { pane, box, type } = setup(schemaReply);
    erBtn(pane).click();
    await settleEr();
    type('update t set a = 1');
    const before = box.value;
    pane.querySelector<HTMLElement>('[data-pkc-field="sql-er-table"]')!.click();
    expect(box.value, '読めない字を書き換えた').toBe(before);
    expect(erNote(pane), '足さなかった理由が出ていない').toContain('足せません');
  });

  it('⚠ 押して足せた回は、前の理由が消える', async () => {
    const { pane, type } = setup(schemaReply);
    erBtn(pane).click();
    await settleEr();
    type('update t set a = 1');
    pane.querySelector<HTMLElement>('[data-pkc-field="sql-er-table"]')!.click();
    expect(erNote(pane)).not.toBe('');
    type('');
    pane.querySelector<HTMLElement>('[data-pkc-field="sql-er-table"]')!.click();
    expect(erNote(pane), '足せたのに前の断りが残っている').toBe('');
  });

  it('🔴 調べる相手を変えたら、前の図を持ち越さない', async () => {
    const { pane, pick, runReadOnlySql } = setup(schemaReply);
    erBtn(pane).click();
    await settleEr();
    expect(tables(pane).length, '中の表 2 つ + 本文の表 1 つ').toBe(3);
    const before = runReadOnlySql.mock.calls.length;

    // 取り込んだ `.sqlite` へ切り替える(開けたら採り直すはず)
    pick('db1');
    await settleEr();
    await settleEr();
    expect(runReadOnlySql.mock.calls.length, '相手を変えたのに採り直していない').toBeGreaterThan(
      before,
    );
    // ⚠ 採っている間に**前の DB の図**を出したままにしない
    expect(
      runReadOnlySql.mock.calls.some((c) => c[1].guest === true),
      'よその DB へ向けて採っていない',
    ).toBe(true);
  });

  /**
   * 🔴 **本文の名前つき csv も図に出る**(#918 段⑤d-2)。
   *
   * ⚠ 本文の csv は **temp の表**なので `sqlite_master` に出ない ── だから
   *   図には**この PKC の中の表だけ**が並び、`name=棚卸` と書いた user は
   *   「自分の表がどこにも無い」と読んでいた。
   */
  it('🔴 本文の名前つき csv も、図の四角として出る(#918 段⑤d-2)', async () => {
    const { pane, box } = setup(schemaReply);
    erBtn(pane).click();
    await settleEr();
    // 🔑 種類が字で分かる(「表」でも「ビュー」でもない ── 本文から来ている)
    expect(tables(pane), '本文の表が図に出ていない').toContain('棚卸(本文の表・4 行)');
    // ⚠ 対照群 ── 中の表も消えていない(足したぶんで押しのけていない)
    expect(
      tables(pane).some((t) => t.startsWith('売上(表')),
      '中の表が消えた',
    ).toBe(true);

    // 🔴 押せる ── 出すだけで終わらせない(図から引ける形まで通す)
    pane
      .querySelector<HTMLElement>('[data-pkc-field="sql-er-table"][data-pkc-name="棚卸"]')!
      .click();
    expect(box.value, '本文の表を押しても SQL が組まれない').toBe('select * from 棚卸');
    pane
      .querySelector<HTMLElement>(
        '[data-pkc-field="sql-er-column"][data-pkc-name="棚卸"][data-pkc-col="品名"]',
      )!
      .click();
    expect(box.value, '本文の表の列が足せない').toBe('select 品名 from 棚卸');
  });

  /**
   * 🔴 **客の DB へは、本文の目録を打たない**(#918 段⑤d-2)。
   * ⚠ 目録(`csv_columns`)は**この PKC の側にしか**組み立てられない ──
   *   向こうへ打つと「そんな表は無い」で落ちる。
   */
  it('🔴 取り込んだ DB では、本文の csv を採りに行かない', async () => {
    const { pane, pick, runReadOnlySql } = setup(schemaReply);
    erBtn(pane).click();
    await settleEr();
    // ⚠ 対照群 ── ノート側では打っている(打っていなければ、下の 0 件は意味が無い)
    const asked = runReadOnlySql.mock.calls.map((c) => String(c[0]));
    expect(
      asked.filter((q) => q.includes('csv_columns')),
      'ノート側で本文の目録を打っていない',
    ).toHaveLength(1);

    const before = runReadOnlySql.mock.calls.length;
    pick('db1');
    await settleEr();
    await settleEr();
    const after = runReadOnlySql.mock.calls.slice(before).map((c) => String(c[0]));
    expect(after.length, '相手を変えたのに採り直していない').toBeGreaterThan(0);
    expect(
      after.filter((q) => q.includes('csv_columns')),
      '客の DB へ本文の目録を打っている(向こうには無い)',
    ).toHaveLength(0);
  });

  it('⚠ 構造を採れなかったら、黙らずに理由を出す', async () => {
    const { pane } = setup(async (sql) => {
      if (sql.includes('pragma_table_info')) throw new Error('だめでした');
      return answer(['a'], [[1]]);
    });
    erBtn(pane).click();
    await settleEr();
    expect(region(pane).hidden, '採れなくても器は開いたまま').toBe(false);
    expect(erNote(pane), '採れなかった理由が出ていない').toContain('構造を採れませんでした');
  });
});

describe('🔴 ER の図で、自分でキーどうしを繋ぐ(#918 段⑤d-1)', () => {
  /**
   * ⚠ **外部キーの宣言が 1 本も無い DB**(CLAUDE.md §2「fixture のゼロ件次元は
   *   測っていない次元」── ここまでの段⑤ の検査は全部 FK 付きの DB でしか
   *   通っていなかった。それが「繋ぐ手段が画面に無い」という穴を見逃した原因)。
   *
   * 売上 ── 客id / 担当id の 2 本を、それぞれ 客 / 社員 へ**自分で**繋ぐ。
   */
  const noFkReply = async (sql: string): Promise<SqlAnswer> => {
    if (sql.includes('pragma_table_info')) {
      return answer(
        ['kind', 'tbl', 'cid', 'col', 'typ', 'nn', 'pk'],
        [
          ['table', '売上', 0, 'id', 'INTEGER', 1, 1],
          ['table', '売上', 1, '客id', 'INTEGER', 0, 0],
          ['table', '売上', 2, '担当id', 'INTEGER', 0, 0],
          ['table', '客', 0, 'id', 'INTEGER', 1, 1],
          ['table', '社員', 0, 'id', 'INTEGER', 1, 1],
        ],
      );
    }
    // 🔴 外部キーは 0 本(csv 取込 / FK 無し .sqlite を想定)
    if (sql.includes('pragma_foreign_key_list')) return answer(['tbl', 'ref', 'col', 'refcol'], []);
    if (sql.includes('count(*)')) return answer(['tbl', 'n'], [['売上', 3], ['客', 2], ['社員', 4]]);
    return answer(['a'], [[1]]);
  };

  /**
   * ⚠ 対照群 ── 宣言された外部キーを 1 本持つ DB(「宣言 FK は消せない」を見るため)。
   * `describe('表のつながり図(#918 段⑤)', …)` の `schemaReply` と**同じ構造**にする ──
   *   別の describe のブロック内 `const` なのでここからは参照できない(ここで作り直す)。
   */
  const withFkReply = async (sql: string): Promise<SqlAnswer> => {
    if (sql.includes('pragma_table_info')) {
      return answer(
        ['kind', 'tbl', 'cid', 'col', 'typ', 'nn', 'pk'],
        [
          ['table', '売上', 0, 'id', 'INTEGER', 1, 1],
          ['table', '売上', 1, '客id', 'INTEGER', 0, 0],
          ['table', '売上', 2, '金額', 'INTEGER', 0, 0],
          ['table', '客', 0, 'id', 'INTEGER', 1, 1],
          ['table', '客', 1, '名前', 'TEXT', 0, 0],
        ],
      );
    }
    if (sql.includes('pragma_foreign_key_list')) {
      return answer(['tbl', 'ref', 'col', 'refcol'], [['売上', '客', '客id', 'id']]);
    }
    if (sql.includes('count(*)')) return answer(['tbl', 'n'], [['売上', 3], ['客', 2]]);
    return answer(['a'], [[1]]);
  };

  const settleEr = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  const erBtn = (pane: HTMLElement): HTMLButtonElement =>
    pane.querySelector<HTMLButtonElement>('[data-pkc-field="sql-er-toggle"]')!;
  const connectBtn = (pane: HTMLElement): HTMLButtonElement =>
    pane.querySelector<HTMLButtonElement>('[data-pkc-field="sql-er-connect"]')!;
  const hint = (pane: HTMLElement): string =>
    pane.querySelector('[data-pkc-field="sql-er-connect-hint"]')?.textContent ?? '';
  const erNote = (pane: HTMLElement): string =>
    pane.querySelector('[data-pkc-field="sql-er-note"]')?.textContent ?? '';
  const lineCount = (pane: HTMLElement): number =>
    pane.querySelectorAll('[data-pkc-field="sql-er-lines"] line').length;
  const mineChips = (pane: HTMLElement): HTMLElement[] =>
    [...pane.querySelectorAll<HTMLElement>('[data-pkc-field="sql-er-link"][data-pkc-mine="true"]')];
  const fkChips = (pane: HTMLElement): HTMLElement[] =>
    [...pane.querySelectorAll<HTMLElement>('[data-pkc-field="sql-er-link"][data-pkc-mine="false"]')];
  const pressColumn = (pane: HTMLElement, table: string, column: string): void => {
    const el = pane.querySelector<HTMLElement>(
      `[data-pkc-field="sql-er-column"][data-pkc-name="${table}"][data-pkc-col="${column}"]`,
    );
    expect(el, `列の押し所が無い: ${table}.${column}`).toBeTruthy();
    el!.click();
  };
  const columnAt = (pane: HTMLElement, table: string, column: string): HTMLElement =>
    pane.querySelector<HTMLElement>(
      `[data-pkc-field="sql-er-column"][data-pkc-name="${table}"][data-pkc-col="${column}"]`,
    )!;
  const pressTable = (pane: HTMLElement, table: string): void => {
    pane.querySelector<HTMLElement>(`[data-pkc-field="sql-er-table"][data-pkc-name="${table}"]`)!.click();
  };

  it('🔴 外部キーが 0 本の DB でも、「繋ぐ」で線が引ける(欄にも JOIN が組まれる)', async () => {
    const { pane, box } = setup(noFkReply);
    erBtn(pane).click();
    await settleEr();
    expect(lineCount(pane), '外部キーが無いのに線が出ている').toBe(0);
    // ⚠ 普段の流れどおり、先に表を押して取り出し元にする(でないと erSql は
    //   「先に表の名前を押してください」と断る ── それは別の it で見る)
    pressTable(pane, '売上');

    connectBtn(pane).click();
    expect(connectBtn(pane).getAttribute('aria-pressed'), '入れたのに押されて見えない').toBe('true');
    expect(hint(pane), '入れた直後の案内が出ていない').toContain('繋ぎたい列を 2 つ');

    pressColumn(pane, '売上', '客id');
    expect(hint(pane), '1 列目を押した後の案内が出ていない').toContain('売上.客id');

    pressColumn(pane, '客', 'id');
    expect(lineCount(pane), '線が引かれていない').toBe(1);
    expect(box.value, '欄に JOIN が組まれていない').toBe(
      'select * from 売上\n  join 客 on 客.id = 売上.客id',
    );
    const chip = mineChips(pane)[0];
    expect(chip?.textContent, '自分で引いた札に列どうしが書かれていない').toContain('売上.客id → 客.id');
    expect(chip?.title, '消せることが伝わらない').toContain('消します');
  });

  /**
   * 🔴 **2026-09-16 に裏返した**(#918 段⑤d-1)。⚠ 直す前はここが
   *   「線は引けるが欄は動かず『先に表の名前を押してください』と出る」を pin していた
   *   ── **実ブラウザの smoke が「線は引けたのに欄が空のまま」で落ちて**分かった。
   * 🔑 繋ぐ道ができた後は、**押した 2 つで取り出し元も決まる** ── そこで断るのは、
   *   持っている情報で組めるのに、もう 1 手を要求していることになる。
   */
  it('🔴 表を 1 つも押していなくても、繋げば両方の表から組む', async () => {
    const { pane, box } = setup(noFkReply);
    erBtn(pane).click();
    await settleEr();
    connectBtn(pane).click();
    pressColumn(pane, '売上', '客id');
    pressColumn(pane, '客', 'id');
    expect(lineCount(pane), '線が引かれていない').toBe(1);
    expect(box.value, '空の欄から組めていない').toBe(
      'select * from 売上\n  join 客 on 客.id = 売上.客id',
    );
    // ⚠ 組めたのだから、断りの字は残さない(前の断りが居座らないこと)
    expect(erNote(pane), '組めたのに断りの字が残っている').not.toContain('先に表の名前');
  });

  it('🔴 同じ表の中では繋げない(理由が出て、線は増えない)', async () => {
    const { pane } = setup(noFkReply);
    erBtn(pane).click();
    await settleEr();
    connectBtn(pane).click();
    pressColumn(pane, '売上', '客id');
    pressColumn(pane, '売上', '担当id');
    expect(lineCount(pane), '同じ表なのに線が引けている').toBe(0);
    expect(erNote(pane)).toBe('同じ表の中では繋げません');
  });

  it('🔴 もう在る繋がりと同じ組み合わせは断られる(2 本目にはならない)', async () => {
    const { pane } = setup(noFkReply);
    erBtn(pane).click();
    await settleEr();
    connectBtn(pane).click();
    pressColumn(pane, '売上', '客id');
    pressColumn(pane, '客', 'id');
    expect(lineCount(pane)).toBe(1);
    // 同じ 2 列をもう一度
    pressColumn(pane, '売上', '客id');
    pressColumn(pane, '客', 'id');
    expect(lineCount(pane), 'もう繋がっているのに増えている').toBe(1);
    expect(erNote(pane)).toBe('その 2 つはもう繋がっています');
  });

  it('⚠ 同じ列をもう一度押すとやめられる(片道の操作を作らない)', async () => {
    const { pane, box } = setup(noFkReply);
    erBtn(pane).click();
    await settleEr();
    connectBtn(pane).click();
    pressColumn(pane, '売上', '客id');
    expect(columnAt(pane, '売上', '客id').getAttribute('aria-pressed'), '押した印が付いていない').toBe(
      'true',
    );
    pressColumn(pane, '売上', '客id');
    expect(
      columnAt(pane, '売上', '客id').getAttribute('aria-pressed'),
      'もう一度押したのに印が残っている',
    ).toBe('false');
    expect(hint(pane), 'やめたのに「ここから」の案内が残っている').toContain('繋ぎたい列を 2 つ');
    expect(box.value, 'やめただけなのに欄が動いている').toBe('');
  });

  it('🔴 切るとやめかけの相手を捨てる(入れ直しても復活しない)', async () => {
    const { pane, box } = setup(noFkReply);
    erBtn(pane).click();
    await settleEr();
    connectBtn(pane).click();
    pressColumn(pane, '売上', '客id');
    expect(hint(pane)).toContain('売上.客id');
    // 切る
    connectBtn(pane).click();
    expect(connectBtn(pane).getAttribute('aria-pressed')).toBe('false');
    // もう一度入れる ── 前の「ここから」が残っていたら、次の 1 押しで繋がってしまう
    connectBtn(pane).click();
    expect(hint(pane), '切ったのに「ここから」が生きている').toContain('繋ぎたい列を 2 つ');
    pressColumn(pane, '社員', 'id');
    expect(lineCount(pane), '1 列しか押していないのに線が出ている').toBe(0);
    expect(hint(pane)).toContain('社員.id');
    expect(box.value).toBe('');
  });

  it('🔴 自分で引いた線の札を押すと消える。宣言された外部キーは消えない', async () => {
    const { pane } = setup(withFkReply);
    erBtn(pane).click();
    await settleEr();
    // このフィクスチャは 売上→客 の宣言済み FK を 1 本持つ
    expect(fkChips(pane).length, '宣言された FK が出ていない').toBe(1);
    connectBtn(pane).click();
    pressColumn(pane, '売上', '金額');
    // ⚠ 型は数だが SchemaLink としては列名だけが要る ── 別の列名を使い
    //   「宣言 FK とは別の、自分で引いた線」を 1 本足す
    pressColumn(pane, '客', '名前');
    expect(lineCount(pane), '自分の線が引けていない').toBe(2);
    expect(mineChips(pane).length).toBe(1);

    // 宣言された FK の札を押しても、消えるのではなく JOIN が足される(既存の動きのまま)
    fkChips(pane)[0]!.click();
    expect(lineCount(pane), '宣言された FK が消えている').toBe(2);

    // 自分の線の札を押すと消える
    mineChips(pane)[0]!.click();
    expect(lineCount(pane), '自分の線が消えていない').toBe(1);
    expect(mineChips(pane).length).toBe(0);
    expect(fkChips(pane).length, '宣言された FK まで消えている').toBe(1);
  });

  it('🔴 見分けが色だけに頼っていない(mine の札に字の手がかりが付く)', async () => {
    const { pane } = setup(noFkReply);
    erBtn(pane).click();
    await settleEr();
    connectBtn(pane).click();
    pressColumn(pane, '売上', '客id');
    pressColumn(pane, '客', 'id');
    const chip = mineChips(pane)[0]!;
    expect(chip.querySelector('[data-pkc-field="sql-er-mine-badge"]')?.textContent, '色以外の手がかりが無い').toBe(
      '自分',
    );
    const svgLine = pane.querySelector('[data-pkc-field="sql-er-lines"] line');
    expect(svgLine?.getAttribute('data-pkc-mine')).toBe('true');
  });

  it('🔴 調べる相手を変えたら、自分で引いた線を持ち越さない', async () => {
    const { pane, pick } = setup(noFkReply);
    erBtn(pane).click();
    await settleEr();
    connectBtn(pane).click();
    pressColumn(pane, '売上', '客id');
    pressColumn(pane, '客', 'id');
    expect(lineCount(pane)).toBe(1);

    pick('db1');
    await settleEr();
    await settleEr();
    expect(lineCount(pane), '相手を変えたのに前の DB の繋がりが残っている').toBe(0);

    /**
     * 🔑 **もう 1 段 ── 単独の経路で捨てているかを見る**。
     * ⚠ 上の「ノート → db1」は `SET_SQL_SOURCE`(1 段目の捨て)と
     *   `SQL_GUEST_OPENED`(2 段目の捨て)が**続けて**働くので、片方だけ壊れても
     *   もう片方が救ってしまう(CLAUDE.md §3.9「同じ物を守る網が 2 枚」)。
     *   ここで「db1 → ノート」を通すと、`SET_SQL_SOURCE` の**1 回だけ**で
     *   捨てる経路(2 段目を経由しない)を単独で確かめられる。
     * ⚠ 「繋ぐ」の入切は相手を変えても持ち越る(user の好みなので)── ここでは
     *   まだ入ったままなので、もう一度押さない(押すと切ってしまう)。
     */
    expect(connectBtn(pane).getAttribute('aria-pressed'), '繋ぐが持ち越っていない').toBe('true');
    pressColumn(pane, '売上', '客id');
    pressColumn(pane, '客', 'id');
    expect(lineCount(pane), 'db1 の図で線が引けていない').toBe(1);
    pick('');
    await settleEr();
    await settleEr();
    expect(lineCount(pane), '素のノートへ戻したのに db1 の繋がりが残っている').toBe(0);
  });

  /**
   * 🔴 **線が 0 本の画面が、何も言わないままだった**(#918 段⑤d-3)。
   *
   * ⚠ 段⑤d-1 で「繋ぐ」を足しても、**気づかなければ user は最初の報告と同じ所へ戻る**
   *   (「箱は出たのに線が出ない = 壊れている」)。
   */
  const zeroNote = (pane: HTMLElement): string =>
    pane.querySelector('[data-pkc-field="sql-er-zero"]')?.textContent ?? '';

  it('🔴 線が 0 本なら、理由と次の一手を図の下に出す(#918 段⑤d-3)', async () => {
    const { pane } = setup(noFkReply);
    erBtn(pane).click();
    await settleEr();
    // ⚠ 前提を assert する ── 崩れたら「一致しない」ではなく「前提が崩れた」と読めるように
    expect(lineCount(pane), '前提が崩れている(この fixture は外部キー 0 本)').toBe(0);
    const s = zeroNote(pane);
    expect(s, 'なぜ 0 本なのかを言っていない').toContain('宣言していません');
    expect(s, '次に何を押せばよいか言っていない').toContain('繋ぐ');

    /**
     * 🔴 **読む順** ── 理由が先、案内が後。
     * ⚠ 案内(「繋ぎたい列を 2 つ」)だけ先に読んでも、**なぜ繋ぐ必要があるのか**が
     *   分からない。`DOCUMENT_POSITION_FOLLOWING` で**実際の並び**を見る。
     */
    const zeroEl = pane.querySelector('[data-pkc-field="sql-er-zero"]')!;
    const scrollEl = pane.querySelector('[data-pkc-field="sql-er-scroll"]')!;
    expect(
      scrollEl.compareDocumentPosition(zeroEl) & Node.DOCUMENT_POSITION_FOLLOWING,
      '理由が図より前に出ている',
    ).toBeTruthy();
  });

  it('🔴 「繋ぐ」が入のときは、次の一手を二重に言わない(理由は言い続ける)', async () => {
    const { pane } = setup(noFkReply);
    erBtn(pane).click();
    await settleEr();
    // ⚠ 対照群 ── 切のときは言っている(言わない実装でも、入だけ見たら通る)
    expect(zeroNote(pane), '切のときに次の一手が出ていない').toContain('押して列を 2 つ');

    connectBtn(pane).click();
    expect(zeroNote(pane), '入にしたのに理由まで消えている').toContain('宣言していません');
    expect(zeroNote(pane), '入なのに「繋ぐを押せ」と言い続けている').not.toContain('押して列を 2 つ');
    // 🔑 代わりに、すぐ下の案内が次の一手を言っている(言う人が 0 人にならない)
    expect(hint(pane), '次の一手を言う人が 1 人もいない').toContain('繋ぎたい列を 2 つ');
  });

  it('🔴 線が 1 本でも引けたら、その字は消える(嘘が残らない)', async () => {
    const { pane } = setup(noFkReply);
    erBtn(pane).click();
    await settleEr();
    expect(zeroNote(pane), '前提が崩れている').not.toBe('');
    connectBtn(pane).click();
    pressColumn(pane, '売上', '客id');
    pressColumn(pane, '客', 'id');
    expect(lineCount(pane), '線が引けていない(前提が崩れている)').toBe(1);
    expect(zeroNote(pane), '線が在るのに「0 本です」の字が残っている').toBe('');
  });

  it('🔴 表が 1 つだけなら「繋ぐ」を勧めない(同じ表の中は繋げない = 押せない道)', async () => {
    const oneTable = async (sql: string): Promise<SqlAnswer> => {
      if (sql.includes('pragma_table_info')) {
        return answer(
          ['kind', 'tbl', 'cid', 'col', 'typ', 'nn', 'pk'],
          [
            ['table', '売上', 0, 'id', 'INTEGER', 1, 1],
            ['table', '売上', 1, '金額', 'INTEGER', 0, 0],
          ],
        );
      }
      if (sql.includes('pragma_foreign_key_list')) {
        return answer(['tbl', 'ref', 'col', 'refcol'], []);
      }
      if (sql.includes('count(*)')) return answer(['tbl', 'n'], [['売上', 3]]);
      return answer(['a'], [[1]]);
    };
    const { pane } = setup(oneTable);
    erBtn(pane).click();
    await settleEr();
    expect(zeroNote(pane), '相手がいないことを言っていない').toContain('繋ぐ相手がいません');
    expect(zeroNote(pane), '押せない道へ誘っている').not.toContain('押して列を 2 つ');
  });
});

describe('🔴 どのエンジンで引くか(#682 段②。user 裁定 2026-09-15 = §9 は A)', () => {
  /**
   * 🔴 **段③c で裏返した**(user 報告 2026-09-16「duckdb の導線が無い」)。
   *
   * ⚠ 直す前は「選べる物が 1 つなら選び所ごと隠す」で、**この test はそれを pin していた** ──
   *   つまり **user が困っていた当の作りを守っていた**。
   * 🔑 いまは**常に出して、選べない側を薄い字にし、理由をその場に書く**。
   */
  it('🔴 最初から出ている ── DuckDB は薄い字で、どうすれば使えるかが書いてある', () => {
    const { engineSel, tipText } = setup();
    expect(engineSel.hidden, '選び所が出ていない(= 導線が無い)').toBe(false);
    expect([...engineSel.options].map((o) => o.value)).toEqual(['sqlite', 'duckdb']);
    const duck = [...engineSel.options].find((o) => o.value === 'duckdb');
    // 🔴 **選べないことと、その理由が、同じ所に在る**
    expect(duck?.disabled, 'ノートなのに DuckDB を選ばせている').toBe(true);
    expect(duck?.textContent, 'どうすれば使えるかが書いていない').toContain('.csv');
    // ⚠ 対照群 ── いま引ける側は薄くしない(全部薄いと、選び所ごと死ぬ)
    expect([...engineSel.options].find((o) => o.value === 'sqlite')?.disabled).toBe(false);
    expect(engineSel.value, '引くのは sqlite のまま').toBe('sqlite');
    // 🔑 案内文も残す(見つけ方は 1 本より 2 本)
    expect(tipText(), 'DuckDB が在ることを、どこにも書いていない').toContain('DuckDB');
  });

  it('🔴 取り込んだ csv を選ぶと出てきて、既定は今までの sqlite のまま', async () => {
    const { pick, engineSel, d } = setup();
    pick('db4'); // 売上.csv
    await settle();
    expect(engineSel.hidden, 'csv を選んだのに選び所が出ない').toBe(false);
    expect([...engineSel.options].map((o) => o.value)).toEqual(['sqlite', 'duckdb']);
    // 🔑 csv では**どちらも選べる** ── 薄い字が残っていたら、相手で解いていない
    expect([...engineSel.options].filter((o) => o.disabled), 'csv なのに選べない側がある').toHaveLength(0);
    expect(engineSel.value, '既定が sqlite でない(選ばなければ今までどおり、が崩れる)').toBe('sqlite');
    expect(d.getState().sqlPage.engine).toBe('sqlite');
  });

  /**
   * ⚠ この fixture に `.xlsx` の添付は無い(この file の相手は `.sqlite` / `.csv` / `.tsv` だけ)。
   * 🔑 拡張子ごとの全数は `tests/features/sql-engine.test.ts` が等値で見る ── ここは**配線**を見る。
   */
  it('🔴 .sqlite では DuckDB を選べない(薄い字のまま)', async () => {
    const { pick, engineSel } = setup();
    pick('db1'); // 売上.sqlite
    await settle();
    expect(engineSel.hidden, '選び所が消えている').toBe(false);
    const duck = [...engineSel.options].find((o) => o.value === 'duckdb');
    expect(duck?.disabled, '.sqlite で DuckDB を選ばせている').toBe(true);
    /**
     * 🔴 **理由の字が、相手に合わせて変わる**。
     * ⚠ 組み直す合図を「並ぶ数」で持つと、ノート(1 つ)→ `.sqlite`(1 つ)で
     *   **数が動かない**ので、**前の相手の理由が残る** ── そこを見る。
     */
    expect(duck?.textContent, '前の相手の理由が残っている').toContain('のときだけ');
  });

  it('🔴 DuckDB を選んで走らせると、DuckDB で引く ── sqlite は 1 度も叩かない', async () => {
    const { pick, pickEngine, type, runBtn, runReadOnlySql, duckSeen, cells } = setup();
    pick('db4');
    await settle();
    pickEngine('duckdb');
    type('FROM csv SELECT *');
    runBtn.click();
    await settle();
    expect(duckSeen, 'DuckDB を選んだのに引いていない').toHaveLength(1);
    expect(duckSeen[0]?.sql).toBe('FROM csv SELECT *');
    expect(duckSeen[0]?.source).toEqual({ lid: 'db4', name: '売上.csv' });
    // 🔴 相手の中身を読みに来ている(読まなければ、表は空のままになる)
    expect(duckSeen[0]?.bytes, '相手の中身を読みに来ていない').toBeGreaterThan(0);
    // ⚠ 空振り防止 ── sqlite の口が 1 度でも叩かれていたら、engine を取り違えている
    expect(runReadOnlySql, 'sqlite も叩いている(engine を分けていない)').toHaveBeenCalledTimes(0);
    expect(cells()).toEqual([['duck']]);
  });

  it('🔴 sqlite に戻せば sqlite で引く(対照群)', async () => {
    const { pick, pickEngine, type, runBtn, runReadOnlySql, duckSeen } = setup();
    pick('db4');
    await settle();
    pickEngine('duckdb');
    pickEngine('sqlite');
    type('SELECT * FROM csv');
    runBtn.click();
    await settle();
    expect(duckSeen).toHaveLength(0);
    expect(runReadOnlySql).toHaveBeenCalledTimes(1);
  });

  it('🔴 DuckDB でだけ打てる字が、DuckDB のときだけ通る', async () => {
    const { pick, pickEngine, type, runBtn, note, duckSeen } = setup();
    pick('db4');
    await settle();
    // ⚠ まず sqlite のまま打つ ── FROM 先行は sqlite では打てないので断られる
    type('FROM csv SELECT *');
    runBtn.click();
    await settle();
    expect(note(), 'sqlite なのに FROM 先行が通っている').toContain('FROM');
    expect(duckSeen, '断ったのに引きに行った').toHaveLength(0);
    // 🔑 engine を替えると、同じ字が通る
    pickEngine('duckdb');
    runBtn.click();
    await settle();
    expect(duckSeen, 'DuckDB でも FROM 先行が通らない').toHaveLength(1);
  });

  it('🔴 外へ取りに行く字は、DuckDB でも断る(引きに行かない)', async () => {
    const { pick, pickEngine, type, runBtn, note, duckSeen } = setup();
    pick('db4');
    await settle();
    pickEngine('duckdb');
    type('INSTALL parquet');
    runBtn.click();
    await settle();
    expect(note()).toContain('外から');
    expect(duckSeen, '断ったのに引きに行った').toHaveLength(0);
  });

  it('🔴 相手を .sqlite へ替えると、選んだ DuckDB は薄い字になって sqlite で引く', async () => {
    const { pick, pickEngine, engineSel, type, runBtn, runReadOnlySql, duckSeen, d } = setup();
    pick('db4');
    await settle();
    pickEngine('duckdb');
    pick('db1'); // 売上.sqlite ── DuckDB では引けない相手
    await settle();
    expect([...engineSel.options].find((o) => o.value === 'duckdb')?.disabled).toBe(true);
    // 🔑 画面に出る値は**実際に引く物** ── 選んだ物(duckdb)をそのまま出さない
    expect(engineSel.value, '画面が、引かない engine を指している').toBe('sqlite');
    type('SELECT 1');
    runBtn.click();
    await settle();
    expect(duckSeen, '画面に無い engine で引いている').toHaveLength(0);
    expect(runReadOnlySql).toHaveBeenCalledTimes(1);
    // 🔑 **選んだ物は消さない** ── csv へ戻れば DuckDB が戻る(選択が黙って消えない)
    expect(d.getState().sqlPage.engine).toBe('duckdb');
    pick('db4');
    await settle();
    expect(engineSel.value, 'csv へ戻ったのに、選んでいた DuckDB が戻らない').toBe('duckdb');
  });

  it('🔴 相手の名前は state から引く ── 画面の字が古くても取り違えない', async () => {
    const { pick, sourceSel, d } = setup();
    pick('db4');
    await settle();
    /**
     * ⚠ **画面の字をわざと嘘にする** ── 実機では起きないが、happy-dom の
     *   `selectedOptions` が腐る形(2026-09-15 実測)と**同じ嘘**である。
     * 🔑 名前を DOM から採っていた頃は、ここで「売上.csv」が飛んでいた ──
     *   lid は正しいので**どの test も落ちず**、案内文と engine だけが前の相手の物になった。
     */
    for (const o of sourceSel.options) if (o.value === 'db1') o.textContent = 'ぜんぜん違う名前';
    pick('db1');
    await settle();
    expect(d.getState().sqlPage.guest?.name, '画面の字を信じて相手を取り違えている').toBe('売上.sqlite');
  });

  it('🔴 口が無い版では理由を言って断る(黙って sqlite で引かない)', async () => {
    const { pick, pickEngine, type, runBtn, note, runReadOnlySql } = setup(undefined, { withDuck: false });
    pick('db4');
    await settle();
    pickEngine('duckdb');
    type('FROM csv SELECT *');
    runBtn.click();
    await settle();
    expect(note(), '押して無反応になっている').toContain('DuckDB');
    // 🔴 いちばん気づけない外し方 ── 選んだ物と違う所で引く
    expect(runReadOnlySql, '黙って sqlite で引いている').toHaveBeenCalledTimes(0);
  });

  it('🔴 打ち方の約束が engine で入れ替わる(sqlite の字を DuckDB に出さない)', async () => {
    const { pick, pickEngine, rules } = setup();
    pick('db4');
    await settle();
    // ⚠ sqlite の約束は**実測した字** ── DuckDB には当たらない
    expect(rules()).toContain('REGEXP');
    pickEngine('duckdb');
    await settle();
    expect(rules(), 'DuckDB なのに sqlite の癖を出している').not.toContain('REGEXP');
    expect(rules()).toContain('FROM');
  });

  it('DuckDB の断りは、そのまま画面に出る(黙って消さない)', async () => {
    const { pick, pickEngine, type, runBtn, note, runDuckDbSql } = setup();
    runDuckDbSql.mockRejectedValueOnce(new Error('DuckDB の一式を取ってこられませんでした'));
    pick('db4');
    await settle();
    pickEngine('duckdb');
    type('FROM csv SELECT *');
    runBtn.click();
    await settle();
    expect(note()).toContain('取ってこられませんでした');
  });
});
