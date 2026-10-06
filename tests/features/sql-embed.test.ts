/** @vitest-environment happy-dom */
/**
 * 🔴 **本文に SQL の答えを埋め込む ── 綴り・器・書き出しの焼き込み**(#1223)。
 *
 * 守る主張:
 * 1. ` ```sql embed ` だけが器を置く(`sql` だけ / `sql:embed` / 語順違いは**置かない**)
 * 2. 器を置いても、**コード枠は素の ` ```sql ` と 1 バイトも違わない**(差は末尾の 1 要素)
 * 3. 器を置かない面(クリップボード)でも、**原文の SQL はコード枠として残る**
 * 4. 書き出した HTML には**その時点の答えが表で焼かれ**、原文も残る
 * 5. `sql` を fence の登録(`RENDERABLE_FENCE_LANGS`)へ足していない
 *
 * ⚠ 期待値は実 DOM / 実原文から読む(字を手で書き写さない)。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  RENDERABLE_FENCE_LANGS,
  renderFenceFromAsset,
  renderMarkdown,
} from '../../src/features/markdown/markdown-render';
import {
  bakeSqlEmbeds,
  isSqlEmbedInfo,
  SQL_EMBED_ATTR,
  SQL_EMBED_FETCH_ROWS,
  SQL_EMBED_MAX_MS,
  SQL_EMBED_MAX_STEPS,
  SQL_EMBED_MORE_FIELD,
  SQL_EMBED_PAGE_ROWS,
  SQL_EMBED_SRC_ATTR,
  sqlEmbedAnswerHtml,
  sqlEmbedHostHtml,
  type SqlEmbedAnswer,
} from '../../src/features/markdown/sql-embed';
import { cleanForClipboard } from '../../src/features/export/clipboard-html';

const fence = (info: string, sql: string): string => '```' + info + '\n' + sql + '\n```\n';

/** 器の HTML(描いた物からこの綴りで引く ── 手で書き写さない)。 */
const hostsOf = (html: string): HTMLElement[] => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return [...d.querySelectorAll<HTMLElement>(`[${SQL_EMBED_ATTR}]`)];
};

describe('綴りの判定(isSqlEmbedInfo)', () => {
  it.each([
    ['sql embed', true],
    ['SQL Embed', true],
    ['sql  embed', true],
    ['sql\tembed', true],
    ['  sql embed  ', true],
    ['sql embed limit=5', true],
    ['sql', false],
    ['sql:embed', false],
    ['sql-embed', false],
    ['embed sql', false],
    ['sqlembed', false],
    ['sql embedded', false],
    ['sql-render embed', false],
    ['csv embed', false],
    ['', false],
  ])('%j → %s', (info, want) => {
    expect(isSqlEmbedInfo(info), info).toBe(want);
  });
  it('null / undefined は偽', () => {
    expect(isSqlEmbedInfo(null)).toBe(false);
    expect(isSqlEmbedInfo(undefined)).toBe(false);
  });
});

describe('描く側(renderMarkdown)', () => {
  it('🔴 ` ```sql embed ` は器を 1 つ置き、原文の SQL を属性に持つ', () => {
    const sql = "SELECT '<a>' AS x, \"q\" & 1";
    const html = renderMarkdown(fence('sql embed', sql));
    const hosts = hostsOf(html);
    expect(hosts).toHaveLength(1);
    // ⚠ 属性から読み戻した字が原文そのもの(エスケープの往復が壊れていない)
    expect(hosts[0]!.getAttribute(SQL_EMBED_SRC_ATTR)).toBe(sql + '\n');
    expect(hosts[0]!.childElementCount, '描く側が答えを入れている').toBe(0);
  });

  it('🔴 素の ` ```sql ` は 1 バイトも変わらない(器が無く、色づけだけ)', () => {
    const html = renderMarkdown(fence('sql', 'SELECT 1'));
    expect(html).not.toContain(SQL_EMBED_ATTR);
    expect(html).toContain('<pre><code class="language-sql">');
    expect(html).toContain('pkc-tok-keyword');
  });

  it('🔴 器を取り除けば、` ```sql ` の出力と**完全に一致する**(枠は同じ)', () => {
    const sql = 'SELECT 1';
    const plain = renderMarkdown(fence('sql', sql));
    const embedded = renderMarkdown(fence('sql embed', sql));
    expect(embedded).not.toBe(plain);
    expect(embedded.replace(sqlEmbedHostHtml(sql + '\n'), '')).toBe(plain);
  });

  it.each(['sql:embed', 'sql-embed', 'embed sql', 'sql-render embed', 'sql-norender embed', 'sqlite embed'])(
    '🔴 見出し %j は器を置かない',
    (info) => {
      expect(renderMarkdown(fence(info, 'SELECT 1'))).not.toContain(SQL_EMBED_ATTR);
    },
  );

  it('大小・空白の揺れ(`SQL EMBED` / `sql   embed`)でも置く', () => {
    expect(hostsOf(renderMarkdown(fence('SQL EMBED', 'SELECT 1')))).toHaveLength(1);
    expect(hostsOf(renderMarkdown(fence('sql   embed', 'SELECT 1')))).toHaveLength(1);
  });

  it('同じ本文に 2 つ書けば器も 2 つ(それぞれの SQL を持つ)', () => {
    const html = renderMarkdown(fence('sql embed', 'SELECT 1') + '\n' + fence('sql embed', 'SELECT 2'));
    expect(hostsOf(html).map((h) => h.getAttribute(SQL_EMBED_SRC_ATTR))).toEqual([
      'SELECT 1\n',
      'SELECT 2\n',
    ]);
  });

  it('同じ本文の描き直しは同じ HTML(差分反映が塊を作り直さない)', () => {
    const body = fence('sql embed', 'SELECT 1');
    expect(renderMarkdown(body)).toBe(renderMarkdown(body));
  });

  it('🔴 `sql` を fence の登録へ足していない(足すと `sql-render` 等まで受けてしまう)', () => {
    expect(RENDERABLE_FENCE_LANGS.has('sql')).toBe(false);
  });

  it('🔴 添付から取った字は器を置かない(読み直す経路が別 ── 空の器を残さない)', () => {
    // 添付の中身を字として描く経路(`renderFenceFromAsset`)
    expect(renderFenceFromAsset('sql embed', 'SELECT 1')).not.toContain(SQL_EMBED_ATTR);
    // 本文の囲みが `asset:` を指すとき、器は在る(`fenceAssets` を渡した書き出し)が…
    const withAsset = renderMarkdown(fence('sql embed asset:ast-1', ''), {
      fenceAssets: { 'ast-1': 'SELECT 1' },
    });
    expect(withAsset).not.toContain(SQL_EMBED_ATTR);
  });

  it('csv の囲み(対照群)は今までどおり表になる', () => {
    const html = renderMarkdown(fence('csv name=t', 'a,b\n1,2'));
    expect(html).toContain('<table');
    expect(html).not.toContain(SQL_EMBED_ATTR);
  });
});

