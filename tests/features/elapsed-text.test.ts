/**
 * 🔴 **経過した時間の見せ方は 1 本**(#279)。
 *
 * ⚠ ここは**寄せた先**である ── 直す前は `features/asset/capture-text.ts` の中に在り、
 *   タイマーが 2 本目を書くところだった(#454 と同じ型)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { elapsedText } from '../../src/features/elapsed-text';
import { codeOnly } from '../helpers/code-only';

describe('経過の見せ方(#279)', () => {
  it('🔴 1 時間を超えたら時を出す(62:03 と書かない)', () => {
    expect(elapsedText(0)).toBe('0:00');
    expect(elapsedText(7_400), '秒は切り捨て(繰り上げない)').toBe('0:07');
    expect(elapsedText(65_000)).toBe('1:05');
    expect(elapsedText(59 * 60_000 + 59_000), 'ここまでは分だけ').toBe('59:59');
    expect(elapsedText(60 * 60_000), 'ここから時が出る').toBe('1:00:00');
    expect(elapsedText(3_723_000)).toBe('1:02:03');
  });

  it('🔴 分と秒は 2 桁に揃える(1:2:3 と書かない)', () => {
    expect(elapsedText(3_600_000 + 2 * 60_000 + 3_000)).toBe('1:02:03');
    // ⚠ **時は揃えない** ── `01:02:03` は「日付か」と読まれる
    expect(elapsedText(10 * 3_600_000)).toBe('10:00:00');
  });

  it('⚠ 負の経過でも壊れない(時計が戻っても帯は出る)', () => {
    expect(elapsedText(-5_000)).toBe('0:00');
  });

  /**
   * 🔴 **2 本目が生えていないことを、中身で見る**(#454 の `humanBytes` と同じ作法)。
   *
   * ⚠ 見るのは「**60 で割って `:` で繋いでいる**」形 ── 名前では見ない
   *   (直す前の名前は `captureElapsed` で、`elapsed` すら入っていなかった)。
   */
  it('🔴 経過を組み立てている場所は elapsed-text.ts だけ', () => {
    const JOIN = /\}:\$\{/g;
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.ts')) files.push(full);
      }
    };
    walk('src');

    const hits = new Map<string, number>();
    for (const f of files) {
      const code = codeOnly(readFileSync(f, 'utf-8'));
      /**
       * ⚠ **時計の字(`HH:MM:SS`)は別物**である ── 見分けるのは
       *   **ミリ秒を割っているか**(`3600` / `60_000` / `/ 1000`)。
       * ⚠ 1 稿目は `% 60` も入れていたので、`datetime-format.ts` の
       *   **時差の分**(`absOffset % 60`)に当たった ── 時刻の組み立てを
       *   「経過の 2 本目」と読む形になっていた。
       */
      if (!/\b3600\b|\b60_?000\b|\/ 1000\b/.test(code)) continue;
      const n = [...code.matchAll(JOIN)].length;
      if (n > 0) hits.set(f, n);
    }

    // ⚠ **空振り防止 2 つ** ── ①走査が届いている ②当の 1 本を実際に拾えている
    expect(files.length, 'src を走査できていない').toBeGreaterThan(200);
    expect(hits.get('src/features/elapsed-text.ts'), 'elapsed-text.ts を拾えていない').toBe(3);

    expect([...hits.keys()].sort(), '経過を自前で組み立てている場所がある').toEqual([
      'src/features/elapsed-text.ts',
    ]);
  });
});
