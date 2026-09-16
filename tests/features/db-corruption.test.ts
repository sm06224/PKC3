/**
 * 🔴 **中身が壊れたときに、書き込みだけ止める**(#971。user 報告 2026-09-16)。
 *
 * ⚠ 守る主張は 3 つで、**どれも逆向きの誤りのほうが害が大きい**:
 * ① 壊れを**見落とす** → 書き続けて壊れ方が広がる
 * ② 普通の失敗を**壊れと読む** → ノートを保存できなくなる(user は何も壊していない)
 * ③ 読む op まで止める → **持ち出す道が消える**(データは在るのに取り出せない)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CORRUPT_BLOCKED_OPS,
  CORRUPT_REFUSAL,
  corruptReport,
  looksCorrupt,
  shouldFlagCorrupt,
} from '../../src/features/storage/db-corruption';

describe('壊れを見分ける(#971)', () => {
  it('🔴 user が実際に見た字を拾う', () => {
    // ⚠ 2026-09-16 の報告そのもの
    expect(looksCorrupt('sqlite result code 11')).toBe(true);
    expect(looksCorrupt('database disk image is malformed')).toBe(true);
    expect(looksCorrupt('SQLITE_CORRUPT: sqlite3 result code 11')).toBe(true);
    expect(looksCorrupt('file is not a database')).toBe(true);
    expect(looksCorrupt('malformed database schema (entries_fts)')).toBe(true);
  });

  /**
   * 🔴 **対照群 ── ここが本番である。**
   * ⚠ 普通の失敗を壊れと読むと、**書き込みが全部止まる** ── user から見れば
   *   「何もしていないのに保存できなくなった」であり、壊れの見落としより始末が悪い。
   */
  it('🔴 普通の失敗は壊れと読まない', () => {
    for (const ok of [
      '未知の op です: nope',
      '編集を終了してから整理してください',
      'no such table: 売上',
      '読み取り専用です ── UPDATE は打てません',
      'この表は大きすぎます(升が 200000 を超えました)',
      'QuotaExceededError: 保存領域の上限を超えました',
      'sqlite3 result code 1: SQL logic error',
      'exit code 110',
    ]) {
      expect(looksCorrupt(ok), `壊れと読んではいけない: ${ok}`).toBe(false);
    }
  });

  /**
   * 🔴 **客の file の破損を、うちの破損として扱わない**(実装中に見つけた穴)。
   * ⚠ 壊れた `.sqlite` を 1 つ取り込んだだけで本体への書き込みが止まる形だった。
   */
  it('🔴 取り込んだ file が壊れていても、本体は止めない', () => {
    const raw = 'この file は sqlite として読めませんでした(file is not a database)';
    expect(shouldFlagCorrupt('openSqlGuest', false, raw), '客の file で本体を止めた').toBe(false);
    expect(shouldFlagCorrupt('runReadOnlySql', true, raw), '客へ向けた問い合わせで本体を止めた').toBe(
      false,
    );
    // ⚠ 対照群 ── うちの DB へ向いていたら、同じ字で止める(規則そのものは生きている)
    expect(shouldFlagCorrupt('runReadOnlySql', false, raw), 'うちの DB の破損を見落とした').toBe(
      true,
    );
  });
});