describe('クリップボード ── 答えは貼らず、原文のコード枠は残る', () => {
  it('🔴 画面で答えが入った器は、貼る HTML から落ちる(コード枠は残る)', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown(fence('sql embed', 'SELECT 1'));
    const host = root.querySelector<HTMLElement>(`[${SQL_EMBED_ATTR}]`)!;
    host.innerHTML = '<table><tbody><tr><td>ANSWER</td></tr></tbody></table>';
    const { html, removed } = cleanForClipboard(root);
    expect(html, '答えが貼り先へ漏れた').not.toContain('ANSWER');
    expect(html, '原文の SQL が消えた').toContain('language-sql');
    expect(html).toContain('SELECT');
    expect(removed).toBeGreaterThan(0);
  });
});

describe('答えの表(sqlEmbedAnswerHtml)', () => {
  const answer = (n: number, truncated = false): SqlEmbedAnswer => ({
    columns: ['a', 'b'],
    rows: Array.from({ length: n }, (_, i) => [i, `v${String(i)}`]),
    truncated,
  });
  const parse = (h: string): HTMLElement => {
    const d = document.createElement('div');
    d.innerHTML = h;
    return d;
  };

  it('列見出しと行を出し、null は「(なし)」(空文字と見分けられる)', () => {
    const d = parse(
      sqlEmbedAnswerHtml({ columns: ['x'], rows: [[null], [''], [3]], truncated: false }, 200, true),
    );
    expect([...d.querySelectorAll('th')].map((e) => e.textContent)).toEqual(['x']);
    expect([...d.querySelectorAll('td')].map((e) => e.textContent)).toEqual(['(なし)', '', '3']);
  });

  it('🔴 中身は全部エスケープする(答えの字が HTML として読まれない)', () => {
    const d = parse(
      sqlEmbedAnswerHtml(
        { columns: ['<img src=x onerror=1>'], rows: [['<b>&"x']], truncated: false },
        200,
        true,
      ),
    );
    expect(d.querySelector('img, b')).toBeNull();
    expect(d.querySelector('td')!.textContent).toBe('<b>&"x');
    expect(d.querySelector('th')!.textContent).toBe('<img src=x onerror=1>');
  });

  it('上限の数(別建て。測って決める初期値)', () => {
    expect(SQL_EMBED_PAGE_ROWS).toBe(200);
    expect(SQL_EMBED_MAX_MS).toBe(2000);
    expect(SQL_EMBED_MAX_STEPS).toBe(20_000);
    expect(SQL_EMBED_FETCH_ROWS).toBeGreaterThan(SQL_EMBED_PAGE_ROWS);
  });

  it('200 行ちょうどなら「さらに」は出ない / 201 行なら「さらに 1 行」', () => {
    const exact = parse(sqlEmbedAnswerHtml(answer(200), SQL_EMBED_PAGE_ROWS, true));
    expect(exact.querySelectorAll('tbody tr')).toHaveLength(200);
    expect(exact.querySelector(`[data-pkc-field="${SQL_EMBED_MORE_FIELD}"]`)).toBeNull();
    const over = parse(sqlEmbedAnswerHtml(answer(201), SQL_EMBED_PAGE_ROWS, true));
    expect(over.querySelectorAll('tbody tr')).toHaveLength(200);
    expect(over.querySelector(`[data-pkc-field="${SQL_EMBED_MORE_FIELD}"]`)!.textContent).toBe(
      'さらに 1 行',
    );
  });

  it('「さらに」の数は 1 回に出る行数(残りが 200 を超えても 200)', () => {
    const d = parse(sqlEmbedAnswerHtml(answer(700), SQL_EMBED_PAGE_ROWS, true));
    expect(d.querySelector(`[data-pkc-field="${SQL_EMBED_MORE_FIELD}"]`)!.textContent).toBe(
      'さらに 200 行',
    );
  });

  it('書き出し用(押せない)は、ボタンではなく字の注記で残りを言う', () => {
    const d = parse(sqlEmbedAnswerHtml(answer(250), SQL_EMBED_PAGE_ROWS, false));
    expect(d.querySelector('button')).toBeNull();
    expect(d.textContent).toContain('ほかに 50 行あります');
  });

  it('受け取る天井で切ったときは、そう言う(「これで全部」と読ませない)', () => {
    const d = parse(sqlEmbedAnswerHtml(answer(5, true), 200, true));
    expect(d.textContent).toContain('先頭の 5 行までです');
  });

  it('0 行は表ではなく 1 行の注記', () => {
    const d = parse(sqlEmbedAnswerHtml(answer(0), 200, true));
    expect(d.querySelector('table')).toBeNull();
    expect(d.textContent).toContain('該当する行はありません');
  });
});

