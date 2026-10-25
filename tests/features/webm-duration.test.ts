/**
 * 🔴 **webm の先頭から長さを読む**(`webm-duration.ts`。着地前レビュー ⚠3 ── 復号の前に長すぎる録音を断る材料)。
 *
 * ⚠ fixture は実装の書き手(`ebml.ts` の `element`)と、手で数えたバイト列の両方で組む(共有の盲点を避ける)。
 */
import { describe, expect, it } from 'vitest';
import { webmDurationMs } from '../../src/features/audio/webm-duration';
import { asciiBytes, concatBytes, element, float64Bytes, hexBytes, uintBytes } from '../../src/features/audio/ebml';

const UNKNOWN = Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
const ebmlHead = (): Uint8Array => element('1a45dfa3', element('4282', asciiBytes('webm')));
const segmentOf = (...children: Uint8Array[]): Uint8Array => concatBytes([hexBytes('18538067'), UNKNOWN, ...children]);
const infoOf = (...children: Uint8Array[]): Uint8Array => element('1549a966', concatBytes(children));
const scale = (ns: number): Uint8Array => element('2ad7b1', uintBytes(ns));
const duration64 = (ticks: number): Uint8Array => element('4489', float64Bytes(ticks));

describe('webmDurationMs', () => {
  it('🔴 Duration を TimestampScale の目盛りからミリ秒に直す(既定 1ms / 別の目盛りでは換算する)', () => {
    expect(webmDurationMs(concatBytes([ebmlHead(), segmentOf(infoOf(scale(1_000_000), duration64(2_400_000)))]))).toBe(2_400_000);
    // 目盛り 500000ns = 0.5ms:10000 目盛り = 5000ms(生の値をそのまま ms と読むと倍になる)
    expect(webmDurationMs(concatBytes([ebmlHead(), segmentOf(infoOf(scale(500_000), duration64(10_000)))]))).toBe(5000);
    // TimestampScale が書かれていなければ既定の 1ms
    expect(webmDurationMs(concatBytes([ebmlHead(), segmentOf(infoOf(duration64(1234)))]))).toBe(1234);
  });

  it('4 バイトの浮動小数(float32)の Duration も読める', () => {
    const f32 = new Uint8Array(4);
    new DataView(f32.buffer).setFloat32(0, 90_000, false);
    expect(webmDurationMs(concatBytes([ebmlHead(), segmentOf(infoOf(scale(1_000_000), element('4489', f32)))]))).toBe(90_000);
  });

  it('🔴 Duration が無い(MediaRecorder の素のまま)・Info より先に Cluster が来る・先頭が足りない・webm でない は null', () => {
    expect(webmDurationMs(concatBytes([ebmlHead(), segmentOf(infoOf(scale(1_000_000)))]))).toBeNull();
    expect(webmDurationMs(concatBytes([ebmlHead(), segmentOf(element('1f43b675', element('e7', uintBytes(0))), infoOf(duration64(1000)))]))).toBeNull();
    const whole = concatBytes([ebmlHead(), segmentOf(infoOf(scale(1_000_000), duration64(1000)))]);
    expect(webmDurationMs(whole.subarray(0, whole.length - 3)), 'Info の途中で切れている').toBeNull();
    expect(webmDurationMs(Uint8Array.of(1, 2, 3, 4, 5, 6))).toBeNull();
    expect(webmDurationMs(new Uint8Array(0))).toBeNull();
  });

  it('壊れた値(負・NaN)は読まない', () => {
    expect(webmDurationMs(concatBytes([ebmlHead(), segmentOf(infoOf(duration64(-5)))]))).toBeNull();
    expect(webmDurationMs(concatBytes([ebmlHead(), segmentOf(infoOf(duration64(Number.NaN)))]))).toBeNull();
  });

  it('Info の前に別の要素(Void など)があっても歩いて見つける', () => {
    const voidEl = element('ec', new Uint8Array(6));
    expect(webmDurationMs(concatBytes([ebmlHead(), segmentOf(voidEl, infoOf(scale(1_000_000), duration64(777)))]))).toBe(777);
  });
});
