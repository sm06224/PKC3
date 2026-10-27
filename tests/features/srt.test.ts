/** @vitest-environment node */
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
import { readFileSync } from 'node:fs';
import {
  LAST_CUE_MS,
  MAX_CUE_MS,
  hasEmbeddedSrt,
  hasEstimatedCue,
  hasTranscriptCues,
  srtFromTranscript,
  srtMarkdownBlock,
  srtSavedNotice,
  transcriptCues,
} from '../../src/features/asr/srt';
import { codeOnly } from '../helpers/code-only';
import { ELAPSED_LINE_HEAD, readElapsedHead, srtTime } from '../../src/features/elapsed-text';
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
      { startMs: 15_000, endMs: 15_000 + MAX_CUE_MS, text: '今日は晴れです' },
      { startMs: 3_723_000, endMs: 3_723_000 + LAST_CUE_MS, text: 'おわり' },
    ]);
    expect(LAST_CUE_MS, '知らせの字(5 秒後)と対で変える').toBe(5000);
  });

  it('🔴 文中の時刻・時刻だけの行・読めない綴り・コードブロックの中は拾わない', () => {
    const body = [
      '会議は 14:00 から',       // 文中 ── 行頭でない
      '0:15',                     // 字が無い(時刻の後ろに空白も無い ── 綴りで落ちる)
      '0:15 ',                    // 🔴 字が無い(綴りは当たる ── 空の字の門で落ちる。変異 M3 が教えた)
      '0:75 読めない綴り',        // parseElapsed が null
      '0:5 読めない綴り',         // 秒が 1 桁
      '```',
      '0:20 コードブロックの中',
      '```',
      '~~~',
      '0:21 ~~~ の中',
      '~~~',
      '0:30 拾う ',               // 末尾の空白は落とす
    ].join('\n');
    expect(transcriptCues(body)).toEqual([{ startMs: 30_000, endMs: 35_000, text: '拾う' }]);
  });

  it('🔴 コードブロックの閉じは markdown と同じ規則(同じ字で、開いたとき以上の長さ)── 数で数えない', () => {
    // ⚠ 着地前レビュー(2026-10-08)が実行で出した形:``` の中の ```` は閉じではないので、x は中のまま
    const nested = ['````', '0:10 外の囲みの字', '```', '0:20 x', '```', '````', '0:30 y'].join('\n');
    expect(transcriptCues(nested).map((c) => c.text)).toEqual(['y']);
    // ~~~ で開いた囲みは ``` では閉じない
    const mixed = ['~~~', '0:20 x', '```', '0:30 y', '~~~', '0:40 z'].join('\n');
    expect(transcriptCues(mixed).map((c) => c.text)).toEqual(['z']);
  });

  it('🔴 同じ秒に 2 行あるとき、前の行は長さ 0 にせず推定(+LAST_CUE_MS)で閉じる(変異 M2)', () => {
    const cues = transcriptCues('0:15 a\n0:15 b\n0:20 c');
    expect(cues.map((c) => [c.startMs, c.endMs])).toEqual([
      [15_000, 20_000],
      [15_000, 20_000],
      [20_000, 25_000],
    ]);
  });

  it('hasTranscriptCues ── 1 行でも在れば真、無ければ偽(transcriptCues と同じ読み)', () => {
    expect(hasTranscriptCues('x\n0:15 a')).toBe(true);
    expect(hasTranscriptCues('```\n0:15 a\n```')).toBe(false);
    expect(hasTranscriptCues('')).toBe(false);
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
        '00:00:15,000 --> 00:00:45,000',
        '今日は晴れです',
        '',
        '3',
        '01:02:03,000 --> 01:02:08,000',
        'おわり',
        '',
        '',
      ].join('\n'),
    );
  });

  it('🔴 最後の件の後にも空行 1 つ(厳密な読み手が最後の件を落とさない)', () => {
    expect(srtFromTranscript('0:00 a')!.endsWith('a\n\n')).toBe(true);
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
  const lines = [
    '0:15 押せる',
    '14:00 時計も押せる',
    '1:02:03 時つき',
    '0:75 読めない',
    '文中 0:15 は押せない',
    '0:5 一桁',
    // 🔴 行の構造(着地前レビュー 2026-10-08 #3)── 画面は inline の行頭で当てるので、印の中も押せる
    '- 0:15 箇条書き',
    '> 0:20 引用',
    '1. 0:25 番号',
    '## 0:26 見出し',
    '   0:27 字下げ 3 つ',
    '    0:28 字下げ 4 つは code',
    '- > 0:29 入れ子',
    '```\n0:35 コードブロック\n```',
    '~~~\n0:36 波のコードブロック\n~~~',
  ];
  it('🔴 行ごとに「押せる印が出る」と「字幕に出る」が一致する', () => {
    for (const line of lines) {
      const html = renderMarkdown(line, { interactiveSeek: true });
      const seekable = html.includes('data-pkc-action="seek-media"');
      const cued = transcriptCues(line).length === 1;
      expect(cued, `${JSON.stringify(line)}: 押せる=${String(seekable)} / 字幕=${String(cued)}`).toBe(seekable);
    }
    // 空振り防止 ── 押せる側と押せない側が両方在る(数は corpus と対で動く)
    expect(lines.filter((l) => transcriptCues(l).length === 1).length).toBe(9);
  });
  /**
   * 🔴 綴りの正本は `ELAPSED_LINE_HEAD` ── **両側がそれを参照していて、`\d{1,2}:` の直書きを持たない**
   *   (着地前レビュー 2026-10-08 M1:字幕の側だけ同じ字面の regex に fork されても、上の corpus では
   *   区別できない)。⚠ 注釈を落としてから見る(§1 の 5 度目)。
   */
  it('🔴 字幕の側も画面の側も ELAPSED_LINE_HEAD を参照し、時刻の綴りを直書きしていない', () => {
    expect(ELAPSED_LINE_HEAD.source).toBe(
      '^((?:\\d{1,2}:)?\\d{1,2}:\\d{2}) (?:〜((?:\\d{1,2}:)?\\d{1,2}:\\d{2}) )?',
    );
    // 行頭の時刻を読む所は全部 `readElapsedHead`(= ELAPSED_LINE_HEAD の 1 関数)を通る
    for (const [f, ref] of [
      ['src/features/asr/srt.ts', 'readElapsedHead'],
      ['src/features/markdown/markdown-render.ts', 'readElapsedHead'],
      ['src/features/capture/clip-transcript.ts', 'readElapsedHead'],
      ['src/features/capture/contact-sheet-layout.ts', 'readElapsedHead'],
      ['src/features/capture/speakers.ts', 'readElapsedHead'],
    ] as const) {
      const code = codeOnly(readFileSync(f, 'utf-8'));
      expect(code, `${f} が ${ref} を参照していない`).toContain(ref);
      expect(code, `${f} に時刻の綴りの直書きがある`).not.toMatch(/\\d\{1,2\}:/);
    }
  });
});

