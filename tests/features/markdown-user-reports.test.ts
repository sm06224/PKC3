/**
 * user 報告(2026-08-05)から見つかった markdown の欠陥を pin する。
 * 調査 doc: `docs/development/user-reports-2026-08-05.md`
 *
 * 🔴 **ここに並ぶ 2 件は、直す前も `npm test` が全部緑だった。**
 * 既存の検査(golden / css-parity / docs-parity)はどれもこの振る舞いを見ていない ──
 * CLAUDE.md「通っている test は、何も保証していないかもしれない」の実例である。
 */
import { describe, expect, it, vi } from 'vitest';
import { ALIGN_CANONICAL_HINT, renderMarkdown } from '@features/markdown/markdown-render';
// 🔑 **global direction の switch** は frontmatter 側の機構(行頭マーカーとは別系統)
import { extractDocumentGlobals } from '@features/markdown/document-globals';

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

/**
 * 🔴 **行頭アラインの矢印の向きは意味を持たない**(記法の正本)。
 *
 * `PKC2: docs/development/notation-redesign-2026-05/01-notation-catalog.md` §1.4.2 が
 * 「`|>` `<|` `|<` `>|` … **全 4 形が同じ "logical end"** として正規化(典型 typo
 * パターン受理)」と定め、§1.4.1 が **`<|text` align prefix を ❌ 廃止**として
 * 「**default flow は frontmatter で declare**、明示的左寄せ強制は formal
 * `:::paragraph{align=left}`」と書いている。
 *
 * つまり ── **どちら側が既定の流れかは文書全体の direction が決める**
 * (frontmatter `direction:` / `writing:` = global direction の switch)。
 * 行頭マーカーは物理方向を主張してはならず、持てるのは
 * 「中央」と「流れの反対側(end)」の 2 つだけである。
 *
 * ⚠ **この test は一度この規則を逆に pin していた**(2026-08-06。`<|` を start に
 * 変えた誤り。user の指摘で revert)。誤りの根拠は 2 つとも「実装より弱い出典」で、
 * 調査 doc の minor 一覧と、`markdown-css-parity.test.ts` の corpus の註記だった。
 * 🔑 だからこの test は **4 形が同じ値になること**を明示的に見る ── 「向きを
 * 読みたくなる」誤りが**もう一度入らないように**するのが目的である。
 */
