import { describe, expect, it } from 'vitest';
import {
  ensureBlankAroundSectionBreaks,
  preprocessAlignPrefix,
  renderMarkdown,
  renderMarkdownWithoutPostGuard,
} from '../../src/features/markdown/markdown-render';
import { ensureBlankAroundColonBlocksWithLineMap } from '../../src/features/markdown/colon-block-normalize';

/**
 * #1087 ── 描画の post 段(sentinel → HTML)の近道と、colon 正規化の近道は、
 * 出力を 1 バイトも変えない。
 *
 * 守るもの:近道を使う描画と使わない描画が、様々な本文で byte 一致すること。
 * ⚠ 守っていないもの:近道が実際に速いこと(速さは別に測る)。
 */

const SENTINEL = /[\u{E110}-\u{E17F}]/u;

const CORPUS: readonly string[] = [
  '# 見出し1\n\n本文です。\n\n## 見出し2\n\n- a\n- b\n',
  '| a | b |\n|---|---|\n| 1 | 2 |\n',
  '```ts\nconst x = 1;\n```\n\n~~~\nplain\n~~~\n',
  '```ts\nunclosed fence\n',
  ':::section{role=note}\n中身\n:::\n',
  ':::details{summary=詳細}\n隠す\n:::\n',
  ':::quote{author=漱石}\n吾輩は猫である\n:::\n',
  ':::format{class=a,indent=2}\n箱\n:::\n',
  ':::toc{depth=2}\n\n# A\n\n## B\n\n### C\n',
  ':::figure{id=f1}\n画像\n\n図の説明\n:::\n\n参照 [@f1]\n',
  '前\n_\n中\n_3\n後\n',
  '前\r\n\r\n後\r\n:::section{role=tip}\r\nx\r\n:::\r\n',
  '{{vars.undefined}} と {{vars.x}}\n',
  ':lead: 導入\n\n:spacing: 3\n\n:align: end\n\n:quote: 誰か\n',
  ':::note\n注意\n:::\n',
  '+++\n\n---\n\n***\n',
  '%%隠す%% と %%%\nブロックコメント\n%%%\n本文\n',
  '||## 中央見出し\n\n>| 右寄せ\n\n__ 字下げ\n',
  '> 引用\n:::section{role=x}\ny\n:::\n',
  '- [ ] task\n- [x] done\n\n==強調== [[ruby:漢字|かんじ]]\n',
  '\uE110\uE140 本文に紛れた私用領域の字\n',
  '# 日本語の見出し\n\n本文。https://example.com を含む。\n',
  'plain only',
  '# a\n\n:::toc\n\n# a\n\n## a\n',
  ':::format{class=a\n壊れた opener\n:::\n',
];

