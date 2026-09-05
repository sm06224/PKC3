/**
 * 🔴 **表の幅の規則**(#699)── CSS の字面を**構文で**pin する。
 *
 * ⚠ 実ブラウザで組んだ結果(数字が 1 行に収まる / 器の中で横に流れる)は
 *   `tests/smoke/table-width.smoke.spec.ts` が見る。ここは「規則が在って、
 *   当たる先が合っている」だけを見る ── **選択子リストを `,` で割って丸ごと一致**
 *   (`tests/helpers/css-blocks.ts`。CLAUDE.md §1 に 5 回踏んだ記録がある形)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, decl, stripComments, withoutMedia } from '../helpers/css-blocks';

const css = (): string => withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));

describe('表のセルは語の途中で折らない(#699)', () => {
  it('🔴 td / th は break-word ── 本文の anywhere を継承させない', () => {
    const text = css();
    // ⚠ 対照群: 本文の器には `anywhere` が在る(これが無ければセルの規則は要らない ──
    //    そのときはこの test ごと消してよい)
    const root = blocksFor(text, '.pkc-md-rendered').join('\n');
    expect(root, '本文の器の overflow-wrap: anywhere が消えた(前提が変わった)').toMatch(
      decl('overflow-wrap', 'anywhere'),
    );
    for (const sel of ['.pkc-md-rendered td', '.pkc-md-rendered th']) {
      const b = blocksFor(text, sel);
      expect(b.length, `${sel} の規則が無い(空振り)`).toBeGreaterThan(0);
      const joined = b.join('\n');
      expect(joined, `${sel} が break-word でない(狭い器で数字が「12 / 0」に割れる)`).toMatch(
        decl('overflow-wrap', 'break-word'),
      );
      expect(joined, `${sel} に anywhere が残っている`).not.toMatch(decl('overflow-wrap', 'anywhere'));
    }
  });

  it('🔴 表の器(markdown の表 / csv の fence)は横に流す ── 画面を横に広げない', () => {
    const text = css();
    for (const sel of [
      ".pkc-md-rendered .pkc-md-block[data-pkc-md-block-kind='table']",
      ".pkc-md-rendered .pkc-md-block[data-pkc-render-lang='csv']",
    ]) {
      const b = blocksFor(text, sel);
      expect(b.length, `${sel} の規則が無い(表が面の外へはみ出す)`).toBeGreaterThan(0);
      expect(b.join('\n'), `${sel} が横に流れない`).toMatch(decl('overflow-x', 'auto'));
    }
    // ⚠ コードの器には当てない(`<pre>` は自分の流し方を持つ ── 二重の scroll を作らない)
    expect(
      blocksFor(text, ".pkc-md-rendered .pkc-md-block[data-pkc-md-block-kind='code']"),
      'コードの器にまで横流しが当たっている',
    ).toHaveLength(0);
  });
});

/**
 * 🔴 **csv の表は読み幅まで / markdown の表の器は表の幅**(#704、裁定 案 A)。
 * ⚠ 組んだ寸法(csv の右端 = 段落の右端 / ⧉ が表の右上)は smoke が見る。
 */
describe('csv の表は読み幅の中で器いっぱい(#704)', () => {
  const CSV_BLOCK = ".pkc-md-rendered[data-pkc-prose] > .pkc-md-block[data-pkc-render-lang='csv']";
  it('🔴 csv の器の上限は散文と同じ --read-w ── 器いっぱい(width: 100%)は残す', () => {
    const text = css();
    const cap = blocksFor(text, CSV_BLOCK);
    expect(cap.length, 'csv の器に読み幅の上限が無い(広い窓で段落の右へ伸びる)').toBeGreaterThan(0);
    expect(cap.join('\n'), '上限が読み幅(--read-w)でない').toMatch(decl('max-width', 'var\\(--read-w\\)'));
    // ⚠ 散文の印は立てない ── 立てると、ライブエディタが csv の編集欄まで読み幅へ縮める
    expect(cap.join('\n'), 'csv の器が散文の印(--pkc-prose-block)を立てている').not.toContain(
      '--pkc-prose-block',
    );
    const table = blocksFor(text, '.pkc-md-rendered .pkc-md-rendered-csv');
    expect(table.join('\n'), 'csv の表が器いっぱいに広がらなくなった(裁定 A は「器いっぱい」)').toMatch(
      decl('width', '100%'),
    );
  });

  it('🔴 markdown の表の器は表の幅(⧉ が表の右上に来る)── ただし面より広くはならない', () => {
    const b = blocksFor(css(), ".pkc-md-rendered .pkc-md-block[data-pkc-md-block-kind='table']").join('\n');
    expect(b, '表の器が表の幅になっていない(⧉ が面の右端に浮く)').toMatch(decl('width', 'fit-content'));
    expect(b, '表の器に上限が無い(広い表で器が面の外へ出る)').toMatch(decl('max-width', '100%'));
    // ⚠ csv の器は fit-content にしない(width: 100% の表が循環して中身の幅へ縮む)
    expect(
      blocksFor(css(), ".pkc-md-rendered .pkc-md-block[data-pkc-render-lang='csv']").join('\n'),
      'csv の器が fit-content になっている(表が器いっぱいに広がらない)',
    ).not.toMatch(decl('width', 'fit-content'));
  });
});
