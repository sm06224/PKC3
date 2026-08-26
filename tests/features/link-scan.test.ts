/** @vitest-environment node */
/**
 * markdown のリンク宛先走査(P7 段② review M-1 / M-3 で 1 本に寄せた規則)。
 *
 * 🔴 **ここは書出しと取込の共有基盤**なので、片方の都合で緩めると
 * もう片方が静かに壊れる:
 * - 緩めると **書出しが本文を誤って書き換える**(コードブロックの中まで)
 * - 狭めると **取込が「黙って画像が壊れる」参照を数え落とす**
 * どちらの向きにも動かせないよう、両側から縛る。
 */
import { describe, expect, it } from 'vitest';
import { rewriteLinkDests, scanLinks } from '../../src/features/markdown/link-scan';

const dests = (text: string): string[] => scanLinks(text).sites.map((s) => s.dest);
const kinds = (text: string): string[] => scanLinks(text).sites.map((s) => s.kind);

describe('拾う ── 宛先の書かれ方', () => {
  it.each([
    ['インライン', '![図](images/a.png)\n', ['images/a.png']],
    ['複数', '[a](x.png)\n[b](y.pdf)\n', ['x.png', 'y.pdf']],
    ['題名つき', '[a](path.png "題名")\n', ['path.png']],
    ["題名つき(')", "[a](path.png 'title')\n", ['path.png']],
    ['山括弧', '[a](<my file.png>)\n', ['my file.png']],
    ['括弧 1 段', '[a](path_(1).png)\n', ['path_(1).png']],
    ['空白まわり', '[a](  x.png  )\n', ['x.png']],
    ['asset 参照', '![図](asset:ast-1)\n', ['asset:ast-1']],
    ['参照形式の定義', '![図][a]\n\n[a]: images/a.png\n', ['images/a.png']],
    ['参照形式 + 題名', '[a]: images/a.png "題名"\n', ['images/a.png']],
    ['参照形式 + 山括弧', '[a]: <my file.png>\n', ['my file.png']],
    ['HTML img', '<img src="images/a.png" alt="x">\n', ['images/a.png']],
    ['HTML a', "<a href='docs/b.pdf'>x</a>\n", ['docs/b.pdf']],
    ['HTML 引用符なし', '<a href=docs/b.pdf>x</a>\n', ['docs/b.pdf']],
  ])('%s', (_label, src, expected) => {
    expect(dests(src)).toEqual(expected);
  });

  it('種別を返す(consumer が書換対象を選べる)', () => {
    expect(kinds('[a](x.png)\n\n[b]: y.png\n\n<img src="z.png">\n')).toEqual([
      'inline',
      'reference',
      'html',
    ]);
  });
});

describe('🔴 拾わない ── コードとエスケープ', () => {
  it.each([
    ['fence の中', '```md\n![例](images/example.png)\n```\n'],
    ['~~~ fence の中', '~~~\n[a](x.png)\n~~~\n'],
    ['行内コード', 'a `](foo.png)` b\n'],
    ['エスケープした `]`', 'a \\](notalink.png) b\n'],
  ])('%s', (_label, src) => {
    expect(dests(src)).toEqual([]);
  });

  it('🔴 閉じ fence は**開き以上の長さ**が要る', () => {
    // 4 個で開いて 3 個で閉じない = markdown を説明する文書が壊れない
    expect(dests('````\n```\n[a](x.png)\n```\n````\n[b](y.png)\n')).toEqual(['y.png']);
  });

  it('🔴 閉じ fence は 3 スペースまで字下げできる(以降を全部飲まない)', () => {
    expect(dests('```\ncode\n  ```\n\n[a](x.png)\n')).toEqual(['x.png']);
  });

  it('🔴 行内コードは空行を越えない(間の本文を飲まない)', () => {
    expect(dests('`x\n\n[a](y.png)\n\n`z\n')).toEqual(['y.png']);
  });

  it('閉じない fence は末尾まで飲み、その事実を返す', () => {
    const r = scanLinks('```\n[a](x.png)\n');
    expect(r.sites).toEqual([]);
    expect(r.openFence).toBe('```');
  });

  it('閉じた fence では openFence は null', () => {
    expect(scanLinks('```\ncode\n```\n').openFence).toBe(null);
  });

  it('参照形式の定義は**行頭**だけ(文中の `[a]:` は拾わない)', () => {
    expect(dests('見よ [a]: images/a.png と書く\n')).toEqual([]);
  });
});

