/**
 * 🔴 **DuckDB の拡張を、配っている wasm に読み込ませられるかを測る**(#682 段④a)。
 *
 * ⚠ **これは診断であって、門ではない**(CLAUDE.md「未確認は assert ではなく診断で出す。
 *   通ったのを見てから後条件へ昇格させる」)── 何も pin せず、**起きたことを印字する**。
 *
 * ## なぜ CI でしか測れないか
 *
 * 開発の箱からは `extensions.duckdb.org` へ出られない(実測 2026-09-16:
 * `CONNECT tunnel failed, response 403` ── 方針で塞がれている)。
 * ⚠ npm の `@duckdb/duckdb-wasm` にも拡張は 1 件も入っていない(`find` で 0 件)。
 * 🔑 だから**取得はランナーでやる**。この script は「落とした物」を受け取って、
 *   **配っているのと同じ `duckdb-eh.wasm`** に読み込ませられるかだけを見る。
 *
 * ## 使い方
 *
 * ```
 * node scripts/duckdb-ext-probe.mjs <落とした .wasm が居るディレクトリ>
 * ```
 *
 * ⚠ **cwd を repo の中にしない**(書き出しが repo へ落ちる ── 2026-09-16 に踏んだ)。
 *   この script は**自分の作業を `mkdtemp` の中だけ**で済ませる。
 */
import { createDuckDB, NODE_RUNTIME, VoidLogger } from '@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const require_ = createRequire(import.meta.url);