describe('行頭アライン: 矢印の向きは意味を持たない(記法の正本)', () => {
  const alignOf = (src: string): string | null => {
    const html = renderMarkdown(src, { silentHallucinationWarnings: true });
    return /data-pkc-align="([^"]+)"/.exec(html)?.[1] ?? null;
  };

  it('🔴 `|>` `<|` `|<` `>|` は**全 4 形が end**(typo 寛容 ── 向きで分けない)', () => {
    const got = ['|>', '<|', '|<', '>|'].map((sym) => [sym, alignOf(`${sym} 本文\n`)]);
    expect(Object.fromEntries(got), '矢印の向きを意味として読んでいる').toEqual({
      '|>': 'end',
      '<|': 'end',
      '|<': 'end',
      '>|': 'end',
    });
  });

  it('`||` だけが center(対称形なので typo 形を持たない)', () => {
    expect(alignOf('|| 中央\n')).toBe('center');
  });

  /**
   * 🔴 **「左」の行頭マーカーは存在しない**(廃止済み)。
   * ⚠ ここは**無いことを pin する** test である ── 誰かが「`<|` は左だろう」と
   * 直感で足すのを止めるために置く。左に寄せたいときの正しい道は 2 つ:
   * ① 文書の `direction` を宣言する(既定の流れを変える)
   * ② formal の `:::paragraph{align=left}`(物理左の強制)
   */
  it('🔴 simple 形に start / left は 1 つも無い(左は direction か formal の仕事)', () => {
    for (const sym of ['||', '|>', '<|', '|<', '>|']) {
      const a = alignOf(`${sym} 本文\n`);
      expect(a, `${sym} が物理/論理の「左」を主張している`).not.toBe('start');
      expect(a, `${sym} が物理左を主張している`).not.toBe('left');
    }
  });

  it('🔑 左寄せは formal 形で書ける(廃止した simple の移行先が生きている)', () => {
    const html = renderMarkdown(':::paragraph{align=left}\n左に寄せる\n:::\n', {
      silentHallucinationWarnings: true,
    });
    expect(html, 'formal の物理左が効いていない').toContain('data-pkc-align="left"');
  });

  /**
   * ⚠ **もう 1 本の formal 経路**(`:::format{…}` = catalog #25b の block format wrapper)。
   * 🔴 この test は**変異試験で見つけた穴**である ── `:::format` の align は
   * `:::paragraph` とは**別の allowlist** を通っていて、そこから `left` を落としても
   * 全 test が緑のままだった(2026-08-06。B3)。同じ「align」の判定が 2 か所に在るので、
   * 片方だけ守っていると片方だけ静かに死ぬ(CLAUDE.md「判定が 2 か所に生えたら両方 pin」)。
   */
  /**
   * 🔴 **曖昧記法の要点は「受理して、正しい形を教える」**(user 2026-08-06
   * 「いわゆる曖昧記法です」)。その「教える文言」が誤っていた ──
   * `:align:{position=X}` を書いた人に `<|`(start)を canonical として配っていた。
   *
   * ⚠ この文言は **user に見える 3 面**へ流れる: ① `console.info` ②
   * レンダ HTML の `data-pkc-canonical` 属性(**書き出した HTML に焼かれる**)
   * ③ hover の `title`。しかも**誰も pin していなかった**ので dist まで出荷された
   * (`markdown-golden.test.ts` は `console.info` を mock で潰している)。
   * 🔑 だからここは**文言そのもの**を見る ── 実装が正しくても、教える文が
   * 誤っていれば user と AI は誤った記法を学ぶ。
   */
  describe('曖昧記法の canonical hint(教える文言)', () => {
    it('🔴 hint が「左」「start」を名乗らない(廃止済みの意味を再教育しない)', () => {
      expect(ALIGN_CANONICAL_HINT, 'hint が start を canonical として教えている').not.toContain(
        'start',
      );
      expect(ALIGN_CANONICAL_HINT, 'hint が「左」の行頭マーカーを教えている').not.toMatch(
        /`<\|`(\s*|\()?左|左寄せ.*`<\|`/,
      );
    });

    it('🔑 hint が正本の 2 つ(center / end)と、左の正しい道を名乗る', () => {
      expect(ALIGN_CANONICAL_HINT).toContain('center');
      expect(ALIGN_CANONICAL_HINT).toContain('end');
      // typo 3 形が同じ end であることまで書く(向きを読ませない)
      for (const sym of ['<|', '|<', '>|']) expect(ALIGN_CANONICAL_HINT).toContain(sym);
      // 左に寄せたい人の行き先(direction / formal)を書く
      expect(ALIGN_CANONICAL_HINT).toContain('direction');
      expect(ALIGN_CANONICAL_HINT).toContain('align=left');
    });

    /**
     * ⚠ **経路が 2 本ある**(表 / standalone)。直す前は同じ誤りが独立に 2 か所
     * 埋まっていて、表だけ直すと**もう片方が残った**。文言を 1 本に寄せたので、
     * 「2 つの出口が同じ文を配る」ことを pin する。
     */
    it('🔴 2 つの出口が同じ文言を配る(片方だけ古くならない)', () => {
      const infos: string[] = [];
      const spy = vi.spyOn(console, 'info').mockImplementation((...a: unknown[]) => {
        infos.push(a.map(String).join(' '));
      });
      try {
        // ① inline 経路(段落の中に書いた `:align:{}`)
        renderMarkdown('本文 :align:{position=center} の続き\n');
        // ② standalone 経路(行そのものが `:align:{}`)
        renderMarkdown(':align:{position=center}\n\n次の段落\n');
      } finally {
        spy.mockRestore();
      }
      const hints = infos.filter((l) => l.includes('PKC2007'));
      expect(hints.length, '2 つの経路のどちらかが hint を出していない').toBeGreaterThanOrEqual(2);
      for (const h of hints) {
        expect(h, 'hint が start を教えている').not.toContain('(start)');
        expect(h, 'hint が正本の文言を使っていない').toContain(ALIGN_CANONICAL_HINT);
      }
    });

    it('🔴 書き出した HTML に焼かれる属性も同じ文言(export が誤りを配らない)', () => {
      const html = renderMarkdown('本文 :align:{position=center} の続き\n', {
        silentHallucinationWarnings: true,
      });
      expect(html, 'canonical 属性が出ていない').toContain('data-pkc-canonical=');
      expect(html, '属性が start を教えている').not.toContain('(start)');
      expect(html).toContain('logical end');
    });
  });

  it('🔴 `:::format{align=…}` も同じ語彙で効く(2 本目の経路を無防備にしない)', () => {
    const left = renderMarkdown(':::format{align=left}\n本文\n:::\n', {
      silentHallucinationWarnings: true,
    });
    expect(left, ':::format の align=left が無視された').toContain('data-pkc-align="left"');
    expect(left).toContain('pkc-format-block');
    const center = renderMarkdown(':::format{align=center}\n本文\n:::\n', {
      silentHallucinationWarnings: true,
    });
    expect(center).toContain('data-pkc-align="center"');
  });

  /**
   * 🔴 **受理集合を 1 つに寄せた**(2026-08-06)。`:::format` の allowlist は
   * `left|center|right|justify` だけで、`start` / `end` / `top` / `bottom` を
   * **黙って落としていた** ── `:::format{align=end}` は `align=letterspacing` と
   * 同じ no-op だった。CLAUDE.md「同じ判定が 2 か所に生えたら規則を 1 つに寄せ、
   * **A が keep するものは B にも必ず入る** parity test を置く」の適用。
   */
  it('🔑 `:::paragraph` が受ける align は `:::format` も全部受ける(parity)', () => {
    const kinds = ['center', 'end', 'start', 'left', 'right', 'top', 'bottom'];
    for (const k of kinds) {
      const para = renderMarkdown(`:::paragraph{align=${k}}\n本文\n:::\n`, {
        silentHallucinationWarnings: true,
      });
      // fixture 自身のゼロ件防止 ── paragraph 側が受けていることを先に確かめる
      expect(para, `:::paragraph{align=${k}} が受理されていない`).toContain(
        `data-pkc-align="${k}"`,
      );
      const fmt = renderMarkdown(`:::format{align=${k}}\n本文\n:::\n`, {
        silentHallucinationWarnings: true,
      });
      expect(fmt, `:::format が align=${k} を黙って落としている`).toContain(
        `data-pkc-align="${k}"`,
      );
    }
    // `justify` は装飾箱だけの値(段落側には無い)── 受けることを別に pin する
    expect(
      renderMarkdown(':::format{align=justify}\n本文\n:::\n', {
        silentHallucinationWarnings: true,
      }),
    ).toContain('data-pkc-align="justify"');
    // 語彙外は依然として落とす(何でも通す方向へ広げていない)
    expect(
      renderMarkdown(':::format{align=letterspacing}\n本文\n:::\n', {
        silentHallucinationWarnings: true,
      }),
      '語彙外の値まで属性になっている',
    ).not.toContain('data-pkc-align=');
  });

  /**
   * 🔴 **物理を logical へ潰さない**(2026-08-06)。`:align:{position=left}` は
   * 直す前 `start` に写されていた ── `start` は `direction` で反転するので、
   * `direction: rtl` の文書で**「左」と書いた段落が右へ行く**。
   * ⚠ CSS から「logical と physical の同居」を取り除いたのに、**同じ潰しが
   *   parser 側に残っていた** ── 判定を 2 か所に持つと片方だけ直る。
   */
  it('🔴 `:align:{position=left|right}` は物理のまま(direction で反転しない)', () => {
    const alignOfNext = (src: string): string | null => {
      const html = renderMarkdown(src, { silentHallucinationWarnings: true });
      return /data-pkc-align="([^"]+)"/.exec(html)?.[1] ?? null;
    };
    expect(alignOfNext(':align:{position=left}\n\n本文\n'), 'left が logical へ潰された').toBe(
      'left',
    );
    expect(alignOfNext(':align:{position=right}\n\n本文\n'), 'right が logical へ潰された').toBe(
      'right',
    );
    // logical を書いたときは logical のまま(物理へも潰さない)
    expect(alignOfNext(':align:{position=end}\n\n本文\n')).toBe('end');
    expect(alignOfNext(':align:{position=start}\n\n本文\n')).toBe('start');

    // inline 経路(chip)も同じ ── 説明文が「end → right」と教えていた
    const chip = renderMarkdown('本文 :align:{position=end} の続き\n', {
      silentHallucinationWarnings: true,
    });
    expect(chip, 'chip が end を right と教えている').toContain('data-pkc-align-next="end"');
    expect(chip, 'chip の説明文が物理へ潰している').not.toContain('end→right');
  });

  /**
   * 🔴 **formal 形は logical 値も受ける**(2026-08-06。曖昧記法の調査で見つけた欠陥)。
   *
   * 正本は formal を「simple の canonical な言い換え」と定めている
   * (spec v4 #33「`:::paragraph{align=center|end|start}`」/ canonicalization-spec §53
   * 「`|> 本文` → `:::paragraph{align=end} 本文 :::`」)。にもかかわらず判定は
   * **物理値だけ**の allowlist を通っていて、`align=end` / `align=start` は
   * `align=letterspacing` と同じ**黙った no-op** だった ── つまり
   * **「`|>` の正しい書き方」が存在しないことになっていた**。
   * ⚠ CSS は最初から対応済み(落ちていたのは受理側 1 か所)。
   */
  it('🔴 `:::paragraph{align=end|start}` が効く(canonical な言い換えが no-op でない)', () => {
    const alignOfFormal = (v: string): string | null => {
      const html = renderMarkdown(`:::paragraph{align=${v}}\n本文\n:::\n`, {
        silentHallucinationWarnings: true,
      });
      return /data-pkc-align="([^"]*)"/.exec(html)?.[1] ?? null;
    };
    expect(alignOfFormal('end'), 'logical end が黙って無視された').toBe('end');
    expect(alignOfFormal('start'), 'logical start が黙って無視された').toBe('start');
    // 物理値は今までどおり(logical を足した代償が出ていない)
    expect(alignOfFormal('left')).toBe('left');
    expect(alignOfFormal('right')).toBe('right');
    expect(alignOfFormal('center')).toBe('center');
    // ⚠ 出典に無い値は今までどおり受けない(受理を広げすぎていない)
    expect(alignOfFormal('letterspacing'), '不正な値まで受けるようになった').toBeNull();
  });

  /**
   * 🔑 **既定の流れは frontmatter が決める**(global direction の switch)。
   * ⚠ この 2 つが同じ文書で共存できることを見る ── `end` の物理的な着地点は
   * ここで反転する(だから行頭マーカーが物理方向を持ってはいけない)。
   */
  it('🔴 文書の direction は frontmatter で切り替わる(行頭マーカーとは別系統)', () => {
    const globals = extractDocumentGlobals('---\ndirection: rtl\n---\n\n|> 本文\n');
    expect(globals.direction, 'global direction の switch が効いていない').toBe('rtl');
    // ⚠ マーカー側は direction に関わらず end のまま(logical なので反転は CSS の仕事)
    expect(alignOf('---\ndirection: rtl\n---\n\n|> 本文\n')).toBe('end');
  });
});