describe('🔴 行末は `\\n` だけではない(CommonMark: `\\n` / `\\r` / `\\r\\n`)', () => {
  // ⚠ markdown-it は `\\r\\n?` を `\\n` に正規化してから parse する ── ここで `\\n` だけを
  // 見ると**描画は正しいのに走査だけがずれる**(fence の中を書き換えてしまう)
  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['CR', '\r'],
  ])('%s: fence の中は拾わない', (_label, eol) => {
    expect(dests(`\`\`\`${eol}[a](x.png)${eol}\`\`\`${eol}[b](y.png)${eol}`)).toEqual(['y.png']);
  });

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['CR', '\r'],
  ])('%s: 参照形式の定義は行頭で拾う', (_label, eol) => {
    expect(dests(`本文${eol}[a]: images/a.png${eol}`)).toEqual(['images/a.png']);
  });

  it.each([
    ['LF', '\n\n'],
    ['CRLF', '\r\n\r\n'],
    ['CR', '\r\r'],
  ])('%s: 行内コードは空行を越えない', (_label, blank) => {
    expect(dests(`\`x${blank}[a](y.png)${blank}\`z`)).toEqual(['y.png']);
  });
});

describe('🔴 走査は線形(空行探索を毎回やり直さない)', () => {
  // 実測: 空行の無い 3MB の md で **74.8 秒 → 53 ms**。バッククォート 1 個ごとに
  // 残り全体を舐めていた(O(n²))。単調前進のキャッシュが壊れると戻る
  it('空行を跨いで何度も走査しても結果が変わらない', () => {
    const text = ['`a` [1](p1.png)', '', '`b` [2](p2.png)', '', '`c` [3](p3.png)'].join('\n');
    expect(dests(text)).toEqual(['p1.png', 'p2.png', 'p3.png']);
  });

  it('空行の前後で「越えない」判定が正しい', () => {
    // 前半の野良バッククォートは空行で切れる → 間の `[a]` は拾う。
    // 後半は CommonMark どおり**左から順に**対応付く ── `` `z ` `` がコードスパンに
    // なり、残りの `q [b](w.png) q` は本文なので `[b]` は**拾う**。
    // ⚠ ここは最初「拾わない」と書いて test が落ちた ── 落ちたのは実装ではなく
    // **期待値の側**だった(バッククォートの対応付けを誤解していた)
    expect(dests('`x\n\n[a](y.png)\n\n`z `q [b](w.png) q`\n')).toEqual(['y.png', 'w.png']);
  });

  it('🔴 空行より後ろのコードスパンでも「越えない」判定が正しい(キャッシュの陳腐化)', () => {
    // ⚠ 単調前進キャッシュを**無条件に**使い回すと、空行を過ぎたあとの
    // バッククォートに**手前の空行位置**を返してしまい、コードスパンと認識
    // されなくなる ── 中の `](…)` を本文として拾い、書出し側なら
    // **コードブロックの中を書き換える**(変異試験で実際に生き残った)
    expect(dests('`a`\n\nx `[b](w.png)` y\n')).toEqual([]);
  });

  it('空行が複数あっても、その先のコードスパンを取り違えない', () => {
    expect(dests('`a`\n\n`b`\n\nx `[c](z.png)` y\n')).toEqual([]);
  });

  it('大きい入力でも現実的な時間で終わる(退行の tripwire)', () => {
    const text = 'a `code` b [x](y.png) c\n'.repeat(40_000); // 約 1MB
    const t0 = Date.now();
    const r = scanLinks(text);
    // ⚠ 絶対値ではなく**桁**を見る(CI の速度差で flake させない)。
    // O(n²) に戻ると秒オーダーになるので 3 秒で十分に検出できる
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.sites).toHaveLength(40_000);
  });
});

describe('宛先だけを差し替える', () => {
  const upper = (text: string): string =>
    rewriteLinkDests(text, scanLinks(text).sites, (s) => s.dest.toUpperCase());

  it('インラインの宛先だけが変わる(題名・記法は残る)', () => {
    expect(upper('[a](x.png "題名")\n')).toBe('[a](X.PNG "題名")\n');
  });

  it('🔴 山括弧は**残す**(空白を含む path で壊れないため)', () => {
    expect(upper('[a](<my file.png>)\n')).toBe('[a](<MY FILE.PNG>)\n');
  });

  it('参照形式・HTML も同じ規則で替わる', () => {
    expect(upper('[a]: x.png\n')).toBe('[a]: X.PNG\n');
    expect(upper('<img src="x.png" alt="図">\n')).toBe('<img src="X.PNG" alt="図">\n');
  });

  it('`undefined` を返した site はそのまま残る', () => {
    const text = '[a](keep.png)\n[b](drop.png)\n';
    const out = rewriteLinkDests(text, scanLinks(text).sites, (s) =>
      s.dest === 'drop.png' ? 'new.png' : undefined,
    );
    expect(out).toBe('[a](keep.png)\n[b](new.png)\n');
  });

  it('何も替えなければ原文と byte 同一', () => {
    const text = '```\n[a](x.png)\n```\n[b](y.png)\n<img src="z.png">\n';
    expect(rewriteLinkDests(text, scanLinks(text).sites, () => undefined)).toBe(text);
  });
});