describe('post 段の近道(sentinel が無ければ飛ばす)', () => {
  it('コーパスが 20 件以上で、記法を使う物と使わない物の両方を含む', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(20);
    const withDirective = CORPUS.filter((s) => /:::|\n_\d*\n|\{\{vars|\[@|\+\+\+|:lead:/.test(s));
    expect(withDirective.length).toBeGreaterThan(5);
    expect(CORPUS.length - withDirective.length).toBeGreaterThan(3);
  });

  for (const [i, src] of CORPUS.entries()) {
    it(`#${i}: 近道あり/なしで byte 一致(既定 + 行の印あり)`, () => {
      expect(renderMarkdown(src)).toBe(renderMarkdownWithoutPostGuard(src));
      expect(renderMarkdown(src, { sourceLineAnchors: true })).toBe(
        renderMarkdownWithoutPostGuard(src, { sourceLineAnchors: true }),
      );
      // 出力に私用領域の字が漏れていない(近道の穴が sentinel 漏れになっていない)
      expect(SENTINEL.test(renderMarkdown(src))).toBe(false);
    });
  }

  it('sentinel を使う記法は近道に入らず、変換が済んでいる', () => {
    const html = renderMarkdown(':::section{role=note}\n中身\n:::\n\n前\n_2\n後\n');
    expect(html).toContain('pkc-section-callout');
    expect(html).toContain('pkc-blank-line');
  });
});

describe('colon-block-normalize の近道(`:::` も `\\r` も無い本文)', () => {
  // 遅い道の強制:末尾に `\r` を足して近道を外し、結果から `\r` を除く
  // (`\r` で終わる行は `:::` の無い入力では何にも当たらないので、他の行は同じ)
  function slow(src: string, map: number[]) {
    const forced = ensureBlankAroundColonBlocksWithLineMap(src + '\r', map);
    expect(forced.transformed.endsWith('\r')).toBe(true);
    return { transformed: forced.transformed.slice(0, -1), lineMap: forced.lineMap };
  }

  const inputs = [
    'a',
    'a\nb\nc',
    '\n\n',
    '# h\n\n- x\n- y\n',
    '```\ncode\n```\n',
    '日本語\n\n本文\n',
    '::二つだけ\n:\n',
  ];

  for (const src of inputs) {
    const n = src.split('\n').length;
    const maps: { name: string; map: number[] }[] = [
      { name: '恒等', map: Array.from({ length: n }, (_, i) => i) },
      { name: 'ずれている', map: Array.from({ length: n }, (_, i) => i * 2 + 1) },
      { name: '短い', map: [] },
    ];
    for (const { name, map } of maps) {
      it(`${JSON.stringify(src)} / lineMap ${name}: 近道と遅い道が一致し、配列を共有しない`, () => {
        const fast = ensureBlankAroundColonBlocksWithLineMap(src, map);
        const ref = slow(src, map);
        expect(fast.transformed).toBe(src);
        expect(fast.transformed).toBe(ref.transformed);
        expect(fast.lineMap).toEqual(ref.lineMap);
        expect(fast.lineMap).toHaveLength(n);
        expect(fast.lineMap).not.toBe(map);
      });
    }
  }

  it('`:::` を含むと近道に入らず、空行が挿入される', () => {
    const r = ensureBlankAroundColonBlocksWithLineMap('a\n:::section\nb\n:::', [0, 1, 2, 3]);
    expect(r.transformed).toBe('a\n\n:::section\n\nb\n\n:::');
  });
});

describe('closedFenceLines は interactiveCodeBlocks のときだけ要る', () => {
  const body = '```ts\nconst a = 1;\n```\n\n```ts\nunclosed\n';
  it('interactiveCodeBlocks なら閉じた枠にだけ ✎ が出る', () => {
    const on = renderMarkdown(body, { interactiveCodeBlocks: true });
    const off = renderMarkdown(body);
    expect(on.split('data-pkc-action="edit-code-block"').length - 1).toBe(1);
    expect(off).not.toContain('edit-code-block');
  });
});

/**
 * 行頭の寄せ・字下げの前処理と、区切りの前後の空行(#1087)の近道。
 * 守るもの:近道を使う/使わないで transformed と lineMap(と alignMap / indentMap)が一致し、
 * lineMap は入力の配列を共有しないこと。入力の lineMap が恒等でない場合も一致すること。
 * ⚠ 守っていないもの:速さ(別に測る)。
 */
const SB_OPEN = '\u{E120}';
const SB_SEP = '\u{E121}';

// 近道に入る本文(記法が無い)と、近い字を含んで遅い道へ倒れる本文の両方
const NEAR_MISS: readonly string[] = [
  'a',
  'a\nb\nc',
  '\n\n',
  '# 見出し\n\n本文です。\n',
  '- a\n- b\n',
  '```ts\nconst x = 1;\n```\n',
  '日本語の本文\n\n二段落目\n',
  'snake_case と _single_ と a_b_c\n',
  'a + b = c\n+ 1\n++ 2\n',
  '1 > 0 と 0 < 1 と a|b\n',
  '単独の | を含む\n',
  '| a | b |\n|---|---|\n| 1 | 2 |\n',
  '__bold__ と ___ と ＿全角\n',
  '＿全角の字下げ\n',
  '||中央\n\n|> 反対\n',
  '   <| 空白つき\n>| x\n|< y\n',
  'crlf1\r\ncrlf2\r\n\r\nend',
  'lone\rcr\n',
  `前\n${SB_OPEN}section${SB_SEP}\n後\n`,
  `${SB_OPEN}cover${SB_SEP}\n${SB_OPEN}x${SB_SEP}`,
  `${SB_OPEN}は単独\n`,
  `a\r\n${SB_OPEN}section${SB_SEP}\r\nb`,
  '',
  '\n',
];

function mapsFor(src: string): number[][] {
  const n = src.split(/\r?\n/).length;
  return [
    Array.from({ length: n }, (_, i) => i),
    Array.from({ length: n }, (_, i) => i * 2 + 1),
    [],
  ];
}

describe('align prefix / section break の近道(#1087)', () => {
  it('コーパスが 15 件以上で、近道に入る本文と倒れる本文の両方を含む', () => {
    expect(NEAR_MISS.length).toBeGreaterThanOrEqual(15);
    const fastAlign = NEAR_MISS.filter((s) => !/\||__|\uFF3F|\r/.test(s));
    const fastSection = NEAR_MISS.filter((s) => !s.includes(SB_OPEN) && !s.includes('\r'));
    expect(fastAlign.length).toBeGreaterThan(5);
    expect(NEAR_MISS.length - fastAlign.length).toBeGreaterThan(5);
    expect(fastSection.length).toBeGreaterThan(10);
    expect(NEAR_MISS.length - fastSection.length).toBeGreaterThan(3);
  });

  for (const src of NEAR_MISS) {
    for (const map of mapsFor(src)) {
      it(`${JSON.stringify(src)} / lineMap ${JSON.stringify(map)}: 近道と遅い道が一致`, () => {
        const a = preprocessAlignPrefix(src, map);
        const aSlow = preprocessAlignPrefix(src, map, false);
        expect(a.stripped).toBe(aSlow.stripped);
        expect(a.lineMap).toEqual(aSlow.lineMap);
        expect([...a.alignMap]).toEqual([...aSlow.alignMap]);
        expect([...a.indentMap]).toEqual([...aSlow.indentMap]);
        expect(a.lineMap).not.toBe(map);

        const b = ensureBlankAroundSectionBreaks(src, map);
        const bSlow = ensureBlankAroundSectionBreaks(src, map, false);
        expect(b.transformed).toBe(bSlow.transformed);
        expect(b.lineMap).toEqual(bSlow.lineMap);
        expect(b.lineMap).not.toBe(map);
      });
    }
  }

  it('記法を含むと近道に入らず、変換が起きる(対照群)', () => {
    const a = preprocessAlignPrefix('前\n||中央\n', [0, 1, 2]);
    expect(a.stripped).toBe('前\n\n中央\n');
    expect(a.alignMap.size).toBe(1);
    const i = preprocessAlignPrefix('前\n__字下げ\n', [0, 1, 2]);
    expect(i.indentMap.size).toBe(1);
    const z = preprocessAlignPrefix('前\n＿字下げ\n', [0, 1, 2]);
    expect(z.indentMap.size).toBe(1);
    const b = ensureBlankAroundSectionBreaks(`a\n${SB_OPEN}x${SB_SEP}\nb`, [0, 1, 2]);
    expect(b.transformed).toBe(`a\n\n${SB_OPEN}x${SB_SEP}\n\nb`);
  });

  it('CRLF は近道に入らず LF へ正規化される(近道が \\r を見ている)', () => {
    expect(preprocessAlignPrefix('a\r\nb', [0, 1]).stripped).toBe('a\nb');
    expect(ensureBlankAroundSectionBreaks('a\r\nb', [0, 1]).transformed).toBe('a\nb');
  });

  it('近道に入った入力は、入力 lineMap を新しい配列に写す(長い map は切り詰める)', () => {
    const map = [5, 6, 7, 8];
    const r = preprocessAlignPrefix('a\nb', map);
    expect(r.lineMap).toEqual([5, 6]);
    expect(ensureBlankAroundSectionBreaks('a\nb', map).lineMap).toEqual([5, 6]);
  });
});
