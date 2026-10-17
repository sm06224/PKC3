/** @vitest-environment node */
/**
 * PDF の窓の「添付から選ぶ」に出す一覧の規則(#275 結合)。
 * 🔴 守るもの: ①PDF の添付だけが載る(画像・動画・別の種類は載らない = 窓の鍵が指せる範囲)②鍵の無い添付は載せない
 * ③名前は元の file 名、空なら題名 ④並びは受け取った順。
 */
import { describe, expect, it } from 'vitest';
import { attachmentBody } from '../../src/features/flavor/attachment-flavor';
import { pdfAttachmentsOf } from '../../src/features/pdf/pdf-attachments';

const att = (title: string, name: string, mime: string, assetKey: string, size = 100) => ({
  title,
  body: attachmentBody({ name, mime, size, assetKey }),
});

describe('pdfAttachmentsOf', () => {
  it('PDF の添付だけを、受け取った順に、元の名前・鍵・大きさで挙げる', () => {
    const rows = [
      att('会議B', '会議B.pdf', 'application/pdf', 'kA', 1200),
      att('写真', 'p.png', 'image/png', 'kP'),
      att('契約', '契約.pdf', 'application/pdf', 'kC', 30),
      att('音声', 'a.mp3', 'audio/mpeg', 'kM'),
    ];
    expect(pdfAttachmentsOf(rows)).toEqual([
      { key: 'kA', name: '会議B.pdf', size: 1200 },
      { key: 'kC', name: '契約.pdf', size: 30 },
    ]);
  });

  it('元の名前が空なら題名 / 鍵の無い添付と、添付でないノートは載せない', () => {
    const noName = att('題名だけ', '', 'application/pdf', 'kT');
    expect(pdfAttachmentsOf([noName])).toEqual([{ key: 'kT', name: '題名だけ', size: 100 }]);
    const noKey = att('鍵なし', 'x.pdf', 'application/pdf', '');
    expect(pdfAttachmentsOf([noKey])).toEqual([]);
    expect(pdfAttachmentsOf([{ title: 'ふつうのノート', body: '# 本文\nただの字' }])).toEqual([]);
    expect(pdfAttachmentsOf([])).toEqual([]);
  });
});
