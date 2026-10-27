/**
 * 🔴 **切り出した録音へ移す文字起こしの行**(#1232)。期待値は手で書いた固定の字で守る。
 */
import { describe, expect, it } from 'vitest';
import { clipTranscript } from '../../src/features/capture/clip-transcript';

const body = (...lines: string[]): string => ['---', 'attachment.name: x.webm', '---', '', ...lines].join('\n');

describe('範囲にかかる文字起こしの行を移す', () => {
  // 0:05 [5〜15 秒) / 0:15 [15〜45 秒) / 1:02:03 [最後の行なので 30 秒)
  const B = body(
    '## 文字起こし 2026-10-02 12:34',
    '0:05 こんにちは',
    '0:15 本題です',
    '1:02:03 長い録音の終わり近く',
  );

  it('範囲にかかる行を、始まりを引いた時刻で返す。始まりより前から続く発言は 0:00 に置く', () => {
    // 10〜20 秒: 0:05 の発言は 10 秒の時点でまだ続いている(→ 0:00)/ 0:15 は範囲の中(→ 0:05)
    expect(clipTranscript(B, 10_000, 20_000)).toEqual({ text: '0:00 こんにちは\n0:05 本題です', lines: 2 });
  });
  it('発言が終わった後ろから始まる範囲には、その発言は入らない(終わりちょうど = 入らない)', () => {
    expect(clipTranscript(B, 15_000, 20_000)).toEqual({ text: '0:00 本題です', lines: 1 });
    expect(clipTranscript(B, 14_999, 20_000)?.lines).toBe(2);
  });
  it('範囲の終わりちょうどから始まる発言は入らない', () => {
    expect(clipTranscript(B, 5_000, 15_000)).toEqual({ text: '0:00 こんにちは', lines: 1 });
    expect(clipTranscript(B, 5_000, 15_001)?.lines).toBe(2);
  });
  it('時間つきの綴り(1:02:03)も引ける。最後の行は 30 秒だけ続くとみなす', () => {
    expect(clipTranscript(B, 3_700_000, 3_800_000)).toEqual({ text: '0:23 長い録音の終わり近く', lines: 1 });
    // 対照: 最後の行の 30 秒後(3,753,000)以降の範囲には入らない ── 無音の末尾に前の発言が混ざらない
    expect(clipTranscript(B, 3_753_000, 3_800_000)).toBeNull();
    expect(clipTranscript(B, 3_752_999, 3_800_000)?.lines).toBe(1);
  });
  it('次の行が遠いときも、1 行は 30 秒までしか続かない', () => {
    // 0:15 の次は 1:02:03 まで空く ── 0:15 は 45 秒まで。60 秒〜の範囲には入らない
    expect(clipTranscript(B, 60_000, 90_000)).toBeNull();
  });
  it('範囲にかかる行が無ければ null', () => {
    expect(clipTranscript(B, 100_000, 110_000)).toBeNull();
  });
  it('文字起こしの節が無ければ null(時刻に見える行があっても拾わない)', () => {
    expect(clipTranscript(body('0:15 ただのメモ'), 0, 60_000)).toBeNull();
    expect(clipTranscript('', 0, 60_000)).toBeNull();
  });
  it('🔴 見るのはいちばん最後の節だけ(古い節の行を混ぜない)', () => {
    const two = body(
      '## 文字起こし 2026-10-01 09:00',
      '0:15 古い版',
      '',
      '## 文字起こし 2026-10-02 12:34',
      '0:15 新しい版',
    );
    expect(clipTranscript(two, 10_000, 20_000)).toEqual({ text: '0:05 新しい版', lines: 1 });
  });
  it('節は次の見出しで終わる(後ろの別の節の時刻の行を拾わない)', () => {
    const b = body('## 文字起こし 2026-10-02 12:34', '0:15 これ', '', '## 議事録', '0:16 別の物');
    expect(clipTranscript(b, 0, 60_000)).toEqual({ text: '0:15 これ', lines: 1 });
  });
  it('読めない綴り(0:75)・時刻の無い行は移さない', () => {
    const b = body('## 文字起こし 2026-10-02 12:34', '0:75 壊れた綴り', '時刻の無い行', '0:20 読める行');
    expect(clipTranscript(b, 0, 60_000)).toEqual({ text: '0:20 読める行', lines: 1 });
  });
  it('行末の空白は落とし、行の字はそのまま移す', () => {
    const b = body('## 文字起こし 2026-10-02 12:34', '0:20 そのまま ですよ  ');
    expect(clipTranscript(b, 10_000, 30_000)?.text).toBe('0:10 そのまま ですよ');
  });
  it('🔴 #1447 終わりつきの行は、その終わりまでが発言。移すときは終わりも切り出しの範囲に収めて付け直す', () => {
    const b = body('## 文字起こし 2026-10-02 12:34', '0:07 〜0:12 こんにちは', '0:20 〜0:50 長い発言', '2:00 終わりなし');
    // [5s, 10s): 0:07〜0:12 は範囲の終わり(10s)で切る → 0:02 〜0:05
    expect(clipTranscript(b, 5_000, 10_000)).toEqual({ text: '0:02 〜0:05 こんにちは', lines: 1 });
    // [9s, 25s): 始まりの手前から続く発言は 0:00 に置き、終わりは 0:03。0:20 の発言は終わりが範囲の外なので 25s で切る
    expect(clipTranscript(b, 9_000, 25_000)).toEqual({
      text: '0:00 〜0:03 こんにちは\n0:11 〜0:16 長い発言',
      lines: 2,
    });
    // 終わりの後ろ(推定ならまだ続く 5 秒〜)には入らない: 0:12 ちょうどから始まる範囲に最初の行は入らない
    expect(clipTranscript(b, 12_000, 19_000)).toBeNull();
    // 終わりを持つ行は 30 秒の推定を使わない: 0:20〜0:50 は 49 秒の時点でまだ発言中
    expect(clipTranscript(b, 49_000, 60_000)?.text).toBe('0:00 〜0:01 長い発言');
  });
});
