/**
 * 🔴 **文字起こしを字幕ファイル(SRT)にする**(#1447)。
 *
 * 守りたい主張:
 *  ① 行頭に時刻のある行だけを拾い、開始 = その時刻、終了 = 次の行の開始、最後は +5 秒の推定
 *  ② 綴りは SRT の規格(`HH:MM:SS,mmm --> HH:MM:SS,mmm`、件番号、件の間は空行)
 *  ③ 時刻つきの行が無ければ `null`(呼び側は「できません」と言い、空の file を落とさない)
 *  ④ 「時刻つきの行」の読みは画面で押せる字にする側と**同じ 1 本**(`ELAPSED_LINE_HEAD` + `parseElapsed`)
 */
import { describe, expect, it } from 'vitest';
import { LAST_CUE_MS, srtFromTranscript, transcriptCues } from '../../src/features/asr/srt';
import { ELAPSED_LINE_HEAD, srtTime } from '../../src/features/elapsed-text';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const BODY = [
  '## 文字起こし 2026-10-02 12:34',
  '0:00 こんにちは',
  '0:15 今日は晴れです',
  '1:02:03 おわり',
].join('\n');

describe('字幕ファイルの時刻(srtTime)', () => {
  it('🔴 `HH:MM:SS,mmm` ── 時は 2 桁で必ず出す(elapsedText と違う)、小数点はコンマ', () => {
    expect(srtTime(0)).toBe('00:00:00,000');
    expect(srtTime(15_000)).toBe('00:00:15,000');
    expect(srtTime(3_723_456)).toBe('01:02:03,456');
    expect(srtTime(10 * 3_600_000)).toBe('10:00:00,000');
  });
  it('⚠ 負の値は 0 に倒す / 小数のミリ秒は切り捨てる', () => {
    expect(srtTime(-5)).toBe('00:00:00,000');
    expect(srtTime(1_234.9)).toBe('00:00:01,234');
  });
});

describe('transcriptCues(#1447 ①)', () => {
  it('🔴 行頭の時刻だけを拾い、終了は次の行の開始、最後は +LAST_CUE_MS', () => {
    expect(transcriptCues(BODY)).toEqual([
      { startMs: 0, endMs: 15_000, text: 'こんにちは' },
      { startMs: 15_000, endMs: 3_723_000, text: '今日は晴れです' },
      { startMs: 3_723_000, endMs: 3_723_000 + LAST_CUE_MS, text: 'おわり' },
    ]);
    expect(LAST_CUE_MS, '知らせの字(5 秒後)と対で変える').toBe(5000);
  });

  it('🔴 文中の時刻・時刻だけの行・読めない綴り・囲みの中は拾わない', () => {
    const body = [
      '会議は 14:00 から',       // 文中 ── 行頭でない
      '0:15',                     // 字が無い
      '0:75 読めない綴り',        // parseElapsed が null
      '0:5 読めない綴り',         // 秒が 1 桁
      '```',
      '0:20 囲みの中',
      '```',
      '0:30 拾う ',               // 末尾の空白は落とす
    ].join('\n');
    expect(transcriptCues(body)).toEqual([{ startMs: 30_000, endMs: 35_000, text: '拾う' }]);
  });

  it('⚠ 次の行が前より後ろでない(手で並べ替えた)ときも、負の長さを作らず推定で閉じる', () => {
    const cues = transcriptCues('0:30 さき\n0:10 あと');
    expect(cues.map((c) => c.endMs - c.startMs)).toEqual([LAST_CUE_MS, LAST_CUE_MS]);
  });

  it('⚠ CRLF の本文でも同じ(行末の `\\r` を字に混ぜない)', () => {
    expect(transcriptCues('0:00 あ\r\n0:05 い\r\n')).toEqual([
      { startMs: 0, endMs: 5_000, text: 'あ' },
      { startMs: 5_000, endMs: 10_000, text: 'い' },
    ]);
  });
});

describe('srtFromTranscript(#1447 ②③)', () => {
  it('🔴 SRT の綴り ── 件番号 / 時刻の行 / 字 / 空行、の繰り返し', () => {
    expect(srtFromTranscript(BODY)).toBe(
      [
        '1',
        '00:00:00,000 --> 00:00:15,000',
        'こんにちは',
        '',
        '2',
        '00:00:15,000 --> 01:02:03,000',
        '今日は晴れです',
        '',
        '3',
        '01:02:03,000 --> 01:02:08,000',
        'おわり',
        '',
      ].join('\n'),
    );
  });

  it('🔴 時刻つきの行が無ければ null(空の file を作らない)', () => {
    expect(srtFromTranscript('')).toBeNull();
    expect(srtFromTranscript('ただの本文\n会議は 14:00 から')).toBeNull();
    expect(srtFromTranscript('0:15')).toBeNull();
  });

  it('⚠ 出た字に `\\r` も制御文字も無い(規格の読み手が止まらない)', () => {
    const srt = srtFromTranscript(BODY)!;
    // ⚠ 制御文字は正規表現に書かない(no-control-regex)── 符号位置で数える
    const bad = [...srt].filter((ch) => {
      const c = ch.codePointAt(0)!;
      return (c < 0x20 && c !== 0x0a) || c === 0x7f;
    });
    expect(bad).toEqual([]);
  });
});

/**
 * 🔴 **④ 読みは 1 本** ── 画面で押せる字(`pkc-seek-link`)になる行と、字幕になる行が一致する。
 * ⚠ 綴りの一覧を両側に手で書くと、同じ盲点を共有する(CLAUDE.md §1「別の綴り」)── だから
 *   **実物の描画**を対照群にする:押せる印が出た行の数 = 字幕の件数、を複数の形で見る。
 */
describe('画面で押せる行と字幕の行は同じ 1 本で読む(#1447 ④)', () => {
  const lines = ['0:15 押せる', '14:00 時計も押せる', '1:02:03 時つき', '0:75 読めない', '文中 0:15 は押せない', '0:5 一桁'];
  it('🔴 行ごとに「押せる印が出る」と「字幕に出る」が一致する', () => {
    for (const line of lines) {
      const html = renderMarkdown(line, { interactiveSeek: true });
      const seekable = html.includes('data-pkc-action="seek-media"');
      const cued = transcriptCues(line).length === 1;
      expect(cued, `${line}: 押せる=${String(seekable)} / 字幕=${String(cued)}`).toBe(seekable);
    }
    // 空振り防止 ── 押せる側と押せない側が両方在る
    expect(lines.filter((l) => transcriptCues(l).length === 1).length).toBe(3);
  });
  it('🔴 綴りの正本は `ELAPSED_LINE_HEAD`(markdown-render が別の regex を持っていない)', () => {
    expect(ELAPSED_LINE_HEAD.source).toBe('^((?:\\d{1,2}:)?\\d{1,2}:\\d{2}) ');
  });
});