/**
 * 🔴 **画像として書かれているか**(#264 段⓪)。
 *
 * ⚠ **これを持たないと「取り込む」がリンクまで取りに行く** ── user が単に貼った
 *   web ページの URL まで第三者へ通信することになる。⚠ 「fetch してから MIME で
 *   捨てる」は解にならない(**通信そのもの**が問題なので、行く前に絞る)。
 */
describe('画像として書かれているか(#264 段⓪)', () => {
  const img = (text: string): boolean[] => scanLinks(text).sites.map((x) => x.image);

  it('🔴 `![x](y)` は画像、`[x](y)` はリンク', () => {
    expect(img('![絵](a.png)')).toEqual([true]);
    expect(img('[記事](https://example.com)')).toEqual([false]);
    // ⚠ **同じ行に並べても取り違えない**
    expect(img('[記事](a) と ![絵](b)')).toEqual([false, true]);
  });

  /** ⚠ `\!` はリンク ── `!` 自身のエスケープを見ていないと取り違える。 */
  it('🔴 エスケープした `!` はリンクのまま', () => {
    expect(img('\\![x](y)')).toEqual([false]);
    // ⚠ **対照群** ── `\\` が 2 つなら `!` は生きている(画像)
    expect(img('\\\\![x](y)')).toEqual([true]);
  });

  /**
   * 🔴 **散らばった角括弧に釣られない**。
   * ⚠ 1 稿目はこれを「リンクにならない `]` でも降ろすこと」の検査だと書いていたが、
   *   **それは守っていない**(変異試験 L1 が SURVIVED で教えた ── 積みは LIFO なので、
   *   置き去りの `[` は下に沈んだまま誰にも降ろされない)。
   * 🔑 ここが守っているのは「**前に角括弧が在っても、画像の判定が変わらない**」
   *   ことである ── `!` を見ない実装(L3)はここで落ちる。
   */
  it('🔴 ただの角括弧のあとでも、画像を取り違えない', () => {
    expect(img('[ただの角括弧] のあとの ![絵](x.png)')).toEqual([true]);
    expect(img('[脚注] と [記事](a) と ![絵](b)')).toEqual([false, true]);
  });

  /** ⚠ 入れ子のラベル ── 内側が対応する。 */
  it('🔴 入れ子でも、内側の `[` と対応する', () => {
    // 内側の `![絵](x)` は画像 / 外側は `[…](y)` でリンク
    expect(img('[前 ![絵](x) 後](y)')).toEqual([true, false]);
  });

  /**
   * 🔴 **定義行では決まらない**(#264 段⓪)── `!` が付くのは**使う側**である。
   * ⚠ ここで `true` にすると、**同じ定義をリンクとしても使っているノート**で
   *   取りに行ってしまう。
   */
  it('🔴 参照形式の定義行は、常にリンク扱い', () => {
    expect(img('[label]: https://example.com/a.png')).toEqual([false]);
  });

  /** 🔴 HTML は**タグ名**で決まる ── 属性名で分けると `<video src>` を取りこぼす。 */
  it('🔴 HTML は、タグ名で決まる', () => {
    expect(img('<img src="a.png">')).toEqual([true]);
    expect(img('<a href="https://example.com">x</a>')).toEqual([false]);
    expect(img('<video src="a.mp4">')).toEqual([true]);
    expect(img('<source src="a.webm">')).toEqual([true]);
    // ⚠ 絵ではないものは入れない(取り込んでも意味が無く、通信だけ増える)
    expect(img('<iframe src="https://example.com">')).toEqual([false]);
    expect(img('<script src="a.js">')).toEqual([false]);
  });

  /** ⚠ コードの中は拾わない(既存の規則が画像でも効いていること)。 */
  it('⚠ コードの中の `![x](y)` は拾わない', () => {
    expect(scanLinks('`![絵](x.png)`').sites).toEqual([]);
    expect(scanLinks('```\n![絵](x.png)\n```\n').sites).toEqual([]);
  });

  /**
   * 🔑 **1 パスのままであること**(#264 段⓪ の理由)。
   * ⚠ 「`]` から後ろ向きに `[` を探す」形だと O(n²) になり、この file が
   *   書き直された当の穴を掘り直すことになる ── **大きい入力で確かめる**。
   */
  it('🔴 角括弧が大量に在っても、走査が実用の時間で終わる', () => {
    const text = `${'[x] '.repeat(20_000)}![絵](a.png)`;
    const t0 = Date.now();
    const out = scanLinks(text);
    const ms = Date.now() - t0;
    expect(out.sites.map((x) => x.image), '最後の画像が拾えていない').toEqual([true]);
    // ⚠ 上限は**手違いの検出**(O(n²) なら桁で超える ── 実測は 1 桁 ms)
    expect(ms, `走査が遅い(${String(ms)}ms)`).toBeLessThan(2_000);
  });
});
