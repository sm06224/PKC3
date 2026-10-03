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
import {
  blockedActionNote,
  isAsidePane,
  SQL_HISTORY_MAX,
  viewModeLabel,
} from '../../src/adapter/state/app-state';
import {
  duckdbWarmupNote,
  fitSqlInput,
  SQL_SOURCE_GROUP_ADD,
  SQL_SOURCE_GROUP_ATTACHED,
  SQL_SOURCE_GROUP_LOCAL,
  SQL_SOURCE_GROUP_PKC,
} from '../../src/adapter/ui/render/sql';
import { SQL_WINDOW_MIN } from '../../src/features/query/sql-window';
import { homeTabOf } from '../../src/adapter/ui/render/browse-mode';
import { readFileSync } from 'node:fs';
import { blocksFor, stripComments, withoutMedia } from '../helpers/css-blocks';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import { DUCKDB_NETWORK_NOTE } from '../../src/features/query/sql-guest-source';
import type { DuckDbCopyReport } from '../../src/features/query/duckdb-copy-report';
import {
  DEFAULT_IDLE_MS,
  DUCKDB_LOAD_TOO_LONG,
  DUCKDB_TOO_LONG,
} from '../../src/adapter/platform/duckdb/duckdb-lease';
import type {
  DuckDbReadableGuestSource,
  SqliteConvertGuestSource,
} from '../../src/features/query/sql-guest-source';
// 🔴 手持ちのファイルを開く(#854 段②)── main.ts と**同じ実物**を配線する
import {
  readSqlLocalFileBytes,
  pickSqlLocalFileInto,
  releaseSqlLocalFile,
  sqlLocalFileSize,
} from '../../src/adapter/state/sql-local-file';
import { SQL_ADD_LOCAL_FILE_VALUE, SQL_PICK_LOCAL_FILE_VALUE } from '../../src/features/query/sql-local-file';

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
  const duckSeen: Array<{
    sql: string;
    /** 1 件目(= 今までの test が見ていた物)。 */
    source: DuckDbReadableGuestSource;
    bytes: number | null;
    /** 🔴 並べた相手の全部と、その中身を読めた大きさ(#918 段⑦)。 */
    all: DuckDbReadableGuestSource[];
    allBytes: Array<number | null>;
  }> = [];
  const runDuckDbSql = vi.fn(
    async (input: {
      sql: string;
      sources: readonly {
        source: DuckDbReadableGuestSource;
        readBytes: () => Promise<Uint8Array | null>;
      }[];
    }) => {
      const read = await Promise.all(input.sources.map((s) => s.readBytes()));
      const first = input.sources[0];
      if (first === undefined) throw new Error('相手が空で呼ばれた');
      duckSeen.push({
        sql: input.sql,
        source: first.source,
        bytes: read[0]?.byteLength ?? null,
        all: input.sources.map((s) => s.source),
        allBytes: read.map((b) => b?.byteLength ?? null),
      });
      return { columns: ['g'], rows: [['duck']] as Array<Array<string | number | null>>, truncated: false, ms: 2 };
    },
  );
  /**
   * 🔴 **DuckDB の器の構造を採る口**(#918)。⚠ 実物は DuckDB の器へ聞く ── ここは
   *   「**どの相手の組で、中身を読みに行ける形で頼まれたか**」を控える fake。返す形は**実物と同じ 3 枚**
   *   (`DUCKDB_SCHEMA_*` の列名)で、内容は 2 つの表(売上 → 客 の外部キー 1 本)。
   */
  const schemaSeen: Array<{ sources: DuckDbReadableGuestSource[]; bytes: Array<number | null> }> = [];
  const schemaDuckDb = vi.fn(
    async (input: {
      sources: readonly {
        source: DuckDbReadableGuestSource;
        readBytes: () => Promise<Uint8Array | null>;
      }[];
    }) => {
      const read = await Promise.all(input.sources.map((x) => x.readBytes()));
      schemaSeen.push({ sources: input.sources.map((x) => x.source), bytes: read.map((b) => b?.byteLength ?? null) });
      return {
        columns: {
          columns: ['kind', 'tbl', 'cid', 'col', 'typ', 'nn', 'pk'],
          rows: [
            ['table', '客', 0, 'id', 'BIGINT', 1, 1],
            ['table', '客', 1, '名前', 'VARCHAR', 0, 0],
            ['table', '売上', 0, 'id', 'BIGINT', 1, 1],
            ['table', '売上', 1, '客id', 'BIGINT', 0, 0],
          ] as Array<Array<string | number | null>>,
        },
        fks: {
          columns: ['tbl', 'ref', 'col', 'refcol'],
          rows: [['売上', '客', '客id', 'id']] as Array<Array<string | number | null>>,
        },
        counts: {
          columns: ['tbl', 'n'],
          rows: [['客', 2], ['売上', 3]] as Array<Array<string | number | null>>,
        },
        // 🔴 既定は「写した報告なし」(省略)。写せなかった表を言う test が、1 回だけ差し替える
        ...({} as { copy?: DuckDbCopyReport }),
      };
    },
  );
  /** 取り込んだ `.sqlite` / `.csv` / `.tsv` の口(#681 段③ の 2 つ目、#854 段①)。
   *  ⚠ 実物は worker の別接続 ── ここは**渡された引数**だけを見る fake である。 */
  /** 開くのを**手で止められる**門(遅れて届く答えを作るため)。 */
  let holdOpen: null | (() => void) = null;
  const openSqlGuest = vi.fn(async (image: Uint8Array, source?: SqliteConvertGuestSource) => {
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
                  : lid === 'db7'
                    ? // 🔑 大きさは**本文の `attachment.size`** から採る(中身は読まない。#682 段④c)
                      '---\nattachment.name: 売上.parquet\nattachment.size: 4096\nattachment.asset_key: ast-parquet\n---\n'
                    : lid === 'db8'
                      ? '---\nattachment.name: 明細.ndjson\nattachment.size: 321\nattachment.asset_key: ast-ndjson\n---\n'
                      : '',
    ...(opts.withOp === false ? {} : { runReadOnlySql, openSqlGuest, closeSqlGuest }),
  }, opts.withOp === false
    ? {}
    : {
        readAssetBytes,
        // 🔴 手持ちのファイル(#854 段②)── 実物の控えをそのまま繋ぐ
        //    (⚠ `withLocal: false` のときは**この口だけ**外す)
        ...(opts.withLocal === false
          ? {}
          : {
              readLocalSqlFile: (lid: string) => readSqlLocalFileBytes(lid),
              /**
               * 🔴 **控えを手放す口も、実物を繋ぐ**(#682 段④c)。
               * ⚠ 直す前はここを繋いでいなかったので、**この口の経路を
               *   unit が 1 度も通っていなかった** ── そのせいで
               *   「選び直した瞬間に、いま控えた file を消す」という欠陥を
               *   **139 件緑のまま**作った(CLAUDE.md §2)。
               */
              releaseLocalSqlFile: (lid: string) => {
                releaseSqlLocalFile(lid);
              },
              localSqlFileSize: (lid: string) => sqlLocalFileSize(lid),
            }),
        // 🔴 DuckDB の口(#682 段②)── 実物は別ワーカー。ここは**渡された引数**だけを見る
        ...(opts.withDuck === false ? {} : { runDuckDbSql, schemaDuckDb }),
      });
  // 🔑 帯の下の 1 行に出す知らせを控える(#992 ①)
  const said: string[] = [];
  bindActions(root, d, {
    showStatus: (t: string) => {
      said.push(t);
    },
    // 🔴 main.ts と**同じ実物の配線**(#854 段②)── ここだけ fake にしない
    pickSqlLocalFile: (file: File, add?: boolean) => {
      pickSqlLocalFileInto(d, file, add === true);
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
      // 🔑 DuckDB でしか読めない相手(#682 段④c)── いちばん下に並ぶはず
      { ...meta('db7', '売上.parquet'), archetype: 'attachment' },
      { ...meta('db8', '明細.ndjson'), archetype: 'attachment' },
      // ⚠ **対照群** ── 添付でも読める拡張子でないものは並ばない
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
    schemaDuckDb,
    schemaSeen,
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
    said,
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
    expect(runBtn.textContent, '押し所の字').toBe('SQL を走らせる');
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
    // 🔑 字は `blockedActionNote` の 1 か所から(C11b / #1045)── 手で書いた
    //   「編集中は書き出せません」は消えた(この面の外と同じ字にそろえた)
    expect(note(), '黙って捨てている(理由が画面に出ない)').toContain(blockedActionNote('editing')!);
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
    // 🔑 数えた物の名前だけを書く ── 本文の表が在るときだけ、その欄が出る
    expect(body, '件数が本表だけになっている').toContain('表 / ビュー: 1 件 / 本文の表: 1 件');
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

  it('🔴 先頭が空行でも、その空行(= 1 行目)で ↑ を押せば履歴が戻る(#1241)', async () => {
    const { d, type, key, runBtn, box } = setup();
    type('select 1');
    runBtn.click();
    await settle();
    // ⚠ 先頭が空行の本文。caret 0 は 1 行目(空行)にある。
    //   `lastIndexOf('\n', 0)` は 0 番目の `\n` を見て「前に行がある」と読んでいた。
    type('\nselect 2');
    caret(box, 0);
    key({ key: 'ArrowUp' });
    expect(d.getState().sqlPage.sql, '1 行目の空行なのに握らなかった').toBe('select 1');
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
  it('🔴 .xlsx では DuckDB を選べない(薄い字のまま)', async () => {
    const { pickLocalFile, engineSel } = setup();
    // ⚠ この fixture に `.xlsx` の添付は無いので、手持ちのファイルで開く(判定は同じ 1 か所)
    pickLocalFile(new File([new Uint8Array(8)], '台帳.xlsx'));
    await settle();
    expect(engineSel.hidden, '選び所が消えている').toBe(false);
    const duck = [...engineSel.options].find((o) => o.value === 'duckdb');
    expect(duck?.disabled, '.xlsx で DuckDB を選ばせている').toBe(true);
    /**
     * 🔴 **理由の字が、相手に合わせて変わる**。
     * ⚠ 組み直す合図を「並ぶ数」で持つと、ノート(1 つ)→ `.xlsx`(1 つ)で
     *   **数が動かない**ので、**前の相手の理由が残る** ── そこを見る。
     */
    expect(duck?.textContent, '前の相手の理由が残っている').toContain('のときだけ');
    // 🔴 足せる拡張子の案内に `.sqlite` が入っている(#682 段④d)
    expect(duck?.textContent).toContain('.sqlite');
  });

  /**
   * 🔴 **`.sqlite` は DuckDB も選べる**(#682 段④d。🟣 Gemini 裁定 2026-10-02)。
   * ⚠ 直す前のこの test は「`.sqlite` では DuckDB を選べない」を pin していた ── 判定が
   *   `sqlGuestSourceOf` の `null`(= 画像のまま開く道)に頼っていたため。
   */
  it('🔴 .sqlite でも DuckDB を選べる ── 内蔵の sqlite は今までどおり画像のまま開く', async () => {
    const { pick, engineSel, openSqlGuest, d } = setup();
    pick('db1'); // 売上.sqlite
    await settle();
    const duck = [...engineSel.options].find((o) => o.value === 'duckdb');
    expect(duck?.disabled, '.sqlite で DuckDB を選べない').toBe(false);
    expect([...engineSel.options].filter((o) => o.disabled), '.sqlite なのに選べない側がある').toHaveLength(0);
    // 🔴 既定は今までどおり sqlite
    expect(engineSel.value).toBe('sqlite');
    expect(d.getState().sqlPage.engine).toBe('sqlite');
    // 🔴 worker へは `source` を渡さない(画像として開く ── `.sqlite` を「変換して開く種類」へ流さない)
    expect(openSqlGuest).toHaveBeenCalledTimes(1);
    expect(openSqlGuest.mock.calls[0]?.[1], '.sqlite に source を渡している').toBeUndefined();
    // 🔑 表の名前は開いた客の物のまま(DuckDB でも元の名前で引ける)
    expect(d.getState().sqlPage.guest?.tables).toEqual(['売上', '客']);
  });

  it('🔴 .sqlite を DuckDB で引くと、DuckDB の器へ .sqlite として渡る ── sqlite は叩かない', async () => {
    const { pick, pickEngine, type, runBtn, runReadOnlySql, duckSeen, cells, tipText } = setup();
    pick('db1');
    await settle();
    pickEngine('duckdb');
    // 🔴 案内は元の表の名前を言う(csv などに潰さない)/ 手本は 1 つ目の表を元の名前で
    expect(tipText()).toContain('売上, 客');
    expect(tipText()).toContain('元のまま');
    type('FROM "売上" SELECT *');
    runBtn.click();
    await settle();
    expect(duckSeen).toHaveLength(1);
    expect(duckSeen[0]?.source).toEqual({ kind: 'sqlite', lid: 'db1', name: '売上.sqlite' });
    // 🔴 相手の中身を読みに来ている(画像を DuckDB の側へ渡すのに要る)
    expect(duckSeen[0]?.bytes, '相手の中身を読みに来ていない').toBeGreaterThan(0);
    expect(runReadOnlySql, 'sqlite も叩いている(engine を分けていない)').toHaveBeenCalledTimes(0);
    expect(cells()).toEqual([['duck']]);
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
    /**
     * 🔴 **`kind` まで渡る**(#682 段④c)── これが無いと
     *   `read_csv_auto` / `read_parquet` / `read_json_auto` を選び分けられない。
     */
    expect(duckSeen[0]?.source).toEqual({ kind: 'csv', lang: 'csv', lid: 'db4', name: '売上.csv' });
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

  it('🔴 相手を .xlsx へ替えると、選んだ DuckDB は薄い字になって sqlite で引く', async () => {
    const { pick, pickEngine, pickLocalFile, engineSel, type, runBtn, runReadOnlySql, duckSeen, d } = setup();
    pick('db4');
    await settle();
    pickEngine('duckdb');
    pickLocalFile(new File([new Uint8Array(8)], '台帳.xlsx')); // DuckDB では引けない相手
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

/**
 * 🔴 **DuckDB のときだけ、表を作れる**(#918 段⑧)。
 *
 * ## user の物語(ここを見る)
 *
 * ①取り込んだ `.csv` を選び ②エンジンを DuckDB にし ③`CREATE TABLE …` を打って走らせる
 * ④「◯ 行に効きました ── 作った表はウィンドウを閉じると消えます」と出る
 * ⑤`SELECT` で作った表を引ける ⑥**内蔵の sqlite のまま同じ字を打つと、今までどおり断られる**。
 *
 * ⚠ ここが見るのは**画面と配線**で、engine が実際に実行できるかは
 *   `tests/duckdb-write.test.ts`(実物)、字の門は `tests/features/duckdb-write.test.ts` が見る。
 */
describe('🔴 DuckDB では表を作れる / sqlite では断る(#918 段⑧)', () => {
  /** 書き込みが返す形(実測:`Count` の列に 1 行)。 */
  const counted = (n: number) => ({
    columns: ['Count'],
    rows: [[n]] as Array<Array<string | number | null>>,
    truncated: false,
    ms: 4,
  });

  it('🔴 DuckDB で CREATE TABLE を打つと通り、件数と寿命を言う(表は出さない)', async () => {
    const { pick, pickEngine, type, runBtn, note, duckSeen, runDuckDbSql, runReadOnlySql, pane } = setup();
    runDuckDbSql.mockResolvedValueOnce(counted(3));
    pick('db4');
    await settle();
    pickEngine('duckdb');
    type('CREATE TABLE 集計 AS SELECT * FROM csv');
    runBtn.click();
    await settle();
    expect(runDuckDbSql, 'DuckDB へ渡していない').toHaveBeenCalledTimes(1);
    expect(runReadOnlySql, 'sqlite も叩いている').toHaveBeenCalledTimes(0);
    void duckSeen;
    expect(note(), '件数を言っていない').toContain('3 行に効きました');
    expect(note(), '作った表の寿命を言っていない').toContain('作った表はウィンドウを閉じると消えます');
    // 🔴 「条件に当たるものがありませんでした」と読める字を出さない
    expect(note()).not.toContain('条件に当たる');
    // 🔑 `Count` の 1 升だけの表を出さない(同じことを 2 回言わない)
    expect(pane.querySelector('[data-pkc-field="sql-table"]'), '書き込みの答えを表にしている').toBeNull();
  });

  it('🔴 件数が返らない書き込み(AS の無い CREATE TABLE)は「実行しました」', async () => {
    const { pick, pickEngine, type, runBtn, note, runDuckDbSql } = setup();
    runDuckDbSql.mockResolvedValueOnce({ columns: ['Count'], rows: [], truncated: false, ms: 1 });
    pick('db4');
    await settle();
    pickEngine('duckdb');
    type('CREATE TABLE 空 (a INT)');
    runBtn.click();
    await settle();
    expect(note()).toContain('実行しました');
    // ⚠ 0 行の答え(`SELECT` が空だったとき)の字を出さない
    expect(note()).not.toContain('0 行');
  });

  it('🔴 INSERT / UPDATE / DELETE は件数と「元の file は書き換わりません」を言う(寿命は言わない)', async () => {
    const { pick, pickEngine, type, runBtn, note, runDuckDbSql } = setup();
    pick('db4');
    await settle();
    pickEngine('duckdb');
    for (const [sql, n] of [
      ['INSERT INTO t VALUES (1)', 1],
      ["UPDATE csv SET _note = 'x'", 5],
      ['DELETE FROM csv WHERE id = 1', 0],
    ] as const) {
      runDuckDbSql.mockResolvedValueOnce(counted(n));
      type(sql);
      runBtn.click();
      await settle();
      expect(note(), sql).toContain(`${String(n)} 行に効きました`);
      expect(note(), sql).toContain('元の file は書き換わりません');
      expect(note(), `${sql}: 表を作っていないのに寿命を言っている`).not.toContain('消えます');
    }
  });

  it('🔴 書き込みの答えは、ノートへ / ファイルへ 持ち帰らせない(押せるのに何も得られない口を作らない)', async () => {
    const { pick, pickEngine, type, runBtn, saveBtn, runDuckDbSql, pane } = setup();
    pick('db4');
    await settle();
    pickEngine('duckdb');
    // 対照群:読むだけの答えは持ち帰れる
    type('FROM csv SELECT *');
    runBtn.click();
    await settle();
    expect(saveBtn.disabled, '前提:読むだけの答えなのに持ち帰れない').toBe(false);
    runDuckDbSql.mockResolvedValueOnce(counted(2));
    type('INSERT INTO t VALUES (1)');
    runBtn.click();
    await settle();
    expect(saveBtn.disabled, '書き込みの答えを持ち帰らせている').toBe(true);
    expect(pane.querySelector<HTMLButtonElement>('[data-pkc-field="sql-to-file"]')?.disabled).toBe(true);
  });

  it('🔑 書き込みの後に SELECT を打つと、表が普通に出る(note も戻る)', async () => {
    const { pick, pickEngine, type, runBtn, note, cells, runDuckDbSql } = setup();
    pick('db4');
    await settle();
    pickEngine('duckdb');
    runDuckDbSql.mockResolvedValueOnce(counted(1));
    type('CREATE TABLE t AS SELECT 1');
    runBtn.click();
    await settle();
    expect(note()).toContain('作った表はウィンドウを閉じると消えます');
    type('SELECT * FROM t');
    runBtn.click();
    await settle();
    expect(cells(), '作った表を引いた答えが出ていない').toEqual([['duck']]);
    expect(note(), '前の書き込みの知らせが残っている').not.toContain('消えます');
  });

  it('🔴 内蔵の sqlite のまま同じ字を打つと、今までどおり断る(DuckDB へも sqlite へも送らない)', async () => {
    const { pick, type, runBtn, note, runDuckDbSql, runReadOnlySql } = setup();
    // ⚠ 相手を選ばない = この PKC のノート(正本)。ここへ書く道が無いことが主張である
    for (const sql of [
      'CREATE TABLE t (a INT)',
      'INSERT INTO entries VALUES (1)',
      'UPDATE entries SET title = 1',
      'DELETE FROM entries',
      'DROP TABLE entries',
    ]) {
      type(sql);
      runBtn.click();
      await settle();
      expect(note(), `${sql}: 断り文が出ていない`).toContain('読み取り専用です');
      expect(note(), sql).toContain('ここは読むだけです');
    }
    expect(runReadOnlySql, 'sqlite へ書き込みを送っている').toHaveBeenCalledTimes(0);
    expect(runDuckDbSql, 'DuckDB へ送っている').toHaveBeenCalledTimes(0);
    void pick;
  });

  it('🔴 取り込んだ csv でも、sqlite を選んでいる間は断る(engine で門を選んでいる)', async () => {
    const { pick, type, runBtn, note, runDuckDbSql, runReadOnlySql } = setup();
    pick('db4');
    await settle();
    type('CREATE TABLE t AS SELECT * FROM csv');
    runBtn.click();
    await settle();
    expect(note()).toContain('読み取り専用です');
    expect(runReadOnlySql).toHaveBeenCalledTimes(0);
    expect(runDuckDbSql).toHaveBeenCalledTimes(0);
  });

  it('🔴 DuckDB でも、白名簿の外は断る(引きに行かない)', async () => {
    const { pick, pickEngine, type, runBtn, note, runDuckDbSql } = setup();
    pick('db4');
    await settle();
    pickEngine('duckdb');
    for (const sql of ['CREATE VIEW v AS SELECT 1', "COPY csv TO 'o.csv'", 'ALTER TABLE csv ADD COLUMN x INT']) {
      type(sql);
      runBtn.click();
      await settle();
      // 🔑 どの断り方でも、書ける形を挙げる(次に何を打てばよいかが読める)
      expect(note(), sql).toContain('CREATE TABLE / INSERT INTO / UPDATE / DELETE FROM / DROP TABLE');
      // ⚠ DuckDB では書けるので「ここは読むだけです」とは言わない
      expect(note(), sql).not.toContain('ここは読むだけです');
    }
    expect(runDuckDbSql, '断ったのに引きに行った').toHaveBeenCalledTimes(0);
  });

  it('🔴 打ち方の約束は engine で入れ替わる ── DuckDB は表を作れて寿命を言い、sqlite は読むだけのまま', async () => {
    const { pick, pickEngine, rules } = setup();
    pick('db4');
    await settle();
    // 対照群:sqlite の約束は今までどおり
    expect(rules()).toContain('読むだけ');
    pickEngine('duckdb');
    await settle();
    expect(rules(), 'DuckDB なのに「読むだけ」と言っている(嘘になる)').not.toContain('読むだけ');
    expect(rules(), '表を作れることを言っていない').toContain('CREATE TABLE');
    expect(rules(), '作った表の寿命を、打つ前に言っていない').toContain('作った表はウィンドウを閉じると消えます');
    expect(rules(), '別の file を選び直すと消えることを言っていない').toContain('別の file を選び直した');
    expect(rules(), '元の file を触らないことを言っていない').toContain('元の file は書き換わりません');
  });
});

/**
 * 🔴 **`.parquet` / `.json` を調べる相手として受ける**(#682 段④c)。
 *
 * ## user の物語(ここを見る)
 *
 * ①`.parquet` を取り込む ②「SQL で調べる」を開く ③選び所の**いちばん下**に並ぶ
 * ④選ぶと「◯◯ を調べています(表 1 個 / …)」と出る ⑤エンジンは **DuckDB** になり、
 * 「内蔵の sqlite」は薄い字 + 理由 ⑥`SELECT * FROM parquet` が引ける。
 *
 * ## ⚠ ここでいちばん大事な 1 件
 *
 * 🔴 **sqlite worker を 1 度も叩かない。** 叩けば必ず断られる(中身を解釈できない)ので、
 *   user には「開けません」としか出ない ── 型でも塞いであるが、
 *   **配線が本当にそこを通っていないこと**は、この経路でしか見えない。
 */
/**
 * 🔴 **手持ちのファイルを DuckDB で引く**(#682 段②+段④c)。
 *
 * ## ⚠ ここは「配った日から 1 度も通っていなかった」道である
 *
 * 段② で DuckDB を足したとき、相手の bytes を読む口は 2 人に増えた ──
 * **選んだ回**(`REQUEST_SQL_GUEST_OPEN`)と**走らせた回**(`DuckDbRunner.load`)。
 * 🔴 ところが手持ちのファイルの控えは「**1 回読んだら消える**」形だったので、
 * 走らせた回は**必ず `null`** を受け取っていた(実測 2026-09-16)。
 * ⚠ **unit も smoke も 1 件も落ちなかった** ── 手持ちのファイルの test は
 * 「開けたか」までしか見ておらず、DuckDB の test は**添付**しか使っていなかった。
 * 🔑 だから **2 つが交わる 1 点**をここに置く。
 */
describe('🔴 手持ちのファイルを DuckDB で引く(#682 段④c)', () => {
  it('🔴 手持ちの .csv を選んで DuckDB で走らせると、中身が読める', async () => {
    const { pickLocalFile, pickEngine, type, runBtn, duckSeen, cells, note } = setup();
    pickLocalFile(new File(['id,name\n1,a\n'], 'tegara.csv', { type: 'text/csv' }));
    await settle();
    expect(note(), '前提が崩れている(手持ちの file が開けていない)').toContain(
      'tegara.csv を調べています',
    );
    pickEngine('duckdb');
    type('FROM csv SELECT *');
    runBtn.click();
    await settle();
    expect(duckSeen, 'DuckDB へ引きに行っていない').toHaveLength(1);
    /**
     * 🔴 **ここが本題** ── 直す前はここが `null` だった(控えが 1 回で消えていた)。
     * ⚠ 「引きに行った」だけを見ると、`null` を渡して断られた回と区別が付かない。
     */
    expect(duckSeen[0]?.bytes, '控えが消えていて、走らせる回に中身を読めていない').toBeGreaterThan(
      0,
    );
    expect(cells()).toEqual([['duck']]);
  });

  /**
   * 🔴 **器を起こし直すたびに読む** ── DuckDB は畳んでから起き直すと**また読む**ので、
   *   「2 回目までは読める」形の実装でも足りない。
   * 🔑 だから **3 回**走らせて、3 回とも中身が届くことを見る。
   */
  it('🔴 同じ相手で何度走らせても、そのたびに中身を読める', async () => {
    const { pickLocalFile, pickEngine, type, runBtn, duckSeen } = setup();
    pickLocalFile(new File(['id,name\n1,a\n'], 'tegara.csv', { type: 'text/csv' }));
    await settle();
    pickEngine('duckdb');
    for (const nth of [1, 2, 3]) {
      type(`FROM csv SELECT ${String(nth)}`);
      runBtn.click();
      await settle();
    }
    expect(duckSeen).toHaveLength(3);
    for (const [i, seen] of duckSeen.entries()) {
      expect(seen.bytes, `${String(i + 1)} 回目で中身が読めていない`).toBeGreaterThan(0);
    }
  });

  /**
   * 🔴 **選び直しても、いま選んだ file が消えない**(#682 段④c で 1 度壊した)。
   *
   * ⚠ `SET_SQL_SOURCE` は「**前の相手を閉じる**」→「**新しい相手を開く**」の順に出す。
   *   控えを手放す口が lid を見ないと、**いま控えたばかりの file を消す**。
   * 🔑 手持ちの file を**続けて 2 回**選ぶ、が唯一この形を作れる場面である。
   */
  it('🔴 手持ちの file を続けて 2 回選んでも、2 つ目が読める', async () => {
    const { pickLocalFile, pickEngine, type, runBtn, duckSeen, note } = setup();
    pickLocalFile(new File(['id\n1\n'], 'ichi.csv', { type: 'text/csv' }));
    await settle();
    pickLocalFile(new File(['id,name\n2,b\n3,c\n'], 'ni.csv', { type: 'text/csv' }));
    await settle();
    expect(note(), '2 つ目が開けていない').toContain('ni.csv を調べています');
    pickEngine('duckdb');
    type('FROM csv SELECT *');
    runBtn.click();
    await settle();
    expect(duckSeen[0]?.source.name, '2 つ目を選んだのに 1 つ目を引いている').toBe('ni.csv');
    expect(
      duckSeen[0]?.bytes,
      '選び直したときに、いま控えた file まで手放している',
    ).toBeGreaterThan(0);
  });
});

describe('🔴 .parquet / .json を調べる相手として受ける(#682 段④c)', () => {
  it('🔴 選び所のいちばん下に並び、csv や xlsx より後ろに来る', async () => {
    const { sourceSel } = setup();
    await settle();
    const labels = [...sourceSel.options].map((o) => o.textContent ?? '');
    const csv = labels.indexOf('売上.csv');
    const parquet = labels.indexOf('売上.parquet');
    const ndjson = labels.indexOf('明細.ndjson');
    expect(parquet, '.parquet が選び所に並んでいない').toBeGreaterThanOrEqual(0);
    expect(ndjson, '.ndjson が選び所に並んでいない').toBeGreaterThanOrEqual(0);
    expect(parquet, '.parquet が .csv より前に出ている').toBeGreaterThan(csv);
    // ⚠ 対照群 ── 読めない添付は並ばない(白名簿の向きが崩れていない)
    expect(labels, '読めない添付まで並べている').not.toContain('ねこ.png');
  });

  it('🔴 選ぶと、sqlite worker を 1 度も叩かずに「調べています」になる', async () => {
    const { pick, note, openSqlGuest, readAssetBytes, d } = setup();
    pick('db7');
    await settle();
    expect(openSqlGuest, '内蔵の sqlite に .parquet を渡している(必ず断られる)').toHaveBeenCalledTimes(0);
    /**
     * 🔴 **中身も読まない**(#682 段④c)── 選んだだけで何十 MB も heap へ載せない
     *   (不可侵指示 2026-07-27)。読むのは「走らせる」を押したときだけである。
     */
    expect(readAssetBytes, '選んだだけで中身を読みに行っている').toHaveBeenCalledTimes(0);
    expect(note(), '開いたことが画面に出ない').toContain('売上.parquet を調べています');
    expect(note()).toContain('表 1 個');
    /**
     * 🔴 **表の名前そのものを見る**(着地前レビューの変異 2)。
     * ⚠ 帯に出るのは**個数だけ**なので、`tables: ['csv']` に潰す変異は
     *   `toContain('表 1 個')` では殺せない ── **state の値**を直に見る。
     * 🔑 この名前は `guestTableNameOf` から出ており、器が `CREATE TABLE` する名前と
     *   **同じ 1 か所**である(§7)。
     */
    expect(d.getState().sqlPage.guest?.tables, 'user が打つ表の名前が違う').toEqual(['parquet']);
    // ⚠ 大きさは**本文の `attachment.size`** から採る(中身を読まずに)
    expect(note(), '大きさが出ていない(中身を読まずに採れているか)').toContain('4.0 KB');
  });

  /**
   * 🔴 **画面の案内と手本が、そのまま打てる字である**(#682 段④c)。
   *
   * ⚠ 直す前は `sql-tip.ts` が **`csv` を直書き**していたので、`.parquet` を選ぶと
   *   **画面のいちばん近くに在る手本が、打つと英語で断られる字**だった
   *   (着地前レビューと動線レビューが独立に同じ 1 件を挙げた)。
   * 🔑 だから**画面から読んだ字**を見る ── 関数を直に呼ぶ test では、
   *   描画器が別の字を出していても気づけない。
   */
  it('🔴 画面の案内と手本が、いまの相手の表の名前で書かれている', async () => {
    const { pick, pane } = setup();
    pick('db7');
    await settle();
    const tip = pane.querySelector('[data-pkc-field="sql-tip"]')?.textContent ?? '';
    const example = pane.querySelector('[data-pkc-field="sql-example"]')?.textContent ?? '';
    expect(tip, '案内が前の相手(csv)の話をしている').toContain('写した表 parquet です');
    expect(tip, '足さない列を約束している').not.toContain('_note');
    expect(example, '手本が打てない字になっている').toContain('FROM parquet');
    /**
     * ⚠ **対照群** ── csv では今までどおり(「どの相手でも parquet」に壊れていない)。
     * 🔑 `.csv` の既定は**内蔵の sqlite** なので、DuckDB の枝を見るには**選び直す**
     *   ── 選び直さないと、比べているのは別の engine の字である。
     */
    const { pick: pick2, pane: pane2, pickEngine } = setup();
    pick2('db4');
    await settle();
    pickEngine('duckdb');
    await settle();
    expect(pane2.querySelector('[data-pkc-field="sql-example"]')?.textContent).toContain('FROM csv');
  });

  it('🔴 エンジンは DuckDB になり、内蔵の sqlite は薄い字で理由が出る', async () => {
    const { pick, engineSel } = setup();
    pick('db7');
    await settle();
    expect(engineSel.value, '.parquet なのに sqlite で引こうとしている').toBe('duckdb');
    const lite = [...engineSel.options].find((o) => o.value === 'sqlite');
    expect(lite?.disabled, '.parquet で内蔵の sqlite を選ばせている').toBe(true);
    expect(lite?.textContent, 'なぜ選べないかが書いていない').toContain('DuckDB');
    // ⚠ 対照群 ── csv では sqlite が選べる(「いつも薄い」に壊れていない)
    const { pick: pick2, engineSel: sel2 } = setup();
    pick2('db4');
    await settle();
    expect([...sel2.options].find((o) => o.value === 'sqlite')?.disabled).toBe(false);
  });

  it('🔴 走らせると、DuckDB へ kind ごと渡る(読み手を選び分けられる形)', async () => {
    const { pick, type, runBtn, runReadOnlySql, duckSeen, cells } = setup();
    pick('db7');
    await settle();
    type('SELECT * FROM parquet');
    runBtn.click();
    await settle();
    expect(duckSeen, 'DuckDB へ引きに行っていない').toHaveLength(1);
    expect(duckSeen[0]?.source, 'kind が渡っていない(読み手を選び分けられない)').toEqual({
      kind: 'parquet',
      lid: 'db7',
      name: '売上.parquet',
    });
    // 🔴 **ここで初めて中身を読む**(選んだ時点では読んでいない)
    expect(duckSeen[0]?.bytes, '相手の中身を読みに来ていない').toBeGreaterThan(0);
    expect(runReadOnlySql, '内蔵の sqlite でも引いている').toHaveBeenCalledTimes(0);
    expect(cells()).toEqual([['duck']]);
  });

  it('🔴 .ndjson は「1 行 1 件」として渡る(.json と別物)', async () => {
    const { pick, type, runBtn, duckSeen } = setup();
    pick('db8');
    await settle();
    type('SELECT * FROM json');
    runBtn.click();
    await settle();
    expect(duckSeen[0]?.source).toEqual({
      kind: 'json',
      lang: 'ndjson',
      lid: 'db8',
      name: '明細.ndjson',
    });
  });

  /**
   * 🔴 **つながり図は、`.parquet` / `.json` でも出る**(#918。🟣 Gemini 裁定 2026-10-02 = A。
   *   以前は「まだ出せません(DuckDB で引く相手です)」と断っていた)。
   * ⚠ 採るのは **DuckDB の器**(`schemaDuckDb`)で、内蔵の sqlite へは**聞きに行かない**
   *   (そこに客の DB は無い ── 聞くと「先に選んでください」と言われる)。
   * 🔴 **物語の順で押しても出る**(#682 段④c の着地前レビュー F2 の続き)── user は
   *   「相手を選ぶ → 図を開く」の順に押す。下にもう 1 本「図を先に開く」順を置く
   *   (§2「経路が一度も通っていない」)。
   */
  it('🔴 相手を選んでから図を開くと、DuckDB の器から採った図が出る(断りの字は出ない)', async () => {
    const { pick, pane, runReadOnlySql, schemaDuckDb, schemaSeen } = setup();
    pick('db7');
    await settle();
    runReadOnlySql.mockClear();
    pane.querySelector<HTMLButtonElement>('[data-pkc-field="sql-er-toggle"]')!.click();
    await settle();
    const er = pane.querySelector('[data-pkc-region="sql-er"]')?.textContent ?? '';
    expect(er, '断りの字が残っている').not.toContain('まだ出せません');
    expect(er, '選んだばかりなのに「先に選んでください」と言っている').not.toContain('先に選んで');
    expect(schemaDuckDb, 'DuckDB の器へ採りに行っていない').toHaveBeenCalledTimes(1);
    expect(schemaSeen[0]?.sources.map((x) => x.kind), '種類が渡っていない').toEqual(['parquet']);
    // 🔴 中身を読める形で頼まれている(選んだ時点では読まず、採るときに読む)
    expect(schemaSeen[0]?.bytes, '相手の中身を読めない形で頼んでいる').toEqual([4]);
    expect(runReadOnlySql, '採れるのに内蔵の sqlite へ聞きに行っている').toHaveBeenCalledTimes(0);
    // 四角(表)と線が出る ── 描くのは sqlite のときと同じ描画器
    expect(
      [...pane.querySelectorAll('[data-pkc-field="sql-er-table"]')].map((e) => e.textContent),
    ).toEqual(['客(表・2 行)', '売上(表・3 行)']);
    expect(pane.querySelectorAll('[data-pkc-field="sql-er-lines"] line').length, '線が無い').toBe(1);
  });

  /**
   * 🔴 **「構造をノートへ」も同じ道を通る**(着地前レビュー F2 の 2 つ目の続き)。
   * ⚠ この押し所は**答えが無くても押せる**ので、`.parquet` を選んだまま押せる ── 押したらノートができる。
   */
  it('🔴 「構造をノートへ」も、DuckDB の器から採ったノートを作る(断らない)', async () => {
    const { pick, pane, schemaBtn, runReadOnlySql, schemaDuckDb, persisted } = setup();
    pick('db7');
    await settle();
    runReadOnlySql.mockClear();
    schemaBtn.click();
    await settle();
    expect(pane.textContent, '断りの字が残っている').not.toContain('まだ出せません');
    expect(pane.textContent, '選んだばかりなのに「先に選んでください」と言っている').not.toContain(
      '先に選んで',
    );
    expect(schemaDuckDb, 'DuckDB の器へ採りに行っていない').toHaveBeenCalledTimes(1);
    expect(runReadOnlySql, '採れるのに内蔵の sqlite へ聞きに行っている').toHaveBeenCalledTimes(0);
    expect(persisted, 'ノートが 1 件できていない').toHaveLength(1);
    const body = persisted[0]?.body ?? '';
    expect(body, 'どこの構造かが書かれていない').toContain('# 売上.parquet の構造');
    expect(body).toContain('## 売上(表・3 行)');
    expect(body).toContain('- 売上.客id → 客.id');
    // ⚠ **押せなくなっていない**(`running` を立てたまま止めていない)
    expect(schemaBtn.disabled, '押したきり、二度と押せなくなっている').toBe(false);
  });

  /**
   * 🔴 **手持ちの `.parquet`**(着地前レビュー F6)── `sqlSourceSize` の
   *   手持ち file の枝を通る**唯一の場面**である。
   */
  it('🔴 手持ちの .parquet も、sqlite を叩かずに開ける', async () => {
    const { pickLocalFile, note, openSqlGuest, engineSel } = setup();
    pickLocalFile(new File([new Uint8Array(1234)], 'tegara.parquet'));
    await settle();
    expect(openSqlGuest, '手持ちの .parquet を内蔵の sqlite へ渡している').toHaveBeenCalledTimes(0);
    expect(note(), '開いたことが画面に出ない').toContain('tegara.parquet を調べています');
    // ⚠ 大きさは `File.size` から採る(中身は 1 バイトも読まない)
    expect(note(), '大きさが出ていない').toContain('1.2 KB');
    expect(engineSel.value, '手持ちの .parquet で sqlite を選んでいる').toBe('duckdb');
  });

  it('🔴 図を先に開いてから相手を選んでも、採れた図が出る(永久に「採っています」にしない)', async () => {
    const { pick, pane, runReadOnlySql, schemaDuckDb } = setup();
    // 図を開いてから相手を選ぶ(開いているときだけ採りに行く作り)
    pane.querySelector<HTMLButtonElement>('[data-pkc-field="sql-er-toggle"]')?.click();
    await settle();
    runReadOnlySql.mockClear();
    pick('db7');
    await settle();
    const er = pane.querySelector('[data-pkc-region="sql-er"]')?.textContent ?? '';
    expect(er, '断りの字が残っている').not.toContain('まだ出せません');
    expect(er, '採っています、のまま止まっている').not.toContain('採っています');
    expect(schemaDuckDb, 'DuckDB の器へ採りに行っていない').toHaveBeenCalledTimes(1);
    expect(runReadOnlySql, '採れるのに内蔵の sqlite へ聞きに行っている').toHaveBeenCalledTimes(0);
    expect(pane.querySelectorAll('[data-pkc-field="sql-er-table"]').length).toBe(2);
  });

  it('🔴 DuckDB の器が採れなかったら、図の所に理由が出る(「採っています」のまま止めない)', async () => {
    const { pick, pane, schemaDuckDb } = setup();
    schemaDuckDb.mockRejectedValueOnce(new Error('DuckDB の一式を取ってこられませんでした'));
    pick('db7');
    await settle();
    pane.querySelector<HTMLButtonElement>('[data-pkc-field="sql-er-toggle"]')!.click();
    await settle();
    const er = pane.querySelector('[data-pkc-region="sql-er"]')?.textContent ?? '';
    expect(er).toContain('構造を採れませんでした');
    expect(er, '落ちた理由が消えている').toContain('一式を取ってこられません');
    expect(er, '採っています、のまま止まっている').not.toContain('採っています');
  });

  it('🔴 DuckDB の口が無い版では、図の所に理由が出る(黙って空の図を出さない)', async () => {
    const { pick, pane } = setup(undefined, { withDuck: false });
    pick('db7');
    await settle();
    pane.querySelector<HTMLButtonElement>('[data-pkc-field="sql-er-toggle"]')!.click();
    await settle();
    expect(pane.querySelector('[data-pkc-region="sql-er"]')?.textContent).toContain(
      'この版では構造を採れません',
    );
  });
});

/**
 * 🔴 **#992 の 3 件**(Gemini の裁定 2026-10-01 = ①A / ③A / ④A)。
 * ⚠ 画面の見え方が変わるので、**選び所の仕切り・並び・知らせ**を DOM で見る。
 */
describe('🔴 調べる相手の選び所(#992)', () => {
  it('🔴 ③ 仕切りは「この PKC / 添付 / 手持ちの file」の順で、中の並びは今までどおり', async () => {
    const { sourceSel } = setup();
    await settle();
    const groups = [...sourceSel.querySelectorAll('optgroup')];
    expect(
      groups.map((g) => g.label),
      '仕切りの順番が違う',
    ).toEqual([SQL_SOURCE_GROUP_PKC, SQL_SOURCE_GROUP_ATTACHED, SQL_SOURCE_GROUP_LOCAL]);
    const inside = (label: string): string[] =>
      [...(groups.find((g) => g.label === label)?.querySelectorAll('option') ?? [])].map(
        (o) => o.textContent ?? '',
      );
    expect(inside(SQL_SOURCE_GROUP_PKC)).toEqual(['この PKC のノート']);
    // 🔑 添付の中の並びは**仕切りを足す前と同じ**(.sqlite → .csv/.tsv → .parquet/.ndjson)
    const attached = inside(SQL_SOURCE_GROUP_ATTACHED);
    expect(attached.indexOf('売上.csv'), '.csv が .sqlite より前').toBeGreaterThan(attached.indexOf('売上.sqlite'));
    expect(attached.indexOf('売上.parquet'), '.parquet が .csv より前').toBeGreaterThan(attached.indexOf('売上.csv'));
    // ⚠ 対照群 ── 読めない添付は並ばない
    expect(attached).not.toContain('ねこ.png');
    expect(inside(SQL_SOURCE_GROUP_LOCAL)).toEqual(['手持ちのファイルを開く…']);
    // ⚠ 選べる物は仕切りの外に 1 つも無い(平らな option が残っていない)
    expect(
      [...sourceSel.children].every((c) => c.tagName === 'OPTGROUP'),
      '仕切りの外に選べる物が残っている',
    ).toBe(true);
  });

  it('🔴 ③ 添付が 1 つも無いときは「添付」の仕切りを出さない(空の仕切りを作らない)', async () => {
    const { d, sourceSel } = setup();
    await settle();
    expect(sourceSel.querySelector('optgroup[label="添付"]'), '前提 ── 添付が在るときは出る').not.toBeNull();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', '会議メモ')], relations: [] });
    await settle();
    const labels = [...sourceSel.querySelectorAll('optgroup')].map((g) => g.label);
    expect(labels, '空の仕切りが出ている').toEqual([SQL_SOURCE_GROUP_PKC, SQL_SOURCE_GROUP_LOCAL]);
  });

  it('🔴 ③ 手持ちの file を開いている間は、その file が「手持ちの file」の仕切りに並ぶ', async () => {
    const { sourceSel, pickLocalFile } = setup();
    pickLocalFile(new File([new Uint8Array(1200)], 'tegara.parquet'));
    await settle();
    const local = sourceSel.querySelector(`optgroup[label="${SQL_SOURCE_GROUP_LOCAL}"]`)!;
    expect(
      [...local.querySelectorAll('option')].map((o) => o.textContent),
      '開いた file が手持ちの仕切りに無い',
    ).toEqual(['tegara.parquet', '手持ちのファイルを開く…']);
    // ⚠ 選び所は開いた file を指したまま(「この PKC」へ戻していない)
    expect(sourceSel.selectedOptions[0]?.textContent).toBe('tegara.parquet');
  });

  it('🔴 ④ 帯の先頭に「調べる相手」と「どのエンジンで引くか」が在り、押し所はその後ろに並ぶ', () => {
    const { pane } = setup();
    const bar = pane.querySelector('[data-pkc-field="sql-bar"]')!;
    const fields = [...bar.children].map((c) => c.getAttribute('data-pkc-field'));
    expect(fields.slice(0, 3), '選び所が先頭にない').toEqual(['sql-source', 'sql-engine', 'sql-run']);
    // ⚠ 並びだけを動かした ── 帯の部品は 1 つも増えても減ってもいない
    expect([...fields].sort()).toEqual(
      [
        'sql-engine',
        'sql-er-toggle',
        'sql-file-input',
        'sql-history',
        'sql-run',
        'sql-schema-to-note',
        'sql-source',
        'sql-to-file',
        'sql-to-note',
      ].sort(),
    );
  });

  it('🔴 ① .parquet を選んだ直後に、電波が要ることを 1 文で言う(走らせる前)', async () => {
    const { pick, said, runDuckDbSql } = setup();
    pick('db7');
    await settle();
    expect(said, '選んだ直後に知らせていない').toEqual([DUCKDB_NETWORK_NOTE]);
    expect(runDuckDbSql, '知らせるために走らせてはいけない').toHaveBeenCalledTimes(0);
  });

  it('🔴 ① .ndjson も同じ ── DuckDB でしか読めない相手は全部言う', async () => {
    const { pick, said } = setup();
    pick('db8');
    await settle();
    expect(said).toEqual([DUCKDB_NETWORK_NOTE]);
  });

  it('🔴 ① 手持ちの .parquet を選んだ直後にも言う(添付と同じ知らせ)', async () => {
    const { pickLocalFile, said } = setup();
    pickLocalFile(new File([new Uint8Array(1200)], 'tegara.parquet'));
    await settle();
    expect(said).toEqual([DUCKDB_NETWORK_NOTE]);
  });

  it('🔴 ① 対照群:.csv / .sqlite / この PKC に戻るときは言わない(内蔵の sqlite で引ける)', async () => {
    const { pick, said, pickLocalFile } = setup();
    pick('db4');
    await settle();
    pick('db1');
    await settle();
    pick('');
    await settle();
    pickLocalFile(new File([new Uint8Array(10)], 'tegara.csv'));
    await settle();
    expect(said, '電波が要らない相手にまで知らせている').toEqual([]);
  });
});

/**
 * 🔴 **複数の file を並べて、1 つの SQL で引く**(#918 段⑦。Gemini 裁定 2026-10-01)。
 *
 * ## user の物語(ここを見る)
 *
 * ①取り込んだ `売上.csv` を選ぶ ②調べる相手の一覧の**末尾**「もう 1 つ足す…」から
 * 添付か手持ちの file を足す ③案内が「いま調べているのは 売上 / … の N つの表です」と言い直す
 * ④走らせると**全部の file が器へ届く** ⑤足した相手の **×** で外せる(片道にしない)
 * ⑥足す / 外す / 選び直すと、**作った表は消える**と字で言っている(確認は出さない)。
 *
 * ⚠ ここが見るのは**画面と配線**(控えの手放しも含む)。名前の規則は
 * `tests/features/sql-multi-source.test.ts`、器は `tests/adapter/duckdb-runner-multi.test.ts`、
 * 実物の engine で JOIN できることは `tests/duckdb-write.test.ts` が見る。
 */
describe('🔴 複数の file を並べて引く(#918 段⑦)', () => {
  const groups = (sel: HTMLSelectElement): string[] =>
    [...sel.querySelectorAll('optgroup')].map((g) => g.label);
  const optionValues = (sel: HTMLSelectElement): string[] =>
    [...sel.querySelectorAll('option')].map((o) => o.value);
  const chips = (pane: HTMLElement): string[] =>
    [...pane.querySelectorAll('[data-pkc-field="sql-extra"]')].map(
      (e) => e.querySelector('[data-pkc-field="sql-extra-name"]')?.textContent ?? '',
    );
  const dropBtn = (pane: HTMLElement, lid: string): HTMLButtonElement | null =>
    pane.querySelector<HTMLButtonElement>(`[data-pkc-action="remove-sql-source"][data-pkc-sql-source="${lid}"]`);
  const extrasHost = (pane: HTMLElement): HTMLElement =>
    pane.querySelector<HTMLElement>('[data-pkc-field="sql-extras"]')!;

  /** 「もう 1 つ足す…」から添付を足す。 */
  const addAttached = (s: ReturnType<typeof setup>, lid: string): void => {
    s.sourceSel.selectedIndex = [...s.sourceSel.options].findIndex((o) => o.value === `add:${lid}`);
    s.sourceSel.dispatchEvent(new Event('change', { bubbles: true }));
  };
  /** 「手持ちのファイルを足す…」→ file を選ぶ(実機の 2 段と同じ)。 */
  const addLocal = (s: ReturnType<typeof setup>, file: File): void => {
    s.sourceSel.selectedIndex = [...s.sourceSel.options].findIndex((o) => o.value === SQL_ADD_LOCAL_FILE_VALUE);
    s.sourceSel.dispatchEvent(new Event('change', { bubbles: true }));
    Object.defineProperty(s.fileInput, 'files', { value: [file], configurable: true });
    s.fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  };
  /** 足せなかった / 外した / 選び直したときに出る「手放して」の合図を控える。 */
  const releases = (d: Dispatcher): string[][] => {
    const seen: string[][] = [];
    d.onEvent((e) => {
      if (e.type === 'REQUEST_SQL_EXTRA_RELEASE') seen.push([...e.lids]);
    });
    return seen;
  };

  it('🔴 足す口は一覧の末尾。1 件目が DuckDB で読める相手のときだけ出る(出せない形では出さない)', async () => {
    const s = setup();
    // 何も選んでいない(この PKC のノート)/ .xlsx を選んでいる ── 足す口は無い
    expect(groups(s.sourceSel), 'ノートを調べているのに足す口が出ている').not.toContain(SQL_SOURCE_GROUP_ADD);
    s.pickLocalFile(new File([new Uint8Array(8)], '台帳.xlsx'));
    await settle();
    expect(groups(s.sourceSel), '.xlsx を調べているのに足す口が出ている').not.toContain(SQL_SOURCE_GROUP_ADD);
    expect(optionValues(s.sourceSel).some((v) => v.startsWith('add:') || v === SQL_ADD_LOCAL_FILE_VALUE)).toBe(false);
    // 🟢 .sqlite を調べているときは出る(#682 段④d ── 以前は出さなかった)
    s.pick('db1');
    await settle();
    expect(groups(s.sourceSel), '.sqlite を調べているのに足す口が出ない').toContain(SQL_SOURCE_GROUP_ADD);
    // csv を選ぶと出る ── そして**末尾**
    s.pick('db4');
    await settle();
    const gs = groups(s.sourceSel);
    expect(gs[gs.length - 1], '足す口が一覧の末尾に無い').toBe(SQL_SOURCE_GROUP_ADD);
    const vals = optionValues(s.sourceSel);
    expect(vals).toContain('add:db7');
    expect(vals).toContain('add:db8');
    expect(vals).toContain(SQL_ADD_LOCAL_FILE_VALUE);
    // 自分自身は足せない相手に並ばない
    expect(vals).not.toContain('add:db4');
    // 🟢 .sqlite も足せる(#682 段④d)── 薄い字ではなく、理由の字も付かない
    const sqliteOpt = s.sourceSel.querySelector<HTMLOptionElement>('option[value="add:db1"]');
    expect(sqliteOpt, '.sqlite の添付が足す口に無い').not.toBeNull();
    expect(sqliteOpt?.disabled, '.sqlite が足せない扱いのまま').toBe(false);
    expect(sqliteOpt?.textContent).not.toContain('DuckDB では読めない');
    // 選び所は 1 件目を指したまま
    expect(s.sourceSel.value).toBe('db4');
  });

  it('🔴 添付を足す:相手が 2 つになり、案内が名前を並べ、DuckDB 固定になり、走らせると全部が器へ届く', async () => {
    const s = setup();
    s.pick('db4'); // 売上.csv
    await settle();
    // 足す前:今までどおり(内蔵の sqlite で、表は csv)
    expect(s.tipText()).toContain('この file に在る表: csv');
    expect(extrasHost(s.pane).hidden, '足していないのに行が出ている').toBe(true);
    s.runDuckDbSql.mockClear();
    addAttached(s, 'db7'); // 売上.parquet(同じ stem)
    await settle();
    expect(s.sourceSel.value, '足したら選び所が 1 件目から動いた').toBe('db4');
    expect(chips(s.pane)).toEqual(['売上.parquet(表 売上_2)']);
    expect(extrasHost(s.pane).hidden).toBe(false);
    // 🔴 案内:裁定の字(名前を並べる)+ 同名は _2
    expect(s.tipText()).toContain('いま調べているのは 売上 / 売上_2 の 2 つの表です');
    expect(s.tipText(), '足したのに 1 件のときの表の名前 csv を言っている').not.toContain('在る表: csv');
    // 🔴 engine は DuckDB 固定(sqlite を選んでいた人も)
    expect(s.engineSel.value).toBe('duckdb');
    expect(s.engineSel.querySelector<HTMLOptionElement>('option[value="sqlite"]')?.disabled).toBe(true);
    expect(s.engineSel.querySelector<HTMLOptionElement>('option[value="sqlite"]')?.textContent).toContain('DuckDB だけ');
    // 走らせる:全部の相手が 1 本の呼び出しで届く(sqlite へは行かない)
    s.type('FROM 売上 SELECT 1');
    s.runBtn.click();
    await settle();
    expect(s.runReadOnlySql, 'sqlite へ飛んでいる').toHaveBeenCalledTimes(0);
    expect(s.runDuckDbSql).toHaveBeenCalledTimes(1);
    const seen = s.duckSeen[s.duckSeen.length - 1]!;
    expect(seen.all.map((x) => x.name)).toEqual(['売上.csv', '売上.parquet']);
    expect(seen.all.map((x) => x.kind)).toEqual(['csv', 'parquet']);
    expect(seen.allBytes, '足した相手の中身が読めていない').toEqual([4, 4]);
    // 足した相手は、足した一覧から外れる(もう並べてある)
    expect(optionValues(s.sourceSel)).not.toContain('add:db7');
  });

  it('🔴 1 件のときの呼び出しは今までどおり(相手は 1 つだけ)── 足さない人の画面は動かない', async () => {
    const s = setup();
    s.pick('db4');
    await settle();
    s.pickEngine('duckdb');
    s.type('FROM csv SELECT 1');
    s.runBtn.click();
    await settle();
    expect(s.duckSeen[0]?.all.map((x) => x.name)).toEqual(['売上.csv']);
  });

  it('🔴 ×で外せる(片道にしない)── 外すと 1 件のときの案内・engine の選び所・呼び出しへ戻る', async () => {
    const s = setup();
    s.pick('db4');
    await settle();
    addAttached(s, 'db7');
    await settle();
    const drop = dropBtn(s.pane, 'db7');
    expect(drop, '足した相手に × が無い').not.toBeNull();
    expect(drop?.textContent).toBe('×');
    drop!.click();
    await settle();
    expect(chips(s.pane)).toEqual([]);
    expect(extrasHost(s.pane).hidden, '外したのに行が残っている').toBe(true);
    expect(s.tipText(), '外したのに案内が 1 件のときへ戻らない').toContain('この file に在る表: csv');
    expect(s.engineSel.querySelector<HTMLOptionElement>('option[value="sqlite"]')?.disabled, 'sqlite を選べないまま').toBe(false);
    // 外した相手は、また足せる側へ戻る
    expect(optionValues(s.sourceSel)).toContain('add:db7');
    s.pickEngine('duckdb');
    s.type('FROM csv SELECT 1');
    s.runBtn.click();
    await settle();
    expect(s.duckSeen[s.duckSeen.length - 1]?.all.map((x) => x.name)).toEqual(['売上.csv']);
  });

  it('🔴 足す / 外すと、出ていた答えは消える(別の file の組の話になる)', async () => {
    const s = setup();
    s.pick('db4');
    await settle();
    s.pickEngine('duckdb');
    s.type('FROM csv SELECT 1');
    s.runBtn.click();
    await settle();
    expect(s.cells().length, '前提:答えが出ていない').toBeGreaterThan(0);
    addAttached(s, 'db7');
    await settle();
    expect(s.cells(), '足したのに前の組の答えが残っている').toEqual([]);
    s.type('FROM 売上 SELECT 1');
    s.runBtn.click();
    await settle();
    expect(s.cells().length).toBeGreaterThan(0);
    dropBtn(s.pane, 'db7')!.click();
    await settle();
    expect(s.cells(), '外したのに前の組の答えが残っている').toEqual([]);
  });

  it('🔴 走っている最中に足したら、遅れて届いた前の組の答えは捨てる', async () => {
    const s = setup();
    s.pick('db4');
    await settle();
    s.pickEngine('duckdb');
    let finish: (() => void) | null = null;
    s.runDuckDbSql.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ columns: ['old'], rows: [['前の組']], truncated: false, ms: 1 });
        }),
    );
    s.type('FROM csv SELECT 1');
    s.runBtn.click();
    await settle();
    addAttached(s, 'db7');
    await settle();
    (finish as (() => void) | null)?.();
    await settle();
    expect(s.cells(), '足した後に、前の組の答えを受けている').toEqual([]);
    expect(s.runBtn.disabled, '「走らせています…」のまま止まっている').toBe(false);
  });

  it('🔴 上限 4:4 つ並んだら足す口が消え、理由を言う。5 つ目は断りの字(黙って足さない)', async () => {
    const s = setup();
    s.pick('db4');
    await settle();
    for (const lid of ['db5', 'db6', 'db7']) {
      addAttached(s, lid);
      await settle();
    }
    expect(chips(s.pane)).toHaveLength(3);
    expect(groups(s.sourceSel), '上限なのに足す口が出ている').not.toContain(SQL_SOURCE_GROUP_ADD);
    expect(extrasHost(s.pane).textContent).toContain('4 つまで');
    s.d.dispatch({ type: 'ADD_SQL_SOURCE', lid: 'db8', name: '明細.ndjson' });
    await settle();
    expect(chips(s.pane), '5 つ目が足せてしまっている').toHaveLength(3);
    expect(s.note()).toContain('4 つまで');
    // 外すと、また足せる
    dropBtn(s.pane, 'db6')!.click();
    await settle();
    expect(groups(s.sourceSel)).toContain(SQL_SOURCE_GROUP_ADD);
  });

  it('🔴 .xlsx は 2 件目として足せない(理由を 1 行)── 足した扱いにならず、控えも手放す', async () => {
    const s = setup();
    const seen = releases(s.d);
    s.pick('db4');
    await settle();
    // 手持ちの .xlsx を足そうとする(選び所では薄い字だが、file 選択画面は何でも選べる)
    addLocal(s, new File([new Uint8Array(8)], '帳簿.xlsx'));
    await settle();
    expect(chips(s.pane), '.xlsx が足せてしまっている').toEqual([]);
    expect(s.note()).toContain('帳簿.xlsx は DuckDB で読めないので足せません');
    expect(s.engineSel.value, '足せていないのに engine が動いた').toBe('sqlite');
    // 🔴 断った file の控えは手放す(File を握ったまま残さない)
    expect(seen).toHaveLength(1);
    expect(await readSqlLocalFileBytes(seen[0]![0]!), '断った file の控えが残っている').toBeNull();
  });

  /**
   * 🔴 **`.sqlite` は 2 件目として足せる**(#682 段④d)。表は「ファイル名_表名」と**形**で言う ──
   *   中に何枚在るかは走らせるまで分からない(足した側は選んだだけでは読まない)。
   */
  it('🔴 .sqlite を足す:足せて、案内は表の数を言わずに「ファイル名_表の名前」の形で言う', async () => {
    const s = setup();
    s.pick('db4'); // 売上.csv
    await settle();
    addLocal(s, new File([new Uint8Array(8)], '別.sqlite'));
    await settle();
    // 🔴 実名のように読める「別_表の名前」を出さない(#682 段④d の着地後レビュー D4)── 形だけを言う
    expect(chips(s.pane), '.sqlite が足せていない').toEqual(['別.sqlite(表は ファイル名_表名 の形)']);
    expect(s.engineSel.value, '並べたら DuckDB 固定').toBe('duckdb');
    // 🔴 「2 つの表です」「(表 2 個)」と数えない(.sqlite は中の表の数だけ在る)
    expect(s.tipText()).not.toContain('2 つの表');
    expect(s.tipText(), '足した .sqlite の表の名前を実名のように出している').not.toContain('別_表の名前');
    expect(s.tipText()).toContain('別.sqlite → ファイル名_表名 の形');
    expect(s.note()).not.toContain('表 2 個');
    expect(s.note()).toContain('売上.csv / 別.sqlite を並べて調べています');
    // 走らせると、足した .sqlite も器へ届く(種類つきで)
    s.type('FROM 売上 SELECT *');
    s.runBtn.click();
    await settle();
    const last = s.duckSeen[s.duckSeen.length - 1];
    expect(last?.all.map((x) => x.kind)).toEqual(['csv', 'sqlite']);
    expect(last?.allBytes).toEqual([4, 8]);
  });

  it('🔴 手持ちの file を足す:2 件目を足しても 1 件目が読める / 外すとその控えだけ手放す', async () => {
    const s = setup();
    const seen = releases(s.d);
    s.pickLocalFile(new File([new Uint8Array(10)], 'ほか.csv'));
    await settle();
    addLocal(s, new File([new Uint8Array(20)], '在庫.parquet'));
    await settle();
    addLocal(s, new File([new Uint8Array(30)], '客.json'));
    await settle();
    expect(chips(s.pane)).toEqual(['在庫.parquet(表 在庫)', '客.json(表 客)']);
    expect(s.tipText()).toContain('いま調べているのは ほか / 在庫 / 客 の 3 つの表です');
    s.type('FROM ほか SELECT 1');
    s.runBtn.click();
    await settle();
    // 🔴 3 つとも読めている(1 件目が、足した 2 件に消されていない)
    expect(s.duckSeen[s.duckSeen.length - 1]?.allBytes).toEqual([10, 20, 30]);
    // 外す → その 1 件の控えだけ手放す
    dropBtn(s.pane, s.d.getState().sqlPage.extraGuests[0]!.lid)!.click();
    await settle();
    expect(seen).toHaveLength(1);
    expect(await readSqlLocalFileBytes(seen[0]![0]!), '外した file の控えが残っている').toBeNull();
    s.type('FROM ほか SELECT 2');
    s.runBtn.click();
    await settle();
    expect(s.duckSeen[s.duckSeen.length - 1]?.allBytes, '外していない file が読めなくなった').toEqual([10, 30]);
  });

  it('🔴 1 件目を選び直すと、足した相手は全部外れ、手持ちの file の控えも全部手放す', async () => {
    const s = setup();
    const seen = releases(s.d);
    s.pick('db4');
    await settle();
    addLocal(s, new File([new Uint8Array(20)], '在庫.parquet'));
    await settle();
    addAttached(s, 'db7');
    await settle();
    const lids = s.d.getState().sqlPage.extraGuests.map((g) => g.lid);
    expect(lids).toHaveLength(2);
    s.pick('db6'); // 1 件目を選び直す
    await settle();
    expect(s.d.getState().sqlPage.extraGuests, '選び直したのに足した相手が残っている').toEqual([]);
    expect(extrasHost(s.pane).hidden).toBe(true);
    expect(seen.flat(), '足した相手の控えを手放していない').toEqual(expect.arrayContaining(lids));
    expect(await readSqlLocalFileBytes(lids[0]!), '手持ちの file の控えが残っている').toBeNull();
  });

  it('🔴 消える扱い(設問 2 = B):確認は出さず、字で言う(通った直後の 1 行と案内文)', async () => {
    const s = setup();
    s.pick('db4');
    await settle();
    addAttached(s, 'db7');
    await settle();
    // 確認の窓は出ない(足したその場で反映される)
    expect(chips(s.pane)).toHaveLength(1);
    expect(document.querySelector('dialog[open]'), '確認の窓が出ている').toBeNull();
    // 打つ前の約束に書いてある
    expect(s.rules()).toContain('足したり外したりすると、作った表は消えます');
    // 表を作った直後の 1 行にも出る
    s.runDuckDbSql.mockResolvedValueOnce({ columns: ['Count'], rows: [[2]], truncated: false, ms: 3 });
    s.type('CREATE TABLE t AS SELECT 1');
    s.runBtn.click();
    await settle();
    expect(s.note()).toContain('作った表はウィンドウを閉じると消えます');
    expect(s.note()).toContain('足したり外したりすると、作った表は消えます');
  });

  it('🔴 2 件以上のとき、構造をノートへ / つながり図は、並べた全部を DuckDB の器から採る(断らない)', async () => {
    const s = setup();
    s.pick('db4');
    await settle();
    addAttached(s, 'db7');
    await settle();
    s.runReadOnlySql.mockClear();
    s.schemaBtn.click();
    await settle();
    expect(s.note(), '断りの字が残っている').not.toContain('まだ出せません');
    expect(s.runReadOnlySql, '2 件以上なのに sqlite へ頼んでいる').toHaveBeenCalledTimes(0);
    // 🔴 並べた全部(1 件目 + 足した相手)が、並べた順で器へ渡る
    expect(s.schemaSeen[0]?.sources.map((x) => x.kind)).toEqual(['csv', 'parquet']);
    expect(s.persisted, '構造のノートが 1 件できていない').toHaveLength(1);
    // 🔑 題名・見出しに並べた全部の名前が出る(1 件目だけだと、足した相手の構造が読めない)
    expect(s.persisted[0]?.body).toContain('# 売上.csv + 売上.parquet の構造');
    // 図を開く
    s.pane.querySelector<HTMLButtonElement>('[data-pkc-field="sql-er-toggle"]')!.click();
    await settle();
    expect(s.pane.querySelector('[data-pkc-region="sql-er"]')?.textContent).not.toContain('まだ出せません');
    expect(s.pane.querySelectorAll('[data-pkc-field="sql-er-table"]').length, '四角が出ていない').toBe(2);
  });

  /**
   * 🔴 **足した / 外したら、図は採り直す**(名札は同じ lid でも、組が変われば別の図)。
   * ⚠ 採り直さないと「1 件目だけの図」が「2 件の図」として残る(名札は新しいのに中身は前の組)。
   */
  it('🔴 図を開いたまま相手を足す / 外すと、その組の構造を採り直す', async () => {
    const s = setup();
    s.pick('db4');
    await settle();
    s.pane.querySelector<HTMLButtonElement>('[data-pkc-field="sql-er-toggle"]')!.click();
    await settle();
    expect(s.schemaDuckDb, '1 件のとき(.csv)は内蔵の sqlite で採る(今までどおり)').toHaveBeenCalledTimes(0);
    addAttached(s, 'db7');
    await settle();
    expect(s.schemaDuckDb, '足したのに採り直していない').toHaveBeenCalledTimes(1);
    expect(s.schemaSeen[0]?.sources.map((x) => x.kind)).toEqual(['csv', 'parquet']);
    dropBtn(s.pane, 'db7')!.click();
    await settle();
    // 1 件へ戻ったら内蔵の sqlite へ戻る(DuckDB は呼ばれない)
    expect(s.schemaDuckDb, '外したのに DuckDB へ採りに行っている').toHaveBeenCalledTimes(1);
  });

  it('🔴 足した相手の名前(日本語)が、× の読み上げ名と答えの上の行に出る(画面と実体が同じ名前)', async () => {
    const s = setup();
    s.pick('db4');
    await settle();
    addAttached(s, 'db8');
    await settle();
    expect(dropBtn(s.pane, 'db8')?.getAttribute('aria-label')).toBe('明細.ndjson を外す');
    expect(s.note()).toContain('売上.csv / 明細.ndjson を並べて調べています(表 2 個)');
  });

  it('電波が要る相手(parquet / json)を足したら、足した直後に言う(選んだ道と同じ知らせ)', async () => {
    const s = setup();
    s.pick('db4');
    await settle();
    expect(s.said).toEqual([]);
    addAttached(s, 'db7');
    await settle();
    expect(s.said).toEqual([DUCKDB_NETWORK_NOTE]);
  });
});

/**
 * 🔴 **着地後レビューで出た直し**(#682 段④d / #918)── 画面に届くところ。
 *
 * - R1:DuckDB で表を作った / 消した後、つながり図が古いまま(押すと `no such table`)
 * - D3 / D6 / D7:写せなかった表・ビューと全列を文字で写した表を、帯・構造ノート・つながり図で言う
 * - D1:DuckDB へ写している間の進捗の字
 * - D8:つながり図の主語(「この DB」/「この file」/「これらの file」)
 */
describe('🔴 DuckDB で書いた後のつながり図(R1)', () => {
  const counted = (n: number) => ({
    columns: ['Count'],
    rows: [[n]] as Array<Array<string | number | null>>,
    truncated: false,
    ms: 4,
  });
  const addAttached = (s: ReturnType<typeof setup>, lid: string): void => {
    s.sourceSel.selectedIndex = [...s.sourceSel.options].findIndex((o) => o.value === `add:${lid}`);
    s.sourceSel.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const erToggle = (pane: HTMLElement): HTMLButtonElement =>
    pane.querySelector<HTMLButtonElement>('[data-pkc-field="sql-er-toggle"]')!;
  const write = async (s: ReturnType<typeof setup>, sql: string): Promise<void> => {
    s.runDuckDbSql.mockResolvedValueOnce(counted(0));
    s.type(sql);
    s.runBtn.click();
    await settle();
  };

  it('🔴 図を開いたまま DuckDB で表を作ると、構造を採り直す(古い図のまま「作った表」が出ない)', async () => {
    const s = setup();
    s.pick('db4'); // 売上.csv
    await settle();
    addAttached(s, 'db7'); // + 売上.parquet → DuckDB の器から採る相手
    await settle();
    erToggle(s.pane).click();
    await settle();
    expect(s.schemaDuckDb, '前提:図は DuckDB の器から採っている').toHaveBeenCalledTimes(1);
    const before = s.d.getState().sqlPage.er;
    await write(s, 'CREATE TABLE 新 AS SELECT 1');
    expect(s.schemaDuckDb, '書いたのに、図を採り直していない').toHaveBeenCalledTimes(2);
    // 🔴 札を進めて古い模型を捨てている(捨てないと、採り直した答えは札違いで受け取られず、古い図が残る)
    const after = s.d.getState().sqlPage.er;
    expect(after.token, '札を進めていない').toBe(before.token + 1);
    expect(after.model, '採り直した新しい模型が入っていない').not.toBe(before.model);
    expect(after.model, '採り直した答えが届いていない').not.toBeNull();
    // 採り直した後の図が出ている(「採っています」のまま止まらない)
    const er = s.pane.querySelector('[data-pkc-region="sql-er"]')?.textContent ?? '';
    expect(er, '採っています、のまま止まっている').not.toContain('採っています');
    expect(s.pane.querySelectorAll('[data-pkc-field="sql-er-table"]').length).toBe(2);
  });

  it('🔴 DROP / INSERT でも採り直す(書き込みの種類は字の門 `duckDbWriteKind` と同じ 1 本で見る。INSERT は行数が古くなる)', async () => {
    const s = setup();
    s.pick('db4');
    await settle();
    addAttached(s, 'db7');
    await settle();
    erToggle(s.pane).click();
    await settle();
    await write(s, 'DROP TABLE 新');
    expect(s.schemaDuckDb).toHaveBeenCalledTimes(2);
    await write(s, 'INSERT INTO 新 VALUES (1)');
    expect(s.schemaDuckDb, '行を足したのに、四角の行数が古いまま').toHaveBeenCalledTimes(3);
  });

  it('対照群:読むだけの文では採り直さない(打鍵のたびに器を舐めない)', async () => {
    const s = setup();
    s.pick('db4');
    await settle();
    addAttached(s, 'db7');
    await settle();
    erToggle(s.pane).click();
    await settle();
    s.type('SELECT 1');
    s.runBtn.click();
    await settle();
    expect(s.schemaDuckDb, '読むだけの文で図を採り直している').toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 **時計で器が畳まれた回も、開いたままの図を採り直す**(着地後レビュー 💭10)。
   * ⚠ 30 秒の門・写す所の 120 秒の門が鳴ると器は畳まれ、写した表も作った表も消える ── 直す前は
   *   図に**もう無い表の四角が残り**、押すと `no such table` だった(R1 と同じ症状の、失敗の側)。
   */
  describe('時計で畳まれた回(💭10)', () => {
    const open = async (): Promise<ReturnType<typeof setup>> => {
      const s = setup();
      s.pick('db4');
      await settle();
      addAttached(s, 'db7');
      await settle();
      erToggle(s.pane).click();
      await settle();
      expect(s.schemaDuckDb, '前提:図は DuckDB の器から採っている').toHaveBeenCalledTimes(1);
      return s;
    };
    const failWith = async (s: ReturnType<typeof setup>, msg: string): Promise<void> => {
      s.runDuckDbSql.mockRejectedValueOnce(new Error(msg));
      s.type('SELECT 1');
      s.runBtn.click();
      await settle();
    };

    it.each([
      ['打つ文が 30 秒の門に掛かった', DUCKDB_TOO_LONG],
      ['器へ写す所が 120 秒の門に掛かった', DUCKDB_LOAD_TOO_LONG],
      ['断りの後ろに「写せなかった表」の理由が付いた', `${DUCKDB_TOO_LONG} ── 大きい は DuckDB へ写せませんでした(x)`],
    ])('🔴 %s → 図を採り直す(札を進め、古い模型を捨てる)', async (_name, msg) => {
      const s = await open();
      const before = s.d.getState().sqlPage.er;
      await failWith(s, msg);
      expect(s.d.getState().sqlPage.error, '前提:失敗が画面に出ている').toContain(msg);
      expect(s.schemaDuckDb, '器が畳まれたのに、図を採り直していない').toHaveBeenCalledTimes(2);
      expect(s.d.getState().sqlPage.er.token, '札を進めていない').toBe(before.token + 1);
      expect(s.pane.querySelectorAll('[data-pkc-field="sql-er-table"]').length, '採り直した図が出ていない').toBe(2);
    });

    it('対照群:器が畳まれていない失敗(字の誤り・表が無い)では採り直さない', async () => {
      const s = await open();
      await failWith(s, 'Catalog Error: Table with name x does not exist!');
      expect(s.schemaDuckDb, '畳まれていないのに図を採り直している').toHaveBeenCalledTimes(1);
    });

    it('対照群:閉じている図は採り直さない(開くとき採る)/ 内蔵の sqlite から採る図は触らない', async () => {
      const s = await open();
      erToggle(s.pane).click(); // 畳む
      await failWith(s, DUCKDB_TOO_LONG);
      expect(s.schemaDuckDb, '閉じている間は採りに行かない').toHaveBeenCalledTimes(1);
      // 1 件の .csv の図は内蔵の sqlite から採る ── DuckDB の器とは関係が無い
      const t = setup();
      t.pick('db4');
      await settle();
      t.pickEngine('duckdb');
      erToggle(t.pane).click();
      await settle();
      t.runReadOnlySql.mockClear();
      await failWith(t, DUCKDB_TOO_LONG);
      expect(t.schemaDuckDb, 'sqlite から採る図なのに DuckDB へ採りに行っている').toHaveBeenCalledTimes(0);
      expect(t.runReadOnlySql, 'sqlite の図まで採り直している').toHaveBeenCalledTimes(0);
    });
  });

  it('🔴 閉じているうちに書いたら、開いたときに採り直す(古い物を使い回さない)', async () => {
    const s = setup();
    s.pick('db4');
    await settle();
    addAttached(s, 'db7');
    await settle();
    erToggle(s.pane).click();
    await settle();
    erToggle(s.pane).click(); // 畳む(採った構造は残っている)
    expect(s.schemaDuckDb).toHaveBeenCalledTimes(1);
    await write(s, 'CREATE TABLE 新 AS SELECT 1');
    expect(s.schemaDuckDb, '閉じている間は採りに行かない').toHaveBeenCalledTimes(1);
    erToggle(s.pane).click(); // 開く
    await settle();
    expect(s.schemaDuckDb, '書いた後に開いたのに、前の構造を使い回している').toHaveBeenCalledTimes(2);
  });

  it('🔴 自分で引いた線は残し、押しかけの「ここから」は捨てる(同じ相手のまま構造だけが変わった)', async () => {
    const s = setup();
    s.pick('db4');
    await settle();
    addAttached(s, 'db7');
    await settle();
    erToggle(s.pane).click();
    await settle();
    s.d.dispatch({ type: 'SQL_ER_CONNECT_TOGGLE' });
    s.d.dispatch({ type: 'SQL_ER_PICK', table: '客', column: 'id' });
    s.d.dispatch({ type: 'SQL_ER_PICK', table: '売上', column: 'id' });
    s.d.dispatch({ type: 'SQL_ER_PICK', table: '客', column: '名前' });
    expect(s.d.getState().sqlPage.er.mine, '前提:自分の線が 1 本引けている').toHaveLength(1);
    expect(s.d.getState().sqlPage.er.pendingFrom, '前提:押しかけの列がある').not.toBeNull();
    await write(s, 'CREATE TABLE 新 AS SELECT 1');
    const er = s.d.getState().sqlPage.er;
    expect(er.mine, 'user が引いた線まで消えている').toHaveLength(1);
    expect(er.pendingFrom, 'もう無いかもしれない列を「ここから」に残している').toBeNull();
    expect(er.connecting, '「繋ぐ」の入切(好み)まで動いている').toBe(true);
  });

  it('対照群:内蔵の sqlite から採る図(csv 1 件)は、DuckDB で書いても採り直さない', async () => {
    const s = setup();
    s.pick('db4');
    await settle();
    s.pickEngine('duckdb');
    erToggle(s.pane).click();
    await settle();
    s.runReadOnlySql.mockClear();
    await write(s, 'CREATE TABLE 新 AS SELECT 1');
    expect(s.schemaDuckDb, 'sqlite から採る図なのに DuckDB へ採りに行っている').toHaveBeenCalledTimes(0);
    expect(s.runReadOnlySql, 'sqlite の図まで採り直している').toHaveBeenCalledTimes(0);
  });
});

describe('🔴 写せなかった表・ビュー・文字で写した表を、画面で言う(D3 / D6 / D7)', () => {
  const copy = {
    refused: [
      { name: '大きい', view: false, why: '写した行が 64.0 MB を超えました' },
      { name: '月別', view: true, why: 'ビューは写しません' },
    ],
    asText: ['価格'],
    sqlite: true,
    blob: false,
  };
  const addAttached = (s: ReturnType<typeof setup>, lid: string): void => {
    s.sourceSel.selectedIndex = [...s.sourceSel.options].findIndex((o) => o.value === `add:${lid}`);
    s.sourceSel.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const runWith = async (s: ReturnType<typeof setup>, reply: Record<string, unknown>): Promise<void> => {
    s.runDuckDbSql.mockResolvedValueOnce({
      columns: ['g'],
      rows: [['x']] as Array<Array<string | number | null>>,
      truncated: false,
      ms: 2,
      ...reply,
    });
    s.type('SELECT 1');
    s.runBtn.click();
    await settle();
  };

  it('🔴 DuckDB で引いた答えの帯に「写せなかった表」「写らないビュー」「全部の列を文字で写した表」が出る', async () => {
    const s = setup();
    s.pick('db1'); // 売上.sqlite
    await settle();
    s.pickEngine('duckdb');
    await runWith(s, { copy });
    const n = s.note();
    expect(n, '写せなかった表が出ていない').toContain('写せなかった表: 大きい');
    expect(n, 'ビューが写らないことを言っていない').toContain('写らないビュー: 月別');
    expect(n, '全列を文字で写した表を言っていない').toContain('全部の列を文字で写した表: 価格');
    // 🔴 1 件だけなら内蔵の sqlite へ切り替えられる
    expect(n).toContain('内蔵の sqlite なら引けます');
    expect(n, '1 件なのに「1 つに戻す」と言っている').not.toContain('1 つに戻す');
  });

  it('🔴 並べているときの逃げ道は「file を 1 つに戻すと」(engine が DuckDB 固定で、内蔵の sqlite を選べない)', async () => {
    const s = setup();
    s.pick('db4');
    await settle();
    addAttached(s, 'db1');
    await settle();
    await runWith(s, { copy });
    expect(s.note()).toContain('file を 1 つに戻すと内蔵の sqlite で引けます');
    expect(s.note(), '押せない道を案内している').not.toContain('内蔵の sqlite なら引けます');
  });

  it('🔴 内蔵の sqlite に切り替えたら言わない(写していないので、写せなかった表は無い)/ 戻せば言う', async () => {
    const s = setup();
    s.pick('db1');
    await settle();
    s.pickEngine('duckdb');
    await runWith(s, { copy });
    expect(s.note()).toContain('写せなかった表');
    s.pickEngine('sqlite');
    expect(s.note(), 'sqlite で引いているのに DuckDB の写しの話をしている').not.toContain('写せなかった表');
    s.pickEngine('duckdb');
    expect(s.note(), '戻したのに言い直していない').toContain('写せなかった表: 大きい');
  });

  it('🔴 相手を選び直したら消える(新しい相手の帯に、前の file の「写せなかった表」を出さない)', async () => {
    const s = setup();
    s.pick('db1');
    await settle();
    s.pickEngine('duckdb');
    await runWith(s, { copy });
    expect(s.d.getState().sqlPage.duckCopy).not.toBeNull();
    s.pick('db4');
    await settle();
    expect(s.d.getState().sqlPage.duckCopy, '相手が変わったのに報告が残っている').toBeNull();
    expect(s.note()).not.toContain('写せなかった表');
  });

  it('対照群:言うことが無ければ、帯は今までと同じ(何も足さない)', async () => {
    const s = setup();
    s.pick('db1');
    await settle();
    s.pickEngine('duckdb');
    await runWith(s, { copy: { refused: [], asText: [], sqlite: true, blob: false } });
    expect(s.note()).not.toContain('写せなかった');
    expect(s.note()).not.toContain('文字で写した');
    expect(s.note()).not.toContain(' ── 写');
  });

  it('🔴 つながり図の下にも「写せなかった表・ビュー」が出る(図に出ない物を、図を見た人に言う)', async () => {
    const s = setup();
    s.schemaDuckDb.mockResolvedValueOnce({
      columns: {
        columns: ['kind', 'tbl', 'cid', 'col', 'typ', 'nn', 'pk'],
        rows: [['table', '小さい', 0, 'id', 'INTEGER', 0, 0]],
      },
      fks: { columns: ['tbl', 'ref', 'col', 'refcol'], rows: [] },
      counts: { columns: ['tbl', 'n'], rows: [['小さい', 2]] },
      copy,
    });
    s.pick('db7'); // DuckDB の器から図を採る相手
    await settle();
    s.pane.querySelector<HTMLButtonElement>('[data-pkc-field="sql-er-toggle"]')!.click();
    await settle();
    const line = s.pane.querySelector('[data-pkc-field="sql-er-copy"]')?.textContent ?? '';
    expect(line, '図の下に出ていない').toContain('写せなかった表: 大きい');
    expect(line).toContain('写らないビュー: 月別');
    // 🔴 図の構造から採った報告は、帯にも効く(同じ state)
    expect(s.d.getState().sqlPage.duckCopy?.refused).toHaveLength(2);
  });

  it('🔴 構造ノートにも、写せなかった表と「型を 3 つへ丸めている」が書かれる', async () => {
    const s = setup();
    s.schemaDuckDb.mockResolvedValueOnce({
      columns: {
        columns: ['kind', 'tbl', 'cid', 'col', 'typ', 'nn', 'pk'],
        rows: [['table', '小さい', 0, 'id', 'DECIMAL(10,2)', 0, 0]],
      },
      fks: { columns: ['tbl', 'ref', 'col', 'refcol'], rows: [] },
      counts: { columns: ['tbl', 'n'], rows: [['小さい', 2]] },
      copy,
    });
    s.pick('db7');
    await settle();
    s.schemaBtn.click();
    await settle();
    const body = s.persisted[0]?.body ?? '';
    expect(body, '写せなかった表が書かれていない').toContain('⚠ 写せなかった表: 大きい');
    expect(body, '型の丸めが書かれていない').toContain('BIGINT / DOUBLE / VARCHAR の 3 つに丸めています');
    expect(body, '元の宣言の型は残る').toContain('DECIMAL(10,2)');
  });
});

/**
 * 🔴 **逃げ道の字の「並べているか」が、つながり図と構造ノートの行にも届いている**(着地後レビュー ⚠4)。
 * ⚠ 帯(`copyBandNote`)の 2 つの字は上の describe が見ているが、図の下の行(`erCopyLine`)と構造ノート
 *   (`copyDigestNotes`)へ渡す第 2 引数(並べているか)は**どちらも未 pin**で、`false` に固定しても緑だった。
 *   並べているときの engine は DuckDB 固定なので、「内蔵の sqlite なら引けます」は**押せない道を指す**。
 * 🔴 **全文検索の仮想表を写さなかったこと**(💭8)も、帯・図の下・構造ノートの 3 か所に名前つきで出る。
 */
describe('🔴 逃げ道の字は図の下と構造ノートでも「並べているか」で変わる / 全文検索の表を写さなかったと言う', () => {
  const FTS_WHY = '全文検索の表は写しません';
  const copy = {
    refused: [
      { name: '大きい', view: false, why: '写した行が 64.0 MB を超えました' },
      { name: 'docs', view: false, why: FTS_WHY },
    ],
    asText: [],
    sqlite: true,
    blob: false,
  };
  const oneTable = {
    columns: {
      columns: ['kind', 'tbl', 'cid', 'col', 'typ', 'nn', 'pk'],
      rows: [['table', '小さい', 0, 'id', 'INTEGER', 0, 0]] as Array<Array<string | number | null>>,
    },
    fks: { columns: ['tbl', 'ref', 'col', 'refcol'], rows: [] as Array<Array<string | number | null>> },
    counts: { columns: ['tbl', 'n'], rows: [['小さい', 2]] as Array<Array<string | number | null>> },
    copy,
  };
  const addAttached = (s: ReturnType<typeof setup>, lid: string): void => {
    s.sourceSel.selectedIndex = [...s.sourceSel.options].findIndex((o) => o.value === `add:${lid}`);
    s.sourceSel.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const erLine = (s: ReturnType<typeof setup>): string =>
    s.pane.querySelector('[data-pkc-field="sql-er-copy"]')?.textContent ?? '';
  const openEr = async (s: ReturnType<typeof setup>): Promise<void> => {
    s.pane.querySelector<HTMLButtonElement>('[data-pkc-field="sql-er-toggle"]')!.click();
    await settle();
  };

  it('🔴 並べたつながり図の下は「file を 1 つに戻すと」/ 1 件の図の下は「内蔵の sqlite なら引けます」', async () => {
    const s = setup();
    s.pick('db4');
    await settle();
    await openEr(s);
    s.schemaDuckDb.mockResolvedValueOnce(oneTable);
    addAttached(s, 'db7');
    await settle();
    const line = erLine(s);
    expect(line, '前提:図の下に出ている').toContain('写せなかった表: 大きい、docs');
    expect(line).toContain('file を 1 つに戻すと内蔵の sqlite で引けます');
    expect(line, '並べているのに、押せない道を案内している').not.toContain('内蔵の sqlite なら引けます');
    // 対照群:1 件のとき(.parquet を 1 件だけ選ぶ = 図は DuckDB の器から採る)は、押せる道を言う
    const one = setup();
    one.schemaDuckDb.mockResolvedValueOnce(oneTable);
    one.pick('db7');
    await settle();
    await openEr(one);
    expect(erLine(one)).toContain('(内蔵の sqlite なら引けます)');
    expect(erLine(one), '1 件なのに「1 つに戻す」と言っている').not.toContain('1 つに戻す');
  });

  it('🔴 並べて採った構造ノートも「file を 1 つに戻すと」/ 1 件のノートは「内蔵の sqlite なら引けます」', async () => {
    const s = setup();
    s.pick('db4');
    await settle();
    addAttached(s, 'db7');
    await settle();
    s.schemaDuckDb.mockResolvedValueOnce(oneTable);
    s.schemaBtn.click();
    await settle();
    const body = s.persisted[0]?.body ?? '';
    expect(body, '前提:ノートに書かれている').toContain('写せなかった表: 大きい、docs');
    expect(body).toContain('file を 1 つに戻すと内蔵の sqlite で引けます');
    expect(body, '並べているのに、押せない道を案内している').not.toContain('内蔵の sqlite なら引けます');
    // 対照群:1 件のノート
    const one = setup();
    one.schemaDuckDb.mockResolvedValueOnce(oneTable);
    one.pick('db7');
    await settle();
    one.schemaBtn.click();
    await settle();
    const oneBody = one.persisted[0]?.body ?? '';
    expect(oneBody).toContain('内蔵の sqlite なら引けます');
    expect(oneBody, '1 件なのに「1 つに戻す」と言っている').not.toContain('1 つに戻す');
  });

  /**
   * 🔴 **DuckDB で引くとき、案内と手本に並べるのは「写した表」だけ**(着地後レビュー ⚠2)。
   * ⚠ 開いてある客の表は内蔵の sqlite で引ける物で、写さなかった表(全文検索の仮想表・大きすぎる表)を含む ──
   *   並べると、書いてあるとおり打つと DuckDB では `no such table`(手本が 1 つ目の表なら、手本そのものが打てない)。
   */
  it('🔴 DuckDB で写さなかった表は、案内にも手本にも並べない(内蔵の sqlite に戻せば並ぶ)', async () => {
    const s = setup();
    s.pick('db1'); // 表は 売上 / 客(名前順で 1 つ目が 売上)
    await settle();
    s.pickEngine('duckdb');
    const example = (): string => s.pane.querySelector('[data-pkc-field="sql-example"]')?.textContent ?? '';
    // 前提(対照群):まだ写していない回は、開いてある客の表をそのまま並べる
    expect(s.tipText()).toContain('売上, 客');
    expect(example()).toContain('FROM "売上"');
    s.runDuckDbSql.mockResolvedValueOnce({
      columns: ['g'],
      rows: [['x']],
      truncated: false,
      ms: 2,
      ...({ copy: { refused: [{ name: '売上', view: false, why: FTS_WHY }], asText: [], sqlite: true, blob: false } } as Record<
        string,
        unknown
      >),
    });
    s.type('SELECT 1');
    s.runBtn.click();
    await settle();
    expect(s.tipText(), '写さなかった表が案内に並んでいる').not.toContain('在る表: 売上');
    expect(s.tipText()).toContain('この file に在る表: 客。');
    expect(example(), '写さなかった表が手本になっている').toContain('FROM "客"');
    expect(example()).not.toContain('売上');
    // 内蔵の sqlite は写さないので、全部引ける
    s.pickEngine('sqlite');
    expect(s.tipText()).toContain('売上, 客');
  });

  it('🔴 全文検索の表を写さなかったことが、帯・図の下・構造ノートに名前つきで出る', async () => {
    const only = { ...copy, refused: [{ name: 'docs', view: false, why: FTS_WHY }] };
    // 帯
    const a = setup();
    a.pick('db1');
    await settle();
    a.pickEngine('duckdb');
    a.runDuckDbSql.mockResolvedValueOnce({
      columns: ['g'],
      rows: [['x']],
      truncated: false,
      ms: 2,
      ...({ copy: only } as Record<string, unknown>),
    });
    a.type('SELECT 1');
    a.runBtn.click();
    await settle();
    expect(a.note(), '帯に出ていない').toContain('写せなかった表: docs(内蔵の sqlite なら引けます)');
    // 図の下 + 構造ノート(同じ報告)
    const b = setup();
    b.schemaDuckDb.mockResolvedValue({ ...oneTable, copy: only });
    b.pick('db7');
    await settle();
    await openEr(b);
    expect(erLine(b), '図の下に出ていない').toContain('写せなかった表: docs');
    b.schemaBtn.click();
    await settle();
    expect(b.persisted[0]?.body, '構造ノートに出ていない').toContain('⚠ 写せなかった表: docs');
  });
});

describe('🔴 進捗とつながり図の主語(D1 / D8)', () => {
  const addAttached = (s: ReturnType<typeof setup>, lid: string): void => {
    s.sourceSel.selectedIndex = [...s.sourceSel.options].findIndex((o) => o.value === `add:${lid}`);
    s.sourceSel.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('🔴 DuckDB で走らせている間は、写していることを言う(「走らせています…」だけにしない)', async () => {
    const s = setup();
    s.pick('db1');
    await settle();
    s.pickEngine('duckdb');
    let release: () => void = () => undefined;
    s.runDuckDbSql.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ columns: ['g'], rows: [], truncated: false, ms: 1 });
        }),
    );
    s.type('SELECT 1');
    s.runBtn.click();
    await settle();
    const running = s.note();
    expect(running).toContain('走らせています…');
    expect(running, '写していることを言っていない').toContain('DuckDB に表を写すので時間がかかります');
    // 🔴 「最初の 1 回だけ」とは言わない ── 使わないまま置くと片づけて、次に写し直す(実装の事実)
    expect(running).toContain('初回と、');
    expect(running).not.toContain('最初の 1 回だけ');
    /**
     * 🔴 **字の秒数は、片づける間隔そのもの**(#682 Gemini 裁定 A)。⚠ 字に `30` を直書きすると、
     *   間隔(`DEFAULT_IDLE_MS`)を変えた日に字が嘘になる。
     * ① 画面に出た字が、定数から導いた字と一致する ② 字を作る関数は渡された間隔に従う(別の秒数で試す ──
     *   直書きしていれば、ここで落ちる)③ マニュアルの秒数も同じ定数に揃っている。
     */
    expect(DEFAULT_IDLE_MS, '片づける間隔が変わった(字・マニュアルの「30 秒」を見直す)').toBe(30_000);
    expect(running).toContain(duckdbWarmupNote(DEFAULT_IDLE_MS / 1000));
    expect(duckdbWarmupNote(45), '字が渡された秒数に従っていない').toContain('45 秒使わなかったあとは');
    const manual = readFileSync('docs/manual.md', 'utf-8');
    expect(
      manual.includes(`${String(DEFAULT_IDLE_MS / 1000)} 秒使わなかったあとの最初の 1 回`),
      'マニュアルの秒数が、片づける間隔と食い違っている',
    ).toBe(true);
    release();
    await settle();
    expect(s.note(), '答えが出たのに進捗の字が残っている').not.toContain('写すので時間がかかります');
  });

  it('対照群:内蔵の sqlite で走らせている間は、写すとは言わない(写さない)', async () => {
    const s = setup();
    s.pick('db1');
    await settle();
    let release: () => void = () => undefined;
    s.runReadOnlySql.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ columns: ['g'], rows: [], truncated: false, ms: 1 });
        }),
    );
    s.type('SELECT 1');
    s.runBtn.click();
    await settle();
    expect(s.note()).toContain('走らせています…');
    expect(s.note(), 'sqlite なのに DuckDB へ写すと言っている').not.toContain('DuckDB へ写す');
    release();
    await settle();
  });

  const zeroOf = (pane: HTMLElement): string =>
    pane.querySelector('[data-pkc-field="sql-er-zero"]')?.textContent ?? '';
  const noLinks = {
    columns: {
      columns: ['kind', 'tbl', 'cid', 'col', 'typ', 'nn', 'pk'],
      rows: [
        ['table', 'a', 0, 'id', 'BIGINT', 0, 0],
        ['table', 'b', 0, 'id', 'BIGINT', 0, 0],
      ],
    },
    fks: { columns: ['tbl', 'ref', 'col', 'refcol'], rows: [] },
    counts: { columns: ['tbl', 'n'], rows: [['a', 1], ['b', 1]] },
  };

  it('🔴 .parquet 1 件の図が 0 本のとき、「この DB」ではなく「この file」と言う', async () => {
    const s = setup();
    s.schemaDuckDb.mockResolvedValueOnce(noLinks);
    s.pick('db7');
    await settle();
    s.pane.querySelector<HTMLButtonElement>('[data-pkc-field="sql-er-toggle"]')!.click();
    await settle();
    expect(zeroOf(s.pane)).toContain('この file は、表どうしの繋がり(外部キー)を 1 つも宣言していません');
    expect(zeroOf(s.pane), 'parquet を DB と呼んでいる').not.toContain('この DB');
  });

  it('🔴 2 つ並べた図では「これらの file」/ 足した後に図の字も変わる(古い字を残さない)', async () => {
    const s = setup();
    s.pick('db4');
    await settle();
    s.pane.querySelector<HTMLButtonElement>('[data-pkc-field="sql-er-toggle"]')!.click();
    await settle();
    s.schemaDuckDb.mockResolvedValueOnce(noLinks);
    addAttached(s, 'db7');
    await settle();
    expect(zeroOf(s.pane)).toContain('これらの file は、表どうしの繋がり');
  });
});
