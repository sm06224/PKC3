/** @vitest-environment happy-dom */
/**
 * 🔴 **押した見本の色コードだけが書き換わる**(#1224 段②)。
 *
 * 描く側(見本に「何行目の何番目」を焼く)と書く側(原文の行を走って、その番号のコードを入れ替える)は
 * **別の観測**で数えている(markdown-it の `code_inline` / `color-code.ts` の走査)。
 * ここが守るのは、その 2 つが**同じ所を指す**こと ── 食い違うと、押した見本と別の字が書き換わる。
 *
 * ⚠ 期待値を実装と同じ式で組まない。**原文を素の正規表現で走った位置**(別の観測)と、
 *   実際に描いた見本の属性を突き合わせる。
 */
import { describe, expect, it } from 'vitest';
import { applyBodyRewrite } from '@features/markdown/body-rewrite';
import { renderMarkdown } from '@features/markdown/markdown-render';
import { bodyBelowFrontmatter, frontmatterLineCount } from '@features/markdown/frontmatter';

const color = (line: number, nth: number, from: string, to: string) =>
  ({ kind: 'color', line, nth, from, to }) as const;

/** 押せる見本を全部、DOM の順に読む(描画の結果そのもの)。 */
function pressable(body: string): { line: number; nth: number; value: string }[] {
  const html = renderMarkdown(bodyBelowFrontmatter(body), {
    colorSwatches: true,
    taskLineOffset: frontmatterLineCount(body),
  });
  const host = document.createElement('div');
  host.innerHTML = html;
  return [...host.querySelectorAll<HTMLElement>('[data-pkc-action="pick-color"]')].map((e) => ({
    line: Number(e.getAttribute('data-pkc-color-line')),
    nth: Number(e.getAttribute('data-pkc-color-nth')),
    value: e.getAttribute('data-pkc-color-value')!,
  }));
}

/**
 * 別の観測:原文を**素の正規表現**で走り、囲み(```)の外の `` `#rrggbb` `` を
 * (行 / その行の何番目の色コードか / 字 / 先頭からの位置)で返す。
 * ⚠ この corpus は「色コード以外のバッククォート」を 1 行に混ぜない ── 数え方の差が出ない形にして、
 *   **行番号・番号のずれだけ**を見る。
 */
function bySource(body: string): { line: number; nth: number; value: string; at: number }[] {
  const out: { line: number; nth: number; value: string; at: number }[] = [];
  let fence = false;
  let at = 0;
  body.split('\n').forEach((text, line) => {
    if (/^\s*```/.test(text)) fence = !fence;
    else if (!fence) {
      let nth = 0;
      for (const m of text.matchAll(/`#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})`/g)) {
        const value = `#${m[1]}`;
        // 押せるのは 6 桁小文字だけだが、数えるのは色コード全部(番号は行の中の通し番号)
        out.push({ line, nth, value, at: at + m.index! + 1 });
        nth += 1;
      }
    }
    at += text.length + 1;
  });
  return out;
}

const CORPUS = [
  '---',
  'tags:',
  '  - 色',
  '---',
  '# 主色 `#3b82f6`',
  '',
  '`#3b82f6` と `#3b82f6` と `#ef4444`',
  '続きの行 `#3b82f6` と `#FFF` と `#222222`',
  '',
  '| 名 | 色 |',
  '|---|---|',
  '| 青 | `#3b82f6` |',
  '| 二つ | `#111111` `#3b82f6` |',
  '',
  '```',
  '`#aaaaaa`',
  '```',
  '',
  '- 項目 `#3b82f6`',
  '> 引用 `#3b82f6` と `#FFF` と `#333333`',
  '',
  '文中の #3b82f6 は地の文',
  '',
].join('\n');

