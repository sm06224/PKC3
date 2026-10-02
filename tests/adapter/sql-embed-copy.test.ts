/** @vitest-environment happy-dom */
/**
 * 🔴 **SQL の答えの表にも ⧉(コピー)が付く**(#1254 §3 改善 E。Gemini 裁定 = a)。
 *
 * > user の物語:本文の表は右上の ⧉ で表計算に貼れる。**SQL の答えの表だけ** ⧉ が無く、
 * > 範囲を選んで貼るしかなかった。
 *
 * ⚠ 守る主張:
 *  ① 答えの表に ⧉ が在る。**並べ替えの押し所は無い**(「さらに N 行」の追加行と食い違うため)。
 *     ▾(形を選ぶ口)も無い。対照群: 本文の表には ⧉・▾・並べ替えが全部在る
 *  ② コピーされるのは**いま画面に出ている行**(200 行まで → 「さらに」で 250 行)
 *  ③ コピーに ⧉ の字・「答えを引いています…」・「保存したときの答え」・「さらに N 行」が混ざらない
 *  ④ 書き出し(`bakeSqlEmbeds`)は ⧉ を持たない(押す相手が居ない)
 *
 * ⚠ 引く相手は runner の差し替え(判断を見る検査 ── 実 worker は `sql-embed-hydrate.test.ts`)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import {
  SQL_EMBED_ATTR,
  SQL_EMBED_MORE_FIELD,
  SQL_EMBED_NOTE_FIELD,
  SQL_EMBED_PAGE_ROWS,
  SQL_EMBED_SAVED_FIELD,
  SQL_EMBED_SAVED_TEXT,
  SQL_EMBED_PENDING_TEXT,
  bakeSqlEmbeds,
} from '../../src/features/markdown/sql-embed';
import {
  setSqlEmbedRunner,
  SqlEmbedHydrator,
  type SqlEmbedRunner,
} from '../../src/adapter/ui/render/sql-embed-hydrate';
import { applyTableSort } from '../../src/adapter/ui/render/table-sort';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { setCopyRecorder } from '../../src/adapter/platform/clipboard';
import type { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState } from '../../src/adapter/state/app-state';

const BODY =
  '| 名前 | 数 |\n| --- | --- |\n| 本文の表 | 1 |\n\n' + '```sql embed\nSELECT 名前, 数 FROM t\n```\n';

const answerRows = (n: number): Array<Array<string | number | null>> =>
  Array.from({ length: n }, (_, i) => [`行${String(i + 1)}`, i + 1]);

let root: HTMLElement;
const recorded: Array<{ text: string; html: string }> = [];
let undoRecorder: (() => void) | null = null;

function mount(body: string, rows: number, savedNote = false): { host: HTMLElement; hy: SqlEmbedHydrator } {
  root = document.createElement('div');
  root.className = 'pkc-md-rendered';
  root.innerHTML = renderMarkdown(body);
  document.body.append(root);
  const run: SqlEmbedRunner = () =>
    Promise.resolve({ columns: ['名前', '数'], rows: answerRows(rows), truncated: false, ms: 1 });
  setSqlEmbedRunner(run);
  const hy = new SqlEmbedHydrator();
  hy.sync(root, body, savedNote);
  return { host: root.querySelector<HTMLElement>(`[${SQL_EMBED_ATTR}]`)!, hy };
}

const ready = async (host: HTMLElement): Promise<void> => {
  await vi.waitFor(() => expect(host.getAttribute('data-pkc-sql-embed-state')).toBe('ready'));
};

const copyBtn = (scope: ParentNode): HTMLElement | null =>
  scope.querySelector<HTMLElement>('[data-pkc-action="copy-md-block"]:not([data-pkc-copy-menu])');

beforeEach(() => {
  document.body.textContent = '';
  recorded.length = 0;
  // 観測器の無い環境と同じ ── 見えるのを待たず引く(判断は別の test が見る)
  vi.stubGlobal('IntersectionObserver', undefined);
  // 貼り先は text/plain だけ書ける clipboard(`copyMarkdownAndHtml` は plain へ落ちる)
  vi.stubGlobal('navigator', {
    ...navigator,
    clipboard: { writeText: () => Promise.resolve() },
  });
  undoRecorder = setCopyRecorder((item) => {
    recorded.push({ text: item.text, html: item.html });
  });
});
afterEach(() => {
  undoRecorder?.();
  setSqlEmbedRunner(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('答えの表の ⧉(#1254 §3 改善 E)', () => {
  it('🔴 答えの表に ⧉ が在り、並べ替えと ▾ は無い(対照群: 本文の表には全部在る)', async () => {
    const { host } = mount(BODY, 3);
    await ready(host);
    applyTableSort(root); // 実際の描画の流れでも付かないこと(印が先に置いてある)
    // ⚠ 空振り防止 ── 表が描けている
    const answer = host.querySelector('table')!;
    expect(answer, '前提:答えの表が描けていない').not.toBeNull();
    const block = answer.closest('.pkc-md-block');
    expect(block, '答えの表が表の器に入っていない').not.toBeNull();
    expect(block!.getAttribute('data-pkc-md-block-kind')).toBe('table');
    expect(block!.contains(host.querySelector('thead')), '器が表を包んでいない').toBe(true);
    const btn = copyBtn(block!);
    expect(btn, '答えの表に ⧉ が無い').not.toBeNull();
    expect(btn!.getAttribute('data-pkc-copy-kind')).toBe('table');
    expect(btn!.textContent).toBe('⧉');
    // 並べ替えの押し所は無い
    expect(host.querySelectorAll('th[role="button"]'), '答えの表に並べ替えの押し所が付いた').toHaveLength(0);
    expect(host.querySelectorAll('.pkc-table-sort-icon')).toHaveLength(0);
    expect(host.querySelectorAll('[data-pkc-sort-direction]')).toHaveLength(0);
    // ▾(形を選ぶ口 = 本文を書き換える行を含む)も無い
    expect(host.querySelector('[data-pkc-copy-menu]'), '答えの表に ▾ が付いた').toBeNull();

    // ── 対照群 ── 本文の表には ⧉ も ▾ も並べ替えも在る
    const body = [...root.querySelectorAll<HTMLElement>('.pkc-md-block[data-pkc-md-block-kind="table"]')].find(
      (b) => !host.contains(b),
    )!;
    expect(body, '前提:本文の表が無い').toBeDefined();
    expect(copyBtn(body), '対照群:本文の表に ⧉ が無い').not.toBeNull();
    expect(body.querySelector('[data-pkc-copy-menu]'), '対照群:本文の表に ▾ が無い').not.toBeNull();
    expect(body.querySelectorAll('th[role="button"]').length, '対照群:本文の表に並べ替えが付かない').toBeGreaterThan(0);
  });

  it('🔴 ⧉ を押すと、いま画面に出ている行だけが貼れる(200 行まで → 「さらに」で全部)', async () => {
    const { host } = mount(BODY, 250);
    bindActions(root, { dispatch: vi.fn(), getState: () => initialState } as unknown as Dispatcher, {});
    await ready(host);
    expect(host.querySelectorAll('tbody tr'), '前提:200 行で切れていない').toHaveLength(SQL_EMBED_PAGE_ROWS);
    copyBtn(host)!.click();
    await vi.waitFor(() => expect(recorded).toHaveLength(1));
    const lines = recorded[0]!.text.split('\n');
    expect(lines[0], '見出しの行が貼れていない').toBe('名前\t数');
    expect(lines, '見出し 1 + 画面の 200 行').toHaveLength(1 + SQL_EMBED_PAGE_ROWS);
    expect(lines[lines.length - 1]).toBe(`行${String(SQL_EMBED_PAGE_ROWS)}\t${String(SQL_EMBED_PAGE_ROWS)}`);
    expect(recorded[0]!.text, '画面に出ていない行が貼れた').not.toContain(`行${String(SQL_EMBED_PAGE_ROWS + 1)}\t`);

    // 「さらに 50 行」を押すと、出た行ぶんだけ増える
    host.querySelector<HTMLElement>(`[data-pkc-field="${SQL_EMBED_MORE_FIELD}"]`)!.click();
    expect(host.querySelectorAll('tbody tr')).toHaveLength(250);
    copyBtn(host)!.click();
    await vi.waitFor(() => expect(recorded).toHaveLength(2));
    expect(recorded[1]!.text.split('\n')).toHaveLength(251);
  });

  it('🔴 貼れる字に ⧉・「答えを引いています…」・「保存したときの答え」・「さらに N 行」が混ざらない', async () => {
    const { host } = mount(BODY, 250, true);
    bindActions(root, { dispatch: vi.fn(), getState: () => initialState } as unknown as Dispatcher, {});
    // 引いている間は 1 行が出ている(混ざりうる物が実在することを先に見る)
    expect(host.textContent, '前提:引いている間の 1 行が出ていない').toContain(SQL_EMBED_PENDING_TEXT);
    await ready(host);
    // 前提:混ざりうる物が全部、器の中に在る
    expect(host.querySelector(`[data-pkc-field="${SQL_EMBED_SAVED_FIELD}"]`)?.textContent).toBe(SQL_EMBED_SAVED_TEXT);
    expect(host.querySelector(`[data-pkc-field="${SQL_EMBED_MORE_FIELD}"]`), '前提:さらに が無い').not.toBeNull();
    copyBtn(host)!.click();
    await vi.waitFor(() => expect(recorded).toHaveLength(1));
    for (const forbidden of ['⧉', SQL_EMBED_PENDING_TEXT, SQL_EMBED_SAVED_TEXT, 'さらに']) {
      expect(recorded[0]!.text, `貼れる字に「${forbidden}」が混ざった`).not.toContain(forbidden);
    }
    // 器の外の物は表の外に居る(注記・さらに は表の器に入っていない)
    const block = host.querySelector('.pkc-md-block')!;
    expect(block.querySelector(`[data-pkc-field="${SQL_EMBED_NOTE_FIELD}"]`)).toBeNull();
    expect(block.querySelector(`[data-pkc-field="${SQL_EMBED_MORE_FIELD}"]`)).toBeNull();
    expect(block.querySelector(`[data-pkc-field="${SQL_EMBED_SAVED_FIELD}"]`)).toBeNull();
  });

  it('⚠ 0 行の答え(「該当する行はありません」)には表が無いので ⧉ も出ない', async () => {
    const { host } = mount(BODY, 0);
    await ready(host);
    expect(host.querySelector('table')).toBeNull();
    expect(copyBtn(host), '表が無いのに ⧉ が出ている').toBeNull();
  });

  it('⚠ 書き出し(焼き込み)の答えは ⧉ を持たない', async () => {
    const baked = await bakeSqlEmbeds(
      renderMarkdown(BODY),
      () => Promise.resolve({ columns: ['名前', '数'], rows: answerRows(2), truncated: false }),
    );
    const doc = document.createElement('div');
    doc.innerHTML = baked;
    const host = doc.querySelector<HTMLElement>(`[${SQL_EMBED_ATTR}]`)!;
    expect(host.querySelector('table'), '前提:焼けていない').not.toBeNull();
    expect(host.querySelector('[data-pkc-action="copy-md-block"]'), '書き出しに押せない ⧉ が焼かれた').toBeNull();
  });
});
