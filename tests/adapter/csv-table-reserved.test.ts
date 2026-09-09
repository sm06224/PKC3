/**
 * 🔴 **csv の表が、中の表を隠さない**(#681 段③)。
 *
 * ⚠ temp の表は**同じ名前の本表を隠す** ── ` ```csv name=entries ` と書いた人が
 *   `SELECT * FROM entries` を打つと、**ノートではなく自分の csv が出る**。
 *   本人は「ノートを数えたつもり」なので、⚠ **答えが違うことに気づけない**
 *   (CLAUDE.md §4「いちばん気づけない外し方」)。
 *
 * 🔑 **一覧は 2 か所に在る**(features 層から adapter 層は import できない)ので、
 *   ここが**両方を読んで**揃っているかを検める(§7「同じ値が複数の場所にある」)。
 * ⚠ だから schema に表を足した人は、ここが落ちて気づく。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CSV_TABLE_RESERVED,
  csvTableNameWhy,
  validCsvTableName,
} from '../../src/features/query/csv-tables';

/** `schema.ts` が実際に作る表の名前(原文から拾う)。 */
function schemaTables(): string[] {
  const src = readFileSync(join(process.cwd(), 'src/adapter/platform/storage/schema.ts'), 'utf-8');
  const found = [...src.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z_0-9]+)/g)].map(
    (m) => (m[1] ?? '').toLowerCase(),
  );
  return [...new Set(found)].sort();
}

describe('csv の表は、中の表を隠さない(#681 段③)', () => {
  it('🔴 schema が作る表は、全部予約されている', () => {
    const tables = schemaTables();
    // 空振り防止 ── 拾えていない形で「全部入っている」と言わない
    expect(tables.length, 'schema から表を 1 つも拾えていない').toBeGreaterThan(5);
    expect(tables, 'entries を拾えていない(走査が壊れている)').toContain('entries');
    const missing = tables.filter((t) => !CSV_TABLE_RESERVED.includes(t));
    expect(
      missing,
      `schema に足した表が予約に無い ── CSV_TABLE_RESERVED に足すこと: ${missing.join(' ')}`,
    ).toEqual([]);
  });

  it('🔴 予約された名前は受けない ── 理由も言う', () => {
    for (const name of CSV_TABLE_RESERVED) {
      expect(validCsvTableName(name), `受けてはいけない名前: ${name}`).toBe(false);
      expect(csvTableNameWhy(name), `理由を言っていない: ${name}`).toContain('中の仕組み');
    }
  });

  /** 🔑 **目録の名前も予約に入っている**(取られると、名前を知る道が消える)。 */
  it('🔑 目録(csv_tables)も予約されている', () => {
    expect(CSV_TABLE_RESERVED).toContain('csv_tables');
  });

  /** ⚠ 対照群 ── 予約でない名前は受ける(全部断る形になっていない)。 */
  it('⚠ 予約でない名前は受ける', () => {
    expect(validCsvTableName('売上')).toBe(true);
    expect(validCsvTableName('entries_2')).toBe(true);
  });
});