describe('描く側と書く側が同じ所を指す(#1224)', () => {
  it('🔴 押せる見本 1 つずつについて、書き換えると「その見本の字だけ」が変わる', () => {
    expect(frontmatterLineCount(CORPUS), '前提:frontmatter が在る(行番号のずれを見る)').toBeGreaterThan(0);
    const swatches = pressable(CORPUS);
    const src = bySource(CORPUS).filter((s) => /^#[0-9a-f]{6}$/.test(s.value));
    // ⚠ 空振り防止 ── 同じ色が 1 行に 2 つ以上・表・見出し・引用・リスト・続きの行の全部を含む
    expect(swatches.length, '押せる見本が少ない(corpus の空振り)').toBeGreaterThanOrEqual(12);
    // 🔴 描いた見本の並び(DOM の順)と、原文を走った並びが**一致**する
    expect(
      swatches.map((s) => [s.line, s.nth, s.value]),
      '描く側の数え方と原文の数え方が食い違う',
    ).toEqual(src.map((s) => [s.line, s.nth, s.value]));
    for (const [i, sw] of swatches.entries()) {
      const next = applyBodyRewrite(CORPUS, color(sw.line, sw.nth, sw.value, '#000001'));
      expect(next, `${i} 番目の見本を書き換えられない`).not.toBeNull();
      const at = src[i]!.at;
      // その見本の 7 字だけが変わり、前後は 1 バイトも動かない
      expect(next!.slice(0, at)).toBe(CORPUS.slice(0, at));
      expect(next!.slice(at, at + 7)).toBe('#000001');
      expect(next!.slice(at + 7)).toBe(CORPUS.slice(at + 7));
    }
  });

  it('🔴 同じ色が 1 行に 2 つ在るとき、2 つ目を押すと 2 つ目だけが変わる', () => {
    const body = '`#3b82f6` と `#3b82f6` と `#ef4444`\n';
    const two = pressable(body).filter((s) => s.nth === 1);
    expect(two, '2 つ目の見本が押せる形で出ていない').toHaveLength(1);
    expect(applyBodyRewrite(body, color(0, 1, '#3b82f6', '#00ff00'))).toBe(
      '`#3b82f6` と `#00ff00` と `#ef4444`\n',
    );
    // 対照群: 1 つ目を押せば 1 つ目だけ
    expect(applyBodyRewrite(body, color(0, 0, '#3b82f6', '#00ff00'))).toBe(
      '`#00ff00` と `#3b82f6` と `#ef4444`\n',
    );
  });

  it('🔴 囲み(```)の中の色コードは描かれず、書き換えも断る(描く側と書く側が揃う)', () => {
    const body = '```\n`#aaaaaa`\n```\n\n`#aaaaaa`\n';
    // 描かれる見本は外の 1 つだけ(囲みの中は inline code ではない)
    expect(pressable(body)).toEqual([{ line: 4, nth: 0, value: '#aaaaaa' }]);
    // 囲みの中の行を指す書き換えは断る(数えない)
    expect(applyBodyRewrite(body, color(1, 0, '#aaaaaa', '#000001'))).toBeNull();
    // 外の行は書き換わり、囲みの中は 1 バイトも動かない
    expect(applyBodyRewrite(body, color(4, 0, '#aaaaaa', '#000001'))).toBe(
      '```\n`#aaaaaa`\n```\n\n`#000001`\n',
    );
  });

  it('🔴 3 桁・大文字・8 桁は見本だけで、押せる形にならず、書き換えも断る', () => {
    const body = '`#fff` `#FFAA00` `#3b82f680` `#3b82f6`\n';
    expect(pressable(body), '押せるのは 6 桁小文字だけ').toEqual([
      { line: 0, nth: 3, value: '#3b82f6' },
    ]);
    // 番号は色コード全部の通し番号(押せない綴りも数える)
    expect(applyBodyRewrite(body, color(0, 0, '#fff', '#000001'))).toBeNull();
    expect(applyBodyRewrite(body, color(0, 1, '#FFAA00', '#000001'))).toBeNull();
    expect(applyBodyRewrite(body, color(0, 2, '#3b82f680', '#000001'))).toBeNull();
    expect(applyBodyRewrite(body, color(0, 3, '#3b82f6', '#000001'))).toBe(
      '`#fff` `#FFAA00` `#3b82f680` `#000001`\n',
    );
  });

  it('🔴 描く側と数え方が食い違う形(複数行にまたがるコード)は、押せる形にしない', () => {
    // 1 行目の `…` が 2 行目まで続く ── 1 行だけを走ると 2 行目の対が組み変わる
    const body = '長い `コード\n#3b82f6` の続き `#ef4444` です\n';
    const html = renderMarkdown(body, { colorSwatches: true });
    const host = document.createElement('div');
    host.innerHTML = html;
    // `#ef4444` は見本が出るが、数え方が食い違うので押せる形にはならない
    const ef = [...host.querySelectorAll('[data-pkc-color-swatch]')];
    expect(ef.length, '見本そのものは出る').toBe(1);
    expect(ef[0]!.getAttribute('data-pkc-action'), '食い違う形が押せる形になっている').toBeNull();
  });
});

describe('書き換えが断る形(#1224)', () => {
  const body = '一行目\n`#3b82f6` と `#ef4444`\n';
  it.each([
    ['行が無い', color(9, 0, '#3b82f6', '#000001')],
    ['番号の先が無い', color(1, 2, '#3b82f6', '#000001')],
    ['押した時点の字と違う(別の窓で書き換わっている)', color(1, 0, '#111111', '#000001')],
    ['書き込む色が 6 桁小文字でない', color(1, 0, '#3b82f6', '#FFF')],
  ])('null(断る): %s', (_n, rw) => {
    expect(applyBodyRewrite(body, rw)).toBeNull();
  });

  it('同じ色へ変えるなら、本文をそのまま返す(書かない・言わない)', () => {
    expect(applyBodyRewrite(body, color(1, 0, '#3b82f6', '#3b82f6'))).toBe(body);
  });
});

describe('書き換えは本文の他の所を 1 バイトも動かさない(#1224)', () => {
  it('🔴 改行コードが混ざっていても、他の行の改行はそのまま', () => {
    const body = 'a\r\n`#3b82f6`\nb\r\n`#ef4444`\r\n';
    const next = applyBodyRewrite(body, color(3, 0, '#ef4444', '#000001'));
    expect(next).toBe('a\r\n`#3b82f6`\nb\r\n`#000001`\r\n');
  });

  it('🔴 frontmatter の行を数えた原文の行番号で当たる(描く側が足したずれと同じ)', () => {
    const body = '---\ntags:\n  - 色\n---\n`#3b82f6`\n';
    const [sw] = pressable(body);
    expect(sw).toEqual({ line: 4, nth: 0, value: '#3b82f6' });
    expect(applyBodyRewrite(body, color(sw!.line, sw!.nth, sw!.value, '#000001'))).toBe(
      '---\ntags:\n  - 色\n---\n`#000001`\n',
    );
  });
});
