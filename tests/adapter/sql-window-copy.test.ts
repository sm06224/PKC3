/** @vitest-environment happy-dom */
/**
 * 🔴 **「SQL で調べる」の結果の表のコピー 2 つ**(依頼 63-1。Gemini 裁定 2026-10-13 = 推薦どおり)。
 *
 * ⚠ 守る主張:
 *  ① 答えが出たら ⧉(表計算に貼る形)と「本文に貼る形でコピー」が出る。答えが無いうちは畳む
 *  ② ⧉ は**答えの全部の行**を TSV で渡す(窓で描くので、画面の表を読むと見えている行だけになる)
 *  ③ 「本文に貼る形でコピー」は `sql embed` の囲み(`sql-embed.ts` が読む綴り)。柵は SQL の中の ``` より長い
 *  ④ 取り込んだ file を調べているときは「本文に貼る形」を押せない(本文では `no such table` になる)
 *  ⑤ 貼り先に渡せなかったら「コピーできませんでした」(他のコピーと同じ字)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { setCopyRecorder } from '../../src/adapter/platform/clipboard';
import { sqlAnswerTsv, sqlEmbedFence } from '../../src/features/query/sql-to-note';
import { isSqlEmbedInfo } from '../../src/features/markdown/sql-embed';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

let root: HTMLElement;
const recorded: string[] = [];
let undo: (() => void) | null = null;

function setup(sql = 'SELECT title, n FROM entries'): { d: Dispatcher; pane: HTMLElement; said: string[] } {
  root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const center = new CenterRouter(root);
  d.onState((s) => center.render(s));
  const said: string[] = [];
  bindActions(root, d, { showStatus: (t: string) => said.push(t) });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  d.dispatch({ type: 'SET_VIEW_MODE', mode: 'sql' });
  d.dispatch({ type: 'SET_SQL_TEXT', sql });
  d.dispatch({ type: 'RUN_SQL' });
  const token = d.getState().sqlPage.runToken;
  d.dispatch({
    type: 'SET_SQL_RESULT',
    token,
    sql,
    columns: ['title', 'n'],
    rows: [
      ['会議\tメモ', 1],
      [null, 2],
      ['3 行目', 3],
    ],
    truncated: false,
    ms: 1,
  });
  return { d, pane: root.querySelector<HTMLElement>('[data-pkc-view-pane="sql"]')!, said };
}

const btn = (pane: HTMLElement, kind: string): HTMLButtonElement =>
  pane.querySelector<HTMLButtonElement>(`[data-pkc-action="sql-copy"][data-pkc-copy-kind="${kind}"]`)!;

beforeEach(() => {
  document.body.textContent = '';
  recorded.length = 0;
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: () => Promise.resolve() } });
  undo = setCopyRecorder((item) => recorded.push(item.text));
});
afterEach(() => {
  undo?.();
  vi.unstubAllGlobals();
});

describe('SQL の結果の表のコピー(依頼 63-1)', () => {
  it('🔴 答えが出たら 2 つの口が出る / 答えが無いうちは畳んでいる', () => {
    const { pane } = setup();
    const bar = pane.querySelector<HTMLElement>('[data-pkc-field="sql-copy-bar"]')!;
    expect(bar.hidden, '答えが出ているのにコピーの行が畳まれている').toBe(false);
    expect(btn(pane, 'table').textContent, '⧉ の字が本文の表と違う').toBe('⧉');
    expect(btn(pane, 'embed').textContent).toBe('本文に貼る形でコピー');
    // 対照群:答えが無い回
    document.body.textContent = '';
    root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const center = new CenterRouter(root);
    d.onState((s) => center.render(s));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    d.dispatch({ type: 'SET_VIEW_MODE', mode: 'sql' });
    const bar0 = root.querySelector<HTMLElement>('[data-pkc-field="sql-copy-bar"]')!;
    expect(bar0, '前提:コピーの行が器に無い').not.toBeNull();
    expect(bar0.hidden, '答えが無いのに押せる口が出ている').toBe(true);
  });

  it('🔴 ⧉ は答えの全部の行を TSV で渡す(tab は空白へ・値なしは「(なし)」)', async () => {
    const { pane } = setup();
    btn(pane, 'table').click();
    await vi.waitFor(() => expect(recorded).toHaveLength(1));
    expect(recorded[0]).toBe('title\tn\n会議 メモ\t1\n(なし)\t2\n3 行目\t3');
    expect(recorded[0]).toBe(
      sqlAnswerTsv(['title', 'n'], [['会議\tメモ', 1], [null, 2], ['3 行目', 3]]),
    );
  });

  it('🔴 「本文に貼る形でコピー」は sql embed の囲みで、本文の描画器がそのまま答えの器にする', async () => {
    const { pane } = setup('SELECT title FROM entries');
    btn(pane, 'embed').click();
    await vi.waitFor(() => expect(recorded).toHaveLength(1));
    expect(recorded[0]).toBe('```sql embed\nSELECT title FROM entries\n```\n');
    // 綴りが読み手(`sql-embed.ts`)と食い違うと、貼っても答えの器にならない
    expect(isSqlEmbedInfo('sql embed')).toBe(true);
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(recorded[0]!);
    expect(host.querySelector('[data-pkc-sql-embed]'), '貼った囲みが答えの器にならない').not.toBeNull();
  });

  it('🔴 SQL の中に ``` が在っても、囲みは閉じない(柵は中身より長い)', () => {
    const sql = "SELECT '```' AS x";
    const fence = sqlEmbedFence(sql);
    expect(fence.startsWith('````sql embed\n')).toBe(true);
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(fence);
    expect(host.querySelectorAll('[data-pkc-sql-embed]')).toHaveLength(1);
  });

  it('🔴 取り込んだ file を調べているときは「本文に貼る形」を押せない(⧉ は押せる)', () => {
    const { d, pane } = setup();
    expect(btn(pane, 'embed').disabled, '前提:この PKC を調べているのに押せない').toBe(false);
    // 取り込んだ file を調べる(= 本文の `sql embed` が引けない相手)
    d.dispatch({ type: 'SET_SQL_SOURCE', lid: 'db1', name: '売上.sqlite' });
    d.dispatch({ type: 'SQL_GUEST_OPENED', lid: 'db1', name: '売上.sqlite', tables: ['売上'], bytes: 10, truncated: false });
    expect(d.getState().sqlPage.guest?.name, '前提:相手を開けていない').toBe('売上.sqlite');
    expect(btn(pane, 'embed').disabled, '取り込んだ file の答えなのに本文に貼れる').toBe(true);
    expect(btn(pane, 'table').disabled).toBe(false);
  });

  it('🔴 貼り先に渡せなかったら「コピーできませんでした」と出る', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: () => Promise.reject(new Error('denied')) },
    });
    const { d, pane } = setup();
    btn(pane, 'table').click();
    await vi.waitFor(() => expect(d.getState().error ?? '').toContain('コピーできませんでした'));
  });
});
