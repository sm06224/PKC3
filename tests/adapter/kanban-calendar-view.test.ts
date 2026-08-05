/** @vitest-environment happy-dom */
/**
 * kanban / calendar view の end-to-end(P3-6):
 * binder(実クリック)→ dispatcher → CenterRouter → fake store。
 * 「state mutation → consumer 観測点」まで通す(PKC2 Testing 規約)。
 */
import { stubStamps } from '../helpers/store-stamps';
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { extractMeta } from '../../src/features/flavor';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { ViewMode } from '../../src/adapter/state/app-state';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'todo',
    createdAt: null,
    updatedAt: null,
    entryOrder: Number(lid.slice(1)) || 0,
    status: 'open',
    date: null,
    archived: false,
    ...over,
  };
}

/**
 * 🔒 かんばん / カレンダーは**封印中**(`features/sealed.ts`)なので、切替ボタンが
 * 画面に無い。導線ではなく直接 dispatch で見せる ── **封印は導線を畳んだだけで、
 * 描画も state も生きている**という事実を、この test 自身が示している。
 * 封印を解いたら、ここをボタンのクリックへ戻す。
 */
function showView(d: Dispatcher, mode: ViewMode): void {
  d.dispatch({ type: 'SET_VIEW_MODE', mode });
}

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function setup(metas: EntryMeta[], bodies: Record<string, string>) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const center = new CenterRouter(regions.detail, () => new Date(2026, 7, 15)); // 2026-08
  d.onState((s) => center.render(s));
  bindActions(root, d);
  const store = { ...bodies };
  const persisted: EntryUpsert[] = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => store[lid] ?? null,
    deleteEntry: async () => {},
    persistEntry: async (e) => {
      persisted.push(e);
      store[e.lid] = e.body;
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const qa = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
  return { root, d, persisted, q, qa, store };
}

