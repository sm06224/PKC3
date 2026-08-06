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

/**
 * 🔴 **入れ子の `:::` が壊れていた**(2026-08-06 に直した既存バグ)。
 *
 * `processSectionBlocks` は「開いたら**最初に出会った `:::` まで**を中身にする」
 * 平坦な走査だった。だから `:::section` の中に `:::note` を書くと:
 *  ① 内側の開き行が**本文として素通り**して `<p>:::section{role=note}</p>` になり
 *  ② 内側の閉じが**外側の閉じ**として使われ
 *  ③ 外側の閉じが最上位に残って `<p>:::</p>` として漏れていた
 *
 * ⚠ `:::toc` の件(上)と**同じ形の欠陥**である ── 「1 個ぶんしか数えない走査」。
 * ⚠ ライブエディタでは、この食い違いのせいで**行の差し替えが開けなかった**
 * (分割の検証が落ちて今日の編集画面へ退避していた)。
 */
describe('入れ子の `:::` が壊れない', () => {
  it('🔴 `:::section` の中の `:::note` が入れ子の `<section>` になる', () => {
    const html = renderMarkdown(':::section\n\n:::note\n\n中身\n\n:::\n\n:::\n', {
      silentHallucinationWarnings: true,
    });
    // 内側が literal の段落になっていない(直す前はここが `<p>:::section{role=note}</p>`)
    expect(html).not.toContain('<p>:::');
    expect(html).not.toContain(':::section{role=note}');
    // 外側の閉じが漏れていない(直す前はここが `<p>:::</p>`)
    expect(html).not.toMatch(/<p>:::<\/p>/);
    // 入れ子になっている ── 外側 generic の中に内側 note
    const outer = html.indexOf('pkc-section-generic');
    const inner = html.indexOf('pkc-section-note');
    expect(outer, '外側の section が無い').toBeGreaterThanOrEqual(0);
    expect(inner, '内側の section が無い').toBeGreaterThan(outer);
    expect(textOf(html)).toContain('中身');
  });

  it('🔴 入れ子の後ろに書いた本文が飲まれない', () => {
    const html = renderMarkdown(':::section\n\n:::note\n\n中\n\n:::\n\n:::\n\nあとがき\n', {
      silentHallucinationWarnings: true,
    });
    // `あとがき` が section の**外**に在る(飲まれていない)
    const close = html.lastIndexOf('</section>');
    expect(close).toBeGreaterThan(0);
    expect(html.slice(close), 'あとがき が section の中に飲まれた').toContain('あとがき');
  });

  it('3 段の入れ子も段数どおりに組む', () => {
    const html = renderMarkdown(
      ':::section\n\n:::section\n\n:::section\n\n芯\n\n:::\n\n:::\n\n:::\n\n後\n',
      { silentHallucinationWarnings: true },
    );
    expect((html.match(/<section /g) ?? []).length).toBe(3);
    expect((html.match(/<\/section>/g) ?? []).length).toBe(3);
    expect(html).not.toContain('<p>:::');
  });

  /**
   * 🔴 **閉じの取り違えは「タグの入れ子の順序」で見る**(2026-08-06 の変異試験で
   * 分かった)。1 巡目は `<details` が在るか / `あと` が外に在るかだけを見ていて、
   * **2 件の変異が生き延びた** ── 閉じを取り違えると後段の `processDetailsBlocks` が
   * **section の閉じごと `<details>` の中に巻き込む**ので、下流の見た目
   * (`<details>` が在る・`あと` が外に在る)は**どちらも成立してしまう**。
   * ⚠ CLAUDE.md「下流の結果だけを見る test は、別経路が救って変異を見逃す」の実例。
   */
  it('🔴 他の種類の `:::` を跨いでも、閉じを取り違えない', () => {
    const html = renderMarkdown(
      ':::section\n\n:::details{summary=あ}\n\n中\n\n:::\n\n:::\n\nあと\n',
      { silentHallucinationWarnings: true },
    );
    expect(html).toContain('<details');
    expect(html).not.toContain('<p>:::');
    // 🔴 **開いた順の逆で閉じる** ── section の閉じが details の中に入っていない
    const sOpen = html.indexOf('<section ');
    const dOpen = html.indexOf('<details');
    const dClose = html.indexOf('</details>');
    const sClose = html.indexOf('</section>');
    expect(sOpen, 'section が無い').toBeGreaterThanOrEqual(0);
    expect(dOpen, 'details が section より前に在る').toBeGreaterThan(sOpen);
    expect(dClose, 'details が閉じていない').toBeGreaterThan(dOpen);
    expect(sClose, 'section の閉じが details の中に巻き込まれた').toBeGreaterThan(dClose);
    const close = html.lastIndexOf('</section>');
    expect(html.slice(close), 'あと が section の中に飲まれた').toContain('あと');
  });

  it('閉じ忘れは末尾で閉じる(HTML を壊さない)', () => {
    const html = renderMarkdown(':::section\n\n中身\n', { silentHallucinationWarnings: true });
    expect((html.match(/<section /g) ?? []).length).toBe(1);
    expect((html.match(/<\/section>/g) ?? []).length).toBe(1);
  });

  it('開いていないところの `:::` はそのまま文字として出る(挙動を変えていない)', () => {
    const html = renderMarkdown('本文\n\n:::\n\nあと\n', { silentHallucinationWarnings: true });
    expect(html).toContain('<p>:::</p>');
    expect(html).not.toContain('<section');
  });

  it('fence の中の `:::` は数えない', () => {
    const html = renderMarkdown(':::section\n\n```\n:::\n```\n\n:::\n\nあと\n', {
      silentHallucinationWarnings: true,
    });
    expect((html.match(/<section /g) ?? []).length).toBe(1);
    // コードの中身として `:::` が残っている
    expect(html).toMatch(/<code[^>]*>[\s\S]*:::/);
    const close = html.lastIndexOf('</section>');
    expect(html.slice(close)).toContain('あと');
  });
});

