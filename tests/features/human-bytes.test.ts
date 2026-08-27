/**
 * 🔴 **人が読む「大きさ」は 1 本**(#454)。
 *
 * ⚠ ここは**寄せた先**である ── 直す前は同じ量を出す実装が **4 本**あり
 *   (#454 の本文は 3 本と書いていた ── `detail.ts` の `formatSize` を数えていない)、
 *   さらに **MB だけを自前で綴る場所が 3 か所**あった。
 * 🔑 1 本に寄せたら、**その 1 本を境目で押さえる**のが仕事になる ──
 *   寄せただけでは、守りは 1 ミリも増えない。
 * 🔑 そのうえで **2 本目が生えていないこと**を全数で見る(最後の it)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { humanBytes } from '../../src/features/human-bytes';
import { codeOnly } from '../helpers/code-only';

describe('大きさの見せ方(#454)', () => {
  it('🔴 境目は 1024(1000 ではない)', () => {
    expect(humanBytes(1023), '1023 は B のまま').toBe('1023 B');
    // ⚠ **1000 で切る実装だと `1.0 KB` になる**(変異 U2 の当たり所)
    expect(humanBytes(1010), '1010 を KB にしている(境目が 1000 になっている)').toBe('1010 B');
    expect(humanBytes(1024), '1024 から KB').toBe('1.0 KB');
  });

  it('🔴 単位のあとは小数 1 桁・単位の前に空白(`2.0 KB` であって `2KB` ではない)', () => {
    // ⚠ **寄せ先はこちら**(#454)── 4 本のうち 2 本が既にこの形で、
    //    もう一方は KB を整数へ丸め MB だけ小数 1 桁という、精度の揃わない形だった
    expect(humanBytes(2048)).toBe('2.0 KB');
    expect(humanBytes(1500), '四捨五入していない').toBe('1.5 KB');
    expect(humanBytes(1024 * 1024)).toBe('1.0 MB');
    expect(humanBytes(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(humanBytes(1024 * 1024 * 1024 - 1), 'MB の上に単位を作らない').toBe('1024.0 MB');
  });

  it('🔴 丸めてから単位を決める ── `1024.0 KB` を出さない', () => {
    // ⚠ **境目は 1 バイトで切り替わる。** 先に単位を決める実装だと、
    //    下の 1 件目は同じ答えになり、2 件目だけが `1024.0 KB` になる
    expect(humanBytes(1048524), 'ここはまだ KB').toBe('1023.9 KB');
    expect(humanBytes(1048525), '丸めた結果 1024.0 KB になる所を MB へ繰り上げていない').toBe(
      '1.0 MB',
    );
  });

  it('⚠ 0 と小さい数(「0 B」を「」にしない)', () => {
    expect(humanBytes(0)).toBe('0 B');
    expect(humanBytes(1)).toBe('1 B');
  });

  /**
   * 🔴 **2 本目が生えていないことを、名前ではなく中身で見る**(#454)。
   *
   * ⚠ 名前で見ると駄目である ── 直す前の 4 本は `formatBytes` / `humanBytes` /
   *   `formatSize` と**名前がばらけていた**うえ、`formatBytes` は 2 本あった。
   * 🔑 見るのは「**実行時の値にバイト単位を付けている**」形
   *   (`${…}B` / `${…} KB` / `${…}MB`)── 散文の中の `77MB` のような
   *   **書き置きの数字は当たらない**(前が `}` ではない)。
   */
  it('🔴 バイト単位を付けている場所は human-bytes.ts だけ', () => {
    const UNIT = /\}\s?(B|KB|MB|GB|TB)(?![A-Za-z])/g;
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
      const n = [...codeOnly(readFileSync(f, 'utf-8')).matchAll(UNIT)].length;
      if (n > 0) hits.set(f, n);
    }

    // ⚠ **空振り防止 2 つ** ── ①走査が届いている ②当の 1 本を実際に拾えている
    //   (拾えなくなったら「1 本も無い」で緑になる = 検査が消える)
    expect(files.length, 'src を走査できていない').toBeGreaterThan(200);
    expect(hits.get('src/features/human-bytes.ts'), 'human-bytes.ts を拾えていない').toBe(3);

    expect([...hits.keys()].sort(), '大きさを自前で綴っている場所がある').toEqual([
      'src/features/human-bytes.ts',
    ]);
  });
});
