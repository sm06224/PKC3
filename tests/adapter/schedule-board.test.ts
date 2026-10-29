/** @vitest-environment happy-dom */
/**
 * 🔴 **予定表のカンバン**(#277。user 指示 2026-08-19「カンバンとカレンダーを復活」)。
 *
 * 守る主張:
 * 1. 別ウィンドウ(広い面)の予定表に「カンバン」の切替が出て、押すと 未完了 / 完了 の 2 列に札が並ぶ。左の列には出ない
 * 2. 🔴 札を反対の列へ掴んで落とすと、**保存された本文**の `[ ]`↔`[x]` が切り替わる(観測点は本文。画面だけ動く緑を通さない)
 * 3. 書換は印を押すのと同じ道 ── 済みにしたときの「元に戻す」が出る / 編集中は書かない
 * 4. 同じ列へ落としても何も起きない / 日付なしの項目は札にならない
 */
import { stubStamps } from '../helpers/store-stamps';
import { afterEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { ScheduleRenderer } from '../../src/adapter/ui/render/schedule';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';
import { taskCardsOf } from '../../src/features/schedule/task-cards';
import { clearMoveOffer, currentDoneOffer } from '../../src/adapter/ui/render/schedule-undo';

const TODAY = new Date(2026, 7, 23);

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: Number(lid.slice(1)) || 0,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

function setup(bodies: Record<string, string>, wide = true) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const store: Record<string, string> = { ...bodies };
  const persisted: EntryUpsert[] = [];
  const host = document.createElement('div');
  // 広い面(別ウィンドウの中央の器)/ 狭い面(左の列)は器の印で見分ける
  host.setAttribute(wide ? 'data-pkc-view-pane' : 'data-pkc-browse-pane', 'schedule');
  regions.browseHost.append(host);
  const view = new ScheduleRenderer(host, () => TODAY);
  d.onState((s) => view.render(s));
  bindActions(root, d);
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => store[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      persisted.push(e);
      store[e.lid] = e.body;
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: Object.keys(bodies).map(meta), relations: [] });
  const cards = Object.entries(bodies).flatMap(([lid, body]) => taskCardsOf(lid, body));
  d.dispatch({ type: 'SET_TASK_SCAN', scan: { cards, totalNotes: 1, scannedNotes: 1, truncated: false } });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  return { root, d, q, persisted, store, host };
}

/** 掴んで落とす(実 UI と同じ順序:dragstart → dragover → drop)。 */
function dragTo(card: HTMLElement, target: HTMLElement): void {
  const data = new Map<string, string>();
  const dt = {
    types: [] as string[],
    setData: (k: string, v: string) => {
      data.set(k, v);
      dt.types = [...data.keys()];
    },
    getData: (k: string) => data.get(k) ?? '',
    effectAllowed: '',
    dropEffect: '',
  };
  const fire = (el: HTMLElement, type: string): void => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    el.dispatchEvent(ev);
  };
  fire(card, 'dragstart');
  fire(target, 'dragover');
  fire(target, 'drop');
}

const col = (root: HTMLElement, status: 'open' | 'done'): HTMLElement =>
  root.querySelector<HTMLElement>(`[data-pkc-drop-status="${status}"]`)!;
const cardsIn = (root: HTMLElement, status: 'open' | 'done'): HTMLElement[] => [
  ...col(root, status).querySelectorAll<HTMLElement>('[data-pkc-region="schedule-cards"] > [data-pkc-entry]'),
];
const BODY = '- [ ] 見積を送る @2026-08-23\n- [x] 済んだ件 @2026-08-20\n- [ ] 体裁のチェック\n';

afterEach(() => {
  clearMoveOffer();
  localStorage.removeItem('pkc3.board-layout');
});