describe('止める op の仕分け(#971)', () => {
  /** protocol が宣言している op を**原文から全数**拾う。 */
  function allOps(): string[] {
    const src = readFileSync(
      join(process.cwd(), 'src/adapter/platform/storage/protocol.ts'),
      'utf-8',
    );
    const found = [...src.matchAll(/\bop: '([A-Za-z][A-Za-z0-9]*)'/g)].map((m) => m[1] ?? '');
    return [...new Set(found)].sort();
  }

  /**
   * 🔴 **読んでよい op**(= 壊れていても通す)。
   * ⚠ ここに 1 つでも書き換える op を入れると、**壊れた DB へ書いてしまう**。
   * ⚠ 逆に持ち出しに要る op を落とすと、**取り出せなくなる**。
   */
  const ALLOWED: readonly string[] = [
    'init',
    'close',
    'openContainer',
    'resolveContainer',
    'listContainerIds',
    'counts',
    'listEntryMetas',
    'listBodies',
    'getBody',
    'getBodies',
    'taskScan',
    'contactScan',
    'snippetScan',
    'smartScan',
    'queryScan',
    'searchEntries',
    'searchDetail',
    'findBacklinks',
    'findAssetOwner',
    'listRelations',
    'revisionCounts',
    'getRevision',
    'listRevisionMetas',
    'listRevisionLids',
    'revisionDiffStats',
    'exportRevisionChain',
    'listTrash',
    'listAssetMetas',
    'scanAssetRefs',
    'storageProfile',
    'exportImage',
    'runReadOnlySql',
    'openSqlGuest',
    'closeSqlGuest',
  ];

  it('🔴 protocol の op は 1 つ残らず、止めるか通すかが決まっている', () => {
    const ops = allOps();
    // ⚠ 空振り防止 ── 拾えていない走査で「全部仕分け済み」と言わない
    expect(ops.length, 'op を 1 つも拾えていない(走査が壊れている)').toBeGreaterThan(30);
    expect(ops, 'upsertEntry を拾えていない').toContain('upsertEntry');

    const classified = new Set([...CORRUPT_BLOCKED_OPS, ...ALLOWED]);
    const missing = ops.filter((o) => !classified.has(o));
    expect(
      missing,
      `op を足した人が仕分けていない ── CORRUPT_BLOCKED_OPS か ALLOWED へ入れること: ${missing.join(' ')}`,
    ).toEqual([]);

    // ⚠ 両方に入っている物は無い(入れると、読めるのか止まるのか読めなくなる)
    const both = CORRUPT_BLOCKED_OPS.filter((o) => ALLOWED.includes(o));
    expect(both, '止めると通すの両方に入っている').toEqual([]);

    // ⚠ 実在しない名前を止めていない(改名に取り残されていないか)
    const ghosts = CORRUPT_BLOCKED_OPS.filter((o) => !ops.includes(o));
    expect(ghosts, 'protocol に無い op を止めようとしている').toEqual([]);
  });

  it('🔴 持ち出しに要る 4 つは、止めない', () => {
    // 🔑 これが止まると「データは在るのに取り出せない」になる
    for (const o of ['getBody', 'getBodies', 'runReadOnlySql', 'exportImage']) {
      expect(CORRUPT_BLOCKED_OPS, `持ち出す道を塞いだ: ${o}`).not.toContain(o);
    }
  });

  it('🔴 書き換える口は、1 つ残らず止める', () => {
    for (const o of ['upsertEntry', 'reorderEntry', 'deleteEntry', 'renameEntry', 'purgeTrash']) {
      expect(CORRUPT_BLOCKED_OPS, `書き込みを通している: ${o}`).toContain(o);
    }
  });
});

describe('断り文(#971)', () => {
  it('🔑 次の一手が書いてある(「壊れました」で終わらない)', () => {
    expect(CORRUPT_REFUSAL, '持ち出す道を案内していない').toContain('SQL で調べる');
    expect(CORRUPT_REFUSAL, '読めることを言っていない').toContain('読むことはできます');
    // ⚠ 記法を書かない(素のテキストとして出る面がある)
    expect(CORRUPT_REFUSAL).not.toMatch(/\*\*|`/);
    // ⚠ 鍵の綴りを書かない(スマホに F5 は無い)
    expect(CORRUPT_REFUSAL).not.toMatch(/F5|Ctrl|Cmd/);
  });

  it('⚠ 元の字を捨てない(切り分けに要る)', () => {
    const r = corruptReport('reorderEntry', 'database disk image is malformed');
    expect(r, 'どの op で出たか消えている').toContain('reorderEntry');
    expect(r, 'engine の字が消えている').toContain('disk image is malformed');
  });
});
