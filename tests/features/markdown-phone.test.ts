/**
 * 🔴 **本文の電話番号を押せる形で描く**(#278 段②)。
 *
 * 判定そのものは `tests/features/phone-link.test.ts` が見ている。
 * ⚠ ここが見るのは**描画に届いているか**である ── 判定が正しくても、
 * 渡し忘れ・当てる場所の間違いで「押せない」「本文が化ける」になる。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const on = (md: string): string => renderMarkdown(md, { phoneLinks: true });
const off = (md: string): string => renderMarkdown(md, {});

describe('素の電話番号を押せる形にする(#278 段②)', () => {
  it('🔴 入れた人には、押せる字になる', () => {
    const html = on('連絡は 090-1234-5678 まで。');
    expect(html, 'tel: のリンクになっていない').toContain('href="tel:09012345678"');
    // ⚠ 画面に出す字は**打ったまま**(勝手に半角へ直したように見せない)
    expect(html, '打った字が変わっている').toContain('>090-1234-5678</a>');
    /**
     * 🔴 **前後の字が 1 文字も消えていない**(変異試験 M3 / M4 が教えた)。
     * ⚠ 切り貼りで本文を失うのは、いちばん取り返しがつかない壊れ方である。
     */
    expect(html, '番号の前の字が消えた').toContain('連絡は ');
    expect(html, '番号の後ろの字が消えた').toContain(' まで。');
  });

  /**
   * 🔴 **既定は切**(user 裁定 2026-09-04 の推薦 C)。
   * ⚠ ここが緩むと、**何も選んでいない全 user の本文の見え方が変わる**
   *   (CLAUDE.md「見え方を変える判断は user のもの」)。
   */
  it('🔴 選んでいない人の本文は、1 文字も変わらない', () => {
    const html = off('連絡は 090-1234-5678 まで。');
    expect(html, '既定で押せる字になっている').not.toContain('tel:');
    expect(html, '素の字が消えている').toContain('090-1234-5678');
    // 🔴 空振り防止 ── 同じ本文で、入れれば変わること(この test 自体が効いている)
    expect(on('連絡は 090-1234-5678 まで。')).not.toBe(html);
  });

  it('🔴 日付は押せる字にしない(本文が化けない)', () => {
    const html = on('2026-09-09 に打ち合わせ。');
    expect(html, '日付を電話にした').not.toContain('tel:');
    expect(html).toContain('2026-09-09');
  });

  it('🔴 全角で打った番号も押せる(日本語入力のまま書いた形)', () => {
    const html = on('０９０－１２３４－５６７８ へ。');
    expect(html, '全角の番号を拾えていない').toContain('href="tel:09012345678"');
    expect(html, '打った字が半角へ直っている').toContain('>０９０－１２３４－５６７８</a>');
  });

  /**
   * 🔴 **リンクの字が番号そのものでも、二重にしない**(変異試験 M2 が SURVIVED で教えた)。
   * ⚠ 1 稿目のリンクの字は「この番号」で、**番号を 1 桁も含んでいなかった** ──
   *   だから「リンクの中では当てない」を外しても何も起きなかった(空振り)。
   */
  it('⚠ 既に押せるリンクの中は、二重にしない', () => {
    const html = on('[090-1234-5678](tel:09012345678) と 03-1234-5678');
    // ⚠ 2 つ在ってよい(1 つは元のリンク、もう 1 つが素の番号)が、**入れ子は作らない**
    expect(html.match(/<a /g) ?? [], 'リンクの数が合わない').toHaveLength(2);
    expect(html, 'リンクの中にもう 1 つリンクを入れた').not.toMatch(/<a [^>]*><a /);
    // 🔑 元のリンクの行き先は**書いたまま**(こちらが上書きしていない)
    expect(html, '元のリンクの行き先が変わった').toContain('href="tel:09012345678"');
  });

  it('⚠ 囲み(コード)の中は当てない', () => {
    const html = on('`090-1234-5678` は素の字のまま');
    expect(html, 'コードの中を押せる字にした').not.toContain('tel:');
    expect(html).toContain('<code>090-1234-5678</code>');
  });

  it('🔴 1 つの段落に 2 件在れば、2 件とも押せる', () => {
    const html = on('会社 03-1234-5678 / 携帯 090-1234-5678');
    expect(html).toContain('href="tel:0312345678"');
    expect(html).toContain('href="tel:09012345678"');
    // ⚠ 間の字が消えていないこと(切り貼りで本文を失わない)
    expect(html, '間の字が消えた').toContain('/ 携帯 ');
    expect(html, '前の字が消えた').toContain('会社 ');
  });
});
