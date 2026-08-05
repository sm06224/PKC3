/**
 * 🔴 **行 → 塊の分割**(2026-08-05。ライブエディタ S2。設計 doc §7)。
 *
 * ここで守るのは 3 つ。どれも「緑のまま壊れる」形が実在する:
 *
 * ① **対応表を取っても HTML が 1 byte も変わらない**
 *    ── ここが崩れると「対応表を取ると見た目が変わる」ことになり、
 *    閲覧と編集を 1 面に寄せる前提が壊れる。goldens も動く
 * ② **分割が全域**(非空の原文行がちょうど 1 つの塊に属し、重複 0)
 *    ── 代替物で満たせない形で書く(「starts が非空」では素通りする)
 * ③ **導出物は 2 種に限る**(脚注の区切り / 脚注本体)── 目次は原文の行を持つので入れない
 *    ── ここが緩むと、原文の行を持たない塊をクリックしたときに
 *    「無い行」を差し替えようとして本文が壊れる
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '@features/markdown/markdown-render';
import { splitTopLevelBlocks } from '@features/markdown/html-blocks';
import {
  blockIndexForLine,
  buildBlockPartition,
  derivedKindOf,
  mapVisibleToSource,
  renderMarkdownWithRanges,
} from '@features/markdown/source-ranges';
import { scanContainers } from '@features/markdown/source-blocks';

const GOLDENS = JSON.parse(
  readFileSync('tests/fixtures/markdown-goldens/goldens.json', 'utf-8'),
) as { cases: { name: string; input: string; options?: Record<string, unknown> }[] };

/**
 * 🔑 **各次元が非ゼロであることを test 自身に assert させる**
 * (fixture のゼロ件の次元は「測っていない次元」── CLAUDE.md)。
 */
const CORPUS = `# 見出し

段落の 1 行目
段落の 2 行目
段落の 3 行目

- 項目 1
- 項目 2

| 見出A | 見出B |
|---|---|
| 行1a | 行1b |
| 行2a | 行2b |

\`\`\`js
const a = 1;
\`\`\`

\`\`\`mermaid
graph TD
  A-->B
\`\`\`

> 引用の行

:::note
中の段落
:::

:::details
畳んだ中身
:::

これは脚注[^a]を持つ段落。

[^a]: 脚注の中身

最後の段落 **太字** つき。
`;

describe('① 対応表を取っても HTML が変わらない', () => {
  it('🔴 corpus で byte 一致', () => {
    const plain = renderMarkdown(CORPUS, {});
    const { html, ranges } = renderMarkdownWithRanges(CORPUS, {});
    expect(html).toBe(plain);
    // ⚠ 空振り防止 ── 対応表が実際に集まっていること
    expect(ranges.length).toBeGreaterThan(10);
  });

  it('🔴 golden 25 件すべてで byte 一致(goldens の契約を動かさない)', () => {
    expect(GOLDENS.cases.length).toBeGreaterThan(20);
    for (const c of GOLDENS.cases) {
      const opts = (c.options ?? {}) as Record<string, never>;
      const plain = renderMarkdown(c.input, opts);
      expect(renderMarkdownWithRanges(c.input, opts).html, `golden: ${c.name}`).toBe(plain);
    }
  });

  it('🔴 刻印を焼く経路と併用しても、焼いた側と byte 一致', () => {
    // 併用したときに集める側が HTML を汚していないことも見る
    const anchored = renderMarkdown(CORPUS, { sourceLineAnchors: true });
    const both = renderMarkdownWithRanges(CORPUS, { sourceLineAnchors: true });
    expect(both.html).toBe(anchored);
  });
});

