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
 * | URL の `user:pass@` | URL の一部 | **切る** | 受け入れ(⚠ 一度戻して**取り下げた**) |
 * | 画像 alt の `` `code` `` | 中身が消える | **残る** | 受け入れ(改善) |
 *
 * ## そのうえで 1 つだけ上流から外した
 *
 * | 何を | どう | なぜ |
 * |---|---|---|
 * | 中黒(`・`)で終端するか | **終端しない**(`src_P` を絞る) | 人名の URL が**静かに別記事へ**行く |
 *
 * ## 裁いた物差し ── **静かに間違うほうが悪い**
 *
 * ⚠ 「壊れたリンクを焼くかどうか」だけでは足りない、と着地前レビューが示した。
 * 4 行目の `user:pass@` は**どちらの向きも壊れたリンク**である:
 * 戻すと「行き先だけが違って**正しく見える**」(静か)、上流のままだと「**途中で切れる**」
 * (見える)。⚠ 初稿は前者を選び、「リンクの字が全文出るから騙されない」と書いたが、
 * `https://example.com@evil.example/x` の実測がそれを否定した。
 * 🔑 **同じ物差しで `・` は直し、`user:pass@` は直さない** ── 前者は静か、後者は見える。
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
   * ⚠ しかも**行き先が無いのではなく、他人のサイトが在る** ── 実測(2026-08-22):
   * `readme.md` / `console.info` / `build.sh` / `main.rs` は **4 つとも名前が引ける**
   * (`.md` はモルドバ、`.sh` はセントヘレナ、`.rs` はセルビア)。
   * つまり押すと `target="_blank"` で**まったく関係のない他人のサイト**が開く。
   * 🔑 PKC 自身の `hasMarkdownSyntax` は FI-08.x(D-FB1=B)以来
   * 「スキームがあるものだけが URL」と判定しており、**そちらが正**だった。
   */
  it('🔴 ファイル名や識別子をリンクにしない(README.md / console.info / main.rs / build.sh)', () => {
    // ⚠ **対照群を同じ it に置く**(CLAUDE.md 2026-08-21)── `toEqual([])` は
    //   描画が丸ごと空でも通るので、これが無いと 3 本まとめて空振りになる。
    expect(hrefs('詳しくは https://example.com/docs を見て'), '描画そのものが死んでいる').toEqual([
      'https://example.com/docs',
    ]);
    expect(hrefs('README.md と console.info を見て'), 'ファイル名がリンクになった').toEqual([]);
    expect(hrefs('main.rs / build.sh / app.ts'), '識別子がリンクになった').toEqual([]);
    expect(hrefs('example.com'), '裸のドメインがリンクになった').toEqual([]);
    // 🔑 **`www.` も拾わない** ── user が実際に書くのはこちらで、
    //   お知らせもマニュアルもこの形を例に出している
    expect(hrefs('会社のサイトは www.example.co.jp です'), '裸の www. がリンクになった').toEqual(
      [],
    );
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
   * 🔴 **ここは直っていない ── 終端になるのは句読点・括弧だけで、仮名や漢字は入る**
   * (着地前レビューが拾った。**現状として pin する**)。
   *
   * ⚠ この形を書かないと、次に読む人は上の it を見て「日本語は直った」と読む。
   *   実際に効くのは「URL の直後が**空白か句読点**のとき」だけで、
   *   `…をどうぞ` のように助詞を空白なしで続ける**ごく普通の書き方**は今も飲む。
   * 🔑 直せない ── 仮名も漢字も URL の path に**正当に出る**(`/日本語パス`)ので、
   *   終端にすると今度はそちらが割れる。**マニュアルに「空白か句読点で区切る」と書く**
   *   のが対処である(`docs/manual.md`)。
   * ⚠ これが落ちたら「直った」のかもしれない ── そのときはマニュアルとお知らせを直す。
   */
  it('⚠ 現状 ── URL の直後に仮名が続くと、そこまで URL に入る(v14 から変わらない)', () => {
    expect(
      hrefs('詳細はhttps://e.example/aをどうぞ'),
      '直ったならマニュアルの「空白か句読点で区切る」を消すこと',
    ).toEqual(['https://e.example/a%E3%82%92%E3%81%A9%E3%81%86%E3%81%9E']);
  });

  /**
   * 🔴 **中黒(・)では終わらない**(着地前の動線レビューが拾った)。
   *
   * ⚠ v15 の素のままだと `https://ja.wikipedia.org/wiki/クロード・モネ` が
   * `…/wiki/クロード` で切れ、**実在する別の記事**へ行くリンクになる。
   * 🔑 切れ方が**静か**なのが悪い ── リンクの字は正しく見え、行き先だけが違う。
   * ⚠ これが落ちたら、`markdown-render.ts` の `src_P` の絞り込みが
   *   効かなくなっている(上流の版が動いた可能性が高い)。
   */
  it('🔴 中黒(・)を含む URL が 1 本のままになる(日本語 Wikipedia の人名記事)', () => {
    expect(
      hrefs('https://ja.wikipedia.org/wiki/クロード・モネ'),
      '中黒で URL が切れ、別の記事へ行くリンクになった',
    ).toEqual(['https://ja.wikipedia.org/wiki/%E3%82%AF%E3%83%AD%E3%83%BC%E3%83%89%E3%83%BB%E3%83%A2%E3%83%8D']);
    // ⚠ 見える字も 1 本であること(href だけ直っても本文が割れていたら意味が無い)
    expect(linkTexts('https://ja.wikipedia.org/wiki/クロード・モネ')).toEqual([
      'https://ja.wikipedia.org/wiki/クロード・モネ',
    ]);
    // 🔑 問い合わせの値にも出る
    expect(hrefs('https://example.com/q?a=猫・犬')).toEqual([
      'https://example.com/q?a=%E7%8C%AB%E3%83%BB%E7%8A%AC',
    ]);
  });

  /**
   * ⚠ **絞ったのは `・` の 2 字だけ**であることを対照群で押さえる。
   * かぎかっこ・波ダッシュ・句読点は**上流のまま終端**にする ── そちらは
   * 「URL の外」に置かれる印なので、v15 の判断が正しい。
   * ⚠ ここが緩むと、`(https://…)` の閉じ括弧まで URL に入る型の後退になる。
   */
  it('⚠ 対照群 ── かぎかっこ・波ダッシュ・句読点は今までどおり終端になる', () => {
    expect(hrefs('https://example.com/a「b」'), 'かぎかっこを URL に飲んだ').toEqual([
      'https://example.com/a',
    ]);
    expect(hrefs('https://example.com/a〜b'), '波ダッシュを URL に飲んだ').toEqual([
      'https://example.com/a',
    ]);
  });

  /**
   * 🔴 **`user:pass@` は URL の外として読む(上流の既定のまま)。**
   *
   * ⚠ **いったん `urlAuth: true` で v14 の形へ戻したが、着地前レビューで取り下げた。**
   * 戻した理由は「PKC は自分のノートで、リンクの字は全文がそのまま出るから騙されない」
   * だったが、**実測がそれを否定した** ── 下の対照群がその実測である。
   *
   * ⚠ 代償は認める:`https://token@github.com/a/b.git` は `https://token` で切れる。
   * 🔑 それでも取らないのは、**切れるのは見える誤り**だからである
   *   (行き先が違うのに正しく見える、が反対側)。
   */
  it('🔴 auth 部で切れる(上流の既定 ── 見える誤りのほうを取る)', () => {
    expect(hrefs('https://token@github.com/a/b.git'), '上流の既定から外れている').toEqual([
      'https://token',
    ]);
    // ⚠ **見える字も同じところで切れている**(= user から見て「割れた」と分かる)
    expect(linkTexts('https://token@github.com/a/b.git')).toEqual(['https://token']);
  });

  /**
   * 🔴 **なりすましの URL で、見える字と行き先が食い違わない**
   * (着地前レビューが拾った ── `urlAuth: true` を取り下げた当の根拠)。
   *
   * ⚠ `urlAuth: true` だと `https://example.com@evil.example/x` が **1 本のリンク**に
   *   なり、`href` の行き先は **`evil.example`** なのに字は左から
   *   `https://example.com…` と読める。⚠ **全文が出ていても騙せる** ──
   *   隠れているのは字ではなく「`@` より前は host ではない」という文法のほうである。
   * 🔑 だから **href と見える字を対で見る**。片方だけ見ていると、この食い違いは
   *   原理的に検出できない(実際、初稿は `hrefs` しか見ておらず素通りした)。
   */
  it('🔴 なりすましの URL が、正しく見えるリンクにならない', () => {
    const src = 'https://example.com@evil.example/x';
    expect(hrefs(src), 'evil.example 行きのリンクが焼かれた').toEqual(['https://example.com']);
    expect(linkTexts(src), '見える字が href より長い(騙せる形)').toEqual([
      'https://example.com',
    ]);
    // ⚠ 残りは地の文として残る(黙って消さない)
    expect(renderMarkdown(src, {})).toContain('@evil.example/x');
  });

  /**
   * 🔴 **自分で囲んだ形では、見える字と行き先が 1 字もずれない。**
   *
   * ⚠ これは**逃げ道の pin** でもある ── マニュアルは「`user@` を含む URL を
   *   1 本にしたいなら `[題名](…)` か `<…>` で囲め」と書いている。
   *   囲んだのにずれるなら、その案内が嘘になる。
   * ⚠ そして自動リンクの側は `@` の手前で切れるので、**この経路だけが
   *   「`://` の後に `@` を含む見える字」を持つ** ── 見える字を書き換える変異
   *   (`normalizeLinkText` の差し替え)は、ここでしか殺せない。
   */
  it('🔴 自分で囲んだ URL は、見える字と行き先がずれない(逃げ道の pin)', () => {
    const src = '<https://u@h.example/p>';
    expect(hrefs(src)).toEqual(['https://u@h.example/p']);
    expect(linkTexts(src), '見える字だけが書き換わった(行き先を偽る形)').toEqual([
      'https://u@h.example/p',
    ]);
    // ⚠ 題名を付けた形は行き先だけ pin する(字は題名なので一致しなくてよい)
    expect(hrefs('[題](https://u@h.example/p)')).toEqual(['https://u@h.example/p']);
  });

  /**
   * ⚠ **対照群** ── `@` を含む隣の形を巻き込んでいないこと。
   * ⚠ 初稿はここに「`@` を含む形はここが唯一の隣接領域である」と書いていたが、
   *   **なりすましの形を数え落としていた**(上の it)。「唯一」と書いたら数え直す。
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
  it('🔴 画像の alt に書いたコード片が残る(外の画像 ── alt が実際に見える面)', () => {
    // 🔴 **観測点は「外のサイトの画像」**(着地前レビューが拾った)。
    //   ⚠ 初稿は `/x.png` を使っていたが、それは PKC の本文にまず出ない形である。
    //   🔑 外部画像は既定で `src` を剥がすので、**画面に出るのは alt だけ** ──
    //     ここが「説明文が読まれる唯一の面」なので、観測点はここに置く。
    const html = renderMarkdown('![a `b` c](https://ex.example/x.png)', {});
    const alt = /<img[^>]*\salt="([^"]*)"/.exec(html)?.[1];
    expect(alt, 'alt からコード片の中身が消えた').toBe('a b c');
    // ⚠ 空振り防止 ── 外部画像の経路を通っている(= alt しか見えない面である)こと
    expect(html, '外部画像の経路を通っていない').toContain('data-pkc-external-src');
  });

  /**
   * ⚠ **貼った画像(`asset:`)の説明は、v15 でも変わらない**(着地前レビューが拾った)。
   *
   * ⚠ こちらは `token.content`(**生の原文**)を読む別経路なので、markdown-it の
   *   alt の組み立てを通らない ── バッククォートがそのまま残る。
   * 🔑 **お知らせに「画像の説明」とだけ書くと、いちばん多いこの形が該当すると
   *   読まれる**ので、文面は「外のサイトの画像」に絞ってある。ここはその裏取りである。
   */
  it('⚠ 対照群 ── 貼った画像(asset:)の説明は原文のまま(v15 でも変わらない)', () => {
    const html = renderMarkdown('![a `b` c](asset:k1)', {});
    const alt = /<img[^>]*\salt="([^"]*)"/.exec(html)?.[1];
    expect(alt, 'asset の説明まで書き換わった').toBe('a `b` c');
  });
});
