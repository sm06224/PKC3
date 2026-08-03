/** @vitest-environment happy-dom */
/**
 * P8 段⑩: **差分で当てる**(丸ごと作り直さない)。
 *
 * > user 指示 2026-08-03「**1 打鍵ではなく、3 秒周期で差分反映してください /
 * > 1 打鍵では、そんなことしたら、重たくなるし、レンダリングで画面がガクガクする**」
 *
 * 🔴 「ガクガク」は頻度ではなく**1 回の重さ**なので、観測点は
 * 「**触っていない要素が同じ実体のまま残るか**」に置く。
 * 「中身が正しいか」だけを見ると、丸ごと差し替えでも通ってしまう。
 */
import { describe, expect, it } from 'vitest';
import { applyBlocks, EMPTY_VIEW } from '../../src/adapter/ui/render/apply-blocks';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

function host(): HTMLElement {
  const el = document.createElement('div');
  document.body.append(el);
  return el;
}

const DOC = [
  '# 題',
  '',
  '最初の段落。',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '真ん中の段落。',
  '',
  '- 箇条 1',
  '- 箇条 2',
  '',
  '最後の段落。',
  '',
].join('\n');

const render = (md: string): string => renderMarkdown(md, { sourceLineAnchors: false });

describe('差分で当てる', () => {
  it('初回は丸ごと(基準が無い)', () => {
    const h = host();
    const r = applyBlocks(h, render(DOC), EMPTY_VIEW);
    expect(h.children.length).toBeGreaterThan(4);
    expect(r.inserted.length).toBe(h.children.length);
    expect(r.view.blocks.join('')).toBe(render(DOC));
  });

  it('🔴 変わっていなければ **DOM を 1 つも触らない**', () => {
    const h = host();
    const first = applyBlocks(h, render(DOC), EMPTY_VIEW);
    const before = [...h.children];
    const r = applyBlocks(h, render(DOC), first.view);
    expect(r.replaced, '変わっていないのに作り直した').toBe(0);
    expect(r.inserted).toEqual([]);
    // ⚠ **同じ実体**であること(innerHTML 比較では作り直しを見逃す)
    expect([...h.children]).toEqual(before);
  });

  it('🔴 1 段落を直したら、**その塊だけ**が新しくなる', () => {
    const h = host();
    const first = applyBlocks(h, render(DOC), EMPTY_VIEW);
    const before = [...h.children];
    const r = applyBlocks(h, render(DOC.replace('真ん中の段落。', '真ん中の段落。あ')), first.view);
    expect(r.replaced).toBeLessThanOrEqual(2);
    const after = [...h.children];
    // 触っていない要素は**同じ実体**のまま(= 図も scroll も生き残る)
    const same = after.filter((el) => before.includes(el)).length;
    expect(same, '触っていない要素まで作り直した').toBeGreaterThanOrEqual(before.length - 2);
    // 中身は正しい
    expect(h.innerHTML).toBe(render(DOC.replace('真ん中の段落。', '真ん中の段落。あ')));
  });

  it('🔴 当てた結果は**丸ごと描いたもの**と一致する(静かに欠けない)', () => {
    // ⚠ これが崩れると preview が「一部だけ消える」形で壊れる
    const h = host();
    let view = applyBlocks(h, render(DOC), EMPTY_VIEW).view;
    const edits = [
      DOC.replace('最初の段落。', '書き換えた。'),
      DOC.replace('- 箇条 2', '- 箇条 2\n- 箇条 3'),
      DOC.replace('| 1 | 2 |\n', ''),
      `${DOC}\n新しい段落。\n`,
      '# 全部消して\n\nこれだけ。\n',
      DOC,
    ];
    for (const md of edits) {
      const html = render(md);
      view = applyBlocks(h, html, view).view;
      expect(h.innerHTML, `編集後に食い違った: ${md.slice(0, 20)}`).toBe(html);
    }
  });

  it('末尾に足すと、前は全部そのまま', () => {
    const h = host();
    const first = applyBlocks(h, render(DOC), EMPTY_VIEW);
    const before = [...h.children];
    const r = applyBlocks(h, render(`${DOC}\n足した段落。\n`), first.view);
    expect(r.replaced).toBe(1);
    expect([...h.children].slice(0, before.length)).toEqual(before);
  });

  it('⚠ DOM が外から書き換わっていたら丸ごとに落ちる(図の hydrate 後など)', () => {
    const h = host();
    const first = applyBlocks(h, render(DOC), EMPTY_VIEW);
    h.children[0]!.remove(); // 外から 1 個消えた状態を作る
    const r = applyBlocks(h, render(DOC), first.view);
    expect(r.replaced).toBe(first.view.blocks.length);
    expect(h.innerHTML).toBe(render(DOC));
  });

  it('🔴 外から要素が**増えて**いても丸ごとに落ちる', () => {
    // ⚠ 「覚えたノードが全部繋がっている」だけでは足りない ── 余分な子が
    // 増えていると、位置がずれたまま差分を当てて**中身が食い違う**
    // (変異試験で、件数の照合を消しても緑だった)
    const h = host();
    const first = applyBlocks(h, render(DOC), EMPTY_VIEW);
    h.append(document.createElement('span')); // 外から 1 個増えた
    const r = applyBlocks(h, render(DOC), first.view);
    expect(r.replaced, '差分を当ててしまった').toBe(first.view.blocks.length);
    expect(h.innerHTML).toBe(render(DOC));
  });

  it('全部消しても壊れない', () => {
    const h = host();
    const first = applyBlocks(h, render(DOC), EMPTY_VIEW);
    const r = applyBlocks(h, '', first.view);
    expect(h.children.length).toBe(0);
    expect(r.view.blocks).toEqual([]);
  });
});
