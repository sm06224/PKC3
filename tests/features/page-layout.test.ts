/** @vitest-environment node */
/**
 * 🔴 ノート単位のページ設定(v4.0 Phase 1 / PR-03)の純関数。
 *
 * ⚠ 期待値は literal で持つ(実装の表から引き写さない ── 写すと「実装を変えたら期待も変わる」)。
 */
import { describe, expect, it } from 'vitest';
import {
  CLEAR_NOTE_LAYOUT,
  EMPTY_NOTE_LAYOUT,
  PAGE_MARGINS,
  hasNoteLayout,
  isPageMargin,
  noteLayoutApplies,
  noteLayoutChoices,
  noteLayoutKeys,
  noteLayoutPatchFor,
  paperSheetSpec,
  readNoteLayout,
  resolveEffectiveLayout,
  sheetPadding,
  writeNoteLayout,
} from '../../src/features/page-layout';
import { PAGE_FORMATS, pageFormatCss, paperRule, type PageFormat } from '../../src/features/page-format';
import { FONTS } from '../../src/features/appearance-choice';
import { READ_COLUMN_CHOICES } from '../../src/features/read-columns';

const APP = { pageFormat: 'a4-portrait', readColumns: '1', font: 'standard' } as const;

describe('余白の表(PAGE_MARGINS)', () => {
  it('🔴 id・字・mm・CSS の値が期待どおり', () => {
    expect(PAGE_MARGINS.map((m) => [m.id, m.label, m.mm, m.css])).toEqual([
      ['narrow', '狭い (12mm)', 12, '12mm'],
      ['normal', '標準 (20mm)', 20, '20mm'],
      ['wide', '広い (30mm)', 30, '30mm'],
    ]);
    expect(isPageMargin('wide')).toBe(true);
    expect(isPageMargin('huge')).toBe(false);
    expect(isPageMargin(20)).toBe(false);
  });
});

describe('paperRule(fmt, margin) ── 後方互換', () => {
  it('🔴 margin なし / null は旧出力と 1 バイトも変わらない', () => {
    for (const f of PAGE_FORMATS) {
      const old = f.paper === null ? '' : `@page{size:${f.paper}}`;
      expect(paperRule(f.id), f.id).toBe(old);
      expect(paperRule(f.id, null), f.id).toBe(old);
      expect(paperRule(f.id, undefined), f.id).toBe(old);
    }
    expect(pageFormatCss('a3-landscape')).toBe("[data-pkc-page-format='a3-landscape']{--read-w:91rem}@page{size:A3 landscape}");
    expect(pageFormatCss('a3-landscape', null)).toBe(pageFormatCss('a3-landscape'));
  });
  it('margin ありは @page に margin を含む(紙を持たない形式は margin だけ)', () => {
    expect(paperRule('a4-landscape', 'wide')).toBe('@page{size:A4 landscape;margin:30mm}');
    expect(paperRule('a4-portrait', 'narrow')).toBe('@page{size:A4 portrait;margin:12mm}');
    expect(paperRule('fullhd', 'normal')).toBe('@page{margin:20mm}');
    expect(pageFormatCss('43', 'wide')).toBe("[data-pkc-page-format='43']{--read-w:60rem}@page{margin:30mm}");
  });
});

describe('paperSheetSpec', () => {
  it('🔴 紙系 4 つは物理寸法、画面用 4 つは A4 縦へ落ちる', () => {
    const cases: Array<[PageFormat, string, string, boolean]> = [
      ['a4-portrait', '210mm', '297mm', false],
      ['a4-landscape', '297mm', '210mm', false],
      ['a3-portrait', '297mm', '420mm', false],
      ['a3-landscape', '420mm', '297mm', false],
      ['fullhd', '210mm', '297mm', true],
      ['fullhd-portrait', '210mm', '297mm', true],
      ['43', '210mm', '297mm', true],
      ['43-portrait', '210mm', '297mm', true],
    ];
    for (const [fmt, w, h, fb] of cases) expect(paperSheetSpec(fmt), fmt).toEqual({ width: w, minHeight: h, fallbackToA4: fb });
    // 全部の形式を見ている(形式が増えたらここで気づく)
    expect(cases.map((c) => c[0]).sort()).toEqual(PAGE_FORMATS.map((f) => f.id).sort());
  });
  it('紙の内側の余白は余白の表の CSS 値', () => {
    expect(sheetPadding('narrow')).toBe('12mm');
    expect(sheetPadding('wide')).toBe('30mm');
  });
});

