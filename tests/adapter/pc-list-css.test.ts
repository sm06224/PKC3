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
const DIR = "[data-pkc-field='pc-list'] > li[data-pkc-action='pc-dir-note']";
const HEAD = "[data-pkc-field='pc-head']";

describe('PC タブの一覧の作り(#1272)', () => {
  it('🔴 空振り防止 ── 5 つの規則が拾える', () => {
    const text = css();
    for (const sel of [LIST, ROW, DIR, OPEN, HEAD]) {
      expect(blocksFor(text, sel).length, `${sel} の規則が拾えない(走査が壊れている / 名前を変えた)`).toBeGreaterThan(0);
    }
  });

  it('🔴 一覧の下地に線色を使わない・gap で線を透かさない', () => {
    const body = blocksFor(css(), LIST).join('\n');
    expect(body, '下地が線色(余りが灰色のベタになる)').not.toMatch(decl('background', '.*'));
    expect(body, 'gap で線を透かしている').not.toMatch(decl('gap', '.*'));
  });

  it('🔴 各行に 1px の下罫線', () => {
    expect(blocksFor(css(), ROW).join('\n')).toMatch(decl('border-bottom', '1px solid var\\(--border\\)'));
  });

  it('🔴 押せる行と押せない行(フォルダ)は、同じ規則の中で余白・行間・寄せを持つ', () => {
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