describe('② 分割は全域で、重複しない', () => {
  const build = (text: string) => {
    const { html, ranges } = renderMarkdownWithRanges(text, {});
    const blocks = splitTopLevelBlocks(html);
    const lines = text.split('\n');
    const part = buildBlockPartition(blocks, ranges, lines.length, scanContainers(text));
    return { part, blocks, lines, ranges };
  };

  it('🔴 corpus の全次元が非ゼロ(この test が何を守っているかの担保)', () => {
    const { ranges } = build(CORPUS);
    const types = new Set(ranges.map((r) => r.type));
    for (const t of [
      'heading_open',
      'paragraph_open',
      'bullet_list_open',
      'list_item_open',
      'table_open',
      'tr_open',
      'fence',
      'blockquote_open',
    ]) {
      expect(types.has(t), `fixture に ${t} が 1 件も無い(測っていない次元)`).toBe(true);
    }
  });

  it('🔴 非空の原文行はちょうど 1 つの塊に属する', () => {
    const { part, lines } = build(CORPUS);
    expect(part.ok, part.reason ?? '').toBe(true);
    let covered = 0;
    const uncovered: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const owner = blockIndexForLine(part, i);
      if (owner !== null) covered += 1;
      else if (lines[i]!.trim() !== '') uncovered.push(`${i}: ${lines[i]!}`);
    }
    // 空行は持ち主が無くてよい。**非空行は全部**持ち主が居ること
    expect(uncovered, `持ち主の無い非空行がある`).toEqual([]);
    expect(covered).toBeGreaterThan(20);
  });

  it('🔴 塊の範囲は昇順で重ならない(重複 0)', () => {
    const { part } = build(CORPUS);
    let prevEnd = -1;
    for (let i = 0; i < part.starts.length; i += 1) {
      if (part.derived[i] !== null) continue;
      expect(part.starts[i]!, `塊 ${i} が前と重なった`).toBeGreaterThan(prevEnd);
      expect(part.ends[i]!).toBeGreaterThanOrEqual(part.starts[i]!);
      prevEnd = part.ends[i]!;
    }
  });

  it('🔴 塊の原文スライスを単独で描くと、全文中のその塊と一致する', () => {
    // ⚠ 脚注 / 目次 は単独描画が一致しないと分かっている(文書全体から作られる)。
    //    だから「一致した数」を数えるのではなく、**一致しなかった塊が
    //    導出物か、脚注を含む塊か**を名指しで確かめる
    const { part, blocks, lines } = build(CORPUS);
    const mismatched: string[] = [];
    for (let i = 0; i < blocks.length; i += 1) {
      if (part.derived[i] !== null) continue;
      const slice = lines.slice(part.starts[i]!, part.ends[i]! + 1).join('\n');
      const alone = splitTopLevelBlocks(renderMarkdown(slice, {}));
      if (alone.length !== 1 || alone[0] !== blocks[i]) mismatched.push(`${i}: ${slice.slice(0, 24)}`);
    }
    // 脚注参照を含む段落だけは単独で描くと `[^a]` がリテラルになるので一致しない
    expect(mismatched.every((m) => m.includes('脚注')), `想定外の不一致: ${mismatched.join(' / ')}`).toBe(
      true,
    );
    // ⚠ 空振り防止 ── 実際に往復を確かめた塊が十分あること
    expect(blocks.length - mismatched.length).toBeGreaterThan(8);
  });

  it('🔴 空の本文でも落ちない', () => {
    const { part } = build('');
    expect(part.ok).toBe(true);
  });

  it('🔴 入れ子の `:::` は今日の描画が壊れているので、開かない側に倒れる', () => {
    // 実測(2026-08-05、本 stage とは無関係な既存バグ): `:::section` の中の
    // `:::note` がリテラルの段落になり、外側の閉じ `:::` が `<p>:::</p>` として漏れる。
    // ⚠ ここで守るのは「**壊れた分割の上で編集させない**」こと ── 描画と原文の
    //    食い違いを検証が捕まえ、行の差し替えを開かない(今日の編集画面へ退避)
    const nested = ':::section{role=warn}\n外\n:::note\n中\n:::\n:::\n';
    expect(renderMarkdown(nested, {})).toContain('<p>:::</p>'); // 壊れている証拠
    const { part } = build(nested);
    expect(part.ok, '壊れた入れ子で分割が通ってしまった(編集させてはいけない)').toBe(false);
  });

  it('🔴 分割が壊れていたら ok:false(開かせない)', () => {
    // range が足りない場合 = 塊と対応が付かない
    const { html } = renderMarkdownWithRanges(CORPUS, {});
    const blocks = splitTopLevelBlocks(html);
    const bad = buildBlockPartition(blocks, [], CORPUS.split('\n').length);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('範囲');
  });

  /**
   * 🔴 **検証を 1 つずつ、直接**当てる(2026-08-05 の変異試験で分かった)。
   *
   * 「重なり」と「範囲の余り」の 2 つの検証は、**互いに庇い合っていた** ──
   * 片方を消しても、壊れた文書はもう片方に捕まるので test が緑のままだった。
   * 純関数なので**crafted な入力を直接**食わせて、1 つずつ効いていることを見る。
   */
  it('🔴 重なった範囲を弾く(単独で効いている)', () => {
    const bad = buildBlockPartition(
      ['<p>a</p>', '<p>b</p>'],
      [
        { start: 0, end: 3, level: 0, type: 'paragraph_open' },
        { start: 2, end: 4, level: 0, type: 'paragraph_open' }, // 0..3 と重なる
      ],
      10,
    );
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('重なって');
  });

  it('🔴 範囲が余ったら弾く(単独で効いている)', () => {
    const bad = buildBlockPartition(
      ['<p>a</p>'],
      [
        { start: 0, end: 0, level: 0, type: 'paragraph_open' },
        { start: 2, end: 2, level: 0, type: 'paragraph_open' }, // 塊が無いのに余る
      ],
      10,
    );
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('余った');
  });

  it('🔴 逆順の範囲を弾く(昇順の仮定が崩れている)', () => {
    const bad = buildBlockPartition(
      ['<p>a</p>', '<p>b</p>'],
      [
        { start: 5, end: 5, level: 0, type: 'paragraph_open' },
        { start: 1, end: 1, level: 0, type: 'paragraph_open' },
      ],
      10,
    );
    expect(bad.ok).toBe(false);
  });

  it('🔴 本文の行数を超える範囲は弾く', () => {
    const blocks = ['<p>a</p>'];
    const bad = buildBlockPartition(blocks, [{ start: 0, end: 99, level: 0, type: 'paragraph_open' }], 3);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('行数');
  });
});