describe('#1447 の残り(長い無音・記号・本文への埋め込み)', () => {
  it('🔴 次の行が遠いとき、字幕は上限(30 秒)で切れる。近い行は切れない', () => {
    const c = transcriptCues('0:00 a\n0:10 b\n5:00 c');
    expect(c.map((x) => x.endMs)).toEqual([10_000, 10_000 + MAX_CUE_MS, 300_000 + LAST_CUE_MS]);
  });

  it('🔴 markdown のインライン記号は字幕に出さない(強調・リンク・コードの中身は残す)', () => {
    const c = transcriptCues('0:01 **大事** な [資料](https://example.com/a) と `x*y`');
    expect(c[0]!.text).toBe('大事 な 資料 (https://example.com/a) と x*y');
  });

  it('🔴 本文へ埋め込む囲みは、書き出し直しても字幕が二重にならない(囲みの中は読まない)', () => {
    const body = '0:00 こんにちは\n0:05 さようなら';
    const block = srtMarkdownBlock(body)!;
    expect(block.startsWith('```srt\n1\n00:00:00,000 --> 00:00:05,000\nこんにちは')).toBe(true);
    expect(block.endsWith('\n```')).toBe(true);
    expect(transcriptCues(`${body}\n\n${block}`)).toHaveLength(2);
    expect(srtMarkdownBlock('時刻のない本文')).toBeNull();
  });

  it('🔴 字の中に ``` があっても囲みが閉じない(囲みを 1 つ長くする)', () => {
    const block = srtMarkdownBlock('0:00 a ``` b')!;
    expect(block.startsWith('````srt\n')).toBe(true);
  });
});

