# DuckDB の拡張(同梱)

🔴 **ここに在るのは、こちらが作った物ではありません。** DuckDB 公式の配布物を
**1 バイトも変えずに**置いています(#682 段④b)。

## なぜ repo に置くのか

DuckDB の拡張は既定では **実行時に `extensions.duckdb.org` から取りに来ます**。
それは PKC3 の柱(**勝手に外へ出ない**)と正面から当たるので、
**PKC3 自身が配って、開いた直後に読み込む**形にしました
(wasm 本体について 2026-09-15 に出した裁定と同じ向き)。

⚠ **wasm 本体は `node_modules` から写しています**(`build/duckdb-assets-plugin.ts`)が、
拡張は**そちらに 1 件もありません**。npm にも package がありません(3 つ試して 404)。
出どころは `extensions.duckdb.org` だけで、🔴 **開発の箱からは出られません**
(`CONNECT tunnel failed, response 403`)── だから repo に置いています。

## 出どころ(2026-09-16 に取得)

```
https://extensions.duckdb.org/v1.5.4/wasm_eh/<名前>.duckdb_extension.wasm
```

| 名前 | bytes | sha256 |
|---|---|---|
| `json` | 821,413 | `993b19f7929cc305b2529c548f2842e8e7a5b112d1c88f31c84798b51901ca16` |
| `parquet` | 3,218,307 | `4845705bbd69fc9ad52878d96a505c73cae4a6c509822079cc2413e5eb437f95` |
| `sqlite_scanner` | 1,641,696 | `489c1be5b6e9b839c1eff358486337e72e1d209f113b620deb5987d094fc32a9` |

落としたのは GitHub Actions(`.github/workflows/duckdb-ext-probe.yml` を
`publish=true` で押した)で、prerelease `duckdb-ext-v1.5.4-wasm_eh` を経由して
手元へ渡しました。⚠ **上の sha256 は release の文面・取得時・commit 時の
3 回とも一致**を確かめています。

## 🔴 版は器と完全一致でなければ読み込めません

`v1.5.4` は **DuckDB エンジンの版**であって、npm の `@duckdb/duckdb-wasm` の版
(`1.33.1-dev57.0`)ではありません。⚠ 2 つは**別々に動く**ので、
npm を上げたときに**ここが黙って古くなる**のがいちばん危ない壊れ方です。

🔑 だから門を置いてあります ── `build/duckdb-assets-plugin.ts` が、
**この folder の版と台の名前が、配る `duckdb-eh.wasm` の中に実在するか**を見ます
(engine はその字から拡張の URL を組むので、必ず入っています)。食い違ったら
**ビルドが落ちます**。

## 取り直し方

1. `.github/workflows/duckdb-ext-probe.yml` を Actions から **Run workflow**
   (`publish` を true に、`duckdb_version` / `platform` を新しい版に)
2. prerelease の zip を落として展開し、この folder を新しい版名で作り直す
3. `src/features/query/duckdb-pack.ts` の `DUCKDB_ENGINE` を直す

## ライセンス

DuckDB / DuckDB 拡張は **MIT License**(DuckDB Foundation / DuckDB Labs)。
表記は `src/features/oss-notices/oss-notices.ts` に在ります。
