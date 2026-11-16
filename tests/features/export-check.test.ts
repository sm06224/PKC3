/**
 * 🔴 **外へ書き出す前の点検**(#1966 4-5。🟣 Gemini の裁定 = 案 ①)の数え方。
 */
import { describe, expect, it } from 'vitest';
import {
  EXPORT_WATCH_TAGS_DEFAULT,
  exportFindingLines,
  exportFindings,
  hasExportFindings,
  isWatchTagsJson,
  parseWatchTags,
  readWatchTags,
  type ExportCheckInput,
} from '../../src/features/export/export-check';

const FENCE = '```';
const base = (over: Partial<ExportCheckInput> = {}): ExportCheckInput => ({
  notes: [],
  exists: (lid) => ['n1', 'n2', 'n3'].includes(lid),
  watchTags: [...EXPORT_WATCH_TAGS_DEFAULT],
  carry: 'images',
  ...over,
});
const note = (body: string, lid = 'n1', title = 'メモ') => ({ lid, title, body });

describe('確かめるタグ', () => {
  it('🔴 初期値は private, 社外秘 / 空は確かめない / 読点・カンマ・空白で区切る(重複は 1 つ)', () => {
    expect(readWatchTags(null)).toEqual(['private', '社外秘']);
    expect(readWatchTags('[]')).toEqual([]);
    expect(parseWatchTags('')).toEqual([]);
    expect(parseWatchTags('社外秘、極秘, draft  draft')).toEqual(['社外秘', '極秘', 'draft']);
  });

  it('⚠ 保存の形は文字列の配列の JSON。読めない形(banana / 数の配列)は初期値', () => {
    expect(isWatchTagsJson('["a","b"]')).toBe(true);
    for (const bad of ['banana', '[1,2]', '{"a":1}', '']) {
      expect(isWatchTagsJson(bad), bad).toBe(false);
      expect(readWatchTags(bad), bad).toEqual(['private', '社外秘']);
    }
  });

  it('🔴 文書タグ(前書き)と本文のタグ(#だけの行)の両方で見つける。大小は区別しない', () => {
    const f = exportFindings(
      base({
        notes: [note('---\ntags: [Private]\n---\n本文'), note('本文\n\n#社外秘', 'n2', '議事')],
      }),
    );
    expect(f.tagged).toEqual([
      { tag: 'private', titles: ['メモ'] },
      { tag: '社外秘', titles: ['議事'] },
    ]);
  });

  it('⚠ 確かめるタグが空なら、タグは数えない', () => {
    expect(exportFindings(base({ notes: [note('#社外秘')], watchTags: [] })).tagged).toEqual([]);
  });
});

describe('リンク切れ', () => {
  it('🔴 見つからないノートへのリンクだけを数える(在るノート・自分へのリンクは数えない)', () => {
    const f = exportFindings(
      base({
        notes: [note('[a](entry:gone) [b](entry:n2) [c](entry:n3) [自分](entry:n1) [d](entry:gone2)')],
      }),
    );
    expect(f.missingLinks).toEqual({ count: 2, titles: ['メモ'] });
  });

  it('⚠ 在るノートへのリンクは、書き出しに入らなくても問題にしない(書き出した後の知らせが言う ── 毎回の確認にしない)', () => {
    const f = exportFindings(base({ notes: [note('[b](entry:n2)')] }));
    expect(hasExportFindings(f)).toBe(false);
  });

  it('⚠ コードの中のリンクは数えない', () => {
    const f = exportFindings(base({ notes: [note(`${FENCE}\n[a](entry:gone)\n${FENCE}`)] }));
    expect(f.missingLinks.count).toBe(0);
  });
});

describe('同梱されない添付', () => {
  it('🔴 画像でない添付へのリンクは、どの形でも運べない', () => {
    expect(exportFindings(base({ notes: [note('[資料](asset:k1)')] })).assets).toEqual({ count: 1, titles: ['メモ'] });
  });

  it('🔴 画像は、画像を運ぶ形では数えず、運ばない形(Markdown 1 件・メール下書き)では数える', () => {
    const body = '![図](asset:k1)';
    expect(exportFindings(base({ notes: [note(body)], carry: 'images' })).assets.count).toBe(0);
    expect(exportFindings(base({ notes: [note(body)], carry: 'nothing' })).assets.count).toBe(1);
  });
});

describe('一覧の字', () => {
  it('🔴 問題ごとに 1 行。題名は多いときに先頭 3 件 + 件数', () => {
    const notes = ['A', 'B', 'C', 'D'].map((t, i) => note('#社外秘\n\n[x](entry:gone)', `m${i}`, t));
    const lines = exportFindingLines(exportFindings(base({ notes })));
    expect(lines).toEqual([
      'タグ「社外秘」が付いたノート: 「A」・「B」・「C」 ほか 1 件',
      '見つからないノートへのリンク 4 か所: 「A」・「B」・「C」 ほか 1 件',
    ]);
  });

  it('⚠ 何も無ければ空(確認を出さない)', () => {
    const f = exportFindings(base({ notes: [note('ただの本文')] }));
    expect(hasExportFindings(f)).toBe(false);
    expect(exportFindingLines(f)).toEqual([]);
  });
});
