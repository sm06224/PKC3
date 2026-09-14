/**
 * 🔴 **EBML の読み書き**(#683 段②a)。
 *
 * ⚠ ここに在るのは**直に当てる test** である ── `webm-opus.test.ts` は
 * 組み上がった file 越しにしか触らないので、**境目の値が 1 度も通らない**
 * (変異試験 E2〜E5 が SURVIVED で教えた:不明な大きさ / 127 バイト /
 * 符号ビットが立つ値 / 16 ビットのはみ出しは、あちらの fixture に 1 つも無い)。
 * 🔑 **門を N 個置いたら、N 個目だけが鳴る場面を N 通り作る**(CLAUDE.md §1)。
 */
import { describe, expect, it } from 'vitest';
import {
  concatBytes,
  element,
  int16Bytes,
  intBytes,
  readAscii,
  readId,
  readSizeAt,
  readUint,
  uintBytes,
  writeSize,
} from '../../src/features/audio/ebml';

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

describe('大きさを読む(readSizeAt)', () => {
  it('1 バイトの大きさ ── 印を落とす', () => {
    expect(readSizeAt(Uint8Array.of(0x85), 0)).toEqual({ value: 5, length: 1 });
  });

  it('2 バイトの大きさ', () => {
    expect(readSizeAt(Uint8Array.of(0x40, 0x7f), 0)).toEqual({ value: 127, length: 2 });
  });

  /**
   * 🔴 **「不明な大きさ」は値ではなく `null`**(`MediaRecorder` は録りながら書くので、
   *   `Segment` の大きさを不明のまま出す)。⚠ 値として読むと、入れ物の中身を
   *   **丸ごと飛ばす**ことになり、packet が 1 つも見つからない。
   */
  it('🔴 全ビット 1 は「不明」── 値を返さない', () => {
    expect(readSizeAt(Uint8Array.of(0xff), 0), '1 バイトの不明').toEqual({ value: null, length: 1 });
    expect(readSizeAt(Uint8Array.of(0x1f, 0xff, 0xff, 0xff), 0), '4 バイトの不明').toEqual({
      value: null,
      length: 4,
    });
  });

  it('⚠ 対照群 ── 全ビット 1 でなければ値が返る', () => {
    expect(readSizeAt(Uint8Array.of(0x1f, 0xff, 0xff, 0xfe), 0)).toEqual({
      value: 0x0ffffffe,
      length: 4,
    });
  });

  it('🔴 この言語の整数で表せない大きさも null(黙って丸めない)', () => {
    // 8 バイト = 最大 2^56-1。⚠ `Number.MAX_SAFE_INTEGER` を超える
    expect(readSizeAt(Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe), 0)).toEqual({
      value: null,
      length: 8,
    });
  });

  it('⚠ 先頭が 0 / 足りない bytes は読めない', () => {
    expect(readSizeAt(Uint8Array.of(0x00), 0)).toBeNull();
    expect(readSizeAt(Uint8Array.of(0x40), 0), '2 バイト要るのに 1 バイトしか無い').toBeNull();
    expect(readSizeAt(Uint8Array.of(0x81), 5)).toBeNull();
  });
});

describe('id を読む(readId)', () => {
  it('印を落とさない(落とすと別の id になる)', () => {
    expect(readId(Uint8Array.of(0xa3), 0)).toEqual({ id: 'a3', length: 1 });
    expect(readId(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3), 0)).toEqual({ id: '1a45dfa3', length: 4 });
  });

  it('⚠ 5 バイト以上の id は無い', () => {
    expect(readId(Uint8Array.of(0x08, 1, 2, 3, 4), 0)).toBeNull();
  });
});

describe('大きさを書く(writeSize)', () => {
  /**
   * 🔴 **「不明」を表す値は使わない**(全ビット 1)── 使うと読み手が
   *   「大きさが決まっていない」と読み、**その後ろを全部その要素の中身**にする。
   * ⚠ 境目は **127**(1 バイトで書ける最大 + 1)と **16383**(2 バイト)である。
   */
  it('🔴 境目で 1 段繰り上がる(不明を表す値を書かない)', () => {
    expect(hex(writeSize(126)), '126 は 1 バイト').toBe('fe');
    expect(writeSize(127), '127 は「不明」なので 2 バイトへ逃がす').toHaveLength(2);
    expect(hex(writeSize(127))).toBe('40 7f');
    expect(writeSize(16382), '16382 は 2 バイト').toHaveLength(2);
    expect(writeSize(16383), '16383 は「不明」なので 3 バイトへ逃がす').toHaveLength(3);
  });

  it('⚠ 読み戻せる(書いた値がそのまま返る)', () => {
    for (const n of [0, 1, 126, 127, 128, 16382, 16383, 16384, 1_000_000]) {
      expect(readSizeAt(writeSize(n), 0)?.value, `${n} が往復しない`).toBe(n);
    }
  });

  it('⚠ 負や整数でない値は書けない', () => {
    expect(() => writeSize(-1)).toThrow();
    expect(() => writeSize(1.5)).toThrow();
  });
});

