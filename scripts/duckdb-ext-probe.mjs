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
  const one = (sql) => {
    const t = conn.query(sql);
    return JSON.stringify(t.toArray().map((r) => r.toJSON()));
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
}

main().catch((e) => {
  console.log(`🔴 測れなかった: ${e instanceof Error ? e.stack : String(e)}`);
  process.exitCode = 1;
});
