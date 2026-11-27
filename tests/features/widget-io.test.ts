/**
 * ウィジェットのファイルの入出力の純関数の契約(#2097)。
 *
 * 守る主張:
 * 1. 🔴 箱が名乗ったファイル名は、パスの区切り・制御文字・予約名・先頭の点を無害化し、拡張子は英数字だけ残す
 * 2. 🔴 実行できる・台本が動く拡張子(.exe / .html / .svg …)は要注意(大文字も)、ふつうの形式は要注意でない
 * 3. 🔴 50 MB を超える要求は写す前に断る / 型の違う要求は断る
 * 4. 🔴 1 つの箱につき 1 秒に 3 回まで、窓が過ぎれば戻る
 */
import { describe, expect, it } from 'vitest';
import {
  checkWidgetPickedFiles,
  createWidgetIoRateLimiter,
  isRiskyWidgetDownloadExt,
  normalizeWidgetAccept,
  parseWidgetDownloadRequest,
  parseWidgetFileRequest,
  sanitizeWidgetFileName,
  widgetAcceptMatches,
  widgetDownloadResponse,
  widgetDownloadRiskNotice,
  widgetFileResponse,
  WIDGET_DL_REQ_MSG_TYPE,
  WIDGET_DL_RES_MSG_TYPE,
  WIDGET_FILE_REQ_MSG_TYPE,
  WIDGET_FILE_RES_MSG_TYPE,
  WIDGET_IO_MAX_BYTES,
  WIDGET_IO_MAX_FILES,
  WIDGET_IO_REASONS,
} from '../../src/features/markdown/widget-io';

describe('🔴 ファイル名の無害化(sanitizeWidgetFileName)', () => {
  it('パスの区切りより前を捨てる(両方の向き)', () => {
    expect(sanitizeWidgetFileName('../../evil.csv', 'text/csv')).toBe('evil.csv');
    expect(sanitizeWidgetFileName('..\\..\\Windows\\evil.csv', 'text/csv')).toBe('evil.csv');
    expect(sanitizeWidgetFileName('/etc/passwd', 'text/plain')).toBe('passwd.txt');
  });
  it('制御文字・OS で使えない字を落とす', () => {
    const name = sanitizeWidgetFileName('a\u0000b\u0007c:d*e?.csv', 'text/csv');
    expect(name).toBe('a-b-c-d-e-.csv'.replace('-.csv', '.csv'));
    expect([...name].some((ch) => ch.codePointAt(0)! < 0x20)).toBe(false);
  });
  it('Windows の予約名(拡張子つき・大文字小文字を問わず)を逃がす', () => {
    expect(sanitizeWidgetFileName('CON.csv', 'text/csv')).toBe('CON-file.csv');
    expect(sanitizeWidgetFileName('nul.txt', 'text/plain')).toBe('nul-file.txt');
    expect(sanitizeWidgetFileName('LPT1.tar.gz', '')).toBe('LPT1-file.tar.gz');
  });
  it('先頭の点を落とす(隠しファイルにしない)・空なら download', () => {
    expect(sanitizeWidgetFileName('.bashrc', 'text/plain')).toBe('bashrc.txt');
    expect(sanitizeWidgetFileName('', 'text/csv')).toBe('download.csv');
    expect(sanitizeWidgetFileName(undefined, 'application/json')).toBe('download.json');
    expect(sanitizeWidgetFileName('...', 'text/plain')).toBe('download.txt');
  });
  it('拡張子が無ければ MIME から補い、知らない MIME は .bin', () => {
    expect(sanitizeWidgetFileName('report', 'text/csv; charset=utf-8')).toBe('report.csv');
    expect(sanitizeWidgetFileName('data', 'application/json')).toBe('data.json');
    expect(sanitizeWidgetFileName('img', 'image/png')).toBe('img.png');
    expect(sanitizeWidgetFileName('blob', 'application/x-unknown')).toBe('blob.bin');
    expect(sanitizeWidgetFileName('blob', '壊れた')).toBe('blob.bin');
  });
  it('英数字でない拡張子は名前の一部として扱い、MIME から補う', () => {
    expect(sanitizeWidgetFileName('a.c$v', 'text/csv')).toBe('a.c$v.csv');
  });
  it('拡張子は 60 字の切り詰めで失われない・サロゲートペアを割らない', () => {
    const long = '😀'.repeat(80);
    const name = sanitizeWidgetFileName(`${long}.csv`, 'text/csv');
    expect(name.endsWith('.csv')).toBe(true);
    // 割れたサロゲート(単独の上位・下位)が無い
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(name)).toBe(false);
    expect([...name.replace(/\.csv$/, '')].length).toBe(60);
  });
  it('日本語の名前は残す', () => {
    expect(sanitizeWidgetFileName('売上 一覧.csv', 'text/csv')).toBe('売上-一覧.csv');
  });
});

