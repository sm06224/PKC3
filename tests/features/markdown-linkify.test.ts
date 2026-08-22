/**
 * 🔴 **markdown-it 15 で変わった「本文のどこがリンクになるか」を pin する**(#78、2026-08-22)。
 *
 * ## なぜ test が要るのか
 *
 * ⚠ 版を上げると**本文の見え方が変わる**が、goldens は PKC2 から採った 25 件しか
 * 無いので、**そこに出てこない形は誰も見ていない**(実際 v14 → v15 で golden に
 * 出たのは `console.info` の 1 セルだけだった)。
 * 🔑 だから「PKC の options で 14 と 15 を並べて実測した差」を、**差の側から**
 * 全部 test にする ── 次に版が動いたとき、**動いた事実がここで鳴る**。
 *
 * ## 実測した差は 4 つ(2026-08-22、PKC3 と同じ options で 14.3.0 / 15.0.0 を突合)
 *
 * | 何が変わったか | 14 | 15(いま) | 裁定 |
 * |---|---|---|---|
 * | スキーム無しの自動リンク | リンクにする | **しない** | 受け入れ |
 * | CJK 句読点でリンクが終わるか | 終わらない | **終わる** | 受け入れ(改善) |
 * | URL の `user:pass@` | URL の一部 | **切る** | 🔴 **戻した**(`urlAuth: true`) |
 * | 画像 alt の `` `code` `` | 中身が消える | **残る** | 受け入れ(改善) |
 *
 * ⚠ 「受け入れ」と「戻した」を分けた基準は **壊れたリンクを焼くかどうか**である ──
 * 自動リンクを**やめる**のは地の文が残るだけだが、途中で**切る**と
 * 「押すと違う所へ行く `<a>`」が本文に残る。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '@features/markdown/markdown-render';

/** 本文 1 行を描いて、`<a>` の href だけを順に取り出す。 */
function hrefs(src: string): string[] {
  const html = renderMarkdown(src, {});
  return [...html.matchAll(/<a\b[^>]*\shref="([^"]*)"/g)].map((m) => m[1]!);
}

/** 本文 1 行を描いて、`<a>` の中身(見える字)を順に取り出す。 */
function linkTexts(src: string): string[] {
  const html = renderMarkdown(src, {});
  return [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1]!);
}

describe('本文の自動リンク(markdown-it 15、#78)', () => {
  /**
   * 🔴 **スキームの無い字はリンクにしない。**
   *
   * ⚠ v14 は `.info` / `.md` / `.rs` / `.sh` が TLD であるため、
   * **開発ノートで日常的に書く形**を片端から `http://…` の外部リンクにしていた。
   * 押すと `target="_blank"` で**空白のタブが開くだけ**の壊れたリンクである。
   * 🔑 PKC 自身の `hasMarkdownSyntax` は FI-08.x(D-FB1=B)以来
   * 「スキームがあるものだけが URL」と判定しており、**そちらが正**だった。
   */
  it('🔴 ファイル名や識別子をリンクにしない(README.md / console.info / main.rs / build.sh)', () => {
    expect(hrefs('README.md と console.info を見て'), 'ファイル名がリンクになった').toEqual([]);
    expect(hrefs('main.rs / build.sh / app.ts'), '識別子がリンクになった').toEqual([]);
    expect(hrefs('example.com'), '裸のドメインがリンクになった').toEqual([]);
  });

  /** ⚠ **対照群** ── スキームがあれば今までどおりリンクになる(全部消していない)。 */
  it('⚠ 対照群 ── スキーム付きは今までどおりリンクになる', () => {
    expect(hrefs('詳しくは https://example.com/docs を見て'), 'スキーム付きまで殺した').toEqual([
      'https://example.com/docs',
    ]);
  });

  /**
   * 🔴 **日本語の句読点でリンクが終わる**(v15 の改善)。
   *
   * ⚠ v14 は `https://例.test/a。次の文` の**文末まで丸ごと URL に飲んで**いた
   * (`…/a%E3%80%82%E6%AC%A1%E3%81%AE%E6%96%87` = 「。次の文」が percent 符号化されて
   * href に入る)。日本語で文中に URL を書くと**必ず壊れる**形だったので、
   * これは PKC の主用途に直接効く。
   */
  it('🔴 CJK の句読点でリンクが終わる(文の残りを飲み込まない)', () => {
    expect(hrefs('https://example.com/a。次の文'), '句点の後まで URL に飲んだ').toEqual([
      'https://example.com/a',
    ]);
    expect(hrefs('https://example.com/a、続き'), '読点の後まで URL に飲んだ').toEqual([
      'https://example.com/a',
    ]);
    // ⚠ 見える字も切れていること(href だけ直っても本文が変なら意味が無い)
    expect(linkTexts('https://example.com/a。次の文')).toEqual(['https://example.com/a']);
  });

  /**
   * 🔴 **`user:pass@` を URL の一部として読む**(`md.linkify.set({ urlAuth: true })`)。
   *
   * ⚠ v15 の既定(off)では `https://token@github.com/a/b.git` が
   * **`https://token` で切れる** ── 押すと違う所へ行く `<a>` が本文に残る。
   * 🔑 この test が落ちたら、`markdown-render.ts` の `urlAuth` 設定が消えている。
   */
  it('🔴 URL の中の user:pass@ を切らない(git / 社内ツールの URL)', () => {
    expect(hrefs('https://token@github.com/a/b.git'), 'auth 部で URL を割った').toEqual([
      'https://token@github.com/a/b.git',
    ]);
    expect(hrefs('https://user:pass@example.com/x'), 'auth 部で URL を割った').toEqual([
      'https://user:pass@example.com/x',
    ]);
  });

  /**
   * ⚠ **対照群** ── `urlAuth` を戻したせいで、メールの側が壊れていないこと。
   * (`@` を含む形はここが唯一の隣接領域である)
   */
  it('⚠ 対照群 ── メールアドレスの自動リンクは変わらない', () => {
    expect(hrefs('a@example.com へ連絡'), 'メールの自動リンクを壊した').toEqual([
      'mailto:a@example.com',
    ]);
    expect(hrefs('time は 12:30@home です'), '時刻をリンクにした').toEqual([]);
  });

  /**
   * 🔴 **画像の alt から `` `code` `` の中身が消えない**(v15 の改善)。
   *
   * ⚠ v14 は `![a \`b\` c](/x.png)` の alt を `"a  c"` にしていた ──
   * 画像が出ない環境で読む人に**書いた字が届かない**(#1142 の上流修正)。
   */
  it('🔴 画像の alt に書いたコード片が残る', () => {
    const html = renderMarkdown('![a `b` c](/x.png)', {});
    const alt = /<img[^>]*\salt="([^"]*)"/.exec(html)?.[1];
    expect(alt, 'alt からコード片の中身が消えた').toBe('a b c');
  });
});
