/**
 * 🔴 **同梱の sqlite に何が入っているか**(#681 の「先に数え上げる」)。
 *
 * > user の言葉 2026-09-03:「**内蔵の sqlite を最大限活用したインスタントな
 * > csv や sqliteDB のクエリアプリ**」
 *
 * ⚠ 「最大限活用」を設計するには、**何が使えるかを推測でなく実測**していないと
 *   いけない ── 使えない物の上に設計を立てると、実装の最後で崩れる
 *   (CLAUDE.md「上流の既定値は推測で渡さない」)。
 *
 * 🔑 この test は 2 つの向きを見る:
 * ① **在るもの**(これに乗って設計する)が消えていないか
 * ② 🔴 **無いもの**(だから別の道を作った)が、後の版で**入っていないか** ──
 *    入ったなら、遠回りをやめられる合図である(§8「両方向を見る」)。
 *
 * ⚠ ここが落ちたときは「壊れた」ではなく「**同梱の sqlite が変わった**」と読む。
 *   直し方は、変わった行を書き換えて **#681 に 1 行残す**こと。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

interface Db {
  selectValue: (sql: string) => unknown;
  exec: (opts: { sql: string; callback?: (row: unknown[]) => void; rowMode?: 'array' }) => void;
  /** ⚠ `capi` へ渡す生のハンドル(進み具合の見張りを付けるのに要る)。 */
  pointer: number;
}

interface Sqlite3 {
  oo1: { DB: new (file: string, mode: string) => Db };
  capi: Record<string, (...a: unknown[]) => unknown>;
  wasm: Record<string, (...a: unknown[]) => unknown>;
}

let api: Sqlite3;
let db: Db;
/** その版で使える仮想表(モジュール)。 */
let modules: string[] = [];
/** `pragma compile_options` の全行。 */
let options: string[] = [];

const list = (sql: string): string[] => {
  const rows: string[] = [];
  db.exec({ sql, callback: (r) => rows.push(String(r[0])), rowMode: 'array' });
  return rows;
};

/** その SQL が通るか(通らない理由は問わない ── 「使えるか」だけを見る)。 */
const works = (sql: string): boolean => {
  try {
    db.selectValue(sql);
    return true;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  // ⚠ 引数を渡さない ── 実装(`storage-worker.ts:201`)と**同じ呼び方**にする
  api = (await sqlite3InitModule()) as unknown as Sqlite3;
  db = new api.oo1.DB(':memory:', 'c');
  modules = list('select name from pragma_module_list order by name');
  options = list('pragma compile_options');
});

