/** @vitest-environment happy-dom */
/**
 * 🔴 **既製の表(` ```embed `)── 作る口・鮮度・行から開く**(#1966 4-2。user 裁定 2026-11-17)。
 *
 * - 作る口(`createEmbedViewRunner`)は材料を集めて features の組み立てへ渡す(書込の後ろへ並んでから)
 * - 器は `sql embed` と同じ係(`SqlEmbedHydrator`)が面倒を見る ── 表の上に名前と「更新」
 * - 鮮度 = 「更新」ボタン + ほかのノートを保存したら止まってから 1 回作り直す(`markEmbedViewsStale`)
 * - ` ```sql embed ` は自動では作り直さない(対照群 ── #1223 Q2 = B のまま)
 * - 未完了の行を押すと、そのノートを開いて項目の字を塗る(「探す」と同じ帯)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import {
  EMBED_VIEW_HEAD_FIELD,
  EMBED_VIEW_REFRESH_FIELD,
  SQL_EMBED_ATTR,
} from '../../src/features/markdown/sql-embed';
import {
  EMBED_VIEW_STALE_MS,
  markEmbedViewsStale,
  resetEmbedViewStaleForTest,
  setEmbedViewRunner,
  setSqlEmbedRunner,
  SqlEmbedHydrator,
} from '../../src/adapter/ui/render/sql-embed-hydrate';
import { createEmbedViewRunner, type EmbedViewDeps } from '../../src/adapter/ui/render/embed-view-runner';
import { taskCardsOf } from '../../src/features/schedule/task-cards';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { buildShell } from '../../src/adapter/ui/render/shell';

function meta(lid: string, title: string, extra: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
    ...extra,
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('作る口(createEmbedViewRunner)', () => {
  // 2026-11-18 12:00 (UTC) ── 端末の暦日は test の TZ に依らず 11/18 か 11/19。期日は余裕を持たせる
  const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
  const metas = new Map<string, EntryMeta>([
    ['n1', meta('n1', '仕事', { updatedAt: '2026-11-17 10:00:00' })],
    ['old', meta('old', '昔', { updatedAt: '2026-01-01 00:00:00' })],
    ['arch', meta('arch', 'しまった', { archived: true, updatedAt: '2026-11-17 10:00:00' })],
    ['s1', meta('s1', '週次', { archetype: 'smart', entryOrder: 2 })],
    ['s0', meta('s0', '空', { archetype: 'smart', entryOrder: 3 })],
  ]);
  const deps = (over: Partial<EmbedViewDeps> = {}): EmbedViewDeps & { order: string[] } => {
    const order: string[] = [];
    return {
      order,
      settled: async () => {
        order.push('settled');
      },
      metas: () => metas,
      taskScan: async () => {
        order.push('taskScan');
        return {
          cards: [...taskCardsOf('n1', '- [ ] 過ぎた @2026-11-01\n- [x] 済み @2026-11-01\n'), ...taskCardsOf('arch', '- [ ] 隠れ @2026-11-01\n')],
          totalNotes: 2,
          scannedNotes: 2,
          truncated: false,
        };
      },
      getBody: async (lid) => (lid === 's1' ? '---\nsmart-tags: [仕事]\n---\n' : lid === 's0' ? '' : null),
      smartScan: async (lid) => {
        order.push(`smartScan:${lid}`);
        return { lids: ['n1', 'arch'], total: 2 };
      },
      weekStart: () => 0,
      now: () => NOW,
      ...over,
    };
  };

  it('🔴 open-tasks: 書込の後ろへ並んでから予定表と同じ走査を読む。済んだ物・アーカイブは出ない', async () => {
    const d = deps();
    const a = await createEmbedViewRunner(d)('open-tasks range=today');
    expect(d.order).toEqual(['settled', 'taskScan']);
    expect(a.rows.map((r) => r[1])).toEqual(['過ぎた']);
    expect(a.rows[0]![2]).toBe('仕事');
  });

  it('🔴 recent: worker を叩かずに主スレッドの一覧から', async () => {
    const d = deps();
    const a = await createEmbedViewRunner(d)('recent days=7');
    expect(d.order).toEqual(['settled']);
    expect(a.rows.map((r) => r[1])).toEqual(['仕事']);
  });

  it('🔴 smart: 題名でスマートフォルダを探し、その本文の条件で走査する', async () => {
    const d = deps();
    const a = await createEmbedViewRunner(d)('smart=週次');
    expect(d.order).toEqual(['settled', 'smartScan:s1']);
    expect(a.rows.map((r) => r[0])).toEqual(['仕事']);
  });

  it('⚠ 断りは字で返す(見つからない / 条件が無い / 古い版 / 打ち間違い)', async () => {
    const run = createEmbedViewRunner(deps());
    await expect(run('smart=無い')).rejects.toThrow('スマートフォルダ「無い」が見つかりません');
    await expect(run('smart=空')).rejects.toThrow('条件がありません');
    await expect(run('todo')).rejects.toThrow('「todo」という表はありません');
    await expect(createEmbedViewRunner(deps({ taskScan: undefined }))('open-tasks')).rejects.toThrow('再読み込みしてください');
  });
});

describe('器・鮮度', () => {
  let root: HTMLElement;
  const mount = (body: string): HTMLElement => {
    root = document.createElement('div');
    root.innerHTML = renderMarkdown(body);
    document.body.append(root);
    return root;
  };
  const host = (i = 0): HTMLElement => [...root.querySelectorAll<HTMLElement>(`[${SQL_EMBED_ATTR}]`)][i]!;

  beforeEach(() => {
    document.body.textContent = '';
    // ⚠ 観測器の無い環境 = 見えるのを待たずに引く(この test は鮮度だけを見る)
    vi.stubGlobal('IntersectionObserver', undefined);
  });
  afterEach(() => {
    setEmbedViewRunner(null);
    setSqlEmbedRunner(null);
    resetEmbedViewStaleForTest();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('🔴 表の上に名前と「更新」。押すとその表だけ作り直す', async () => {
    let n = 0;
    const calls: string[] = [];
    setEmbedViewRunner(async (text) => {
      calls.push(text);
      n += 1;
      return { columns: ['ノート'], rows: [[`版${String(n)}`]], truncated: false };
    });
    mount('```embed recent\n```\n');
    const h = new SqlEmbedHydrator();
    h.sync(root, 'body-1');
    await settle();
    expect(host().querySelector(`[data-pkc-field="${EMBED_VIEW_HEAD_FIELD}"]`)?.textContent).toContain('直近 7 日に更新したノート');
    expect(host().querySelector('tbody')?.textContent).toBe('版1');
    host().querySelector<HTMLButtonElement>(`[data-pkc-field="${EMBED_VIEW_REFRESH_FIELD}"]`)!.click();
    await settle();
    expect(calls).toEqual(['recent', 'recent']);
    expect(host().querySelector('tbody')?.textContent).toBe('版2');
  });

  it('🔴 ほかのノートを保存したら、止まってから 1 回だけ作り直す / sql embed は作り直さない(対照群)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const views: string[] = [];
    const sqls: string[] = [];
    setEmbedViewRunner(async (text) => {
      views.push(text);
      return { columns: ['n'], rows: [[views.length]], truncated: false };
    });
    setSqlEmbedRunner(async (sql) => {
      sqls.push(sql);
      return { columns: ['x'], rows: [[1]], truncated: false, ms: 0 };
    });
    mount('```embed recent\n```\n\n```sql embed\nSELECT 1\n```\n');
    const h = new SqlEmbedHydrator();
    h.sync(root, 'body-1');
    await settle();
    expect(views).toHaveLength(1);
    expect(sqls).toHaveLength(1);
    // 続けて 3 回書いても、止まってから 1 回
    markEmbedViewsStale();
    vi.advanceTimersByTime(EMBED_VIEW_STALE_MS - 10);
    markEmbedViewsStale();
    vi.advanceTimersByTime(EMBED_VIEW_STALE_MS - 10);
    markEmbedViewsStale();
    await settle();
    expect(views, '止まる前に作り直した').toHaveLength(1);
    vi.advanceTimersByTime(EMBED_VIEW_STALE_MS);
    await settle();
    expect(views, '止まった後に作り直していない').toHaveLength(2);
    expect(host(0).querySelector('tbody')?.textContent).toBe('2');
    expect(sqls, 'sql embed まで作り直した').toHaveLength(1);
  });

  it('⚠ 手放した面(別のノートへ移った)は作り直さない', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const views: string[] = [];
    setEmbedViewRunner(async (text) => {
      views.push(text);
      return { columns: ['n'], rows: [[1]], truncated: false };
    });
    mount('```embed recent\n```\n');
    const h = new SqlEmbedHydrator();
    h.sync(root, 'body-1');
    await settle();
    h.release();
    markEmbedViewsStale();
    vi.advanceTimersByTime(EMBED_VIEW_STALE_MS);
    await settle();
    expect(views).toHaveLength(1);
  });

  it('⚠ 作れなかったときも名前と「更新」を出し、表の言葉で断る(SQL の画面へ誘わない)', async () => {
    let fail = true;
    setEmbedViewRunner(async () => {
      if (fail) throw new Error('スマートフォルダ「A」が見つかりません(題名を確かめてください)');
      return { columns: ['ノート'], rows: [['ok']], truncated: false };
    });
    mount('```embed smart=A\n```\n');
    const h = new SqlEmbedHydrator();
    h.sync(root, 'body-1');
    await settle();
    expect(host().textContent).toContain('表を作れませんでした: スマートフォルダ「A」が見つかりません');
    expect(host().textContent).not.toContain('SQL');
    fail = false;
    host().querySelector<HTMLButtonElement>(`[data-pkc-field="${EMBED_VIEW_REFRESH_FIELD}"]`)!.click();
    await settle();
    expect(host().querySelector('tbody')?.textContent).toBe('ok');
  });

  it('⚠ 綴りの打ち間違いは作る口まで届かずに断る', async () => {
    const run = vi.fn();
    setEmbedViewRunner(run);
    mount('```embed todo\n```\n');
    new SqlEmbedHydrator().sync(root, 'body-1');
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(host().textContent).toContain('「todo」という表はありません');
  });
});

describe('行から開く', () => {
  it('🔴 未完了の項目を押すと、そのノートを開いて項目の字を塗る(「探す」と同じ帯)/ ノートの升は開くだけ', () => {
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    const d = new Dispatcher();
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', '仕事'), meta('n2', '別')], relations: [] });
    const press = (lid: string, find: string | null): void => {
      const a = document.createElement('a');
      a.setAttribute('href', `entry:${lid}`);
      a.setAttribute('data-pkc-action', 'navigate-entry-ref');
      a.setAttribute('data-pkc-entry-ref', `entry:${lid}`);
      if (find !== null) a.setAttribute('data-pkc-embed-find', find);
      root.append(a);
      a.click();
    };
    press('n1', '見積を送る');
    expect(d.getState().selectedLid).toBe('n1');
    expect(d.getState().searchJump).toMatchObject({ lid: 'n1', query: '見積を送る' });
    press('n2', null);
    expect(d.getState().selectedLid).toBe('n2');
    expect(d.getState().searchJump ?? null, 'ノートの升で塗りが残った / 付いた').toBeNull();
  });
});