describe('③ 導出物は 2 種に限る', () => {
  it('脚注の区切り / 脚注本体 を見分ける', () => {
    expect(derivedKindOf('<hr class="footnotes-sep">\n')).toBe('footnotes-sep');
    expect(derivedKindOf('<section class="footnotes">x</section>')).toBe('footnotes');
  });

  it('🔴 目次は導出物に入れない(`:::toc` の行を編集できなくなる)', () => {
    expect(derivedKindOf('<nav class="pkc-toc-formal pkc-toc-preview">x</nav>')).toBeNull();
    // 目次を持つ文書でも分割が通り、目次の塊が原文の行を持つ
    const text = '# 題\n\n:::toc\n\n## 節\n';
    const { html, ranges } = renderMarkdownWithRanges(text, {});
    const blocks = splitTopLevelBlocks(html);
    const part = buildBlockPartition(blocks, ranges, text.split('\n').length, scanContainers(text));
    expect(part.ok, part.reason ?? '').toBe(true);
    const navIdx = blocks.findIndex((b) => b.includes('pkc-toc-formal'));
    expect(navIdx).toBeGreaterThanOrEqual(0);
    expect(part.derived[navIdx]).toBeNull();
    expect(part.starts[navIdx], '目次が `:::toc` の行を指していない').toBe(2);
  });

  it('🔴 普通の塊を導出物と見なさない(見なすと編集できなくなる)', () => {
    for (const h of [
      '<p>段落</p>',
      '<h1>見出し</h1>',
      '<hr>',
      '<section class="pkc-section-callout">x</section>',
      '<nav class="pkc-toc-preview">x</nav>',
      '<table><tr><td>a</td></tr></table>',
    ]) {
      expect(derivedKindOf(h), `${h} を導出物と誤判定`).toBeNull();
    }
  });

  it('🔴 脚注を持つ文書では導出物が実際に出る(空振り防止)', () => {
    const { html, ranges } = renderMarkdownWithRanges('本文[^a]\n\n[^a]: 注\n', {});
    const blocks = splitTopLevelBlocks(html);
    const part = buildBlockPartition(blocks, ranges, 3);
    expect(part.ok, part.reason ?? '').toBe(true);
    expect(part.derived.filter((d) => d !== null).length, '導出物が 1 件も出ていない').toBeGreaterThan(
      0,
    );
    // 🔴 **脚注の定義行は編集できる**(脚注の本体が持ち主になっている)
    const fnIdx = blocks.findIndex((b) => b.includes('class="footnotes"'));
    expect(fnIdx).toBeGreaterThanOrEqual(0);
    expect(part.starts[fnIdx], '脚注の定義行の持ち主が居ない').toBe(2);
    expect(blockIndexForLine(part, 2), '定義行から塊が引けない').toBe(fnIdx);
  });
});