describe('同梱の sqlite', () => {
  /**
   * ⚠ **空振り防止** ── 下の「無い」の主張は、DB が開けていなくても全部通る。
   *   だから先に「開いていて、SQL が動く」ことを見る。
   */
  it('開いていて、SQL が動く(これが無いと以下の主張は全部空振り)', () => {
    expect(String(db.selectValue('select sqlite_version()'))).toMatch(/^3\./);
    expect(db.selectValue('select 1 + 1')).toBe(2);
    expect(options.length, 'compile_options が読めていない').toBeGreaterThan(20);
  });

  /** 🟢 **これに乗って設計してよいもの。** */
  it.each([
    ['json(json1 / jsonb)', "select json_extract('{\"a\":1}','$.a')"],
    ['json_each(表として展開)', "select count(*) from json_each('[1,2,3]')"],
    ['数学関数', 'select pow(2, 10)'],
    ['窓関数', 'select count(*) over () from (select 1)'],
    ['percentile / median', 'select median(x) from (select 1 as x)'],
    ['書式(printf / format)', "select printf('%.2f', 1.5)"],
  ])('🟢 %s は使える', (_name, sql) => {
    expect(works(sql as string)).toBe(true);
  });

  it('🟢 全文検索(fts5)と 空間索引(rtree)の仮想表が作れる', () => {
    expect(modules).toContain('fts5');
    expect(modules).toContain('rtree');
  });

  /**
   * 🔴 **無いもの。** ⚠ ここが**通る**ようになったら、それは失敗ではなく
   *   「遠回りをやめられる」合図である ── #681 に 1 行残してから、この行を消す。
   */
  it.each([
    // 🔴 これが無いので、**csv は自前で表を作って入れる**しかない
    ['csv の仮想表', 'csv'],
    // 🔴 拡張を後から読み込めない(`OMIT_LOAD_EXTENSION`)ので、外から足す道も無い
    ['連番の仮想表(series)', 'generate_series'],
  ])('🔴 %s は入っていない', (_name, mod) => {
    expect(modules).not.toContain(mod as string);
  });

  /**
   * ⚠ **「呼んで落ちるか」で見ない**(着地前レビュー 2026-09-09)── `works()` は
   *   例外を丸ごと握り潰すので、「**関数が無い**」と「**在るが今回の呼び方で落ちた**」を
   *   区別できない。🔴 とくに `load_extension` は、**有効な版では
   *   `not authorized` を投げる**ので、**在っても `false` のまま**になる ──
   *   つまり上の「入ったら鳴る」という合図が**原理的に鳴らない**。
   * 🔑 だから**名簿を引く**(`pragma_function_list`)。
   */
  it.each([['regexp'], ['load_extension'], ['uuid'], ['soundex']])(
    '🔴 %s という関数は名簿に無い',
    (name) => {
      expect(list(`select name from pragma_function_list where name = '${name as string}'`)).toEqual(
        [],
      );
    },
  );

  /** ⚠ 空振り防止 ── 名簿の引き方そのものが死んでいたら、上は全部通る。 */
  it('名簿の引き方が生きている(在る関数は引ける)', () => {
    expect(list("select name from pragma_function_list where name = 'replace'")).toEqual(['replace']);
    expect(modules.length, '仮想表の一覧が空 = 数えられていない').toBeGreaterThan(5);
  });

  /**
   * 🔴 **設計が寄りかかっている 4 つ**は、名指しで pin する。
   * ⚠ 一覧全部を pin しない ── 版が上がるたびに落ちて、**読まれなくなる**。
   */
  it.each([
    // 🔑 外から拡張を足せない = 足りない物は自前で書くしかない(csv がこれ)
    ['OMIT_LOAD_EXTENSION', true],
    // 🔑 `"…"` は**必ず識別子**(文字列として通らない)── 打つ人への説明に要る
    ['DQS=0', true],
    // 🔑 取り込んだ `.sqlite` を `ATTACH` する道を採るなら、同時に 10 個まで
    ['MAX_ATTACHED=10', true],
    // 🔑 スレッド安全でない = 1 つの接続を 2 つの worker で共有できない
    ['THREADSAFE=0', true],
  ])('%s', (opt) => {
    expect(options).toContain(opt as string);
  });
});

/**
 * 🔴 **クエリアプリの安全は、字の検査ではなく engine に置く**(#681 段②の前提)。
 *
 * ⚠ `sql-guard.ts` は**断る理由を字で言う**ための門であって、境ではない
 *   (字で見分ける以上、知らない書き方は漏れうる)。
 * 🔑 だから境になる 2 つを**ここで実測して pin する** ── どちらかが消えたら、
 *   段②の設計は**成り立たない**(user のノートを壊せる口 / 保存ごと固まる口が開く)。
 */