describe('🔴 要注意の拡張子', () => {
  it.each(['a.exe', 'b.bat', 'c.ps1', 'd.sh', 'e.html', 'f.svg', 'G.EXE', 'h.HtM', 'i.js', 'j.msi', 'k.lnk'])('%s は要注意', (n) => {
    expect(isRiskyWidgetDownloadExt(n)).toBe(true);
    expect(widgetDownloadRiskNotice(n)).toMatch(/スクリプトや実行コード/);
  });
  it.each(['a.csv', 'b.json', 'c.txt', 'd.png', 'e', 'f.xlsx'])('%s は要注意でない', (n) => {
    expect(isRiskyWidgetDownloadExt(n)).toBe(false);
    expect(widgetDownloadRiskNotice(n)).toBeNull();
  });
});

describe('🔴 保存の要求の検証(parseWidgetDownloadRequest)', () => {
  const base = { type: WIDGET_DL_REQ_MSG_TYPE, id: 'f1', reqId: 7, name: 'out.csv', mime: 'text/csv' };
  it('ArrayBuffer は写さずに窓を作る', () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    const r = parseWidgetDownloadRequest({ ...base, data: buf });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.req.bytes.buffer).toBe(buf);
    expect([...r.req.bytes]).toEqual([1, 2, 3]);
    expect(r.req).toMatchObject({ id: 'f1', reqId: 7, name: 'out.csv', mime: 'text/csv' });
  });
  it('型付き配列はその範囲だけを指す(buffer 全体を読まない)', () => {
    const big = new Uint8Array([9, 9, 1, 2, 9]);
    const r = parseWidgetDownloadRequest({ ...base, data: big.subarray(2, 4) });
    expect(r.ok && [...r.req.bytes]).toEqual([1, 2]);
  });
  it('文字列は UTF-8 にする', () => {
    const r = parseWidgetDownloadRequest({ ...base, data: 'あ,b' });
    expect(r.ok && [...r.req.bytes]).toEqual([0xe3, 0x81, 0x82, 0x2c, 0x62]);
  });
  it('🔴 50 MB を超える要求は断る(ArrayBuffer・型付き配列・文字列)', () => {
    const over = WIDGET_IO_MAX_BYTES + 1;
    // ⚠ 実際に 50 MB を確保しない ── byteLength だけ大きい偽物で「写す前に数える」ことを確かめる
    const fakeView = { byteLength: over, buffer: new ArrayBuffer(0), byteOffset: 0 };
    const isView = ArrayBuffer.isView;
    ArrayBuffer.isView = ((x: unknown) => x === fakeView || isView(x)) as typeof ArrayBuffer.isView;
    try {
      const r = parseWidgetDownloadRequest({ ...base, data: fakeView });
      expect(r).toEqual({ ok: false, reqId: 7, id: 'f1', reason: WIDGET_IO_REASONS.tooLarge });
    } finally {
      ArrayBuffer.isView = isView;
    }
    let encoded = 0;
    const r2 = parseWidgetDownloadRequest({ ...base, data: 'x'.repeat(over) }, (s) => {
      encoded += 1;
      return new TextEncoder().encode(s);
    });
    expect(r2.ok).toBe(false);
    expect(encoded, '上限を超えた字は符号化しない').toBe(0);
    // 字数は上限内でも、UTF-8 で上限を超える(1 字 3 バイト)
    const r3 = parseWidgetDownloadRequest({ ...base, data: 'あ' }, () => ({ byteLength: over }) as Uint8Array);
    expect(r3.ok === false && r3.reason).toBe(WIDGET_IO_REASONS.tooLarge);
  });
  it('ちょうど上限は通る(下限側の確認)', () => {
    const r = parseWidgetDownloadRequest({ ...base, data: new ArrayBuffer(WIDGET_IO_MAX_BYTES) });
    expect(r.ok).toBe(true);
  });
  it('型の違う data・番号の無い要求は断る', () => {
    expect(parseWidgetDownloadRequest({ ...base, data: { a: 1 } })).toMatchObject({ ok: false, reqId: 7, reason: WIDGET_IO_REASONS.badData });
    expect(parseWidgetDownloadRequest({ ...base, data: 5 })).toMatchObject({ ok: false });
    expect(parseWidgetDownloadRequest({ ...base, reqId: 'x', data: 'a' })).toMatchObject({ ok: false, reqId: null });
    expect(parseWidgetDownloadRequest({ ...base, reqId: -1, data: 'a' })).toMatchObject({ ok: false, reqId: null });
    expect(parseWidgetDownloadRequest({ ...base, id: 3, data: 'a' })).toMatchObject({ ok: false, id: null });
  });
  it('名前は無害化し、壊れた MIME は octet-stream', () => {
    const r = parseWidgetDownloadRequest({ ...base, name: '../CON', mime: 'text/html\nx', data: 'a' });
    expect(r.ok && r.req).toMatchObject({ name: 'CON-file.bin', mime: 'application/octet-stream' });
  });
});

