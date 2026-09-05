/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import {
  findMdBlockCopySource,
  findMdBlockTable,
  readTableRows,
  stripTableChromeForCopy,
  extractMdBlockPlainText,
  handleCopyMdBlock,
  type CopyMdBlockDeps,
} from '../../src/adapter/ui/actions/copy-md-block';
import * as clipboard from '../../src/adapter/platform/clipboard';

function el(html: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.firstElementChild as HTMLElement;
}

/**
 * 形を選ぶ器の代わり。⚠ **本物と同じ返し方**にする(選ばなければ `null`)──
 * 甘い stub を置くと、「やめた」経路が誰にも守られない(CLAUDE.md §3)。
 */
function deps(
  pick: string | null,
  sink: { name?: string; blob?: Blob; asked?: readonly { id: string; label: string }[] } = {},
): CopyMdBlockDeps {
  return {
    pick: (choices) => {
      sink.asked = choices.map((c) => ({ id: c.id, label: c.label }));
      return Promise.resolve(pick);
    },
    download: (name, blob) => {
      sink.name = name;
      sink.blob = blob;
    },
    noteTitle: () => '買い物メモ',
  };
}

/** 既定(⧉ を 1 押し)の呼び方。⚠ 形を選ぶ口は使わない。 */
const NO_PICK: CopyMdBlockDeps = deps(null);

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

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
    handleCopyMdBlock(btn, NO_PICK);
    await flush();
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
    handleCopyMdBlock(btn, NO_PICK);
    await flush();
    expect(btn.hasAttribute('data-pkc-flash')).toBe(false);
    block.remove();
  });
});

/**
 * 🔴 **表を持ち出す形を選ぶ**(#708 段①)。
 *
 * 🔑 **本物の描画から作る** ── 手で組んだ表だと「markdown の表と csv の表に
 *   **同じ口**が出ている」という当の主張を 1 度も検めていない(CLAUDE.md §7)。
 */
const MD_TABLE = '| 名前 | メモ |\n|---|---|\n| a\\|b | x,y |\n';
// ⚠ 原文は `"a|b"` と包んである ── 出す側は**包む必要のある升だけ**包むので、
//    持ち出した CSV は `a|b`(裸)に戻る。字面ではなく**升**が保たれるのが正しい。
const CSV_FENCE = '```csv\n名前,メモ\n"a|b","x,y"\n```\n';

/** 描いた本文から `.pkc-md-block` を 1 つ取り出す(本文の面と同じ姿)。 */
function blockOf(src: string): HTMLElement {
  const host = el(`<div>${renderMarkdown(src)}</div>`);
  document.body.append(host);
  return host.querySelector<HTMLElement>('.pkc-md-block')!;
}

const menuBtn = (block: HTMLElement): HTMLElement =>
  block.querySelector<HTMLElement>('[data-pkc-copy-menu]')!;
const plainBtn = (block: HTMLElement): HTMLElement =>
  block.querySelector<HTMLElement>('.pkc-md-copy-btn:not([data-pkc-copy-menu])')!;

describe('readTableRows', () => {
  it('升の中の tab / 改行は空白へ潰し、前後の空白は落とす', () => {
    const t = el('<table><tr><td>1\n2</td><td> a\tb </td></tr></table>');
    expect(readTableRows(t)).toEqual([{ cells: ['1 2', 'a b'], head: false }]);
  });

  it('見出しの行(`th` だけ)を見分ける', () => {
    const t = el('<table><tr><th>a</th></tr><tr><td>1</td></tr></table>');
    expect(readTableRows(t).map((r) => r.head)).toEqual([true, false]);
  });

  /**
   * 🔴 **入れ子の表の行を、外側の行としても数えない**(`html-to-markdown.ts` が
   * 実測で踏んだ罠)── 数えると同じ中身が 2 回入る。
   */
  it('🔴 入れ子の表の行を拾わない', () => {
    const t = el('<table><tr><td>外<table><tr><td>内</td></tr></table></td></tr></table>');
    expect(readTableRows(t)).toEqual([{ cells: ['外内'], head: false }]);
  });
});

