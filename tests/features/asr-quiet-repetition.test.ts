/**
 * 🔴 小さな雑音に出る「同じ語のくり返し」の判定(#1446)。全部か無しか ── 直さず捨てる。
 * 境界は 4 つ(RMS / 語数 / 語彙数 / 区切り)を、それぞれ片側だけ変えた対で見る。
 */
import { describe, expect, it } from 'vitest';
import {
  ASR_QUIET_RMS,
  ASR_REPEAT_MAX_VOCAB,
  ASR_REPEAT_MIN_WORDS,
  isQuietRepetition,
} from '../../src/features/asr/asr-text';

const QUIET = 3.9e-3; // −48 dBFS(実測で `you you you` が出た雑音)
const LOUD = 0.05; // 普通の声(RMS 1e-2 より上)

describe('isQuietRepetition', () => {
  it('定数は裁定の値(1e-2 / 5 語 / 語彙 3)', () => {
    expect(ASR_QUIET_RMS).toBe(1e-2);
    expect(ASR_REPEAT_MIN_WORDS).toBe(5);
    expect(ASR_REPEAT_MAX_VOCAB).toBe(3);
  });

  it.each<[string, string, number, boolean]>([
    ['小さい + くり返し → 捨てる', 'you you you you you', QUIET, true],
    ['−68 dBFS でも捨てる', 'you you you you you', 4e-4, true],
    ['大文字小文字は同じ語', 'You you YOU yOu YoU', QUIET, true],
    ['普通の声(大きい)のくり返しは残す', 'はいはいはい はい はい', LOUD, false],
    ['普通の声の you you you も残す', 'you you you you you', LOUD, false],
    ['境界: RMS がちょうど 1e-2 は普通の声側(残す)', 'you you you you you', 1e-2, false],
    ['小さい + 語彙 4 つ → 残す', 'a b c d a b c d', QUIET, false],
    ['小さい + 語彙 3 つ(上限)→ 捨てる', 'a b c a b c', QUIET, true],
    ['小さい + 4 語 → 残す', 'you you you you', QUIET, false],
    ['小さい + 5 語(下限)→ 捨てる', 'you you you you you', QUIET, true],
    ['日本語の読点区切り', 'カ、カ、カ、カ、カ、', QUIET, true],
    ['句点・感嘆符・三点リーダ・ASCII 記号でも区切る', 'ん。ん!ん?ん…ん,ん.', QUIET, true],
    ['全角の ！？，． も区切る', 'ん！ん？ん，ん．ん', QUIET, true],
    ['空文字は捨てない(語が無い)', '', QUIET, false],
    ['記号だけは捨てない', '。、。、…', QUIET, false],
    ['普通の短い文は残す', 'こんにちは。今日は晴れです', QUIET, false],
  ])('%s', (_name, text, rms, expected) => {
    expect(isQuietRepetition(text, rms)).toBe(expected);
  });
});
