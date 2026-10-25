/**
 * 🔴 **話者の一覧を本文に書く・読む**(#952 B4・B6)。
 *
 * 🔑 期待値は手で書いた固定値(実装と同じ組み立てで作らない)。本文は**他の部分を 1 文字も変えない**ことを、前後の行で見る。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  fixSpeakers,
  isSpeakerTranscriptHeading,
  isSpeakersHeading,
  namedTurnsText,
  parseRenames,
  readSpeakerTurns,
  renameTurns,
  speakerAt,
  speakerName,
  speakersHeading,
  speakersText,
  speakerTranscript,
  speakerTranscriptHeading,
} from '../../src/features/capture/speakers';
import { isNonTranscriptHeading, transcriptLinesOf } from '../../src/features/capture/contact-sheet-layout';
import { captureItemsFrom } from '../../src/features/capture/capture-item';
import { isChaptersHeading } from '../../src/features/capture/chapters';

const AT = new Date(2026, 9, 25, 10, 30);

describe('書く', () => {
  it('名前は A〜Z、27 人目から数字。見出しは日時つき', () => {
    expect(speakerName(0)).toBe('話者A');
    expect(speakerName(25)).toBe('話者Z');
    expect(speakerName(26)).toBe('話者27');
    expect(speakersHeading(AT)).toBe('## 話者 2026-10-25 10:30');
    expect(speakerTranscriptHeading(AT)).toBe('## 話者つき文字起こし 2026-10-25 10:30');
  });

  it('話者が替わる所だけを行にする(同じ話者が続く塊は 1 行)', () => {
    expect(
      speakersText([
        { startMs: 0, endMs: 5000, speaker: 0 },
        { startMs: 7000, endMs: 9000, speaker: 0 },
        { startMs: 12_000, endMs: 20_000, speaker: 1 },
        { startMs: 3_723_000, endMs: 3_730_000, speaker: 0 },
      ]),
    ).toBe('0:00 話者A\n0:12 話者B\n1:02:03 話者A');
  });

  it('文字起こしに話者を添える。最初の話者より前の行には名前を付けない。行が無ければ null', () => {
    const turns = [
      { ms: 5000, name: '話者A' },
      { ms: 12_000, name: '話者B' },
    ];
    expect(speakerAt(turns, 4999)).toBeNull();
    expect(speakerAt(turns, 5000)).toBe('話者A');
    expect(speakerAt(turns, 99_000)).toBe('話者B');
    expect(
      speakerTranscript(turns, [
        { ms: 0, text: 'はじめに' },
        { ms: 6000, text: 'こんにちは' },
        { ms: 15_000, text: 'どうも' },
      ]),
    ).toBe('0:00 はじめに\n0:06 話者A: こんにちは\n0:15 話者B: どうも');
    expect(speakerTranscript(turns, [])).toBeNull();
  });
});

describe('読む', () => {
  const BODY = ['説明', '', '## 話者 2026-10-25 10:30', '0:00 話者A', '0:12 話者B', '本文のメモ', '', '## 文字起こし', '0:15 こんにちは'].join('\n');

  it('節の中の時刻つき行だけを読む。節が無い・行が無いなら null。後ろの節の行は読まない', () => {
    expect(readSpeakerTurns(BODY)).toEqual([
      { ms: 0, name: '話者A' },
      { ms: 12_000, name: '話者B' },
    ]);
    expect(readSpeakerTurns('## 文字起こし\n0:15 こんにちは')).toBeNull();
    expect(readSpeakerTurns('## 話者\nメモだけ')).toBeNull();
    expect(readSpeakerTurns('## 話者つき文字起こし\n0:15 話者A: こんにちは')).toBeNull();
  });

  it('最後の「## 話者」の節を使う(何度か作った場合)', () => {
    const two = '## 話者 古い\n0:00 話者A\n\n## 話者 新しい\n0:00 田中\n0:10 鈴木';
    expect(readSpeakerTurns(two)).toEqual([
      { ms: 0, name: '田中' },
      { ms: 10_000, name: '鈴木' },
    ]);
  });

  it('文字起こしを読むときは、話者・チャプターの節の行を文字起こしに数えない(名前を自由に書き換えても)', () => {
    const body = ['## 文字起こし', '0:00 こんにちは', '## チャプター', '0:00 チャプター 1', '## 話者', '0:00 田中', '## 話者つき文字起こし', '0:00 田中: こんにちは', '## 次の節', '0:30 つづき'].join('\n');
    expect(transcriptLinesOf(body)).toEqual([
      { ms: 0, text: 'こんにちは' },
      { ms: 30_000, text: 'つづき' },
    ]);
  });
});

describe('名前の付け替え', () => {
  it('「話者A=田中」を読む(全角の ＝ ・読点・改行区切り・同じ名前への付け替えと壊れた断片は捨てる)', () => {
    expect(parseRenames('話者A=田中、話者B＝鈴木\n話者C = 佐藤 ,壊れた,=だけ,同じ=同じ')).toEqual([
      ['話者A', '田中'],
      ['話者B', '鈴木'],
      ['話者C', '佐藤'],
    ]);
    expect(parseRenames('')).toEqual([]);
  });

  it('付け替えは連鎖しない(A→B と B→C は 1 回ずつ)。同じ名前になれば 1 人にまとまる(行がまとまる)', () => {
    const turns = [
      { ms: 0, name: 'A' },
      { ms: 10, name: 'B' },
      { ms: 20, name: 'C' },
    ];
    expect(renameTurns(turns, [['A', 'B'], ['B', 'C']]).map((t) => t.name)).toEqual(['B', 'C', 'C']);
    expect(namedTurnsText([{ ms: 0, name: '田中' }, { ms: 5000, name: '田中' }, { ms: 9000, name: '鈴木' }])).toBe('0:00 田中\n0:09 鈴木');
  });
});

describe('話者を直す(fixSpeakers)', () => {
  const BODY = [
    '説明の段落',
    '',
    '## 文字起こし 2026-10-25 10:00',
    '0:00 はじめに',
    '0:15 こんにちは',
    '0:30 どうも',
    '',
    '## 話者 2026-10-25 10:30',
    '0:00 話者A',
    '0:12 話者B',
    '0:25 話者C',
    '',
    '## 最後の節',
    'おわり',
  ].join('\n');
  const LINES = [
    { ms: 0, text: 'はじめに' },
    { ms: 15_000, text: 'こんにちは' },
    { ms: 30_000, text: 'どうも' },
  ];

  it('🔴 名前を替え、話者つき文字起こしを作り直す。ほかの節は 1 文字も変わらない', () => {
    const r = fixSpeakers(BODY, [['話者A', '田中'], ['話者C', '田中']], LINES, AT)!;
    expect(r.renamed).toBe(2);
    expect(r.transcriptLines).toBe(3);
    const lines = r.body.split('\n');
    // 前の節と後ろの節は同じ
    expect(lines.slice(0, 8)).toEqual(BODY.split('\n').slice(0, 8));
    expect(r.body).toContain('## 最後の節\nおわり');
    // 話者の節:A と C が田中になり、B をはさんで 3 行
    expect(r.body).toContain('## 話者 2026-10-25 10:30\n0:00 田中\n0:12 話者B\n0:25 田中');
    // 話者つき文字起こし(新規なので末尾に足される)
    expect(r.body).toContain('## 話者つき文字起こし 2026-10-25 10:30\n0:00 田中: はじめに\n0:15 話者B: こんにちは\n0:30 田中: どうも');
  });

  it('🔴 統合:同じ名前に揃えると 1 人にまとまり、行がまとまる。もう一度直すと「話者つき文字起こし」は置き換わる(増えない)', () => {
    const first = fixSpeakers(BODY, [['話者B', '話者A'], ['話者C', '話者A']], LINES, AT)!;
    expect(first.body).toContain('## 話者 2026-10-25 10:30\n0:00 話者A\n');
    expect(first.body.match(/^## 話者 /gm)).toHaveLength(1);
    expect(first.body).not.toContain('0:12 話者');
    const second = fixSpeakers(first.body, [['話者A', '司会']], LINES, new Date(2026, 9, 26, 8, 0))!;
    expect(second.body.match(/^## 話者つき文字起こし/gm), '話者つき文字起こしが増えた').toHaveLength(1);
    expect(second.body).toContain('## 話者つき文字起こし 2026-10-26 08:00\n0:00 司会: はじめに');
    expect(second.body).not.toContain('話者A');
  });

  it('文字起こしが無ければ話者つき文字起こしは作らない。節が無い本文は null', () => {
    const r = fixSpeakers('## 話者\n0:00 話者A', [['話者A', '田中']], [], AT)!;
    expect(r.transcriptLines).toBe(0);
    expect(r.body).toBe('## 話者\n0:00 田中');
    expect(fixSpeakers('説明だけ', [], LINES, AT)).toBeNull();
  });

  it('付け替えが無ければ、話者の節の中身は変わらない(冪等)', () => {
    const r = fixSpeakers(BODY, [], [], AT)!;
    expect(r.renamed).toBe(0);
    expect(r.body).toBe(BODY);
  });

  it('節の中に書いたメモ(時刻のない行)は残す', () => {
    const body = '## 話者\n0:00 話者A\nこの人は司会\n0:20 話者B';
    const r = fixSpeakers(body, [['話者A', '田中']], [], AT)!;
    expect(r.body).toBe('## 話者\n0:00 田中\n0:20 話者B\nこの人は司会');
  });
});

/**
 * 🔴 **節の見出しの判定は持ち主の 1 つ**(着地前レビュー ⚠8)。「話者」の節かどうかを、行の出し分け(`hasSpeakers`)・読み取り(`readSpeakerTurns`)・
 * 文字起こしの拾い(`transcriptLinesOf`)が**同じ判定**で答えること。読み手ごとに正規表現を持つと、見出しの綴りを変えた日に片方だけ古いまま残る。
 */