describe('readNoteLayout', () => {
  it('前書きの 4 つのキーを読む', () => {
    const body = '---\ntitle: x\npage_format: a4-landscape\npage_margin: wide\npage_columns: 3\npage_font: mincho\n---\n本文';
    expect(readNoteLayout(body)).toEqual({ pageFormat: 'a4-landscape', pageMargin: 'wide', pageColumns: '3', pageFont: 'mincho' });
  });
  it('🔴 数の page_columns: 2 / 字の "2" を受ける。数で読まれる page_format: 43 も受ける', () => {
    expect(readNoteLayout('---\npage_columns: 2\n---\n').pageColumns).toBe('2');
    expect(readNoteLayout("---\npage_columns: '2'\n---\n").pageColumns).toBe('2');
    expect(readNoteLayout('---\npage_format: 43\n---\n').pageFormat).toBe('43');
  });
  it('🔴 読めない値は安全に無視する(その項目だけアプリの設定に従う)', () => {
    const body = '---\npage_format: b5\npage_margin: 10mm\npage_columns: 9\npage_font: comic\n---\n';
    expect(readNoteLayout(body)).toEqual(EMPTY_NOTE_LAYOUT);
    expect(readNoteLayout('---\npage_columns: [1, 2]\npage_font: true\n---\n')).toEqual(EMPTY_NOTE_LAYOUT);
    const mixed = readNoteLayout('---\npage_format: nope\npage_font: biz-ud\n---\n');
    expect(mixed).toEqual({ pageFormat: null, pageMargin: null, pageColumns: null, pageFont: 'biz-ud' });
  });
  it('前書きが無い・本文の中に page_ の字があるだけ・壊れた前書きでも投げない', () => {
    expect(readNoteLayout('')).toEqual(EMPTY_NOTE_LAYOUT);
    expect(readNoteLayout('本文に page_format: a3-landscape と書いてあるだけ')).toEqual(EMPTY_NOTE_LAYOUT);
    expect(readNoteLayout('---\npage_format: a3-landscape\n本文(閉じが無い)')).toEqual(EMPTY_NOTE_LAYOUT);
  });
});

describe('writeNoteLayout', () => {
  it('🔴 往復: 書いた値が読める。他のキー・本文は 1 バイトも動かない', () => {
    const body = '---\ntitle: 会議\ntags: [あ, い]\n---\n# 見出し\n\n本文 page_format の字\n';
    const next = writeNoteLayout(body, { pageFormat: 'a3-landscape', pageMargin: 'narrow', pageColumns: '2', pageFont: 'mono' });
    expect(readNoteLayout(next)).toEqual({ pageFormat: 'a3-landscape', pageMargin: 'narrow', pageColumns: '2', pageFont: 'mono' });
    expect(next).toBe(
      '---\ntitle: 会議\ntags: [あ, い]\npage_format: a3-landscape\npage_margin: narrow\npage_columns: 2\npage_font: mono\n---\n# 見出し\n\n本文 page_format の字\n',
    );
  });
  it('🔴 null はキーを消す。全部消すと元の本文へ 1 バイトも違わず戻る', () => {
    const body = '本文だけのノート\n2 行目';
    const on = writeNoteLayout(body, { pageFormat: 'a4-landscape', pageFont: 'mincho' });
    expect(on).toBe('---\npage_format: a4-landscape\npage_font: mincho\n---\n本文だけのノート\n2 行目');
    const one = writeNoteLayout(on, { pageFont: null });
    expect(readNoteLayout(one)).toEqual({ ...EMPTY_NOTE_LAYOUT, pageFormat: 'a4-landscape' });
    expect(writeNoteLayout(one, CLEAR_NOTE_LAYOUT)).toBe(body);
  });
  it('CRLF の本文でも改行コードを壊さない', () => {
    const body = '---\r\ntitle: x\r\n---\r\n本文\r\n';
    const next = writeNoteLayout(body, { pageMargin: 'wide' });
    expect(next).toBe('---\r\ntitle: x\r\npage_margin: wide\r\n---\r\n本文\r\n');
    expect(writeNoteLayout(next, { pageMargin: null })).toBe(body);
  });
  it('他の項目は書かない(指定した項目だけ)。空の指示は本文をそのまま返す', () => {
    const body = '---\npage_format: a4-landscape\npage_font: mono\n---\n本文';
    expect(writeNoteLayout(body, { pageMargin: 'wide' })).toBe('---\npage_format: a4-landscape\npage_font: mono\npage_margin: wide\n---\n本文');
    expect(writeNoteLayout(body, {})).toBe(body);
  });
  it('noteLayoutKeys: null → undefined(消す)、段数は数で書く', () => {
    expect(noteLayoutKeys({ pageColumns: '3', pageFont: null })).toEqual({ page_columns: 3, page_font: undefined });
    expect(noteLayoutKeys(CLEAR_NOTE_LAYOUT)).toEqual({
      page_format: undefined,
      page_margin: undefined,
      page_columns: undefined,
      page_font: undefined,
    });
  });
});

