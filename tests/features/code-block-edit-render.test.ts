/** @vitest-environment happy-dom */
/**
 * 🔴 **コード枠の ✎ ── 出す条件は描画の出力の属性で決める**(#1044 段3、§9)。
 *
 * 判定:`.pkc-md-block[data-pkc-md-block-kind="code"]` のうち
 * `data-pkc-render-lang` が無い、かつ `data-pkc-fence-asset-key` が無いもの**だけ**。
 * ⚠ 観測点は**実物の描画**(`renderMarkdown`)から採る ── 手で組んだ HTML では
 * 「その属性の組が実際に出る」という前提を検めていない。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

/** `interactiveCodeBlocks: true` で描いた、✎(`edit-code-block`)が付く枠の言語印。 */
function editableFenceLangs(body: string): string[] {
  const host = document.createElement('div');
  host.innerHTML = renderMarkdown(body, { interactiveCodeBlocks: true } as never);
  return [...host.querySelectorAll('[data-pkc-md-block-kind="code"]')]
    .filter((b) => b.querySelector('[data-pkc-action="edit-code-block"]') !== null)
    .map((b) => b.getAttribute('data-pkc-render-lang') ?? '(plain)');
}

const PLAIN = ['```js', 'const a = 1;', '```'].join('\n');
const MERMAID_BOTH = ['```mermaid', 'graph TD; A-->B;', '```'].join('\n');
const MERMAID_NORENDER = ['```mermaid-norender', 'graph TD; A-->B;', '```'].join('\n');
const CSV_OK = ['```csv', 'a,b', '1,2', '```'].join('\n');
// ⚠ `parseCsv` は「trim して空」のときだけ `null`(読み損ね)を返す ── 空の
//   csv 囲みで確実に再現する(`csv-table.ts` の `parseCsv` を見て確かめた)。
const CSV_BROKEN = ['```csv', '```'].join('\n');
const ASSET_PENDING = ['```csv asset:k1', '```'].join('\n');

describe('コード枠の ✎ を出す枠の判定(#1044 段3)', () => {
  it('🔴 普通のコード枠には出る', () => {
    expect(editableFenceLangs(PLAIN)).toEqual(['(plain)']);
  });

  it('🔴 `-norender`(原文のまま出す)には出る', () => {
    expect(editableFenceLangs(MERMAID_NORENDER)).toEqual(['(plain)']);
  });

  it('🔴 csv の読み損ね(parse 失敗)には出る', () => {
    expect(editableFenceLangs(CSV_BROKEN)).toEqual(['(plain)']);
  });

  it('🔴 図(mermaid、描画成功)には出ない(data-pkc-render-lang を持つ)', () => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(MERMAID_BOTH, { interactiveCodeBlocks: true } as never);
    const block = host.querySelector('[data-pkc-md-block-kind="code"]');
    expect(block?.getAttribute('data-pkc-render-lang'), '前提が崩れている(render-lang が無い)').toBe(
      'mermaid',
    );
    expect(block?.querySelector('[data-pkc-action="edit-code-block"]')).toBeNull();
  });

  it('🔴 表(csv、描画成功)には出ない', () => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(CSV_OK, { interactiveCodeBlocks: true } as never);
    const block = host.querySelector('[data-pkc-md-block-kind="code"]');
    expect(block?.getAttribute('data-pkc-render-lang')).toBe('csv');
    expect(block?.querySelector('[data-pkc-action="edit-code-block"]')).toBeNull();
  });

  it('🔴 添付から中身を取る枠(読み込み待ち)には出ない(data-pkc-fence-asset-key を持つ)', () => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(ASSET_PENDING, { interactiveCodeBlocks: true } as never);
    const block = host.querySelector('[data-pkc-fence-asset-key]');
    expect(block, '前提が崩れている(fence-asset-key が無い)').not.toBeNull();
    expect(block?.querySelector('[data-pkc-action="edit-code-block"]')).toBeNull();
  });

  it('🔴 閉じていない枠(末尾まで続く)には出ない(§9)', () => {
    const unterminated = ['```js', 'const a = 1;'].join('\n');
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(unterminated, { interactiveCodeBlocks: true } as never);
    // ⚠ markdown-it 自身が閉じていない fence を最後まで飲んで 1 塊にする ──
    //   ここでは「✎ が出ない」ことだけを見る(枠自体が描かれても構わない)。
    expect(host.querySelector('[data-pkc-action="edit-code-block"]')).toBeNull();
  });

  it('🔴 `interactiveCodeBlocks` を渡さない(既定)と、どの枠にも出ない', () => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(PLAIN, {});
    expect(host.querySelector('[data-pkc-action="edit-code-block"]')).toBeNull();
    // ⚠ ⧉ 自体は変わらず出る(✎ の有無だけが opt-in)
    expect(host.querySelector('[data-pkc-action="copy-md-block"]')).not.toBeNull();
  });

  it('🔴 書き出し・印刷は既定で渡さないので、goldens は 1 バイトも動かない(渡さない = 属性 0)', () => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(PLAIN, { interactiveCodeBlocks: false } as never);
    expect(host.innerHTML).not.toContain('edit-code-block');
  });

  it('🔴 CRLF 改行のノートでもコード枠の ✎ が出る(#1075, #1094)', () => {
    const crlfPlain = ['```js', 'const a = 1;', '```'].join('\r\n');
    expect(editableFenceLangs(crlfPlain)).toEqual(['(plain)']);
  });
});