describe('予定表のカンバン(#277)', () => {
  it('🔴 広い面には「カンバン」の切替が出て、左の列には出ない', () => {
    const wide = setup({ e1: BODY }, true);
    expect(wide.q('[data-pkc-field="schedule-modes"] [data-pkc-mode="board"]'), '切替が無い').not.toBeNull();
    const narrow = setup({ e1: BODY }, false);
    expect(narrow.q('[data-pkc-field="schedule-modes"] [data-pkc-mode="board"]'), '左の列に出ている').toBeNull();
  });

  it('押すと 未完了 / 完了 の 2 列に、日付付きのチェック項目だけが並ぶ', () => {
    const { root, q } = setup({ e1: BODY });
    expect(q('[data-pkc-region="schedule-board"]')!.hidden, '押す前から出ている').toBe(true);
    q('[data-pkc-mode="board"]')!.click();
    const board = q('[data-pkc-region="schedule-board"]')!;
    expect(board.hidden, '押しても出ない').toBe(false);
    expect(cardsIn(root, 'open').map((c) => c.querySelector('[data-pkc-field="text"]')?.textContent)).toEqual([
      '見積を送る',
    ]);
    // 既定では済んだ札は畳まれるが、カンバンは完了の列に出す
    expect(cardsIn(root, 'done').map((c) => c.querySelector('[data-pkc-field="text"]')?.textContent)).toEqual([
      '済んだ件',
    ]);
    // 日付なしの体裁のチェックはどちらにも出ない
    expect(board.textContent).not.toContain('体裁のチェック');
    expect(q('[data-pkc-mode="board"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-pkc-mode="list"]')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('🔴 札を「完了」の列へ落とすと、保存された本文が [x] になり、「元に戻す」が出る', async () => {
    const { root, q, persisted, store } = setup({ e1: BODY });
    q('[data-pkc-mode="board"]')!.click();
    dragTo(cardsIn(root, 'open')[0]!, col(root, 'done'));
    await tick();
    expect(persisted, '本文が書かれていない').toHaveLength(1);
    expect(store['e1'], '[x] に切り替わっていない').toBe(
      '- [x] 見積を送る @2026-08-23\n- [x] 済んだ件 @2026-08-20\n- [ ] 体裁のチェック\n',
    );
    expect(currentDoneOffer(), '印を押したときの「元に戻す」が出ない(別の道で書いている)').not.toBeNull();
    // 画面も追従する(完了の列に居る)
    expect(cardsIn(root, 'done')).toHaveLength(2);
    expect(cardsIn(root, 'open')).toHaveLength(0);
  });

  it('🔴 札を「未完了」の列へ落とすと、[x] が [ ] に戻る', async () => {
    const { root, q, store } = setup({ e1: BODY });
    q('[data-pkc-mode="board"]')!.click();
    dragTo(cardsIn(root, 'done')[0]!, col(root, 'open'));
    await tick();
    expect(store['e1']).toBe('- [ ] 見積を送る @2026-08-23\n- [ ] 済んだ件 @2026-08-20\n- [ ] 体裁のチェック\n');
  });

  it('同じ列へ落としても何も書かない / 日付の落とし先とは別物', async () => {
    const { root, q, persisted } = setup({ e1: BODY });
    q('[data-pkc-mode="board"]')!.click();
    dragTo(cardsIn(root, 'open')[0]!, col(root, 'open'));
    await tick();
    expect(persisted).toHaveLength(0);
  });

  it('🔴 編集中は書かない(書換の門を通っている)', async () => {
    const { root, q, d, persisted, store } = setup({ e1: BODY });
    q('[data-pkc-mode="board"]')!.click();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'e1', body: BODY });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '前提:編集中になっていない').toBe('editing');
    dragTo(cardsIn(root, 'open')[0]!, col(root, 'done'));
    await tick();
    expect(persisted, '編集中に本文を書いた').toHaveLength(0);
    expect(store['e1']).toBe(BODY);
    expect(d.getState().error ?? '', '断った理由が出ていない').not.toBe('');
  });

  it('掴んで列の上を通っている間は光る(落とせる所が分かる)', () => {
    const { root, q } = setup({ e1: BODY });
    q('[data-pkc-mode="board"]')!.click();
    const data = new Map<string, string>();
    const dt = {
      types: [] as string[],
      setData: (k: string, v: string) => {
        data.set(k, v);
        dt.types = [...data.keys()];
      },
      getData: (k: string) => data.get(k) ?? '',
      effectAllowed: '',
      dropEffect: '',
    };
    const fire = (el: HTMLElement, type: string): void => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: dt });
      el.dispatchEvent(ev);
    };
    fire(cardsIn(root, 'open')[0]!, 'dragstart');
    fire(col(root, 'done'), 'dragover');
    expect(col(root, 'done').hasAttribute('data-pkc-dropping')).toBe(true);
    expect(col(root, 'open').hasAttribute('data-pkc-dropping')).toBe(false);
  });
});

/**
 * 🔴 **信号機の列**(#1457)。観測点は「列の中身」「落とした後の本文」「切り替えが端末に残ること」
 * 「状態の列に戻せる(片道にしない)」。
 */
