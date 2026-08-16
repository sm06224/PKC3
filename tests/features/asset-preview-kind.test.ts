/**
 * 添付の見せ方の判定(2026-08-15、user 報告「PDF ビューアが動作しない」)。
 *
 * 🔴 守る主張: **判定は 1 本**。直す前は画面の preview(`detail.ts` の三項連鎖)と
 * 別の窓(`isImageAssetMime`)で**別の規則**を使っており、
 * 「画面には出せるのに別窓には出せない PDF」という食い違いが生まれていた。
 */
import { describe, expect, it } from 'vitest';
import { EXT_MIME } from '@adapter/ui/actions/attach';
import {
  assetPreviewKind,
  assetWindowKind,
  canOpenAssetWindow,
} from '../../src/features/asset/asset-preview-kind';

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
   * 🔴 **恒真な包含を書かない**(2026-08-15、着地前レビューで指摘)。
   *
   * ⚠ 1 稿目は `if (canOpenAssetWindow(m)) expect(assetPreviewKind(m)).not.toBeNull()`
   * と書いていたが、`canOpenAssetWindow` は `assetPreviewKind` で**定義されている**
   * ので、この含意は**定義から従う** ── 実装を何に書き換えても落ちない。
   * ⚠ しかも比べる相手が手書きの 9 件だったので、その外は素通りした。
   * 🔑 **集合の等値**で pin し、母集団は**アプリが実際に作りうる MIME の全数**
   * (`attach.ts` の `EXT_MIME` の値)にする ── 代替物で満たせない条件になる。
   */
  it('🔴 別窓に出せるのは、画面の見せ方が image / pdf のものだけ(集合で pin)', () => {
    /**
     * ⚠ **母集団は実装から採る**(2026-08-16 に手写しをやめた ── 着地前レビュー D1)。
     * 「`EXT_MIME` の値の全数」と書いてありながら**手で写していた**ので、
     * 2026-08-16 に Office の 14 種が増えたとき **1 件も追随しなかった**
     * (docx だけ偶然入っていた)── 表明が嘘になっていた。
     */
    const CORPUS = [
      ...new Set(Object.values(EXT_MIME)),
      // 端の数件(表に無いが取込で実際に付く)
      'application/octet-stream',
      'application/zip',
    ];
    // 空振り防止 ── 母集団が痩せると、この集合の等値は何も見ていない
    expect(CORPUS.length, '母集団が小さすぎる').toBeGreaterThan(20);
    const opened = CORPUS.filter((m) => canOpenAssetWindow(m));
    expect(opened.map((m) => assetPreviewKind(m)).sort(), '別窓の集合が image/pdf からずれた')
      .toEqual(['image', 'image', 'image', 'image', 'image', 'pdf']);
    // 🔑 `assetWindowKind` は「出せない ⇔ null」で `canOpenAssetWindow` と一致する
    for (const m of CORPUS) {
      expect(assetWindowKind(m) !== null, `${m}: 2 つの口の答えが食い違う`).toBe(
        canOpenAssetWindow(m),
      );
    }
  });

  /**
   * 🔴 **知らない種類を黙って image に落とさない**(レビュー指摘の本体)。
   * ⚠ 直す前は `main.ts` に三項で書いてあり、**どの test からも実行されない file**
   * だったので、`'pdf'` 固定へ変える変異が全 test 緑のまま通り、
   * **画像の別窓が空の枠**になった。
   */
  it('🔴 assetWindowKind は出せない種類に null を返す', () => {
    expect(assetWindowKind('image/png')).toBe('image');
    expect(assetWindowKind('image/svg+xml')).toBe('image');
    expect(assetWindowKind('application/pdf')).toBe('pdf');
    expect(assetWindowKind('video/mp4'), '動画を image に落としている').toBeNull();
    expect(assetWindowKind('text/plain')).toBeNull();
    expect(assetWindowKind('application/zip')).toBeNull();
    expect(assetWindowKind(null)).toBeNull();
    expect(assetWindowKind('')).toBeNull();
  });
});
