/**
 * 🔴 **文字起こしの行を、時刻つきの引用としてノートへ入れる**(#1966 4-3 ①。user 裁定 2026-11-17 = 案 B)。
 * 1 行の形・入れ先の決め方・`entry:<録音>#t=<秒>` の読み書き。
 */
import { describe, expect, it } from 'vitest';
import { formatTranscriptQuote, resolveTranscriptQuoteTarget } from '../../src/features/transcript-quote';
import { formatEntryRef, parseEntryRef, parseTimeFragment } from '../../src/features/entry-ref/entry-ref';
import { parseLinkTarget } from '../../src/features/entry-ref/link-target';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';

function meta(lid: string, archetype = 'text', archived = false): EntryMeta {
  return {
    lid,
    title: `題-${lid}`,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived,
    bodyChars: null,
  };
}

describe('1 行の形', () => {
  it('🔴 > [時刻](entry:<録音>#t=<秒>) 字', () => {
    expect(formatTranscriptQuote('rec', 15_000, '0:15', '見積は来週に出します')).toBe(
      '> [0:15](entry:rec#t=15) 見積は来週に出します',
    );
    // 1 時間を超える綴りはそのまま・秒は切り捨て
    expect(formatTranscriptQuote('rec', 3_723_400, '1:02:03', 'x')).toBe('> [1:02:03](entry:rec#t=3723) x');
  });

  it('⚠ 字の記法は効かない形にする / 改行・空白は 1 行へ畳む / 字が無ければ作らない', () => {
    expect(formatTranscriptQuote('rec', 0, '0:00', '**重要** [案]  を\n確認')).toBe(
      '> [0:00](entry:rec#t=0) \\*\\*重要\\*\\* \\[案\\] を 確認',
    );
    expect(formatTranscriptQuote('rec', 1000, '0:01', '   ')).toBeNull();
    expect(formatTranscriptQuote('rec', -1, '0:00', 'x')).toBeNull();
  });
});

describe('entry:<lid>#t=<秒>', () => {
  it('🔴 読んで書けて往復する(秒の小数も受ける)', () => {
    expect(parseEntryRef('entry:rec#t=15')).toEqual({ kind: 'time', lid: 'rec', ms: 15_000 });
    expect(parseEntryRef('entry:rec#t=1.5')).toEqual({ kind: 'time', lid: 'rec', ms: 1_500 });
    expect(formatEntryRef({ kind: 'time', lid: 'rec', ms: 15_000 })).toBe('entry:rec#t=15');
    expect(formatEntryRef({ kind: 'time', lid: 'rec', ms: 1_500 })).toBe('entry:rec#t=1.5');
    expect(parseEntryRef(formatEntryRef({ kind: 'time', lid: 'rec', ms: 61_000 }))).toEqual({ kind: 'time', lid: 'rec', ms: 61_000 });
  });

  it('⚠ 読めない形は断る(1:02 の綴り・負・空)', () => {
    expect(parseEntryRef('entry:rec#t=1:02').kind).toBe('invalid');
    expect(parseEntryRef('entry:rec#t=-3').kind).toBe('invalid');
    expect(parseEntryRef('entry:rec#t=').kind).toBe('invalid');
    expect(parseTimeFragment('#t=2')).toBe(2000);
    expect(parseTimeFragment('h/x')).toBeNull();
  });

  it('🔴 リンクの行き先は録音のノート + 時刻(本文の entry: と pkc:// の両方)', () => {
    const a = parseLinkTarget('entry:rec#t=15');
    expect(a).toMatchObject({ kind: 'entry', lid: 'rec', seekMs: 15_000, section: null });
    expect(parseLinkTarget('pkc://c1/entry/rec#t=15', 'c1')).toMatchObject({ kind: 'entry', lid: 'rec', seekMs: 15_000 });
    expect(parseLinkTarget('entry:rec')).toMatchObject({ seekMs: null });
  });
});

describe('入れ先', () => {
  const metas = new Map<string, EntryMeta>([
    ['rec', meta('rec', 'attachment')],
    ['meet', meta('meet')],
    ['pinned', meta('pinned')],
    ['folder', meta('folder', 'folder')],
    ['old', meta('old', 'text', true)],
    ['prev', meta('prev')],
  ]);
  const base = { recordingLid: 'rec', splitLids: [] as string[], past: [] as string[], metas, relations: [] as Relation[] };

  it('🔴 1. 横に留めた枠のノート(追記できる種類だけ)', () => {
    expect(resolveTranscriptQuoteTarget({ ...base, splitLids: ['folder', 'pinned'], past: ['prev', 'rec'] })).toBe('pinned');
  });

  it('🔴 2. 録音に結びついたノート(PDF の「ノートへ引用」と同じ)', () => {
    const relations = [{ id: 'r1', fromLid: 'meet', toLid: 'rec', kind: 'semantic' } as unknown as Relation];
    expect(resolveTranscriptQuoteTarget({ ...base, relations, past: ['prev', 'rec'] })).toBe('meet');
  });

  it('🔴 3. 直前に開いていたノート(録音そのもの・フォルダ・アーカイブは飛ばす)', () => {
    expect(resolveTranscriptQuoteTarget({ ...base, past: ['prev', 'old', 'folder', 'rec'] })).toBe('prev');
  });

  it('🔴 3. 「戻る」で録音へ戻ってきたなら、離れたばかりのノート(future の先頭)が直前', () => {
    expect(resolveTranscriptQuoteTarget({ ...base, past: ['prev', 'rec'], future: ['meet'] })).toBe('meet');
    // ⚠ 先頭が追記できない物なら past へ
    expect(resolveTranscriptQuoteTarget({ ...base, past: ['prev', 'rec'], future: ['folder', 'meet'] })).toBe('prev');
  });

  it('🔴 4. どれも無ければ録音のノート自身(説明の末尾)', () => {
    expect(resolveTranscriptQuoteTarget({ ...base, past: ['rec'] })).toBe('rec');
  });
});