describe('🔴 段② が寄りかかる 2 つ', () => {
  it('`PRAGMA query_only` で、書き込みを engine が断る', () => {
    // ⚠ **空振り防止** ── 切っている間は書けることを先に見る
    //   (書けない別の理由で落ちていると、下の主張は何も言っていない)
    db.exec({ sql: 'create table qo_control(a)' });
    expect(db.selectValue('select count(*) from qo_control')).toBe(0);

    db.exec({ sql: 'pragma query_only = 1' });
    /**
     * ⚠ **戻しは `finally` に入れる**(着地前レビュー 2026-09-09)── 直す前は
     *   assert 4 つの後ろに素で置いてあったので、**1 つでも落ちると戻らない**。
     *   🔴 `db` は file の中で共有なので、**次の test が「書けない」で巻き添えに落ちる**
     *   ── 「終わらない問い合わせを止められない」ように読めてしまう(実際は
     *   接続が読み取り専用のまま)。
     */
    try {
      expect(db.selectValue('pragma query_only')).toBe(1);
      // 🔴 書けない
      expect(() => db.exec({ sql: 'create table qo_blocked(a)' })).toThrow(/readonly/i);
      expect(() => db.exec({ sql: 'insert into qo_control values (1)' })).toThrow(/readonly/i);
      // 🟢 読めるほうは通る(門ごと閉じてしまっては使えない)
      expect(db.selectValue('select 1 + 1')).toBe(2);
    } finally {
      db.exec({ sql: 'pragma query_only = 0' });
    }
    // ⚠ **戻ることまで見る** ── 戻らないと、この面を 1 度開いた user は
    //   以後ノートを保存できなくなる(同じ接続を使うので)
    db.exec({ sql: 'insert into qo_control values (1)' });
    expect(db.selectValue('select count(*) from qo_control')).toBe(1);
  });

  /**
   * 🔴 **字の門が「語の直後の `(` は関数」と緩めた根拠**(2026-09-09)。
   *
   * ⚠ `replace()` は普通の関数なので、`SELECT replace(a,'1','2')` を断ってはいけない。
   *   そこで「直後が `(` なら関数」と緩めたが、**緩めた分が抜け道でないこと**は
   *   engine 側の事実に寄りかかっている ── **書き込み文は語の直後に `(` を置けない**。
   * 🔑 だからここで pin する。⚠ ここが `OK` に変わったら、字の門の緩和を**取り消す**
   *   合図である(この test が、その日にいちばん早く鳴る計器になる)。
   */
  it.each([
    ['WITH x(a) AS (SELECT 1) REPLACE(a) INTO hole SELECT a FROM x'],
    ['WITH x(a) AS (SELECT 1) DELETE(a) FROM hole'],
    ['DELETE (a) FROM hole'],
    ['UPDATE (hole) SET a = 9'],
    ['INSERT (INTO) hole VALUES (3)'],
  ])('🔴 書き込みの語の直後に `(` は置けない ── %s', (sql) => {
    db.exec({ sql: 'create table if not exists hole(a)' });
    // ⚠ 空振り防止 ── 表が在って、普通の書き込みなら通ることを見る
    db.exec({ sql: 'delete from hole' });
    db.exec({ sql: 'insert into hole values (1)' });
    expect(() => db.exec({ sql: sql as string })).toThrow();
    expect(db.selectValue('select count(*) from hole'), '1 行も動いていないこと').toBe(1);
  });

  it('終わらない問い合わせを、進み具合の見張りで止められる', () => {
    db.exec({
      sql: 'create table busy(a); with r(i) as (select 1 union all select i+1 from r where i<400) insert into busy select i from r',
    });
    const heavy = 'select count(*) from busy a, busy b, busy c';
    let calls = 0;
    const fn = api.wasm['installFunction']!('i(p)', () => {
      calls += 1;
      // 🔑 0 以外を返した瞬間に `SQLITE_INTERRUPT` になる
      return calls > 50 ? 1 : 0;
    }) as unknown as number;
    api.capi['sqlite3_progress_handler']!(db.pointer, 1000, fn, 0);
    try {
      expect(() => db.selectValue(heavy)).toThrow(/interrupt/i);
      // ⚠ 空振り防止 ── 見張りが**実際に呼ばれた**ことを見る
      //   (呼ばれずに別の理由で落ちていたら、止められる証拠にならない)
      expect(calls).toBeGreaterThan(50);
    } finally {
      // ⚠ 外す ── 張ったままだと、この後の test が理由の分からない中断を受ける
      api.capi['sqlite3_progress_handler']!(db.pointer, 0, 0, 0);
    }
  });
});
