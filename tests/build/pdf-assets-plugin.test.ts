/** @vitest-environment node */
/**
 * PDF を PKC の画面で読む窓の部品(pdf.js)を、build で `pdf/lib/` へ写す plugin(#275 段①)。
 *
 * 守るもの:①検品が「要る」と言う file(`PDF_REQUIRED` の lib 側)を**1 つ残らず**写す ②配らない物(`*.map` /
 * `legacy/` / スクリプト実行の QuickJS / viewer の UI)を**写さない** ③日本語の cmap が入っている
 * ④検品の `PDF_DIR` と綴りが同じ。⚠ 実物(`node_modules/pdfjs-dist`)を読んで走らせる ── 上流が名前を
 * 変えた日に、ここが落ちる(黙って 0 件を配らない)。
 */
import { statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Plugin } from 'vite';
import { PDF_DIR, pdfAssetsPlugin } from '../../build/pdf-assets-plugin';
// @ts-expect-error -- 検品規則は素の .mjs(ビルド対象外の CI script 群)
import { PDF_DIR as INSPECT_PDF_DIR, PDF_REQUIRED } from '../../scripts/dist-inspect.mjs';

function emitted(): { fileName: string; bytes: number }[] {
  const out: { fileName: string; bytes: number }[] = [];
  const plugin = pdfAssetsPlugin() as Plugin & { generateBundle: (this: unknown) => void };
  plugin.generateBundle.call({
    emitFile: (f: { fileName: string; source: Buffer }) => {
      out.push({ fileName: f.fileName, bytes: f.source.byteLength });
    },
  });
  return out;
}

describe('pdfAssetsPlugin', () => {
  const files = emitted();
  const names = new Set(files.map((f) => f.fileName));

  it('⚠ 前提: 実際に写している(空振り防止)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.every((f) => f.bytes > 0)).toBe(true);
  });

  it('検品が「要る」と言う lib の file を 1 つ残らず写す(両側の綴りが同じ)', () => {
    expect(PDF_DIR).toBe(INSPECT_PDF_DIR);
    for (const n of PDF_REQUIRED as string[]) {
      expect(names.has(`${PDF_DIR}${n}`), `${n} を写していない`).toBe(true);
    }
  });

  it('全部 `pdf/lib/` の下へ置く(窓の小さな HTML / JS は public/pdf/ 直下から来る)', () => {
    for (const f of files) expect(f.fileName.startsWith(PDF_DIR), f.fileName).toBe(true);
  });

  it('日本語を読むための cmap と、画像の復号 wasm が入っている', () => {
    expect(names.has(`${PDF_DIR}cmaps/Adobe-Japan1-UCS2.bcmap`)).toBe(true);
    expect(names.has(`${PDF_DIR}cmaps/90ms-RKSJ-H.bcmap`)).toBe(true);
    for (const w of ['jbig2', 'openjpeg', 'qcms_bg']) {
      expect(names.has(`${PDF_DIR}wasm/${w}.wasm`), `${w}.wasm`).toBe(true);
    }
  });

  it('🔴 配らない物を写していない(map / legacy / viewer / スクリプト実行)', () => {
    for (const f of files) {
      expect(f.fileName.endsWith('.map'), `${f.fileName}: map は配らない`).toBe(false);
      expect(f.fileName.includes('/legacy/'), f.fileName).toBe(false);
      expect(f.fileName.includes('/web/'), f.fileName).toBe(false);
      expect(f.fileName.includes('quickjs'), `${f.fileName}: PDF の中の JavaScript は動かさない`).toBe(false);
      expect(f.fileName.includes('nowasm'), f.fileName).toBe(false);
    }
  });

  it('本体と解析 worker は minified の版(配る量を抑える)', () => {
    expect(names.has(`${PDF_DIR}pdf.min.mjs`)).toBe(true);
    expect(names.has(`${PDF_DIR}pdf.worker.min.mjs`)).toBe(true);
    expect(names.has(`${PDF_DIR}pdf.mjs`)).toBe(false);
  });

  /**
   * 🔴 **`legacy/` の版を配っている**(実測 2026-10-02)── 素の版は `Map.prototype.getOrInsertComputed` を
   *   そのまま呼ぶので、持たないブラウザ(手元の Chromium 141)では**頁が 1 枚も描けない**。
   * ⚠ 観測点は**中身の大きさ**(名前では素の版と区別が付かない)。本体と worker の**両方**が legacy であること
   *   (片方だけ素の版だと、版が食い違って読み込みで落ちる)。
   */
  it('🔴 本体も解析 worker も legacy の版(素の版は新しい機能を持たないブラウザで描けない)', () => {
    const size = (rel: string): number => statSync(`node_modules/pdfjs-dist/${rel}`).size;
    const got = (n: string): number | undefined => files.find((f) => f.fileName === `${PDF_DIR}${n}`)?.bytes;
    expect(got('pdf.min.mjs')).toBe(size('legacy/build/pdf.min.mjs'));
    expect(got('pdf.worker.min.mjs')).toBe(size('legacy/build/pdf.worker.min.mjs'));
    // ⚠ 空振り防止 ── 2 つの版は実際に大きさが違う(同じなら、この比較は何も見分けていない)
    expect(size('legacy/build/pdf.min.mjs')).not.toBe(size('build/pdf.min.mjs'));
    expect(size('legacy/build/pdf.worker.min.mjs')).not.toBe(size('build/pdf.worker.min.mjs'));
  });

  it('ライセンスの全文を同梱する(Apache-2.0 の本体 / 標準書体 / 復号 wasm)', () => {
    expect(names.has(`${PDF_DIR}LICENSE`)).toBe(true);
    expect(names.has(`${PDF_DIR}standard_fonts/LICENSE_LIBERATION`)).toBe(true);
    expect(names.has(`${PDF_DIR}wasm/LICENSE_OPENJPEG`)).toBe(true);
  });
});