describe('resolveEffectiveLayout', () => {
  it('ノートに何も無ければアプリの設定のまま(@page の余白は null = 従来どおり)', () => {
    expect(resolveEffectiveLayout(EMPTY_NOTE_LAYOUT, APP)).toEqual({
      pageFormat: 'a4-portrait',
      pageMargin: null,
      sheetMargin: 'normal',
      readColumns: '1',
      font: 'standard',
    });
  });
  it('ノートの指定を優先する(項目ごと)', () => {
    expect(
      resolveEffectiveLayout({ pageFormat: 'a3-portrait', pageMargin: 'wide', pageColumns: '2', pageFont: 'mincho' }, APP),
    ).toEqual({ pageFormat: 'a3-portrait', pageMargin: 'wide', sheetMargin: 'wide', readColumns: '2', font: 'mincho' });
    expect(resolveEffectiveLayout({ ...EMPTY_NOTE_LAYOUT, pageColumns: '4' }, { pageFormat: 'fullhd', readColumns: '2', font: 'mono' })).toEqual({
      pageFormat: 'fullhd',
      pageMargin: null,
      sheetMargin: 'normal',
      readColumns: '4',
      font: 'mono',
    });
  });
});

describe('画面の補助', () => {
  it('hasNoteLayout', () => {
    expect(hasNoteLayout(EMPTY_NOTE_LAYOUT)).toBe(false);
    expect(hasNoteLayout({ ...EMPTY_NOTE_LAYOUT, pageMargin: 'narrow' })).toBe(true);
  });
  it('🔴 選択欄の値 → 指示:「アプリの設定に従う」(空) はキーを消す、読めない値・知らない項目は null', () => {
    expect(noteLayoutPatchFor('pageFormat', '')).toEqual({ pageFormat: null });
    expect(noteLayoutPatchFor('pageMargin', 'wide')).toEqual({ pageMargin: 'wide' });
    expect(noteLayoutPatchFor('pageColumns', '3')).toEqual({ pageColumns: '3' });
    expect(noteLayoutPatchFor('pageFont', 'mincho')).toEqual({ pageFont: 'mincho' });
    expect(noteLayoutPatchFor('pageFont', 'comic')).toBeNull();
    expect(noteLayoutPatchFor('title', 'x')).toBeNull();
  });
  it('🔴 選択肢は各正本の表そのもの(写していない)', () => {
    expect(noteLayoutChoices('pageFormat')).toBe(PAGE_FORMATS);
    expect(noteLayoutChoices('pageMargin')).toBe(PAGE_MARGINS);
    expect(noteLayoutChoices('pageColumns')).toBe(READ_COLUMN_CHOICES);
    expect(noteLayoutChoices('pageFont')).toBe(FONTS);
  });
  it('🔴 対象はフォルダ・system 領域以外', () => {
    expect(noteLayoutApplies('n1', 'text')).toBe(true);
    expect(noteLayoutApplies('n1', 'folder')).toBe(false);
    expect(noteLayoutApplies('sys-messages', 'text')).toBe(false);
  });
});
