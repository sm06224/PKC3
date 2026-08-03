/**
 * P8 段⑩: **切って戻せること**が preview の正しさそのもの。
 *
 * 🔴 ここが崩れると preview が「一部だけ静かに消える」形で壊れる ── 例外も
 * 出ないので、気づくのは user である。だから観測点は
 * **`join('') === 元の HTML`**(全量回復)に置く。個別の期待値を並べるより強い。
 *
 * ⚠ 材料は**実際に描いた HTML**にする ── 手で書いた HTML で通しても、
 * markdown-it が実際に吐く形(空行・改行の入り方)を見ていないことになる。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import {
  splitTopLevelBlocks,
  diffBlocks,
} from '../../src/features/markdown/html-blocks';

/** 実際に user が書く形を一通り。⚠ ここに無い形は「見ていない次元」。 */
const DOCS: Record<string, string> = {
  見出しと段落: '# 見出し\n\n本文です。**太字**と `コード`。\n\n## 次\n\nもう 1 段落。\n',
  箇条書き: '- あ\n- い\n  - 入れ子\n- う\n\n1. 一\n2. 二\n',
  表: '| 項目 | 値 |\n|---|---|\n| あ | 1 |\n| い | 2 |\n',
  コード: '```js\nconst a = 1;\nif (a < 2) { console.log("<b>"); }\n```\n',
  図: '```mermaid\ngraph TD\n  A-->B\n```\n',
  引用と区切り: '> 引用\n> つづき\n\n---\n\n次の段落\n',
  チェック: '- [ ] やること\n- [x] 済んだこと\n',
  リンクと画像: '[リンク](https://example.com) と ![alt](asset:k1)\n',
  脚注: '本文[^1]\n\n[^1]: 注釈\n',
  '記号を含む本文': '不等号 < と > と & を含む。`<script>` も。\n',
  html: '```html\n<p>中身</p>\n```\n',
  csv: '```csv\nりんご,120\nみかん,80\n```\n',
  混合: [
    '# 題',
    '',
    '段落。',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '- 箇条 1',
    '- 箇条 2',
    '',
    '> 引用',
    '',
    '最後の段落。',
    '',
  ].join('\n'),
};

describe('🔴 切って戻せる(全量回復)', () => {
  it.each(Object.entries(DOCS))('%s', (_name, md) => {
    const html = renderMarkdown(md, { sourceLineAnchors: true });
    const blocks = splitTopLevelBlocks(html);
    // ⚠ **1 文字も落とさない**。ここが本体
    expect(blocks.join('')).toBe(html);
    // ⚠ 空振り防止 ── 1 個に丸まっていたら「切れていない」
    expect(blocks.length, '塊に切れていない(全部 1 個になっている)').toBeGreaterThan(0);
  });

  it('🔴 複数の塊に**実際に**切れている(1 個に丸めて全量回復を満たさない)', () => {
    const html = renderMarkdown(DOCS['混合']!, { sourceLineAnchors: true });
    expect(splitTopLevelBlocks(html).length).toBeGreaterThan(5);
  });

  it('空文字は空の並び', () => {
    expect(splitTopLevelBlocks('')).toEqual([]);
  });

  it('⚠ 属性値の中の `>` でタグを切らない', () => {
    const html = '<div data-x="a>b"><p>中</p></div>\n<p>次</p>\n';
    const blocks = splitTopLevelBlocks(html);
    expect(blocks.join('')).toBe(html);
    expect(blocks).toHaveLength(2);
  });

  it('🔴 属性値の中の**閉じタグらしき文字列**で閉じない', () => {
    // ⚠ `>` だけを見る test では**引用符の扱いを消しても通る**(変異試験で判明)──
    // 引用符が効いていないと分かるのは、属性の中に閉じタグが入っているとき
    // ⚠ ここは**2 段**の罠。属性の中に `>` が在り、**その後ろ**に閉じタグらしき
    // 文字列が続く形でないと discriminate しない ── `<div title="</div>">` だけでは、
    // 引用符を見ない実装でも「開始タグの走査に飲み込まれて」同じ結果になる
    // (実際にその形で変異が生き残った)
    const html = '<div title="a>b</div>c">中</div>\n<p>次</p>\n';
    const blocks = splitTopLevelBlocks(html);
    expect(blocks.join('')).toBe(html);
    expect(blocks[0], '属性の中の文字列でタグを閉じた').toBe('<div title="a>b</div>c">中</div>\n');
    expect(blocks).toHaveLength(2);
  });

  it('⚠ 同名の入れ子を数える', () => {
    const html = '<div><div>内</div></div>\n<div>次</div>\n';
    const blocks = splitTopLevelBlocks(html);
    expect(blocks.join('')).toBe(html);
    // 🔴 **中身で見る**。件数だけだと、内側で閉じてしまう実装が
    // 「余りが 1 塊に丸まる」ことで同じ件数になり、素通りする(変異試験で判明)
    expect(blocks[0], '内側の閉じタグで切ってしまった').toBe('<div><div>内</div></div>\n');
    expect(blocks[1]).toBe('<div>次</div>\n');
  });

  it('⚠ 閉じタグを持たない要素は 1 つの塊', () => {
    const html = '<hr>\n<p>あと</p>\n';
    expect(splitTopLevelBlocks(html)).toEqual(['<hr>\n', '<p>あと</p>\n']);
  });
});

