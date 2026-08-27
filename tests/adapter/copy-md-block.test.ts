/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import {
  findMdBlockCopySource,
  stripTableChromeForCopy,
  extractMdBlockPlainText,
  handleCopyMdBlock,
} from '../../src/adapter/ui/actions/copy-md-block';
import * as clipboard from '../../src/adapter/platform/clipboard';

function el(html: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.firstElementChild as HTMLElement;
}

describe('findMdBlockCopySource', () => {
  it('csv 系はレンダリング面の slot 内 table を隠しソースより優先(#996 回帰の pin)', () => {
    const block = el(
      '<div class="pkc-md-block">' +
        '<div class="pkc-render-slot"><table><tr><td>x</td></tr></table></div>' +
        '<pre class="pkc-render-source"><code>x</code></pre>' +
        '</div>',
    );
    expect(findMdBlockCopySource(block)?.tagName.toLowerCase()).toBe('table');
  });

  it('ソース面トグル ON なら見えている隠しソースを選ぶ', () => {
    const block = el(
      '<div class="pkc-md-block">' +
        '<input type="checkbox" class="pkc-render-toggle-input" checked>' +
        '<div class="pkc-render-slot"><table><tr><td>x</td></tr></table></div>' +
        '<pre class="pkc-render-source"><code>raw</code></pre>' +
        '</div>',
    );
    expect(findMdBlockCopySource(block)?.className).toBe('pkc-render-source');
  });
});

describe('extractMdBlockPlainText / stripTableChromeForCopy', () => {
  it('table は TSV、セル内の tab / 改行は collapse', () => {
    const table = el(
      '<table><tr><th>a\tb</th><th>c</th></tr><tr><td>1\n2</td><td>3</td></tr></table>',
    );
    expect(extractMdBlockPlainText(table)).toBe('a b\tc\n1 2\t3');
  });

  /**
   * 🔴 **押せる表をコピーしても、口の印が混ざらない**(#418 段①)。
   *
   * ⚠ **本物の描画から作る** ── 手で組んだ fixture だと、
   *   「ボタンに字を入れない」という当の規律を検めていない
   *   (1 稿目は手で `＋` を入れて組んでいたので、何も守っていなかった)。
   */
  it('🔴 押せる表をコピーしても、行・列の口が混ざらない(#418 段①)', () => {
    const host = el(
      `<div>${renderMarkdown('```csv\n名前,数\nあ,1\n```', { interactiveCells: true })}</div>`,
    );
    const table = host.querySelector('table')!;
    // 空振り防止 ── 口が本当に出ている(出ていなければ何も守っていない)
    expect(table.querySelectorAll('.pkc-csv-shape').length, '口が出ていない').toBeGreaterThan(0);
    expect(extractMdBlockPlainText(stripTableChromeForCopy(table)), '口の印が混ざった').toBe(
      '名前\t数\nあ\t1',
    );
  });

  it('table chrome(行番号 / 並べ替え / 絞り込み)は clone から除去、表示 DOM は無傷', () => {
    const table = el(
      '<table><tr><th class="pkc-md-table-rownum">#</th><th>名前<button class="pkc-md-table-sort">↕</button></th></tr></table>',
    );
    const stripped = stripTableChromeForCopy(table);
    expect(stripped).not.toBe(table); // clone
    expect(extractMdBlockPlainText(stripped)).toBe('名前');
    expect(table.querySelector('.pkc-md-table-sort')).not.toBeNull(); // 原本は無傷
  });
});

describe('handleCopyMdBlock', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('コピー成功でボタンに flash 属性、内容は plain(TSV)+ html の対', async () => {
    const spy = vi
      .spyOn(clipboard, 'copyMarkdownAndHtml')
      .mockResolvedValue(true);
    const block = el(
      '<div class="pkc-md-block">' +
        '<button data-pkc-action="copy-md-block">⧉</button>' +
        '<pre><code>const x = 1;</code></pre>' +
        '</div>',
    );
    document.body.append(block);
    const btn = block.querySelector('button')!;
    handleCopyMdBlock(btn);
    await new Promise((r) => setTimeout(r, 0));
    expect(spy).toHaveBeenCalledWith('const x = 1;', expect.stringContaining('<pre>'));
    expect(btn.getAttribute('data-pkc-flash')).toBe('true');
    block.remove();
  });

  it('コピー失敗では flash を出さない', async () => {
    vi.spyOn(clipboard, 'copyMarkdownAndHtml').mockResolvedValue(false);
    const block = el(
      '<div class="pkc-md-block"><button data-pkc-action="copy-md-block">⧉</button><pre>x</pre></div>',
    );
    document.body.append(block);
    const btn = block.querySelector('button')!;
    handleCopyMdBlock(btn);
    await new Promise((r) => setTimeout(r, 0));
    expect(btn.hasAttribute('data-pkc-flash')).toBe(false);
    block.remove();
  });
});