describe('④ 描画テキスト → 原文の位置(2 ポインタ)', () => {
  const at = (src: string, visible: string, needle: string) =>
    mapVisibleToSource(src, visible, visible.indexOf(needle));

  it('🔴 行内の装飾を跨いで正確に当たる', () => {
    const src = 'これは**太字**と[リンク](https://example.com)と`コード`です。';
    const visible = 'これは太字とリンクとコードです。';
    // 「リンク」の直後 → 原文では `リンク` と `](` の境目
    const r = mapVisibleToSource(src, visible, visible.indexOf('リンク') + 3);
    expect(r.exact).toBe(true);
    expect(src.slice(r.offset, r.offset + 2)).toBe('](');
  });

  it('🔴 実体参照(原文に無い文字が描画に出る)でも当たる', () => {
    const r = at('A &amp; B の後ろ。', 'A & B の後ろ。', 'の後ろ');
    expect(r.exact).toBe(true);
    expect('A &amp; B の後ろ。'.slice(r.offset)).toBe('の後ろ。');
  });

  it('🔴 外れたら**必ず手前へ**丸まる(前へ飛び越さない)', () => {
    // 置換で描画にだけ現れる文字(原文には `{{vars.name}}` しか無い)
    const src = 'こんにちは {{vars.name}} さん、の後ろ。';
    const visible = 'こんにちは 佐藤 さん、の後ろ。';
    const r = at(src, visible, 'の後ろ');
    expect(r.exact).toBe(false);
    // 置換の**手前**に落ちている(前へ飛び越していない)
    expect(r.offset).toBeLessThanOrEqual(src.indexOf('{{'));
    expect(src.slice(0, r.offset)).toBe('こんにちは ');
  });

  it('🔴 まったく別の文字列なら「その行の先頭」へ丸まる', () => {
    const r = mapVisibleToSource('```csv\na,b\n```', '描画された表', 4);
    expect(r.exact).toBe(false);
    expect(r.offset).toBe(0);
  });

  it('端の扱い: 0 は 0、範囲外は末尾で止まる', () => {
    expect(mapVisibleToSource('abc', 'abc', 0)).toEqual({ offset: 0, exact: true });
    expect(mapVisibleToSource('abc', 'abc', 99).offset).toBe(3);
    expect(mapVisibleToSource('abc', 'abc', -5)).toEqual({ offset: 0, exact: true });
  });
});

describe('⑤ 実データ(repo の doc 群)で分割が成立する', () => {
  /**
   * 🔴 **合成 corpus では気づけない次元**を塞ぐ ── 実際に人が書いた長い日本語
   * markdown 26 件に当てる。⚠ ここが落ちたら「行の差し替えを開けない文書が在る」
   * ことなので、開かない側に倒れる(= 今日の編集画面)。緑のままの破綻ではないが、
   * **機能が黙って効かない**形になるので数で見る。
   */
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith('.md')) out.push(p);
    }
    return out;
  };

  it('🔴 26 件すべてで分割が通り、非空行に 100% 持ち主が付く', () => {
    const docs = walk('docs');
    expect(docs.length, 'doc が見つからない(この test が空振りしている)').toBeGreaterThan(20);
    const failed: string[] = [];
    let nonBlank = 0;
    let orphan = 0;
    for (const p of docs) {
      const text = readFileSync(p, 'utf-8');
      const { html, ranges } = renderMarkdownWithRanges(text, {});
      const blocks = splitTopLevelBlocks(html);
      const lines = text.split('\n');
      const part = buildBlockPartition(blocks, ranges, lines.length, scanContainers(text));
      if (!part.ok) {
        failed.push(`${p}: ${part.reason}`);
        continue;
      }
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i]!.trim() === '') continue;
        nonBlank += 1;
        if (blockIndexForLine(part, i) === null) orphan += 1;
      }
    }
    expect(failed, '分割が通らない doc がある').toEqual([]);
    // ⚠ 空振り防止 ── 実際に何千行も見ていること
    expect(nonBlank).toBeGreaterThan(4000);
    expect(orphan, `持ち主の無い非空行が ${orphan} / ${nonBlank} 行ある`).toBe(0);
  });
});