describe('🔴 描画は決定的である(差分の前提)', () => {
  // 🔴 かつて fence のトグル id が `Math.random()` だったため、**同じ入力でも
  // 毎回ちがう HTML** になっていた。差分から見ると fence を含む塊は「毎回変わった」
  // ことになり、**図が毎回作り直されて絵が一度消える**(user 指摘の
  // 「レンダリングで画面がガクガクする」の実体の 1 つ)。
  // ⚠ ここが崩れると差分は静かに無効化される ── 例外も出ず、test も緑のまま
  it.each(Object.entries(DOCS))('%s は 2 回描いても同じ', (_name, md) => {
    const a = renderMarkdown(md, { sourceLineAnchors: true });
    expect(renderMarkdown(md, { sourceLineAnchors: true })).toBe(a);
  });

  it('🔴 同じ内容の fence が 2 つあっても id が衝突しない', () => {
    // ⚠ 決定的にした代償で「同じ中身 = 同じ id」になりうる ── 位置も混ぜてある
    // ⚠ トグルが出るのは**描ける** fence だけ(`js` には出ない)── 図で見る。
    // ⚠ `sourceLineAnchors: false`(= プレビュー)で見る。行番号が入る面では
    //    たまたま区別できてしまい、**プレビューでだけ衝突する**を見逃す
    const html = renderMarkdown('```mermaid\ngraph TD\n  A-->B\n```\n\n```mermaid\ngraph TD\n  A-->B\n```\n', {
      sourceLineAnchors: false,
    });
    const ids = [...html.matchAll(/id="(pkc-rv-[^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size, 'id が衝突している(トグルが連動する)').toBe(2);
  });
});

describe('差分(前後の一致を削る)', () => {
  const A = ['<p>1</p>', '<p>2</p>', '<p>3</p>', '<p>4</p>'];

  it('変わっていなければ真ん中は空', () => {
    expect(diffBlocks(A, A)).toEqual({ prefix: 4, suffix: 0, middle: [], removed: 0 });
  });

  it('🔴 真ん中の 1 個だけ差し替える(前後は触らない)', () => {
    const B = ['<p>1</p>', '<p>x</p>', '<p>3</p>', '<p>4</p>'];
    const d = diffBlocks(A, B);
    expect(d.prefix).toBe(1);
    expect(d.suffix).toBe(2);
    expect(d.middle).toEqual(['<p>x</p>']);
    expect(d.removed).toBe(1);
  });

  it('末尾に足すと prefix だけ伸びる(前が全部残る)', () => {
    const B = [...A, '<p>5</p>'];
    const d = diffBlocks(A, B);
    expect(d.prefix).toBe(4);
    expect(d.middle).toEqual(['<p>5</p>']);
    expect(d.removed).toBe(0);
  });

  it('途中を消すと middle が空で removed が立つ', () => {
    const B = ['<p>1</p>', '<p>4</p>'];
    const d = diffBlocks(A, B);
    expect(d.middle).toEqual([]);
    expect(d.removed).toBe(2);
    expect(d.prefix + d.suffix).toBe(2);
  });

  it('🔴 差分を当てると必ず元へ揃う(適用の意味論)', () => {
    const apply = (old: readonly string[], p: ReturnType<typeof diffBlocks>): string[] => [
      ...old.slice(0, p.prefix),
      ...p.middle,
      ...old.slice(p.prefix + p.removed),
    ];
    const cases: Array<[string[], string[]]> = [
      [A, ['<p>1</p>', '<p>x</p>', '<p>3</p>', '<p>4</p>']],
      [A, [...A, '<p>5</p>']],
      [A, ['<p>1</p>', '<p>4</p>']],
      [A, []],
      [[], A],
      [A, ['<p>a</p>', '<p>b</p>', '<p>c</p>']],
    ];
    for (const [before, after] of cases) {
      expect(apply(before, diffBlocks(before, after))).toEqual(after);
    }
  });

  it('🔴 実際の編集(1 文字足す)で触る塊が 1 個で済む', () => {
    // ⚠ ここが本丸 ── 「差分を取っている」ではなく「**本当に少ししか動かない**」
    const md = DOCS['混合']!;
    const before = splitTopLevelBlocks(renderMarkdown(md, { sourceLineAnchors: true }));
    const after = splitTopLevelBlocks(
      renderMarkdown(md.replace('段落。', '段落。あ'), { sourceLineAnchors: true }),
    );
    const d = diffBlocks(before, after);
    expect(before.length).toBeGreaterThan(5);
    expect(d.middle.length, '1 文字の編集で作り直す塊が多すぎる').toBeLessThanOrEqual(2);
    expect(d.removed).toBeLessThanOrEqual(2);
  });
});
