/**
 * user 報告(2026-08-05)から見つかった markdown の欠陥を pin する。
 * 調査 doc: `docs/development/user-reports-2026-08-05.md`
 *
 * 🔴 **ここに並ぶ 2 件は、直す前も `npm test` が全部緑だった。**
 * 既存の検査(golden / css-parity / docs-parity)はどれもこの振る舞いを見ていない ──
 * CLAUDE.md「通っている test は、何も保証していないかもしれない」の実例である。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '@features/markdown/markdown-render';

/** 見える文字だけ取り出す(タグの形ではなく**中身が届いたか**を見る)。 */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

describe(':::toc は 1 行で閉じる(本文を飲まない)', () => {
  it('🔴 `:::toc` の後ろに書いた本文が消えない', () => {
    // ⚠ ここが本題。直す前は「次に現れる単独 `:::`」を探して**その間を全部**
    //    捨てていたので、後ろの `:::note` の閉じに当たって見出しも段落も消えた
    const html = renderMarkdown(
      ['# 題', '', ':::toc', '', '## 見出し A', '本文 A', '', ':::note', '注記', ':::', ''].join(
        '\n',
      ),
    );
    const t = textOf(html);
    expect(t, '見出しが飲まれた').toContain('見出し A');
    expect(t, '本文が飲まれた').toContain('本文 A');
    expect(t, '注記が飲まれた').toContain('注記');
    // 目次そのものは出ている
    expect(html, '目次が出ていない').toContain('pkc-toc-formal');
    // ⚠ 空振り防止 ── `:::note` が実際に callout として描かれている
    //    (単に literal で残っているだけなら上の toContain は無意味に通る)
    expect(html).toContain('pkc-section-note');
  });

  it('🔴 閉じ `:::` 無しの `:::toc` が literal 文字列で出ない(マニュアルの書き方)', () => {
    // docs/manual.md:173 は閉じ無しで案内している ── 書いたとおりに書いて出ないのは嘘
    const html = renderMarkdown(['# 題', '## 節', '', ':::toc', ''].join('\n'));
    expect(html, ':::toc が素のテキストで出ている').not.toContain('>:::toc<');
    expect(textOf(html)).not.toContain(':::toc');
    expect(html).toContain('pkc-toc-formal');
  });

  it('閉じ `:::` を直後に書く旧来の形も動く(後方互換)', () => {
    const html = renderMarkdown(['# 題', '## 節', '', ':::toc{depth=2}', ':::', '', '後ろ'].join('\n'));
    expect(html).toContain('pkc-toc-formal');
    expect(textOf(html), '閉じを書くと後ろが消える').toContain('後ろ');
  });

  it('depth 指定は生きている(1 行化で属性を落としていない)', () => {
    const d3 = renderMarkdown(['# a', '## b', '### c', '', ':::toc{depth=3}'].join('\n'));
    const d1 = renderMarkdown(['# a', '## b', '### c', '', ':::toc{depth=1}'].join('\n'));
    // depth=1 は h1 だけ、depth=3 は h1〜h3 ── 行数で差が出る
    const rows = (h: string): number => (h.match(/<li/g) ?? []).length;
    expect(rows(d3), 'depth=3 が h1〜h3 を拾っていない').toBeGreaterThan(rows(d1));
    expect(rows(d1)).toBeGreaterThan(0);
  });

  it('fence の中の `:::toc` は触らない', () => {
    const html = renderMarkdown(['```', ':::toc', '```', '', '後ろ'].join('\n'));
    expect(textOf(html), 'fence の中身を消した').toContain(':::toc');
    expect(textOf(html)).toContain('後ろ');
  });
});

describe('文書内アンカーは別タブを開かない', () => {
  it('🔴 `[x](#anchor)` に target/rel を付けない', () => {
    // 直す前は `target="_blank"` が付き、押すと 2 枚目のタブが開いて
    // 単一タブ保護(「別のタブで開いています」)に突き当たっていた
    const html = renderMarkdown('[見出しへ](#sec)');
    const a = /<a [^>]*>/.exec(html)?.[0] ?? '';
    expect(a, 'アンカーが別タブで開く').not.toContain('target=');
    expect(a).not.toContain('rel=');
    expect(a).toContain('href="#sec"');
  });

  it('外部リンクは今までどおり別タブ + noopener(硬化を緩めていない)', () => {
    // ⚠ 空振り防止 ── ここが弱まっていたら、上の test は「全部外さした」だけになる
    const a = /<a [^>]*>/.exec(renderMarkdown('[外](https://example.com/x)'))?.[0] ?? '';
    expect(a, '外部リンクの硬化まで外した').toContain('target="_blank"');
    expect(a).toContain('rel="noopener noreferrer"');
  });

  it('`entry:` / `asset:` の扱いは変えていない', () => {
    expect(renderMarkdown('[e](entry:abc)')).toContain('navigate-entry-ref');
    expect(renderMarkdown('[a](asset:k1)')).toContain('download-asset');
  });
});