describe('kanban view (P3-6)', () => {
  it('列振り分け → トグル実クリック → splice 書換が store に届き、カードが列を移る', async () => {
    const { d, q, qa, persisted, store } = setup(
      [
        meta('e1'),
        meta('e2', { status: 'done' }),
        meta('e3', { archived: true }),
        meta('e4', { archetype: 'text', status: null }),
      ],
      { e1: '---\nstatus: open\n---\n\n買い物メモ' },
    );
    showView(d, 'kanban');

    const colOpen = q('[data-pkc-kanban-status="open"] [data-pkc-region="kanban-cards"]')!;
    const colDone = q('[data-pkc-kanban-status="done"] [data-pkc-region="kanban-cards"]')!;
    expect([...colOpen.children].map((c) => c.getAttribute('data-pkc-entry'))).toEqual(['e1']);
    expect([...colDone.children].map((c) => c.getAttribute('data-pkc-entry'))).toEqual(['e2']);
    expect(qa('[data-pkc-entry="e3"]')).toHaveLength(0); // archived は出ない

    const doneCardBefore = q('[data-pkc-entry="e2"]');
    q<HTMLElement>('[data-pkc-entry="e1"] [data-pkc-action="toggle-todo"]')!.click();
    await tick(20);

    // 書込は splice 済み body + 抽出列(roundtrip pin: 列 = body 再抽出)
    expect(persisted).toHaveLength(1);
    const row = persisted[0]!;
    expect(row.body).toBe('---\nstatus: done\n---\n\n買い物メモ'); // 本文 byte 無傷
    expect({ status: row.status, date: row.date, archived: row.archived }).toEqual(
      extractMeta('todo', row.body),
    );
    expect(store['e1']).toBe(row.body);

    // ack でカードが done 列へ移り、既存カードは同一ノードのまま
    expect([...colOpen.children]).toHaveLength(0);
    expect([...colDone.children].map((c) => c.getAttribute('data-pkc-entry'))).toEqual([
      'e1',
      'e2',
    ]);
    expect(q('[data-pkc-entry="e2"]')).toBe(doneCardBefore);
    expect(d.getState().entryMetas.get('e1')?.status).toBe('done');
  });

  it('列間 move は O(1): 先頭トグルで後続カードが insertBefore されない(cursor 汚染 pin)', async () => {
    const metas = Array.from({ length: 8 }, (_, i) =>
      meta('e' + i, { status: 'open' }),
    );
    const { d, q } = setup(metas, {
      e0: '---\nstatus: open\n---\nx',
    });
    showView(d, 'kanban');
    const openHost = q('[data-pkc-kanban-status="open"] [data-pkc-region="kanban-cards"]')!;
    const doneHost = q('[data-pkc-kanban-status="done"] [data-pkc-region="kanban-cards"]')!;

    let moves = 0;
    for (const host of [openHost, doneHost]) {
      const original = host.insertBefore.bind(host);
      (host as { insertBefore: typeof host.insertBefore }).insertBefore = ((
        node: Node,
        ref: Node | null,
      ) => {
        moves++;
        return original(node, ref);
      }) as typeof host.insertBefore;
    }
    q<HTMLElement>('[data-pkc-entry="e0"] [data-pkc-action="toggle-todo"]')!.click();
    await tick(20);

    expect([...doneHost.children].map((c) => c.getAttribute('data-pkc-entry'))).toEqual([
      'e0',
    ]);
    expect([...openHost.children]).toHaveLength(7);
    // 移動カード 1 枚の done 列への挿入だけ ── 後続 7 枚は動かない
    // (review #1: 修正前は移動元列の cursor 汚染で後続全カードが move した)
    expect(moves).toBe(1);
    // 行粒度 patch の pin(review #3): 列移動後のトグル印が ☑ に変わっている
    const toggleBtn = q('[data-pkc-entry="e0"] [data-pkc-action="toggle-todo"]')!;
    expect(toggleBtn.textContent).toBe('☑');
    // data-pkc-entry は entry 要素(カード)専用 ── ボタンには付かない(P3-7a 規約)
    expect(toggleBtn.hasAttribute('data-pkc-entry')).toBe(false);
  });

  it('選択中 entry のトグル ack は openBody(body/baseline/persisted)を disk に揃える(review #2 pin)', async () => {
    const pre = '---\nstatus: open\n---\nメモ';
    const { d, q } = setup([meta('e1')], { e1: pre });
    showView(d, 'kanban');
    q<HTMLElement>('[data-pkc-entry="e1"]')!.click(); // 選択 → openBody 確立
    await tick();
    expect(d.getState().openBody?.body).toBe(pre);

    q<HTMLElement>('[data-pkc-entry="e1"] [data-pkc-action="toggle-todo"]')!.click();
    await tick(20);
    const toggled = '---\nstatus: done\n---\nメモ';
    // ready の openBody は丸ごと disk へ追従 ── stale baseline を残すと次の
    // commit がトグルを黙って巻き戻す(review #2 の退行シナリオ)
    expect(d.getState().openBody).toEqual({
      lid: 'e1',
      body: toggled,
      baseline: toggled,
      persisted: toggled,
      diskAhead: false,
    });
  });

  it('編集中はトグル不可(ready 限定)/ 未知 lid・text は no-op', async () => {
    const { d, persisted } = setup([meta('e1'), meta('e4', { archetype: 'text' })], {
      e1: 'x',
    });
    d.dispatch({ type: 'TOGGLE_TODO_STATUS', lid: 'nope' });
    d.dispatch({ type: 'TOGGLE_TODO_STATUS', lid: 'e4' });
    await tick();
    expect(persisted).toHaveLength(0);
  });

  it('トグル失敗は非致命 ── phase は ready のまま、通知が出て再クリックで復帰(review #1)', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const center = new CenterRouter(regions.detail, () => new Date(2026, 7, 15));
    d.onState((s) => center.render(s));
    bindActions(root, d);
    let failNext = true;
    const persisted: EntryUpsert[] = [];
    connectStoreEffects(d, {
    ...stubRevisionOps(),
      getBody: async () => '---\nstatus: open\n---\nx',
      deleteEntry: async () => {},
      persistEntry: async (e) => {
        if (failNext) throw new Error('flaky');
        persisted.push(e);
        return stubStamps();
      },
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1')], relations: [] });
    showView(d, 'kanban');
    root
      .querySelector<HTMLElement>('[data-pkc-entry="e1"] [data-pkc-action="toggle-todo"]')!
      .click();
    await tick(20);
    expect(d.getState().phase).toBe('ready'); // app は死なない
    expect(d.getState().error).toMatch(/flaky/); // ただし黙らない
    failNext = false;
    root
      .querySelector<HTMLElement>('[data-pkc-entry="e1"] [data-pkc-action="toggle-todo"]')!
      .click();
    await tick(20);
    expect(persisted).toHaveLength(1); // 再クリック = retry
    expect(d.getState().entryMetas.get('e1')?.status).toBe('done');
  });
});

describe('calendar view (P3-6)', () => {
  it('date セルに todo が立ち、showArchived と月送りが効く', async () => {
    const { d, q, qa } = setup(
      [
        meta('e1', { date: '2026-08-01' }),
        meta('e2', { date: '2026-08-01', archived: true }),
        meta('e3', { date: '2026-09-05' }),
      ],
      {},
    );
    showView(d, 'calendar');

    expect(q('[data-pkc-field="calendar-month"]')?.getAttribute('data-pkc-month')).toBe(
      '2026-08',
    );
    const cell = q('[data-pkc-date="2026-08-01"]')!;
    expect(
      [...cell.querySelectorAll('[data-pkc-entry]')].map((e) =>
        e.getAttribute('data-pkc-entry'),
      ),
    ).toEqual(['e1']); // archived は既定で出ない

    q<HTMLElement>('input[data-pkc-action="toggle-show-archived"]')!.click();
    expect(
      [...q('[data-pkc-date="2026-08-01"]')!.querySelectorAll('[data-pkc-entry]')].map(
        (e) => e.getAttribute('data-pkc-entry'),
      ),
    ).toEqual(['e1', 'e2']);

    // 月送り(› = 描画時に焼き込まれた遷移先)で 9 月へ、e3 が見える
    q<HTMLElement>('[data-pkc-action="calendar-nav"][data-pkc-nav-month="9"]')!.click();
    expect(q('[data-pkc-field="calendar-month"]')?.getAttribute('data-pkc-month')).toBe(
      '2026-09',
    );
    expect(q('[data-pkc-date="2026-09-05"]')!.querySelector('[data-pkc-entry]')).not.toBeNull();
    expect(qa('[data-pkc-date="2026-08-01"]')).toHaveLength(0);
  });

  it('12 月から › で年を跨ぐ(reducer 正規化)', () => {
    const { d } = setup([], {});
    d.dispatch({ type: 'SET_CALENDAR_MONTH', year: 2026, month: 13 });
    expect(d.getState().calendarMonth).toEqual({ year: 2027, month: 1 });
    d.dispatch({ type: 'SET_CALENDAR_MONTH', year: 2027, month: 0 });
    expect(d.getState().calendarMonth).toEqual({ year: 2026, month: 12 });
  });

  it('view 切替は pane の hidden 付替のみ(detail の DOM は生きている)', async () => {
    const { d, root } = setup([meta('e1')], { e1: '# 本文' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    const detailPane = root.querySelector<HTMLElement>('[data-pkc-view-pane="detail"]')!;
    const bodyBefore = detailPane.querySelector('[data-pkc-field="detail-body"]');
    expect(bodyBefore).not.toBeNull();

    showView(d, 'kanban');
    expect(detailPane.hidden).toBe(true);
    showView(d, 'detail');
    expect(detailPane.hidden).toBe(false);
    // 中身は作り直されていない(常駐 pane ── ノード同一)
    expect(detailPane.querySelector('[data-pkc-field="detail-body"]')).toBe(bodyBefore);
  });
});