/** 配っているのと同じ一式(`duckdb-eh.wasm` + node の worker)。 */
function bundles() {
  const dist = dirname(require_.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'));
  return {
    mvp: {
      mainModule: join(dist, 'duckdb-mvp.wasm'),
      mainWorker: join(dist, 'duckdb-node-mvp.worker.cjs'),
    },
    eh: {
      mainModule: join(dist, 'duckdb-eh.wasm'),
      mainWorker: join(dist, 'duckdb-node-eh.worker.cjs'),
    },
  };
}

/** 1 行で結果を書く。⚠ 例外は**握り潰さずに字にする**(黙って落ちない)。 */
function line(label, fn) {
  try {
    const v = fn();
    console.log(`🟢 ${label}: ${v === undefined ? 'ok' : String(v)}`);
    return true;
  } catch (e) {
    console.log(`🔴 ${label}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return false;
  }
}

async function main() {
  const dir = resolve(process.argv[2] ?? '.');
  console.log(`# 拡張の置き場: ${dir}`);

  const files = readdirSync(dir).filter((f) => f.endsWith('.wasm'));
  if (files.length === 0) {
    console.log('🔴 .wasm が 1 件も無い ── 取得の段で失敗している(この先は測れない)');
    process.exitCode = 1;
    return;
  }
  for (const f of files) {
    const b = readFileSync(join(dir, f));
    // ⚠ wasm の magic(`\0asm`)── html の error ページを掴んでいないかを見る
    const magic = [...b.subarray(0, 4)].map((x) => x.toString(16).padStart(2, '0')).join('');
    console.log(`# ${f}\t${statSync(join(dir, f)).size} bytes\tmagic=${magic}${magic === '0061736d' ? '' : ' 🔴 wasm ではない'}`);
  }

  const db = await createDuckDB(bundles(), new VoidLogger(), NODE_RUNTIME);
  await db.instantiate();
  const conn = db.connect();
  /**
   * 🔴 **数を `JSON.stringify` にそのまま渡さない**(2026-09-16 の 1 回目で踏んだ)。
   *
   * ⚠ DuckDB の `COUNT(*)` は **BIGINT** なので JS へは `BigInt` で来るが、
   *   `JSON.stringify` はそれを**払えない**(`Do not know how to serialize a BigInt`)。
   * 🔴 帰結が悪い ── **問い合わせは通っているのに、印字だけが落ちて
   *   「🔴 parquet で書いて読み直す」と出た** ── 拡張が使えないように見える。
   * 🔑 CLAUDE.md §4「計器が壊れているなら、結果を読まずに計器を直す」の実例である。
   */
  const one = (sql) => {
    const t = conn.query(sql);
    return JSON.stringify(t.toArray().map((r) => r.toJSON()), (_k, v) =>
      typeof v === 'bigint' ? `${v}n` : v,
    );
  };

  console.log(`# 器の版: ${one('SELECT version() AS v')}`);

  /**
   * ── ① 読み込ませる。
   *
   * 🔴 **綴りを 1 つに決め打たない** ── この箱では本物の拡張が手に入らないので
   *   (`extensions.duckdb.org` が 403)、**どの打ち方が通るかを測っていない**。
   * 🔑 だから **3 通りを順に当てて、通った物を印字する**(CLAUDE.md
   *   「『取れない』で終わらせる前に、取り方を数え上げる」の機械版)。
   *
   * ⚠ 対照群(2026-09-16、拡張ゼロで測った)で分かっていること:
   *   ① 器は `v1.5.4` ② `LOAD <名前>` は**外の URL へ取りに行く**
   *   (`https://extensions.duckdb.org/v1.5.4/wasm_eh/<名前>.duckdb_extension.wasm`)
   *   ③ 署名が無い物は**既定で断られる**(`allow_unsigned_extensions`)。
   *   🔑 ③ が効くので、**公式の署名つきの bytes をそのまま置けるか**がこの probe の要である。
   */
  const SPELLINGS = [
    { how: "INSTALL '<file>' → LOAD <name>", run: (f, n) => { one(`INSTALL '${f}'`); return one(`LOAD ${n}`); } },
    { how: "LOAD '<file>'", run: (f) => one(`LOAD '${f}'`) },
    { how: "FORCE INSTALL '<file>' → LOAD <name>", run: (f, n) => { one(`FORCE INSTALL '${f}'`); return one(`LOAD ${n}`); } },
  ];
  for (const f of files) {
    const name = f.replace(/\.duckdb_extension\.wasm$|\.wasm$/, '');
    db.registerFileBuffer(f, new Uint8Array(readFileSync(join(dir, f))));
    let ok = false;
    for (const s of SPELLINGS) {
      if (ok) break;
      ok = line(`${name} ── ${s.how}`, () => s.run(f, name));
    }
    if (!ok) console.log(`🔴 ${name}: 3 通りとも通らなかった(上の理由を読むこと)`);
  }

  console.log(`# 読み込まれている物: ${one(
    "SELECT extension_name FROM duckdb_extensions() WHERE loaded ORDER BY extension_name",
  )}`);

  // ── ② 本当に使えるか(読み込めた ≠ 効く)
  line('parquet で書いて読み直す', () => {
    one("COPY (SELECT 1 AS a, 'あ' AS b) TO 'p.parquet' (FORMAT PARQUET)");
    return one("SELECT * FROM 'p.parquet'");
  });
  line('json を読む', () => {
    db.registerFileBuffer('t.json', new Uint8Array(Buffer.from('[{"a":1},{"a":2}]', 'utf-8')));
    return one("SELECT sum(a) AS n FROM read_json_auto('t.json')");
  });
  line('sqlite に ATTACH して書いて読む', () => {
    one("ATTACH 's.sqlite' AS s (TYPE SQLITE)");
    one('CREATE TABLE s.t (a INTEGER)');
    one('INSERT INTO s.t VALUES (7)');
    const got = one('SELECT a FROM s.t');
    one('DETACH s');
    return got;
  });

  conn.close();
  await db.terminate?.();

  /**
   * ── ③ 🔴 **門を掛けた状態でも読み込めるか**(#682 段④b の 1 手目)。
   *
   * ⚠ 製品は「外へ拡張を取りに行かせない」ために
   *   `SET autoinstall_known_extensions=false` / `autoload_known_extensions=false` を
   *   掛ける(`duckdb-open.ts`)が、上の①②は**掛けていない**。
   * 🔴 その門が、**手元の file からの `INSTALL` まで塞いでいないか**を
   *   ここで見る ── 塞いでいたら、**同梱しても読み込めない**ことになるので、
   *   同梱の作りを決める前に測る必要がある。
   * ⚠ **別の器を立て直して測る** ── 上で読み込んだ後に掛けても、
   *   **既に入っている物に救われて通る**(§1「今度は何に救われていないか」)。
   */
  const db2 = await createDuckDB(bundles(), new VoidLogger(), NODE_RUNTIME);
  await db2.instantiate();
  const conn2 = db2.connect();
  const one2 = (sql) => {
    const t = conn2.query(sql);
    return JSON.stringify(t.toArray().map((r) => r.toJSON()), (_k, v) =>
      typeof v === 'bigint' ? `${v}n` : v,
    );
  };
  line('門を掛ける(製品と同じ 2 行)', () => {
    one2('SET autoinstall_known_extensions=false');
    one2('SET autoload_known_extensions=false');
  });
  for (const f of files) {
    const name = f.replace(/\.duckdb_extension\.wasm$|\.wasm$/, '');
    db2.registerFileBuffer(f, new Uint8Array(readFileSync(join(dir, f))));
    line(`門あり ${name} ── INSTALL '<file>' → LOAD <name>`, () => {
      one2(`INSTALL '${f}'`);
      return one2(`LOAD ${name}`);
    });
  }
  console.log(`# 門ありで読み込まれた物: ${one2(
    "SELECT extension_name FROM duckdb_extensions() WHERE loaded ORDER BY extension_name",
  )}`);
  conn2.close();
  await db2.terminate?.();

  /**
   * 🔑 **対照群 ── 門が「外へ出る側」には効いていること**を見る。
   *
   * ⚠ これが無いと、上の行が全部緑になっただけで
   *   「門を掛けたつもりで掛かっていない」を見抜けない。
   *
   * 🔴 **1 稿目は空振りだった**(2026-09-16。run 3 で見つけた)。
   * 同じ器に **parquet を既に読み込んだ後**で `read_parquet(...)` を打っていたので、
   * 返ってきたのは `IO Error: No files found that match the pattern ...`
   * ── **ただ file が無いという話**で、門の話ではなかった。
   * 🔑 だから**何も読み込んでいない器を立て直して**打つ
   *  (§1「今度は何に救われていないか」)。
   *
   * ⚠ **断られるのが正解**なので、`line` を使わない
   *  ── 使うと**正しい結果が 🔴 で出て**、次に読む人が壊れていると読む。
   */
  const db3 = await createDuckDB(bundles(), new VoidLogger(), NODE_RUNTIME);
  await db3.instantiate();
  const conn3 = db3.connect();
  conn3.query('SET autoinstall_known_extensions=false');
  conn3.query('SET autoload_known_extensions=false');
  try {
    conn3.query("SELECT * FROM read_parquet('x.parquet')");
    console.log('🔴 対照群: 門を掛けたのに通ってしまった(門が効いていない)');
  } catch (e) {
    const m = e instanceof Error ? e.message.split('\n')[0] : String(e);
    console.log(`🟢 対照群: 何も読み込んでいない器では断られる(正しい): ${m}`);
  }
  conn3.close();
  await db3.terminate?.();
}

main().catch((e) => {
  console.log(`🔴 測れなかった: ${e instanceof Error ? e.stack : String(e)}`);
  process.exitCode = 1;
});