describe('🔴 読み込みの要求の検証(parseWidgetFileRequest)', () => {
  const base = { type: WIDGET_FILE_REQ_MSG_TYPE, id: 'f1', reqId: 1 };
  it('既定は 1 件・上限 50 MB・種類の指定なし', () => {
    expect(parseWidgetFileRequest(base)).toEqual({
      ok: true,
      req: { id: 'f1', reqId: 1, accept: '', multiple: false, maxBytes: WIDGET_IO_MAX_BYTES },
    });
  });
  it('maxBytes は上限で丸め、正の数でなければ上限', () => {
    expect(parseWidgetFileRequest({ ...base, maxBytes: 10 }).ok && (parseWidgetFileRequest({ ...base, maxBytes: 10 }) as { req: { maxBytes: number } }).req.maxBytes).toBe(10);
    const r = parseWidgetFileRequest({ ...base, maxBytes: WIDGET_IO_MAX_BYTES * 10, multiple: true });
    expect(r.ok && r.req).toMatchObject({ maxBytes: WIDGET_IO_MAX_BYTES, multiple: true });
    const r2 = parseWidgetFileRequest({ ...base, maxBytes: -5 });
    expect(r2.ok && r2.req.maxBytes).toBe(WIDGET_IO_MAX_BYTES);
  });
  it('accept は安全な形だけ通す(改行・制御文字・長大な字は断る)', () => {
    expect(normalizeWidgetAccept('.csv, text/csv ,image/*')).toBe('.csv,text/csv,image/*');
    expect(normalizeWidgetAccept('.csv\n')).toBe('.csv');
    expect(normalizeWidgetAccept('.csv\nfoo')).toBeNull();
    expect(normalizeWidgetAccept('.c\u0000sv')).toBeNull();
    expect(normalizeWidgetAccept('.csv'.repeat(100))).toBeNull();
    expect(normalizeWidgetAccept('"><img>')).toBeNull();
    expect(parseWidgetFileRequest({ ...base, accept: 'text/csv\r\n<script>' })).toMatchObject({
      ok: false,
      reason: WIDGET_IO_REASONS.badAccept,
    });
  });
  it('accept の照合(拡張子・種類・種類のワイルドカード)', () => {
    expect(widgetAcceptMatches('', 'a.bin', '')).toBe(true);
    expect(widgetAcceptMatches('.csv', 'A.CSV', 'text/plain')).toBe(true);
    expect(widgetAcceptMatches('image/*', 'x', 'image/png')).toBe(true);
    expect(widgetAcceptMatches('text/csv', 'x', 'text/csv;charset=utf-8')).toBe(true);
    expect(widgetAcceptMatches('.csv,image/*', 'a.txt', 'text/plain')).toBe(false);
  });
  it('選んだファイルの数と大きさを検める(1 件でも大きすぎれば全部断る)', () => {
    expect(checkWidgetPickedFiles([], { multiple: false, maxBytes: 10 })).toBe(WIDGET_IO_REASONS.cancelled);
    expect(checkWidgetPickedFiles([{ size: 1 }, { size: 1 }], { multiple: false, maxBytes: 10 })).toBe(WIDGET_IO_REASONS.tooMany);
    const many = Array.from({ length: WIDGET_IO_MAX_FILES + 1 }, () => ({ size: 1 }));
    expect(checkWidgetPickedFiles(many, { multiple: true, maxBytes: 10 })).toBe(WIDGET_IO_REASONS.tooMany);
    expect(checkWidgetPickedFiles([{ size: 5 }, { size: 11 }], { multiple: true, maxBytes: 10 })).toMatch(/大きすぎ/);
    expect(checkWidgetPickedFiles([{ size: 10 }], { multiple: false, maxBytes: 10 })).toBeNull();
  });
});

describe('🔴 流量の上限(createWidgetIoRateLimiter)', () => {
  it('1 秒に 3 回まで通し、4 回目は断り、窓が過ぎれば戻る', () => {
    const l = createWidgetIoRateLimiter();
    expect([l.allow(0), l.allow(10), l.allow(20), l.allow(30)]).toEqual([true, true, true, false]);
    expect(l.allow(999)).toBe(false);
    expect(l.allow(1000)).toBe(true);
    expect(l.allow(1005)).toBe(false);
    expect(l.allow(1010)).toBe(true);
  });
  it('箱ごとに別の数え(1 つの limiter は他へ影響しない)', () => {
    const a = createWidgetIoRateLimiter();
    const b = createWidgetIoRateLimiter();
    for (let i = 0; i < 3; i++) a.allow(0);
    expect(a.allow(1)).toBe(false);
    expect(b.allow(1)).toBe(true);
  });
});

describe('答えの形', () => {
  it('保存と読み込みの答えの型名と項目', () => {
    expect(widgetDownloadResponse(3, true, 'save')).toEqual({ type: WIDGET_DL_RES_MSG_TYPE, reqId: 3, ok: true, action: 'save' });
    expect(widgetDownloadResponse(3, false, 'cancel', 'x')).toMatchObject({ reason: 'x' });
    expect(widgetFileResponse(4, false, [], 'y')).toEqual({ type: WIDGET_FILE_RES_MSG_TYPE, reqId: 4, ok: false, files: [], reason: 'y' });
  });
});