describe('整数を書く', () => {
  it('符号なしは最短(0 は 1 バイト ── 空にしない)', () => {
    expect(hex(uintBytes(0))).toBe('00');
    expect(hex(uintBytes(1))).toBe('01');
    expect(hex(uintBytes(255))).toBe('ff');
    expect(hex(uintBytes(256))).toBe('01 00');
    expect(hex(uintBytes(1000000))).toBe('0f 42 40');
  });

  /**
   * 🔴 **正の値でも最上位ビットが立ったら 1 バイト足す**(変異試験 E4)。
   *
   * ⚠ 足さないと、読み手に**負の値**として届く ── `DiscardPadding` が負になると
   *   尻が削れずに**伸びる**(切ったのに長い、という読めない結果になる)。
   */
  it('🔴 符号つきは、最上位ビットが立つ所で 1 バイト足す', () => {
    expect(hex(intBytes(127)), '127 は 1 バイトで足りる').toBe('7f');
    expect(hex(intBytes(128)), '128 は符号ビットに当たるので 2 バイト').toBe('00 80');
    expect(hex(intBytes(200))).toBe('00 c8');
    expect(hex(intBytes(32767))).toBe('7f ff');
    expect(hex(intBytes(32768))).toBe('00 80 00');
    // ⚠ 実際に書く値(40ms = 4000 万ナノ秒)も見ておく
    expect(intBytes(40_000_000)[0]! & 0x80, '尻の札が負として届く').toBe(0);
  });

  it('⚠ 負の値は 2 の補数', () => {
    expect(hex(intBytes(-1))).toBe('ff');
    expect(hex(intBytes(-128))).toBe('80');
    expect(hex(intBytes(-129))).toBe('ff 7f');
  });

  /**
   * 🔴 **block の相対時刻は必ず 2 バイト**(変異試験 E5)。
   * ⚠ はみ出したら**黙って折り返さない** ── 折り返すと、時刻が巻き戻った
   *   file ができて、再生が途中で止まる。
   */
  it('🔴 16 ビットからはみ出したら投げる(黙って折り返さない)', () => {
    expect(hex(int16Bytes(0))).toBe('00 00');
    expect(hex(int16Bytes(30000))).toBe('75 30');
    expect(hex(int16Bytes(-1))).toBe('ff ff');
    expect(() => int16Bytes(32768), '上へはみ出しても通る').toThrow();
    expect(() => int16Bytes(-32769), '下へはみ出しても通る').toThrow();
  });
});

describe('読む道具', () => {
  it('末尾の詰め物を落とす(上流は偶数長に揃えることがある)', () => {
    expect(readAscii(Uint8Array.of(65, 95, 79, 80, 85, 83, 0, 0))).toBe('A_OPUS');
    // ⚠ 真ん中の詰め物は落とさない(末尾だけを剥がす)
    expect(readAscii(Uint8Array.of(65, 0, 66))).toBe('A\u0000B');
  });

  it('符号なし整数 ── 精度を超えたら null', () => {
    expect(readUint(Uint8Array.of(0x0f, 0x42, 0x40))).toBe(1_000_000);
    expect(readUint(new Uint8Array(0)), '空は 0').toBe(0);
    expect(readUint(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff))).toBeNull();
  });
});

describe('要素を組む(element)', () => {
  it('id + 大きさ + 中身', () => {
    expect(hex(element('86', Uint8Array.of(65, 66)))).toBe('86 82 41 42');
  });

  it('⚠ つないでも壊れない', () => {
    const out = concatBytes([element('d7', uintBytes(1)), element('83', uintBytes(2))]);
    expect(hex(out)).toBe('d7 81 01 83 81 02');
  });
});