describe('形を選ぶ口(▾)', () => {
  beforeEach(() => vi.restoreAllMocks());

  /**
   * 🔴 **markdown の表と csv の表に、同じ口が出ている**(#708 段① の当の主張)。
   * ⚠ 直す前は csv の囲みにしか形を選ぶ道が無かった。
   */
  it.each([
    ['markdown の表', MD_TABLE],
    ['csv の囲み', CSV_FENCE],
  ])('🔴 %s に ▾ が出て、押すと同じ一覧が出る', async (_name, src) => {
    const block = blockOf(src);
    const btn = menuBtn(block);
    expect(btn, '▾ が出ていない').not.toBeNull();
    const sink: { asked?: readonly { id: string; label: string }[] } = {};
    handleCopyMdBlock(btn, deps(null, sink));
    await flush();
    expect(
      sink.asked?.map((c) => c.id),
      '一覧が食い違っている',
    ).toEqual(['tsv', 'markdown', 'html', 'csv', 'csv-file']);
  });

  /** 図やコードの囲みには出さない ── 選べる形が無いので押せるだけの口になる。 */
  it('図・コードの囲みには ▾ を出さない', () => {
    for (const src of ['```ts\nconst x = 1;\n```\n', '```mermaid\ngraph TD; A-->B;\n```\n']) {
      const block = blockOf(src);
      expect(block.querySelector('[data-pkc-copy-menu]'), `${src} に ▾ が出た`).toBeNull();
    }
  });

  /**
   * 🔴 **⧉ の 1 押しは今までどおり**(TSV + HTML)。
   * ⚠ ここが崩れると、いちばん多い用事が 2 手に増える(動線を 1 つ減らす)。
   */
  it('🔴 ⧉ は 1 押しで今までどおり TSV + HTML が入る', async () => {
    const spy = vi.spyOn(clipboard, 'copyMarkdownAndHtml').mockResolvedValue(true);
    const block = blockOf(MD_TABLE);
    handleCopyMdBlock(plainBtn(block), NO_PICK);
    await flush();
    expect(spy).toHaveBeenCalledWith('名前\tメモ\na|b\tx,y', expect.stringContaining('<table'));
  });

  /**
   * 🔴 **markdown の表を選ぶと、貼り直しても升が 1 つも変わらない。**
   *
   * 🔑 期待値は**別の観測**から作る ── 入った字を**本物の描画器へ通し直し**、
   *   読んだ升を元と比べる(手で期待値を書くと、`|` の逃がし忘れを共有する)。
   */
  it('🔴 markdown の表: 貼り直して描くと、升が元どおり', async () => {
    let put = '';
    vi.spyOn(clipboard, 'copyPlainText').mockImplementation((t: string) => {
      put = t;
      return Promise.resolve(true);
    });
    const block = blockOf(MD_TABLE);
    const before = readTableRows(findMdBlockTable(block)!);
    handleCopyMdBlock(menuBtn(block), deps('markdown'));
    await flush();
    // 空振り防止 ── 何も入っていない字を「一致した」と読まない
    expect(put, 'クリップボードへ渡していない').not.toBe('');
    const again = blockOf(`${put}\n`);
    expect(readTableRows(findMdBlockTable(again)!), '貼り直すと升がずれる').toEqual(before);
  });

  it('CSV を選ぶと素の字で CSV が入る', async () => {
    let put = '';
    vi.spyOn(clipboard, 'copyPlainText').mockImplementation((t: string) => {
      put = t;
      return Promise.resolve(true);
    });
    const block = blockOf(CSV_FENCE);
    handleCopyMdBlock(menuBtn(block), deps('csv'));
    await flush();
    expect(put).toBe('名前,メモ\na|b,"x,y"');
  });

  it('HTML を選ぶと、素の字にも HTML が入る(貼り先が素なら原文が残る)', async () => {
    const spy = vi.spyOn(clipboard, 'copyMarkdownAndHtml').mockResolvedValue(true);
    const block = blockOf(MD_TABLE);
    handleCopyMdBlock(menuBtn(block), deps('html'));
    await flush();
    const [plain, html] = spy.mock.calls[0]!;
    expect(plain, '素の字が HTML になっていない').toMatch(/^<table/);
    expect(plain).toBe(html);
  });

  /**
   * 🔴 **`.csv` で保存**。⚠ BOM を付ける ── 無いと Windows の Excel が
   * 日本語の升を文字化けさせる(表計算で開くための file なのに開けない)。
   */
  it('🔴 .csv で保存: 題名から名前を作り、BOM 付きで渡す', async () => {
    const sink: { name?: string; blob?: Blob } = {};
    const block = blockOf(CSV_FENCE);
    handleCopyMdBlock(menuBtn(block), deps('csv-file', sink));
    await flush();
    expect(sink.name, 'ノートの題名から名前を作っていない').toMatch(
      /^買い物メモ-\d{4}-\d{2}-\d{2}\.csv$/,
    );
    const text = await sink.blob!.text();
    expect(text.charCodeAt(0), 'BOM が無い(Excel で文字化けする)').toBe(0xfeff);
    expect(text.slice(1)).toBe('名前,メモ\na|b,"x,y"');
  });

  it('やめたら何も入らず、合図も出さない', async () => {
    const spy = vi.spyOn(clipboard, 'copyMarkdownAndHtml').mockResolvedValue(true);
    const plain = vi.spyOn(clipboard, 'copyPlainText').mockResolvedValue(true);
    const block = blockOf(MD_TABLE);
    const btn = menuBtn(block);
    handleCopyMdBlock(btn, deps(null));
    await flush();
    expect(spy).not.toHaveBeenCalled();
    expect(plain).not.toHaveBeenCalled();
    expect(btn.hasAttribute('data-pkc-flash'), 'コピーしていないのに光った').toBe(false);
  });

  /**
   * 🔴 **原文を見ている間も ▾ は表を持ち出せる**(`‹/›` を押しただけで
   * 形を選ぶ道が消えると、押せるのに何も起きない口になる)。
   */
  it('🔴 ソース面へ切り替えていても、▾ は表から作る', async () => {
    let put = '';
    vi.spyOn(clipboard, 'copyPlainText').mockImplementation((t: string) => {
      put = t;
      return Promise.resolve(true);
    });
    const block = blockOf(CSV_FENCE);
    const toggle = block.querySelector<HTMLInputElement>('.pkc-render-toggle-input')!;
    toggle.checked = true;
    // 空振り防止 ── 切替が本当に効いている(⧉ 側は原文を拾う)
    expect(findMdBlockCopySource(block)?.tagName.toLowerCase(), '切替が効いていない').toBe('pre');
    handleCopyMdBlock(menuBtn(block), deps('csv'));
    await flush();
    expect(put, '原文を見ていると表を持ち出せない').toBe('名前,メモ\na|b,"x,y"');
  });
});