/**
 * 🔴 **csv/tsv の各セルに文書の脚注が漏れる**(2026-08-06 に直した。user 報告 2-1)。
 *
 * 直す前は `md.renderInline(text, env)` で**文書の env をセルへ共有**していた。
 * `markdown-it-footnote` の `footnote_tail` は core rule なので `renderInline` でも
 * 走り、**セルごとに文書の脚注セクションを丸ごと吐いていた**。
 *
 * 実測(4 セルの表): `<section class="footnotes">` が **5 個** / `id="fn1"` も **5 個**。
 * ⚠ 害は 2 つ:**DOM id の重複**で `[^a]` のジャンプ先が表の中のセルになる /
 *   文書側の脚注が**中身を失って空**になる(セルが先に食う)。
 * ⚠ この振る舞いは **golden が PKC2 のバグごと固定**していた(2 件を理由つきで更新)。
 */
describe('csv/tsv のセルに文書の脚注が漏れない', () => {
  const src = '本文[^a]\n\n```csv\nあ,い\n1,2\n```\n\n[^a]: 注の中身\n';

  it('🔴 脚注セクションは文書に 1 個だけ', () => {
    const html = renderMarkdown(src, { silentHallucinationWarnings: true });
    expect((html.match(/class="footnotes"/g) ?? []).length, 'セルへ漏れている').toBe(1);
    expect((html.match(/class="footnotes-sep"/g) ?? []).length).toBe(1);
  });

  it('🔴 DOM id が重複しない(`[^a]` のジャンプ先が表の中にならない)', () => {
    const html = renderMarkdown(src, { silentHallucinationWarnings: true });
    expect((html.match(/id="fn1"/g) ?? []).length, 'id が重複している').toBe(1);
    expect((html.match(/id="fnref1"/g) ?? []).length).toBe(1);
  });

  it('🔴 文書側の脚注が中身を持つ(セルに食われていない)', () => {
    const html = renderMarkdown(src, { silentHallucinationWarnings: true });
    const at = html.indexOf('id="fn1"');
    expect(at).toBeGreaterThan(0);
    expect(html.slice(at, at + 200), '脚注の本文が空になっている').toContain('注の中身');
  });

  it('セルの中の inline markup は今までどおり描く(env を切っても機能が落ちていない)', () => {
    const html = renderMarkdown('```csv\n**太字**,`コード`\nあ,い\n```\n', {
      silentHallucinationWarnings: true,
    });
    expect(html).toContain('<strong>太字</strong>');
    expect(html).toContain('<code>コード</code>');
  });

  it('セルは表の外の脚注参照も literal にしない(参照そのものは描ける)', () => {
    // ⚠ セルの中の `[^a]` は**定義がセル側の env に無い**ので literal で出る ──
    //    それが正しい(セルは独立した断片であって、文書の脚注表を持たない)
    const html = renderMarkdown('```csv\nあ[^a],い\n1,2\n```\n\n[^a]: 注\n', {
      silentHallucinationWarnings: true,
    });
    const td = html.slice(html.indexOf('<td'), html.indexOf('</td>') + 5);
    expect(td, 'セルが脚注セクションを吐いている').not.toContain('class="footnotes"');
  });
});
