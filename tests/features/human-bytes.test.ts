/**
 * 🔴 **人が読む「大きさ」は 1 本**(#454)。
 *
 * ⚠ ここは**寄せた先**である ── 直す前は同じ実装が 2 本在り、
 *   どちらの test も **512 と 2048 と 2MB ちょうど**しか見ていなかった。
 *   だから **丸め方と境目を変える変異が 2 件とも生き延びた**
 *   (2026-08-27 の変異試験 U1 / U2)。
 * 🔑 1 本に寄せたら、**その 1 本を境目で押さえる**のが仕事になる ──
 *   寄せただけでは、守りは 1 ミリも増えない。
 */
import { describe, expect, it } from 'vitest';
import { humanBytes } from '../../src/features/asset/human-bytes';

describe('大きさの見せ方(#454)', () => {
  it('🔴 境目は 1024(1000 ではない)', () => {
    expect(humanBytes(1023), '1023 は B のまま').toBe('1023B');
    // ⚠ **ここが変異 U2 の当たり所** ── 1000 で切る実装だと `1KB` になる
    expect(humanBytes(1010), '1010 を KB にしている(境目が 1000 になっている)').toBe('1010B');
    expect(humanBytes(1024), '1024 から KB').toBe('1KB');
  });

  it('🔴 KB は四捨五入する(切り捨てない)', () => {
    // ⚠ **ここが変異 U1 の当たり所** ── 切り捨てだと 1 になる
    expect(humanBytes(1600), '1600 を切り捨てている').toBe('2KB');
    expect(humanBytes(1500), '境目の丸めが違う').toBe('1KB');
    expect(humanBytes(2048)).toBe('2KB');
  });

  it('🔴 MB は小数 1 桁(桁を増やさない)', () => {
    expect(humanBytes(1024 * 1024)).toBe('1.0MB');
    expect(humanBytes(2 * 1024 * 1024)).toBe('2.0MB');
    expect(humanBytes(1024 * 1024 * 1024 - 1), 'MB の上に単位を作らない').toBe('1024.0MB');
  });

  it('⚠ 0 と小さい数(「0B」を「」にしない)', () => {
    expect(humanBytes(0)).toBe('0B');
    expect(humanBytes(1)).toBe('1B');
  });

  it('🔴 呼び名が 2 つに戻っていない(同じ実装が 2 本になった合図)', async () => {
    // ⚠ **再輸出は同じ関数**でなければならない ── 別の実装を置いたら落ちる
    const shrink = await import('../../src/features/asset/image-shrink');
    const fence = await import('../../src/features/markdown/fence-asset');
    expect(shrink.humanBytes, 'image-shrink が別の実装を持っている').toBe(humanBytes);
    expect(fence.humanBytes, 'fence-asset が別の実装を持っている').toBe(humanBytes);
  });
});