describe('#1447 の残り(終わりの時刻つきの行・知らせ・二重埋め込み)', () => {
  it('🔴 終わりつきの行(0:07 〜0:12 text)は、その終わりが字幕の終了になる(推定も 30 秒上限も使わない)', () => {
    const c = transcriptCues('0:07 〜0:12 こんにちは\n2:00 〜2:50 遠い行\n');
    expect(c).toEqual([
      { startMs: 7_000, endMs: 12_000, text: 'こんにちは' },
      // 50 秒は上限(30 秒)を超えるが、実測の終わりなので切らない
      { startMs: 120_000, endMs: 170_000, text: '遠い行' },
    ]);
    expect(hasEstimatedCue('0:07 〜0:12 a\n0:20 〜0:25 b')).toBe(false);
    expect(hasEstimatedCue('0:07 〜0:12 a\n0:20 b')).toBe(true);
  });

  it('🔴 終わりが始まり以前・読めない綴りの行は、従来の行として読む(範囲の字は本文に残る)', () => {
    expect(readElapsedHead('0:07 〜0:05 text')).toMatchObject({ endMs: null, headLength: 5 });
    expect(readElapsedHead('0:07 〜0:75 text')).toMatchObject({ endMs: null, headLength: 5 });
    expect(transcriptCues('0:07 〜0:05 text')[0]!.text).toBe('〜0:05 text');
    expect(readElapsedHead('0:07 〜0:12 text')).toMatchObject({ startMs: 7_000, endMs: 12_000, headLength: 11 });
    expect(readElapsedHead('0:75 text')).toBeNull();
  });

  it('🔴 旧ビルド(範囲を知らない)が範囲の行を読んだとき: 行頭の時刻は効き、本文に「〜0:12」が残る', () => {
    // 旧ビルドの綴り(この変更の前の ELAPSED_LINE_HEAD)をそのまま再現する
    const OLD = /^((?:\d{1,2}:)?\d{1,2}:\d{2}) /;
    const line = '0:07 〜0:12 こんにちは';
    const m = OLD.exec(line);
    expect(m, '旧ビルドが範囲の行の時刻を読めない(行頭の時刻が効かなくなる)').not.toBeNull();
    expect(m![1]).toBe('0:07');
    expect(line.slice(m![0].length)).toBe('〜0:12 こんにちは');
  });

  it('🔴 空の字幕の行(時刻だけ)は捨てる。範囲だけの行も同じ', () => {
    expect(transcriptCues('0:01 \n0:02 〜0:05 \n0:09 ある').map((c) => c.text)).toEqual(['ある']);
    expect(hasTranscriptCues('0:01\n0:02 〜0:05 ')).toBe(false);
  });

  it('🔴 知らせの文面は 1 本: 推定があるときだけ推定の説明が付く', () => {
    expect(srtSavedNotice(2, true)).toContain('5 秒後');
    expect(srtSavedNotice(2, true)).toContain('30 秒');
    expect(srtSavedNotice(2, true)).toContain('2 件');
    expect(srtSavedNotice(2, false)).toBe('字幕ファイルを保存しました(2 件)');
  });

  it('🔴 埋め込み済みの判定: 見出しの直後の ```srt だけが当たる(別の節・普通のコードブロックは当たらない)', () => {
    const body = '0:00 a\n';
    expect(hasEmbeddedSrt(`${body}\n## 字幕(SRT)\n\n${srtMarkdownBlock(body)!}`)).toBe(true);
    expect(hasEmbeddedSrt(body)).toBe(false);
    expect(hasEmbeddedSrt('## 字幕(SRT)\n\nただの文章\n```srt\nx\n```')).toBe(false);
    expect(hasEmbeddedSrt('## 別の節\n\n```srt\n1\n```')).toBe(false);
  });
});
