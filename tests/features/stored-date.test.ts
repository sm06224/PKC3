/**
 * DB の時刻文字列 → 表示(P9 段②。#709 で向きを直した)。
 *
 * 🔴 **規則を 1 つに寄せたことの pin**。情報列・一覧の行・フォルダ面が
 * それぞれ独自に `/^(\d{4})-(\d{2})-(\d{2})/` を持っていた(3 つ)。
 * 同じ判定が増えると片方だけ直す事故が起きる(CLAUDE.md)。
 *
 * 🔴 **TZ を固定して回す**(#709)。sqlite の `datetime('now')` は UTC で、
 * 直す前は先頭 10 字を切っていたので **UTC の暦日**が出ていた ── 日本の 0 時〜9 時に
 * 書いたノートは前日で出る。ここは `process.env.TZ` を切り替えて
 * **UTC と JST で答えが違う**ことを見る(CI は UTC、手元が JST でも UTC でも緑)。
 * ⚠ 対照群を先頭に置く ── TZ の切り替えが効いていない箱では以下が全部空振りになる
 * (`tests/features/date-math.test.ts` と同じ作法)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatListDate,
  formatStoredDate,
  storedDateParts,
  storedInstantIso,
} from '@features/datetime/stored-date';

/** `tz` の下で `fn` を回し、必ず元へ戻す。 */
function withTZ<T>(tz: string, fn: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

describe('DB の時刻を表示に落とす', () => {
  it('⚠ 対照群 ── TZ の切り替えが実際に効いていること(効いていなければ以下は空振り)', () => {
    const at = new Date('2026-08-04T23:30:00Z');
    expect(withTZ('Asia/Tokyo', () => at.getDate()), 'JST に切り替わっていない').toBe(5);
    expect(withTZ('UTC', () => at.getDate()), 'UTC に切り替わっていない').toBe(4);
  });

  it('🔴 UTC の深夜は、端末の暦日で出る(JST では翌日、UTC ではその日)', () => {
    // ⚠ これが本題(#709)── cowork 実測: 07:00 JST に作ったノートの作成欄が前日だった
    withTZ('Asia/Tokyo', () => {
      expect(formatStoredDate('2026-08-04 23:30:00')).toBe('2026/08/05');
      expect(formatStoredDate('2026-08-04 14:59:59')).toBe('2026/08/04'); // 23:59:59 JST
      expect(formatStoredDate('2026-08-04 15:00:00')).toBe('2026/08/05'); // 00:00:00 JST
      expect(formatStoredDate('2026-12-31 23:59:59')).toBe('2027/01/01'); // 年も繰り上がる
    });
    withTZ('UTC', () => {
      expect(formatStoredDate('2026-08-04 23:30:00')).toBe('2026/08/04');
      expect(formatStoredDate('2026-12-31 23:59:59')).toBe('2026/12/31');
    });
    // 西側(UTC−4)── 反対向きにずれる
    withTZ('America/New_York', () => {
      expect(formatStoredDate('2026-08-05 02:00:00')).toBe('2026/08/04');
    });
  });

  it('🔴 時刻を持たない値(予定の暦日)は、どの TZ でもずらさない', () => {
    // ⚠ `@2026-08-25` / frontmatter の `date:` は瞬間ではなく暦日 ──
    //    `date-math` / `agenda` / `repeat` / `alarm-due` がここを通す
    for (const tz of ['Asia/Tokyo', 'UTC', 'America/New_York', 'Pacific/Kiritimati']) {
      withTZ(tz, () => {
        expect(storedDateParts('2026-08-25'), `TZ=${tz} で暦日がずれた`).toEqual({
          year: '2026',
          month: '08',
          day: '25',
        });
        expect(formatStoredDate('2026-08-25')).toBe('2026/08/25');
      });
    }
  });

  it('時差の印を持つ値は、その印のとおりに読む(`Z` を二重に付けない)', () => {
    withTZ('Asia/Tokyo', () => {
      expect(formatStoredDate('2026-08-04T23:30:00Z')).toBe('2026/08/05');
      // +09:00 の 08:30 = 23:30Z(前の行と同じ瞬間)
      expect(formatStoredDate('2026-08-05T08:30:00+09:00')).toBe('2026/08/05');
    });
    withTZ('UTC', () => {
      expect(formatStoredDate('2026-08-05T08:30:00+09:00')).toBe('2026/08/04');
    });
  });

  it('無い値は fallback、読めない値はそのまま出す(黙って消さない)', () => {
    expect(formatStoredDate(null)).toBe('—');
    expect(formatStoredDate('')).toBe('—');
    expect(formatStoredDate(undefined, '')).toBe('');
    // ⚠ 形が違う値を捨てない ── 「読めなかった」が見えるほうがよい
    expect(formatStoredDate('2026/08/04')).toBe('2026/08/04');
    expect(formatStoredDate('なにか')).toBe('なにか');
    expect(storedDateParts('なにか')).toBeNull();
    // 時刻の形はあるが `Date` が読めない値 ── 先頭 10 字を切る(今までどおり素通し)
    expect(formatStoredDate('2026-13-45 99:99:99')).toBe('2026/13/45');
  });

  it('🔴 一覧の行は今年なら MM/DD、他の年なら年つき ── 年も端末の暦日で比べる', () => {
    withTZ('UTC', () => {
      expect(formatListDate('2026-08-04 12:00:00', 2026)).toBe('08/04');
      expect(formatListDate('2025-12-31 12:00:00', 2026)).toBe('2025/12/31');
      // 年の判定は**引数**で受ける(内部で now を読むと年明けに落ちる)
      expect(formatListDate('2026-08-04 12:00:00', 2027)).toBe('2026/08/04');
      expect(formatListDate(null, 2026)).toBe('');
    });
    // ⚠ UTC の年末は JST では新年 ── 「今年」の判定も端末の側で行う
    withTZ('Asia/Tokyo', () => {
      expect(formatListDate('2025-12-31 23:30:00', 2026)).toBe('01/01');
    });
    withTZ('UTC', () => {
      expect(formatListDate('2025-12-31 23:30:00', 2026)).toBe('2025/12/31');
    });
  });

  it('`<time datetime>` 向けの瞬間は UTC の ISO、暦日だけの値には付けない', () => {
    // ⚠ 端末の TZ に依らない(機械可読な値は 1 つ)
    for (const tz of ['Asia/Tokyo', 'UTC']) {
      withTZ(tz, () => {
        expect(storedInstantIso('2026-08-04 23:30:00')).toBe('2026-08-04T23:30:00.000Z');
        expect(storedInstantIso('2026-08-05T08:30:00+09:00')).toBe('2026-08-04T23:30:00.000Z');
      });
    }
    expect(storedInstantIso('2026-08-25')).toBeNull();
    expect(storedInstantIso('2026-13-45 99:99:99')).toBeNull();
    expect(storedInstantIso(null)).toBeNull();
    expect(storedInstantIso('なにか')).toBeNull();
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

  /**
   * 🔴 **書き出す file 名の「今日」を UTC で組む書き方が戻っていない**(#709)。
   * ⚠ `toISOString().slice(0, 10)` は UTC の暦日 ── 直す前は設定 / 連絡先の書き出しが
   *   これで、バックアップ(端末の暦日)と**同じ日に落とした file の日付が食い違った**。
   * ⚠ コメントを落としてから見る(CLAUDE.md §1「見るのは実行する行」)。
   */
  it('🔴 `toISOString().slice(0, 10)` で「今日」を組む行が src に無い', () => {
    const offenders = tsFiles('src').filter((f) =>
      /toISOString\(\)\.slice\(0,\s*10\)/.test(
        readFileSync(f, 'utf-8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, ''),
      ),
    );
    expect(offenders, '「今日」を UTC で組んでいる ── date-math の dayStamp に寄せる').toEqual(
      [],
    );
  });
});
