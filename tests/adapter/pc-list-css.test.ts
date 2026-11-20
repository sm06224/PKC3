/**
 * 🔴 **PC タブの一覧は「普通の一覧」── 下地で線を透かさない・行の余白は押せる行と押せない行で同じ**
 * (#1272)── CSS を構文で pin(`button-bars-css.test.ts` と同じ作法)。
 *
 * ## なぜ見るのか
 *
 * 旧い作りは `pc-list` が `gap: 1px` + 下地 `var(--border)` で線を透かしていた(#951 で帯から外した
 * 古い形)。⚠ 行の高さが揃わない・余りが出ると**線色のベタ塗り**になる。
 * そのうえフォルダの行(`li` 直下の字)とファイルの行(`button` の中)で**余白が違い**、
 * 並べると左右・上下がずれて見えた。
 *
 * ⚠ 見るのは**実行する規則**だけ(注釈は剥ぐ・`@media` の中は見ない)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, decl, stripComments, withoutMedia } from '../helpers/css-blocks';

const css = (): string => withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));

const LIST = "[data-pkc-field='pc-list']";
const ROW = "[data-pkc-field='pc-list'] > li";
const OPEN = "[data-pkc-field='pc-open']";
const DIR = "[data-pkc-field='pc-enter']";
const HEAD = "[data-pkc-field='pc-head']";

describe('PC タブの一覧の作り(#1272)', () => {
  it('🔴 空振り防止 ── 5 つの規則が拾える', () => {
    const text = css();
    for (const sel of [LIST, ROW, DIR, OPEN, HEAD]) {
      expect(blocksFor(text, sel).length, `${sel} の規則が拾えない(走査が壊れている / 名前を変えた)`).toBeGreaterThan(0);
    }
  });

  it('🔴 一覧の下地に線色を使わない・行の間は線ではなく隙間(#1982 段 2)', () => {
    const body = blocksFor(css(), LIST).join('\n');
    expect(body, '下地を塗っている(机の地のまま。余りが灰色のベタになる)').not.toMatch(decl('background', '.*'));
    expect(body, '行の間が 1px の透かしへ戻っている').not.toMatch(decl('gap', '1px'));
    expect(body, '行の間(隙間)が無い').toMatch(decl('gap', 'var\\(--s[1-3]\\)'));
  });

  it('🔴 各行に罫線を引かない ── 区切りは隙間と hover の地(#1982 段 2)', () => {
    const row = blocksFor(css(), ROW).join('\n');
    expect(row).not.toMatch(decl('border-bottom', '.*'));
    expect(row, '行の下地を塗っている').not.toMatch(decl('background', '.*'));
    // 🔑 hover は見える地(--surface-hover。全テーマで検算 = shell-tone-css.test.ts)
    expect(blocksFor(css(), `${OPEN}:hover`).join('\n')).toMatch(decl('background', 'var\\(--surface-hover\\)'));
  });

  it('🔴 ファイルの行とフォルダの行(どちらも押せる)は、同じ規則の中で余白・行間・寄せを持つ', () => {
    const text = css();
    // ⚠ 別々の規則に同じ値を書くと、片方だけ直る日が来る ── 1 つの選択子リストに入っていること
    const shared = blocksFor(text, OPEN).filter((b) => blocksFor(text, DIR).includes(b));
    expect(shared.length, 'ファイルの行とフォルダの行が同じ規則を共有していない').toBe(1);
    const body = shared[0]!;
    expect(body).toMatch(decl('padding', 'var\\(--s2\\)'));
    expect(body).toMatch(decl('gap', '2px'));
    expect(body).toMatch(decl('align-items', 'flex-start'));
  });

  it('🔴 1 行目(絵 + 名前)は横 1 列で中心を揃える', () => {
    const body = blocksFor(css(), HEAD).join('\n');
    expect(body).toMatch(decl('display', 'flex'));
    expect(body).toMatch(decl('align-items', 'center'));
  });
});
