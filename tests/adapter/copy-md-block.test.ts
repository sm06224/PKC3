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
  sink: {
    name?: string;
    blob?: Blob;
    asked?: readonly { id: string; label: string }[];
    /** 🔑 **言った字を全部採る** ── 「無言だった」を見分けるのに要る。 */
    said?: string[];
  } = {},
): CopyMdBlockDeps {
  sink.said ??= [];
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
    fail: (m) => sink.said?.push(`fail:${m}`),
    saved: (m) => sink.said?.push(`saved:${m}`),
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

  /**
   * 🔴 **⧉ で表をコピーすると、押せないボタンが一緒に貼られた**(#735)。
   *
   * ⚠ 落とす一覧が **PKC2 由来の 4 つ**(並べ替え / 絞り込みの飾り)だけで、
   *   #418 が足した csv の**升をいじるボタン**を 1 つも落としていなかった。
   * 🔑 いまは「操作子とは何か」を `clipboard-html.ts` の 1 か所から借りる(§7)。
   */
  it('🔴 csv の表を ⧉ でコピーしても、押せないボタンが混ざらない(#735)', () => {
    const host = el(
      `<div>${renderMarkdown('```csv\n名前,数\nあ,1\n```', { interactiveCells: true })}</div>`,
    );
    const table = host.querySelector('table')!;
    // 空振り防止 ── 口が本当に出ている
    expect(table.querySelectorAll('button').length, '口が出ていない(台が古い)').toBeGreaterThan(0);
    const clean = stripTableChromeForCopy(table);
    expect(clean.querySelectorAll('button').length, '押せないボタンが貼られる').toBe(0);
    expect(clean.querySelectorAll('td,th').length, '升まで消えた').toBe(
      table.querySelectorAll('td,th').length,
    );
    expect(clean.outerHTML, '内部の印が貼られる').not.toContain('data-pkc-');
    // ⚠ 画面の DOM は無傷(コピーしたら画面が変わった、を作らない)
    expect(table.querySelectorAll('button').length, '画面の表を壊した').toBeGreaterThan(0);
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

  /**
   * 🔴 **渡らなかったら理由を出す**(2026-09-05、動線レビュー 欠陥 2)。
   * ⚠ 直す前は「光らせないだけ」── user は「入ったが貼り先が悪い」と読んで
   *   **別の場所を探しに行く**(実際には何も入っていない)。
   */
  it('🔴 コピー失敗では flash を出さず、理由を言う', async () => {
    vi.spyOn(clipboard, 'copyMarkdownAndHtml').mockResolvedValue(false);
    const block = el(
      '<div class="pkc-md-block"><button data-pkc-action="copy-md-block">⧉</button><pre>x</pre></div>',
    );
    document.body.append(block);
    const btn = block.querySelector('button')!;
    const sink: { said?: string[] } = {};
    handleCopyMdBlock(btn, deps(null, sink));
    await flush();
    expect(btn.hasAttribute('data-pkc-flash')).toBe(false);
    expect(sink.said, '無言で終わった(⧉ の側)').toEqual(['fail:コピーできませんでした']);
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
  /**
   * 🔴 **読む側は潰さない**(2026-09-05、着地前レビュー A-1 で裏返した主張)。
   *
   * ⚠ 直す前はここで tab / 改行を空白 1 個へ潰しており、**その 1 か所の都合が
   *   3 形式ぜんぶに効いていた** ── `csv` の囲みは引用で囲めば升に改行を書けるのに、
   *   `.csv` で保存すると `1 2` に変わっていた(user のデータが静かに別物になる)。
   * 🔑 潰すのは**潰さないと壊れる形の側**(TSV / GFM の表)── `tests/features/table-copy.test.ts`
   *   がその 2 つを別々に見る。ここが見るのは「**読んだ字をそのまま返す**」だけ。
   * ⚠ 前後の空白は落とす(升の見た目の余白は data ではない)。
   */
  it('🔴 升は潰さずそのまま返す(前後の空白だけ落とす)', () => {
    const t = el('<table><tr><td>1\n2</td><td> a\tb </td></tr></table>');
    expect(readTableRows(t)).toEqual([{ cells: ['1\n2', 'a\tb'], head: false }]);
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
    const sink: { name?: string; blob?: Blob; said?: string[] } = {};
    const block = blockOf(CSV_FENCE);
    handleCopyMdBlock(menuBtn(block), deps('csv-file', sink));
    await flush();
    expect(sink.name, 'ノートの題名から名前を作っていない').toMatch(
      /^買い物メモ-\d{4}-\d{2}-\d{2}\.csv$/,
    );
    const text = await sink.blob!.text();
    expect(text.charCodeAt(0), 'BOM が無い(Excel で文字化けする)').toBe(0xfeff);
    expect(text.slice(1)).toBe('名前,メモ\na|b,"x,y"');
    /**
     * 🔴 **保存は字で言う。光らせない**(2026-09-05、動線レビュー 欠陥 7)。
     * ⚠ 光る合図は「**コピーが渡った**」の意味でこの製品に統一されているので、
     *   保存に使い回すと**どちらが起きたか読めない**。しかも ▾ は普段は
     *   見えない(触れたときだけ出る)ので、光っても気づけない。
     */
    expect(sink.said, '保存したのに何も言っていない').toEqual([
      `saved:${sink.name} を保存しました`,
    ]);
  });

  /**
   * 🔴 **題名の無いノートでも、読める名前で落とす**(2026-09-05、着地前レビュー M3)。
   * ⚠ 直す前はこの枝を 1 度も通っておらず、逃がし(「表」)を消しても緑だった ──
   *   消すと `pkc3-2026-09-05.csv` になり、**何の表か名前から読めなくなる**。
   */
  it('🔴 題名が空でも「表」で落とす(名前が pkc3 にならない)', async () => {
    const sink: { name?: string; blob?: Blob; said?: string[] } = {};
    const block = blockOf(CSV_FENCE);
    const base = deps('csv-file', sink);
    handleCopyMdBlock(menuBtn(block), { ...base, noteTitle: () => '' });
    await flush();
    expect(sink.name, '題名が空のとき、user に読めない名前になっている').toMatch(
      /^表-\d{4}-\d{2}-\d{2}\.csv$/,
    );
  });

  it('🔴 保存では光らない(光る合図はコピーの意味)', async () => {
    const sink: { name?: string; blob?: Blob; said?: string[] } = {};
    const block = blockOf(CSV_FENCE);
    const btn = menuBtn(block);
    handleCopyMdBlock(btn, deps('csv-file', sink));
    await flush();
    expect(btn.hasAttribute('data-pkc-flash'), '保存なのにコピーの合図が出た').toBe(false);
  });

  /**
   * 🔴 **選んだのに渡らなかったら、▾ の側でも理由を出す**(欠陥 2)。
   * ⚠ 3 手かけて選んだ後の無反応は、⧉ の 1 押しより質が悪い。
   */
  it('🔴 形を選んで渡らなかったら、理由を言う', async () => {
    vi.spyOn(clipboard, 'copyPlainText').mockResolvedValue(false);
    const sink: { said?: string[] } = {};
    const block = blockOf(MD_TABLE);
    const btn = menuBtn(block);
    handleCopyMdBlock(btn, deps('csv', sink));
    await flush();
    expect(btn.hasAttribute('data-pkc-flash')).toBe(false);
    expect(sink.said).toEqual(['fail:コピーできませんでした']);
  });

  /**
   * 🔴 **選んでいる間に面が組み直された回も、黙って終わらない**(欠陥 2 の 3 本目の道)。
   * 🔑 台は「選び終えた瞬間に表を抜く」形にする ── `findMdBlockTable` が `null` を返す。
   */
  it('🔴 選んでいる間に表が消えたら、理由を言う', async () => {
    const sink: { said?: string[] } = {};
    const block = blockOf(MD_TABLE);
    const btn = menuBtn(block);
    const base = deps('csv', sink);
    handleCopyMdBlock(btn, {
      ...base,
      pick: async (choices) => {
        const id = await base.pick(choices);
        for (const t of block.querySelectorAll('table')) t.remove();
        return id;
      },
    });
    await flush();
    expect(sink.said, '表が消えたのに無言で終わった').toEqual(['fail:コピーできませんでした']);
  });

  it('やめたら何も入らず、合図も出さない', async () => {
    const spy = vi.spyOn(clipboard, 'copyMarkdownAndHtml').mockResolvedValue(true);
    const plain = vi.spyOn(clipboard, 'copyPlainText').mockResolvedValue(true);
    const block = blockOf(MD_TABLE);
    const btn = menuBtn(block);
    const sink: { said?: string[] } = {};
    handleCopyMdBlock(btn, deps(null, sink));
    await flush();
    expect(spy).not.toHaveBeenCalled();
    expect(plain).not.toHaveBeenCalled();
    expect(btn.hasAttribute('data-pkc-flash'), 'コピーしていないのに光った').toBe(false);
    // ⚠ **「やめた」は断らない** ── user が自分で閉じたので、伝えることは無い
    expect(sink.said, 'やめただけなのに何か言っている').toEqual([]);
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
