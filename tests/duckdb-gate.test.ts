/**
 * 🔴 **DuckDB を「自分で配る」ための門**(#682。裁定 2026-09-15 = 案 A)。
 *
 * ここが見るのは 2 つだけ ──
 * ① **綴りが 3 か所に散っている**(CLAUDE.md §7「同じ値が複数の場所にある」)
 * ② **外の CDN を呼ぶ口が、製品のコードに 1 件も無い**
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DUCKDB_DIR as PLUGIN_DIR, DUCKDB_PACK } from '../build/duckdb-assets-plugin';
import { DUCKDB_PRECACHE_SKIP } from '../src/adapter/platform/sw/sw-source';
import { codeOnly } from './helpers/code-only';
// @ts-expect-error -- 検品規則は素の .mjs(ビルド対象外の CI script 群)
import { DUCKDB_DIR as INSPECT_DIR } from '../scripts/dist-inspect.mjs';

describe('🔴 DuckDB の綴りは 1 つ(#682)', () => {
  /**
   * ⚠ 片方だけ改名すると、**黙って precache に載る / 黙って cap に数えられる**。
   * 🔑 どちらも「落ちない壊れ方」なので、等値で留める。
   */
  it('配り先の綴りが、plugin / 検品 / SW の 3 か所で一致する', () => {
    expect(PLUGIN_DIR).toBe('duckdb/');
    expect(INSPECT_DIR).toBe(PLUGIN_DIR);
    expect(DUCKDB_PRECACHE_SKIP).toBe(PLUGIN_DIR);
  });

  it('目録は配り先の中に在る', () => {
    expect(DUCKDB_PACK.startsWith(PLUGIN_DIR)).toBe(true);
  });
});

/** `src/` の `.ts` を全部読む。⚠ 注釈は落とす(自分の解説に満たされないため)。 */
function srcCode(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts')) out.set(full, codeOnly(readFileSync(full, 'utf-8')));
    }
  };
  walk('src');
  return out;
}

describe('🔴 外の CDN を呼ぶ口が無い(#682)', () => {
  /**
   * 🔴 実測 2026-09-15:duckdb-wasm を Vite で束ねると、**`https://cdn.jsdelivr.net/npm/`
   * が 1 件焼き込まれる**(`getJsDelivrBundles()` の宛先)。
   *
   * ⚠ **呼ばなければ 1 バイトも出ない**が、🔴 **呼べる関数が配る物の中に在る**以上、
   *   「呼ばないと決めた」だけでは守れない ── 次に書く人が素直に使う。
   * 🔑 だから**呼ぶ経路が 0 件**であることを、`src` の全数走査で留める。
   *
   * ⚠ この検査は**注釈を落としてから**当てる ── 落とさないと、この docstring 自身の
   *   綴りに満たされて**必ず落ちる**(CLAUDE.md §1 の 5 度目・10 度目と同じ形)。
   */
  const FORBIDDEN = ['getJsDelivrBundles', 'jsdelivr', 'extensions.duckdb.org'];

  it('製品のコードに、外から一式を引く口が 1 件も無い', () => {
    const code = srcCode();
    // ⚠ **空振り防止** ── 走査が本当に file を読んでいること
    expect(code.size).toBeGreaterThan(100);
    const hits: string[] = [];
    for (const [path, body] of code) {
      for (const word of FORBIDDEN) {
        if (body.toLowerCase().includes(word.toLowerCase())) hits.push(`${path}: ${word}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('⚠ 空振りしていない ── 同じ走査で、在る語はちゃんと見つかる', () => {
    const code = srcCode();
    const found = [...code].filter(([, body]) => body.includes('DUCKDB_PRECACHE_SKIP'));
    expect(found.length).toBeGreaterThan(0);
  });
});

/**
 * 🔴 **「外へ出ない」を守る 3 つの門が、全部実装に在る**(#682 段②)。
 *
 * 実測(2026-09-15、実ブラウザ)で分かったこと ──
 * ① 拡張の自動取得を切らないと、`read_parquet` が `extensions.duckdb.org` へ **XHR を出す**
 * ② 切っただけでは、`read_csv_auto('https://…')` が**素で外へ出る**(拡張を挟まない)
 * ③ `enable_external_access=false` は外を塞ぐが、**差し込んだ file の読みも塞ぐ** ──
 *    だから**写し切ってから**掛ける
 *
 * ⚠ どれか 1 つでも消えると、**落ちずに外へ出るようになる**(user にも test にも見えない)。
 * 🔑 だから 3 つとも、**実行する行**の側で留める(注釈は落としてから当てる)。
 */
describe('🔴 外へ出ない門が 3 つとも在る(#682 段②)', () => {
  const open = () => codeOnly(readFileSync('src/adapter/platform/duckdb/duckdb-open.ts', 'utf-8'));
  const runner = () => codeOnly(readFileSync('src/adapter/platform/duckdb/duckdb-runner.ts', 'utf-8'));

  it('① 起こすときに、拡張の自動取得を切っている', () => {
    const code = open();
    expect(code).toContain('SET autoinstall_known_extensions=false');
    expect(code).toContain('SET autoload_known_extensions=false');
  });

  it('② 外を塞ぐ 1 文が在り、③ それは「写し切る 1 文」の後にしか打たれない', () => {
    const code = runner();
    const seal = code.indexOf('SET enable_external_access=false');
    expect(seal, '外を塞ぐ門が消えている').toBeGreaterThan(-1);
    /**
     * 🔴 **順番そのものを見る** ── 先に塞ぐと写せない(実測で `Permission Error`)。
     * ⚠ ここは字の並びしか見ていない ── **本当の順番は
     *   `tests/adapter/duckdb-runner.test.ts` が、打たれた字を積んで見る**。
     *   こちらは「門そのものが消えていないか」の錨である。
     */
    expect(code).toContain('CREATE OR REPLACE TABLE');
    // ⚠ VIEW にすると、塞いだ後に引けなくなる(実測)
    expect(code).not.toContain('CREATE OR REPLACE VIEW');
  });

  it('🔴 字の門が、門を打ち直す語を断っている(engine の①は打ち直せる ── 実測)', () => {
    const guard = codeOnly(readFileSync('src/features/query/duckdb-guard.ts', 'utf-8'));
    for (const word of ['install', 'load', 'set', 'reset']) {
      expect(guard, `${word} が断る語の一覧から消えている`).toContain(`'${word}'`);
    }
  });
});