describe('書き出しの焼き込み(bakeSqlEmbeds)', () => {
  const ans: SqlEmbedAnswer = { columns: ['n'], rows: [[1], [2]], truncated: false };

  it('🔴 答えを表にして器へ入れ、原文のコード枠も残る', async () => {
    const html = renderMarkdown(fence('sql embed', 'SELECT n FROM t'));
    const ask = vi.fn(async () => ans);
    const out = await bakeSqlEmbeds(html, ask);
    const d = document.createElement('div');
    d.innerHTML = out;
    expect(d.querySelectorAll(`[${SQL_EMBED_ATTR}] table tbody tr`)).toHaveLength(2);
    expect(d.querySelector('pre code.language-sql')!.textContent).toContain('SELECT n FROM t');
    // 引いた字は**描かれた SQL そのもの**(末尾の改行まで)
    expect(ask).toHaveBeenCalledWith('SELECT n FROM t\n');
  });

  it('🔴 器が 0 個なら 1 度も引かず、HTML は 1 バイトも変わらない', async () => {
    const html = renderMarkdown('ふつうの本文\n\n' + fence('sql', 'SELECT 1'));
    const ask = vi.fn(async () => ans);
    expect(await bakeSqlEmbeds(html, ask)).toBe(html);
    expect(ask).not.toHaveBeenCalled();
  });

  it('同じ SQL は 1 回しか引かない(2 つの器に同じ答え)', async () => {
    const html = renderMarkdown(
      fence('sql embed', 'SELECT 1') + '\n' + fence('sql embed', 'SELECT 1') + '\n' + fence('sql embed', 'SELECT 2'),
    );
    const ask = vi.fn(async () => ans);
    const out = await bakeSqlEmbeds(html, ask);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(out.match(/<table/g)).toHaveLength(3);
  });

  it('🔴 引けなかったら 1 行の注記(原文は残り、他の SQL は続ける)', async () => {
    const html = renderMarkdown(
      fence('sql embed', 'SELECT bad') + '\n' + fence('sql embed', 'SELECT 1'),
    );
    const ask = vi.fn(async (sql: string) => {
      if (sql.includes('bad')) throw new Error('no such column: bad');
      return ans;
    });
    const out = await bakeSqlEmbeds(html, ask);
    const d = document.createElement('div');
    d.innerHTML = out;
    const hosts = [...d.querySelectorAll<HTMLElement>(`[${SQL_EMBED_ATTR}]`)];
    expect(hosts[0]!.textContent).toContain('答えを実行できませんでした: no such column: bad');
    expect(hosts[0]!.querySelector('table')).toBeNull();
    expect(hosts[1]!.querySelector('table')).not.toBeNull();
    expect(d.querySelectorAll('pre code.language-sql')).toHaveLength(2);
  });

  it('焼いた物をもう一度焼かない(冪等)', async () => {
    const html = renderMarkdown(fence('sql embed', 'SELECT 1'));
    const ask = vi.fn(async () => ans);
    const once = await bakeSqlEmbeds(html, ask);
    ask.mockClear();
    expect(await bakeSqlEmbeds(once, ask)).toBe(once);
    expect(ask).not.toHaveBeenCalled();
  });

  it('🔴 引いて並べるのは直列(同時に 2 件走らせない)', async () => {
    const html = renderMarkdown(
      fence('sql embed', 'SELECT 1') + '\n' + fence('sql embed', 'SELECT 2'),
    );
    let running = 0;
    let peak = 0;
    const ask = async (): Promise<SqlEmbedAnswer> => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      running -= 1;
      return ans;
    };
    await bakeSqlEmbeds(html, ask);
    expect(peak).toBe(1);
  });
});
