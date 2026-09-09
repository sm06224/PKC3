/**
 * 🔴 **SQL の答えの表 ── 列の名前を貼り付ける**(#837 K2、2026-09-09)。
 *
 * ## 直す前、画面で何が起きていたか
 *
 * 「500 行」出た表を下へ転がして 200 行目を見ているとき、「この 3 列目は何だったか」を
 * 確かめるには**いちばん上まで戻す**しかなく、戻したらまた 200 行目まで転がし直しだった。
 * ⚠ 表は `white-space: pre` なので横にも長くなりやすく、往復はさらに増える。
 *
 * ⚠ ここが見るのは「**規則が在って、当たる先が合っている**」だけである ──
 * 実ブラウザで実際に貼り付くかは別の話(器が転がらなければ sticky は効かない)。
 * 🔑 だから**器が転がること**も対照群として見る ── これが無いと、
 * `position: sticky` を書いただけで「守っている」と言えてしまう。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, decl, stripComments, withoutMedia } from '../helpers/css-blocks';

const css = (): string => withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));

describe('SQL の答えの表(#837 K2)', () => {
  it('🔴 列の名前の行が、器の上に貼り付く', () => {
    const text = css();
    const b = blocksFor(text, "[data-pkc-field='sql-table'] th");
    expect(b.length, '列の名前の規則が無い(空振り)').toBeGreaterThan(0);
    const joined = b.join('\n');
    expect(joined, '貼り付いていない(下へ転がすと列の名前が消える)').toMatch(
      decl('position', 'sticky'),
    );
    expect(joined, '貼り付く位置が決まっていない(sticky は top が要る)').toMatch(
      decl('top', '0'),
    );
    /**
     * 🔴 **地は不透明**(透けると、下を通る行が名前に重なって読めない)。
     * ⚠ `--surface-2` は不透明の変数である(`css-vars.test.ts` が定義を守る)。
     */
    // ⚠ `decl()` は値を正規表現へ入れるので、括弧を含む値は素の字で見る
    expect(joined, '地が無い(下の行が透けて重なる)').toContain('background: var(--surface-2)');
    /**
     * ⚠ `border-collapse: collapse` の表では**枠線が一緒に貼り付かない**ので、
     *   下の線は影で描く ── 無いと、貼り付いた行が中身と地続きに見える。
     */
    expect(joined, '下の区切りが無い(貼り付いた行が中身と地続きに見える)').toContain(
      'box-shadow',
    );
  });

  /**
   * 🔴 **対照群 ── 器が転がること**。
   * ⚠ `position: sticky` は「転がる祖先」が無ければ**何もしない** ──
   *   これを見ないと、規則を書いただけで守っている気になる。
   */
  it('🔴 表の器が転がる(でなければ貼り付きは何もしない)', () => {
    const b = blocksFor(css(), "[data-pkc-field='sql-body']");
    expect(b.length, '表の器の規則が無い(空振り)').toBeGreaterThan(0);
    expect(b.join('\n'), '器が転がらない ── 貼り付きが効かない').toMatch(
      decl('overflow', 'auto'),
    );
  });
});
