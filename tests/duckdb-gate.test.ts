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
