/**
 * O3: 添付の器に出す **Office の入口**(#88)。
 *
 * 守りたい主張:
 *  ① Office の添付でなければ**何も出さない**(csv を横取りしない)
 *  ② MIME が落ちていても**拡張子で拾う**(取りこぼしのほうが痛い)
 *  ③ **使えない環境**は「未配備」より**先**に見る(77MB を無駄に取らせない)
 *  ④ 出すのは常に「押せる」か「理由」── **押しても何も起きないボタンを作らない**
 */
import { describe, expect, it } from 'vitest';
import {
  isOfficeAttachment,
  missingCapabilities,
  officeEntry,
  readOfficeCapability,
  type OfficeCapability,
} from '../../src/features/office/office-entry';

const OK: OfficeCapability = {
  crossOriginIsolated: true,
  sharedArrayBuffer: true,
  jspi: true,
  decompressionStream: true,
};

describe('isOfficeAttachment', () => {
  it('OOXML / 旧形式 / ODF の MIME を拾う', () => {
    for (const mime of [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/msword',
      'application/vnd.ms-excel',
      'application/vnd.ms-powerpoint',
      'application/vnd.oasis.opendocument.text',
      'application/vnd.oasis.opendocument.spreadsheet',
      'application/vnd.oasis.opendocument.presentation',
    ]) {
      expect(isOfficeAttachment(mime, 'x.bin'), mime).toBe(true);
    }
  });

  it('🔴 MIME が落ちていても拡張子で拾う(実環境では octet-stream になる)', () => {
    for (const name of ['報告書.docx', 'a.XLSX', 'b.pptx', 'c.doc', 'd.xls', 'e.ppt',
      'f.odt', 'g.ods', 'h.odp', 'i.odg', 'j.fodt', 'k.rtf']) {
      expect(isOfficeAttachment('application/octet-stream', name), name).toBe(true);
    }
  });

  it('🔴 csv は拾わない(PKC3 が自前で表として描く動線を横取りしない)', () => {
    expect(isOfficeAttachment('text/csv', 'data.csv')).toBe(false);
    expect(isOfficeAttachment('application/octet-stream', 'data.csv')).toBe(false);
  });

  it('画像や PDF や markdown は拾わない', () => {
    expect(isOfficeAttachment('image/png', 'a.png')).toBe(false);
    expect(isOfficeAttachment('application/pdf', 'a.pdf')).toBe(false);
    expect(isOfficeAttachment('text/markdown', 'a.md')).toBe(false);
    expect(isOfficeAttachment('', '')).toBe(false);
  });

  it('🔴 拡張子は**末尾**で見る(含んでいるだけの名前は拾わない)', () => {
    // ⚠ 変異試験で見つけた穴 ── 最初の反例 `docx-notes.txt` は `.docx` を
    //    **含まない**ので、`endsWith` を `includes` に変える変異を殺せなかった。
    //    **判別する例**はこちら:
    expect(isOfficeAttachment('application/octet-stream', 'report.docx.bak'), '.docx を含むが末尾ではない').toBe(false);
    expect(isOfficeAttachment('application/octet-stream', '.odt.zip'), '.odt を含むが末尾ではない').toBe(false);
    expect(isOfficeAttachment('application/octet-stream', 'docx-notes.txt')).toBe(false);
    // 対照: 末尾なら拾う(この test 自体が空振りでないことの確認)
    expect(isOfficeAttachment('application/octet-stream', 'report.docx')).toBe(true);
  });
});

describe('officeEntry', () => {
  it('Office でない添付には何も出さない', () => {
    expect(officeEntry({
      mime: 'image/png', fileName: 'a.png', packInstalled: true, capability: OK,
    })).toEqual({ kind: 'none' });
  });

  it('配備済み・能力あり なら「開く」', () => {
    const e = officeEntry({
      mime: 'application/msword', fileName: 'a.doc', packInstalled: true, capability: OK,
    });
    expect(e.kind).toBe('open');
    expect(e.kind === 'open' && e.label).toBe('Office で開く');
  });

  it('未配備なら設置カード(⚠ 勝手に取得しないので、出すのは案内だけ)', () => {
    const e = officeEntry({
      mime: 'application/msword', fileName: 'a.doc', packInstalled: false, capability: OK,
    });
    expect(e.kind).toBe('setup');
    expect(e.kind === 'setup' && e.reason).toContain('77MB');
  });

  it('🔴 使えない環境は「未配備」より先に見る(77MB を無駄に取らせない)', () => {
    const e = officeEntry({
      mime: 'application/msword',
      fileName: 'a.doc',
      packInstalled: false, // 未配備でもある
      capability: { ...OK, jspi: false },
    });
    expect(e.kind, '設置を促さない').toBe('unsupported');
    expect(e.kind === 'unsupported' && e.missing).toEqual(['JSPI(WebAssembly の Promise 統合)']);
  });

  it('🔴 足りないものを名指しで出す(押しても何も起きないボタンを作らない)', () => {
    const e = officeEntry({
      mime: 'application/msword',
      fileName: 'a.doc',
      packInstalled: true,
      capability: { crossOriginIsolated: false, sharedArrayBuffer: false, jspi: false, decompressionStream: false },
    });
    expect(e.kind).toBe('unsupported');
    expect(e.kind === 'unsupported' && e.missing.length, '4 つとも挙げる').toBe(4);
    expect(e.kind === 'unsupported' && e.reason).toContain('SharedArrayBuffer');
  });
});

describe('missingCapabilities', () => {
  it('揃っていれば空', () => {
    expect(missingCapabilities(OK)).toEqual([]);
  });
  it('欠けたものだけを、読める言葉で並べる', () => {
    expect(missingCapabilities({ ...OK, crossOriginIsolated: false }))
      .toEqual(['分離(cross-origin isolation)']);
  });
});

describe('readOfficeCapability', () => {
  it('window から読む ── 全部揃っている場合', () => {
    const w = {
      crossOriginIsolated: true,
      SharedArrayBuffer: function SAB() { /* 目印 */ },
      WebAssembly: { Suspending: function S() { /* 目印 */ } },
      DecompressionStream: function DS() { /* 目印 */ },
    } as unknown as typeof globalThis;
    expect(readOfficeCapability(w)).toEqual(OK);
  });

  it('🔴 何も無い環境でも投げない(WebAssembly ごと無い場合)', () => {
    const w = {} as unknown as typeof globalThis;
    expect(readOfficeCapability(w)).toEqual({
      crossOriginIsolated: false,
      sharedArrayBuffer: false,
      jspi: false,
      decompressionStream: false,
    });
  });

  it('JSPI だけ無い環境を、そのとおりに読む', () => {
    const w = {
      crossOriginIsolated: true,
      SharedArrayBuffer: function SAB() { /* 目印 */ },
      WebAssembly: {}, // Suspending が無い = JSPI 無し
      DecompressionStream: function DS() { /* 目印 */ },
    } as unknown as typeof globalThis;
    expect(readOfficeCapability(w).jspi).toBe(false);
  });
});
