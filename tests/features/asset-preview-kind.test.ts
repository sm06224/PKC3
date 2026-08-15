/**
 * 添付の見せ方の判定(2026-08-15、user 報告「PDF ビューアが動作しない」)。
 *
 * 🔴 守る主張: **判定は 1 本**。直す前は画面の preview(`detail.ts` の三項連鎖)と
 * 別の窓(`isImageAssetMime`)で**別の規則**を使っており、
 * 「画面には出せるのに別窓には出せない PDF」という食い違いが生まれていた。
 */
import { describe, expect, it } from 'vitest';
import { assetPreviewKind, canOpenAssetWindow } from '../../src/features/asset/asset-preview-kind';

describe('assetPreviewKind', () => {
  it('種類ごとに決まる(全数)', () => {
    const table: [string, ReturnType<typeof assetPreviewKind>][] = [
      ['text/plain', 'text'],
      ['text/markdown', 'text'],
      ['application/json', 'text'],
      ['image/png', 'image'],
      ['image/svg+xml', 'image'],
      ['video/mp4', 'video'],
      ['audio/mpeg', 'audio'],
      ['application/pdf', 'pdf'],
      ['application/zip', null],
      ['text/html', 'text'],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', null],
      ['', null],
    ];
    for (const [mime, want] of table) {
      expect(assetPreviewKind(mime), `${mime} の見せ方`).toBe(want);
    }
  });

  it('欠けた MIME でも落ちない(出せない扱い)', () => {
    expect(assetPreviewKind(null)).toBeNull();
    expect(assetPreviewKind(undefined)).toBeNull();
  });

  /**
   * ⚠ `application/pdf` にしか当てない ── `application/pdf-something` のような
   * 前方一致で拾うと、別形式を PDF ビューアへ渡して空白になる。
   */
  it('PDF は前方一致で拾わない', () => {
    expect(assetPreviewKind('application/pdfx')).toBeNull();
    expect(assetPreviewKind('application/x-pdf')).toBeNull();
  });
});

describe('canOpenAssetWindow', () => {
  it('🔴 画像と PDF だけ別窓に出せる', () => {
    expect(canOpenAssetWindow('image/png')).toBe(true);
    expect(canOpenAssetWindow('application/pdf')).toBe(true);
    // ⚠ 動画・音声は別窓にしない(閉じるまで再生が続き、止める導線が消える)
    expect(canOpenAssetWindow('video/mp4')).toBe(false);
    expect(canOpenAssetWindow('audio/mpeg')).toBe(false);
    expect(canOpenAssetWindow('text/plain')).toBe(false);
    expect(canOpenAssetWindow('application/zip')).toBe(false);
    expect(canOpenAssetWindow(null)).toBe(false);
  });

  /**
   * 🔑 **画面に出せるものの部分集合である**(片方だけ知っている状態を作らない)。
   * ⚠ これが破れると、user 報告の食い違い ── 画面には出るのに別窓には出ない ──
   * が別の MIME で再発する。
   */
  it('🔴 別窓に出せるものは、画面にも出せる', () => {
    const mimes = [
      'image/png',
      'image/gif',
      'application/pdf',
      'video/mp4',
      'audio/mpeg',
      'text/plain',
      'application/json',
      'application/zip',
      'application/octet-stream',
    ];
    for (const m of mimes) {
      if (canOpenAssetWindow(m)) {
        expect(assetPreviewKind(m), `${m} は別窓に出せるのに画面に出せない`).not.toBeNull();
      }
    }
  });
});