describe('節の見出しの判定が読み手ごとに食い違わない(parity)', () => {
  const HEADINGS = [
    '## 話者',
    '## 話者 2026-10-25 10:30',
    '## 話者\t',
    '## 話者  ',
    '## 話者A',
    '## 話者つき文字起こし',
    '## 話者つき文字起こし 2026-10-25 10:30',
    '##話者',
    '### 話者',
    '# 話者',
    '## チャプター',
    '## チャプター 2026-10-25 10:30',
    '## チャプターX',
    '## 文字起こし',
    '## 文字起こし 2026-10-02 12:34',
    '話者',
  ];
  const media = (extra: string): string =>
    ['---', 'attachment.name: a.webm', 'attachment.mime: audio/webm', 'attachment.size: 1', 'attachment.asset_key: k', '---', extra].join('\n');

  it.each(HEADINGS)('「%s」', (heading) => {
    const isSpeakers = isSpeakersHeading(heading);
    // ① 行の出し分け
    const item = captureItemsFrom([{ lid: 'a', title: 'a', body: media(`${heading}\n0:00 田中`) }])[0]!;
    expect(item.hasSpeakers, 'hasSpeakers が isSpeakersHeading と食い違う').toBe(isSpeakers);
    // ② 読み取り
    expect(readSpeakerTurns(`${heading}\n0:00 田中`) !== null, 'readSpeakerTurns が isSpeakersHeading と食い違う').toBe(isSpeakers);
    // ③ 文字起こしの拾い:話者・話者つき文字起こし・チャプターの節の行は文字起こしに数えない
    const skipped = isSpeakers || isSpeakerTranscriptHeading(heading) || isChaptersHeading(heading);
    expect(isNonTranscriptHeading(heading)).toBe(skipped);
    const lines = transcriptLinesOf(`${heading}\n0:00 本文`);
    expect(lines.length === 0, 'transcriptLinesOf が節の判定と食い違う').toBe(/^#{1,6} /.test(heading) ? skipped : false);
  });

  it('前提:表には「話者の節」と「そうでないもの」の両方が入っている(全部同じ答えだと何も見ていない)', () => {
    expect(HEADINGS.filter(isSpeakersHeading).length).toBeGreaterThanOrEqual(3);
    expect(HEADINGS.filter((h) => !isSpeakersHeading(h)).length).toBeGreaterThanOrEqual(8);
  });

  it('capture-item.ts は話者の節の正規表現を自前で持たない(source 読み)', () => {
    const src = readFileSync('src/features/capture/capture-item.ts', 'utf8');
    expect(src).toContain('isSpeakersHeading');
    expect(src).not.toMatch(/話者\(\?:/);
  });
});