/**
 * 🔴 **id の無い図表も図表として描く**(2026-08-06。user 報告 minor
 * 「`:::figure` が素のテキスト」)。
 *
 * 直す前は id を書かないと 3 行が**そのまま画面に並んだ**
 * (`:::figure` / `^^^ 説明` / `:::`)。id は `[@id]` で参照するときだけ要る。
 */
describe('id の無い図表(user 報告 minor)', () => {
  it('🔴 `:::figure` だけでも `<figure>` になる(素のテキストで出ない)', () => {
    const html = renderMarkdown(':::figure\n^^^ 説明\n:::\n', {
      silentHallucinationWarnings: true,
    });
    expect(html, '記法が素のまま出ている').not.toContain('<p>:::figure</p>');
    expect(html).toContain('<figure');
    expect(html).toContain('図 1: 説明');
    // ⚠ 空の id を書かない(`id=""` は妥当でないし、参照先にもならない)
    expect(html, '空の id を吐いた').not.toContain('id=""');
  });

  it('番号は id の有無に関わらず通し番号(数え方が 2 通りにならない)', () => {
    const html = renderMarkdown(
      ':::figure\n^^^ 一枚目\n:::\n\n:::figure{#f2}\n^^^ 二枚目\n:::\n',
      { silentHallucinationWarnings: true },
    );
    expect(html).toContain('図 1: 一枚目');
    expect(html).toContain('図 2: 二枚目');
  });

  /**
   * ⚠ **「不正な id」と「id を書いていない」を分ける**。
   * `{id="あ"}` は **id を書いたのに使えない**形なので、今までどおり素のままで出す
   * (打ち間違いの合図を黙って飲まない)。⚠ `{#あ い}` は属性の parser が
   * id として拾わない = 「書いていない」に落ちるので、こちらの経路には来ない
   * (実測。判定を 2 か所に持たないので、parser の寛容さがそのまま効く)。
   */
  it('🔴 使えない id を書いたときは今までどおり素のまま', () => {
    const html = renderMarkdown(':::figure{id="あ"}\n^^^ 説明\n:::\n', {
      silentHallucinationWarnings: true,
    });
    expect(html).toContain(':::figure');
    expect(html).not.toContain('<figure');
  });

  it('🔴 id の無い図は参照先にならない(`[@…]` が別の図を指さない)', () => {
    const html = renderMarkdown(
      ':::figure\n^^^ 無名\n:::\n\n:::figure{#f2}\n^^^ 名前つき\n:::\n\n参照 [@f2] と [@] \n',
      { silentHallucinationWarnings: true },
    );
    expect(html).toContain('>図 2</a>');
    // `[@]`(空の id)は参照として解決しない
    expect(html).toContain('[@]');
  });

  it('sentinel が漏れていない(PUA の文字が画面に出ない)', () => {
    const html = renderMarkdown(':::figure\n^^^ 説明\n:::\n', {
      silentHallucinationWarnings: true,
    });
    // ⚠ 2026-05-08 に実際に踏んだ形 ── 置換に当たらないと私用領域の文字が残る
    expect(/[-]/.test(html), 'sentinel が HTML に残っている').toBe(false);
  });
});
