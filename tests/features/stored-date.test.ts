/**
 * DB の時刻文字列 → 表示(P9 段②)。
 *
 * 🔴 **規則を 1 つに寄せたことの pin**。情報列・一覧の行・フォルダ面が
 * それぞれ独自に `/^(\d{4})-(\d{2})-(\d{2})/` を持っていた(3 つ)。
 * 同じ判定が増えると片方だけ直す事故が起きる(CLAUDE.md)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatListDate,
  formatStoredDate,
  storedDateParts,
} from '@features/datetime/stored-date';

describe('DB の時刻を表示に落とす', () => {
  it('🔴 `Date` を通さない(UTC の深夜が翌日にずれない)', () => {
    // ⚠ これが本題 ── `new Date('2026-08-04 23:30:00')` を日本時間で読むと
    //    8/5 になる。**DB に書かれている日**を出すのが正しい
    expect(formatStoredDate('2026-08-04 23:30:00')).toBe('2026/08/04');
    expect(formatStoredDate('2026-08-04 00:10:00')).toBe('2026/08/04');
    expect(formatStoredDate('2026-12-31 23:59:59')).toBe('2026/12/31');
  });

  it('無い値は fallback、読めない値はそのまま出す(黙って消さない)', () => {
    expect(formatStoredDate(null)).toBe('—');
    expect(formatStoredDate('')).toBe('—');
    expect(formatStoredDate(undefined, '')).toBe('');
    // ⚠ 形が違う値を捨てない ── 「読めなかった」が見えるほうがよい
    expect(formatStoredDate('2026/08/04')).toBe('2026/08/04');
    expect(formatStoredDate('なにか')).toBe('なにか');
    expect(storedDateParts('なにか')).toBeNull();
  });

  it('🔴 一覧の行は今年なら MM/DD、他の年なら年つき', () => {
    expect(formatListDate('2026-08-04 12:00:00', 2026)).toBe('08/04');
    expect(formatListDate('2025-12-31 12:00:00', 2026)).toBe('2025/12/31');
    // 年の判定は**引数**で受ける(内部で now を読むと年明けに落ちる)
    expect(formatListDate('2026-08-04 12:00:00', 2027)).toBe('2026/08/04');
    expect(formatListDate(null, 2026)).toBe('');
  });
});

/** src 配下の TS を全部集める。 */
function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('規則は 1 つ', () => {
  it('🔴 日付を切る正規表現が stored-date 以外に生えていない', () => {
    const own = 'src/features/datetime/stored-date.ts';
    // ⚠ 「日付らしい正規表現」ではなく **この形**(年-月-日 を 3 つ捕まえる)で探す。
    //    広く拾うと import の判定や CSV の parse を誤検知する
    const pattern = /\(\\d\{4\}\)-\(\\d\{2\}\)-\(\\d\{2\}\)/;
    const offenders = tsFiles('src')
      .filter((f) => f !== own)
      .filter((f) => pattern.test(readFileSync(f, 'utf-8')));
    expect(
      offenders,
      '日付の切り方が 2 か所以上にある ── stored-date.ts に寄せる',
    ).toEqual([]);
  });

  it('🔴 この検査が空振りしていない(正本の側では必ず当たる)', () => {
    // ⚠ 検査する側も変異試験の対象(CLAUDE.md)── 探し方が壊れていれば
    //    「違反 0 件」は何も意味しない。正本で当たることを確かめる
    const pattern = /\(\\d\{4\}\)-\(\\d\{2\}\)-\(\\d\{2\}\)/;
    expect(pattern.test(readFileSync('src/features/datetime/stored-date.ts', 'utf-8'))).toBe(
      true,
    );
  });

  it('🔴 3 つの表示元がすべて共有の関数を使っている', () => {
    for (const f of [
      'src/adapter/ui/render/inspector.ts',
      'src/adapter/ui/render/sidebar.ts',
      'src/adapter/ui/render/filer.ts',
    ]) {
      expect(readFileSync(f, 'utf-8'), `${f} が stored-date を使っていない`).toContain(
        'stored-date',
      );
    }
  });
});
