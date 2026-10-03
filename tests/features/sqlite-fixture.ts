/**
 * test 用の **`.sqlite` の画像**(合成 fixture)。
 *
 * ⚠ **読み手と実装を共有しない** ── 組むのは Node 自身の `node:sqlite`(製品の wasm-sqlite ではない)。
 *   製品が「自分が書いた形しか読めない」状態を避ける(`xlsx-fixture.ts` と同じ作法)。
 * ⚠ 実 file を経由する(`node:sqlite` に画像を直に出す口が無い)── 一時 file は読んだら消す。
 * ⚠ `node:sqlite` は **使うときに読み込む**(import で読むと、この file を import しただけの
 *   playwright の worker 全部が「SQLite is an experimental feature」の警告を出す)。
 */
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * 自作した DB の画像を返す。
 * @param setup 表を作って行を入れる関数(`db.exec('CREATE TABLE …')`)。
 */
export function buildSqlite(setup: (db: DatabaseSync) => void): Uint8Array {
  const { DatabaseSync: Db } = require('node:sqlite') as typeof import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-sqlite-fixture-'));
  const file = join(dir, 'x.sqlite');
  try {
    const db = new Db(file);
    try {
      setup(db);
    } finally {
      db.close();
    }
    return new Uint8Array(readFileSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