describe('カンバンの信号機の列(#1457)', () => {
  // TODAY = 2026-08-23
  const SIG =
    '- [ ] 期限切れ @2026-08-20\n' +
    '- [ ] 今日の分 @2026-08-23\n' +
    '- [ ] 先の分 @2026-09-30\n' +
    '- [ ] 急ぎ #赤 @2026-12-31\n' +
    '- [x] 済んだ @2026-08-01\n';
  const colOf = (root: HTMLElement, sig: 'red' | 'yellow' | 'green'): HTMLElement =>
    root.querySelector<HTMLElement>(`[data-pkc-signal="${sig}"]`)!;
  const textsIn = (el: HTMLElement): (string | null | undefined)[] =>
    [...el.querySelectorAll<HTMLElement>('[data-pkc-region="schedule-cards"] > [data-pkc-entry]')].map(
      (c) => c.querySelector('[data-pkc-field="text"]')?.textContent,
    );
  const toSignal = (q: <T extends HTMLElement>(sel: string) => T | null): void => {
    q('[data-pkc-mode="board"]')!.click();
    q('[data-pkc-board-layout="signal"]')!.click();
  };

  it('🔴 既定は今までどおりの 2 列(信号機の列は隠れている)/ 切り替えは広い面のカンバンの中にある', () => {
    const { q } = setup({ e1: SIG });
    q('[data-pkc-mode="board"]')!.click();
    expect(q('[data-pkc-region="schedule-board"]')!.getAttribute('data-pkc-board-columns')).toBe('status');
    expect(q('[data-pkc-board-layout="status"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-pkc-board-layout="signal"]')!.getAttribute('aria-pressed')).toBe('false');
    for (const c of ['red', 'yellow', 'green'] as const)
      expect(q(`[data-pkc-signal="${c}"]`)!.hidden, `${c} の列が既定で出ている`).toBe(true);
  });

  it('🔴 押すと 赤 / 黄 / 緑 / 完了 の列に、期限とタグで札が並ぶ', () => {
    const { root, q } = setup({ e1: SIG });
    toSignal(q);
    expect(colOf(root, 'red').hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('[data-pkc-board-status="open"]:not([data-pkc-signal])')!.hidden, '状態の「未完了」列が残っている').toBe(true);
    expect(textsIn(colOf(root, 'red')).sort(), '赤: 期限切れ + #赤').toEqual(['急ぎ #赤', '期限切れ'].sort());
    expect(textsIn(colOf(root, 'yellow'))).toEqual(['今日の分']);
    expect(textsIn(colOf(root, 'green'))).toEqual(['先の分']);
    expect(cardsIn(root, 'done').map((c) => c.querySelector('[data-pkc-field="text"]')?.textContent)).toEqual(['済んだ']);
    // 見出しは色の名前だけ。意味(期限・タグ)は説明の行と title に書く(色だけに頼らない・見出しを長くしない)
    const headOf = (c: 'red' | 'yellow' | 'green'): HTMLElement =>
      colOf(root, c).querySelector<HTMLElement>('[data-pkc-field="schedule-board-head"]')!;
    expect(headOf('red').textContent).toMatch(/^赤\(\d+\)$/);
    expect(headOf('yellow').textContent).toMatch(/^黄\(\d+\)$/);
    expect(headOf('green').textContent).toMatch(/^緑\(\d+\)$/);
    expect(headOf('red').title).toContain('期限が今日より前');
    expect(headOf('red').title).toContain('#赤');
    expect(q('[data-pkc-field="schedule-board-note"]')!.textContent).toContain('赤は期限切れ');
    expect(q('[data-pkc-board-layout="signal"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('🔴 赤の札を完了の列へ落とすと、保存された本文が [x] になる(書換は状態のカンバンと同じ道)', async () => {
    const { root, q, store } = setup({ e1: SIG });
    toSignal(q);
    const card = [...colOf(root, 'red').querySelectorAll<HTMLElement>('[data-pkc-entry]')].find(
      (c) => c.querySelector('[data-pkc-field="text"]')?.textContent === '期限切れ',
    )!;
    dragTo(card, col(root, 'done'));
    await tick();
    expect(store['e1']).toContain('- [x] 期限切れ @2026-08-20');
    expect(currentDoneOffer(), '「元に戻す」が出ない').not.toBeNull();
    expect(textsIn(colOf(root, 'red')), '赤の列に残っている').toEqual(['急ぎ #赤']);
  });

  it('🔴 完了の札を赤・黄・緑の列へ落とすと未完了に戻る(列は期日とタグが決める)', async () => {
    const { root, q, store } = setup({ e1: SIG });
    toSignal(q);
    dragTo(cardsIn(root, 'done')[0]!, colOf(root, 'green'));
    await tick();
    expect(store['e1']).toContain('- [ ] 済んだ @2026-08-01');
  });

  it('🔴 切り替えは端末に残り、「状態」で元の 2 列に戻せる(片道にしない)', () => {
    const a = setup({ e1: SIG });
    toSignal(a.q);
    expect(localStorage.getItem('pkc3.board-layout')).toBe('signal');
    document.body.textContent = '';
    const b = setup({ e1: SIG });
    b.q('[data-pkc-mode="board"]')!.click();
    expect(b.q('[data-pkc-region="schedule-board"]')!.getAttribute('data-pkc-board-columns'), '次に開いたとき戻っている').toBe('signal');
    b.q('[data-pkc-board-layout="status"]')!.click();
    expect(b.q('[data-pkc-region="schedule-board"]')!.getAttribute('data-pkc-board-columns')).toBe('status');
    expect(cardsIn(b.root, 'open').length, '状態の「未完了」が戻っていない').toBe(4);
    expect(localStorage.getItem('pkc3.board-layout')).toBe('status');
  });
});
