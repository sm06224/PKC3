/** @vitest-environment happy-dom */
/**
 * 🔴 **予定の面 ── 掴んで落とすと本文が変わる**(#292 段③)。
 *
 * > user 指示 2026-08-23:「**なんで双方向にする発想がでねぇんだよ!**」
 *
 * 🔴 束ね方そのものは `tests/features/agenda.test.ts`、書換の規則は
 * `tests/features/body-rewrite.test.ts` が見ている。
 * **ここが見るのは繋がり**である ── 掴んだ札から本文の 1 行までが本当に届くか。
 *
 * ⚠ 観測点を「札が動いた」にしない ── それだと**画面だけ動いて本文は元のまま**が
 *   緑で通る(いちばん質の悪い形)。**保存された本文**を見る。
 */
import { stubStamps } from '../helpers/store-stamps';
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { ScheduleRenderer } from '../../src/adapter/ui/render/schedule';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';
import { taskCardsOf } from '../../src/features/kanban/kanban-data';

const TODAY = new Date(2026, 7, 23); // 2026-08-23(日)

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
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
    ...over,
  };
}

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

function setup(bodies: Record<string, string>) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const store: Record<string, string> = { ...bodies };
  const persisted: EntryUpsert[] = [];
  // ⚠ 面は左の列に在るが、ここでは器を直に組む(BrowseRouter は別の test が見る)
  const host = document.createElement('div');
  host.setAttribute('data-pkc-browse-pane', 'schedule');
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
    persistEntry: async (e) => {
      persisted.push(e);
      store[e.lid] = e.body;
      return stubStamps();
    },
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: Object.keys(bodies).map((lid) => meta(lid)),
    relations: [],
  });
  const cards = Object.entries(bodies).flatMap(([lid, body]) => taskCardsOf(lid, body));
  d.dispatch({
    type: 'SET_TASK_SCAN',
    scan: { cards, totalNotes: 1, scannedNotes: 1, truncated: false },
  });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const qa = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
  return { root, d, q, qa, persisted, store };
}

/** 掴んで落とす(実 UI と同じ順序:dragstart → dragover → drop)。 */
function dragTo(card: HTMLElement, target: HTMLElement): void {
  const data = new Map<string, string>();
  const dt = {
    types: [...data.keys()],
    setData: (k: string, v: string) => {
      data.set(k, v);
      (dt as { types: string[] }).types = [...data.keys()];
    },
    getData: (k: string) => data.get(k) ?? '',
    effectAllowed: '',
    dropEffect: '',
  };
  const fire = (el: HTMLElement, type: string): Event => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt });
    el.dispatchEvent(ev);
    return ev;
  };
  fire(card, 'dragstart');
  fire(target, 'dragover');
  fire(target, 'drop');
}

const groups = (qa: (s: string) => HTMLElement[]): string[] =>
  qa('[data-pkc-field="schedule-group-label"]').map((e) => e.textContent ?? '');
const cardsOf = (root: HTMLElement, date: string): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(
    `[data-pkc-region="schedule-group"][data-pkc-drop-date="${date}"] [data-pkc-region="schedule-cards"] > [data-pkc-entry]`,
  ),
];

describe('予定の面(#292 段③)', () => {
  it('日ごとの束が、人の言葉の名前で並ぶ', () => {
    const { qa } = setup({
      e1: '- [ ] 見積を送る @2026-08-23\n- [ ] 打合せ @2026-08-24 14:00\n- [ ] 過ぎた @2026-08-20\n',
    });
    // ⚠ 期限切れは**捨てない**(先頭に出す)
    expect(groups(qa)).toEqual(['8/20(木)(1)', '今日(1)', '明日(1)']);
    expect(
      qa('[data-pkc-region="schedule-group"]')[0]?.hasAttribute('data-pkc-overdue'),
      '期限切れの印が付いていない',
    ).toBe(true);
  });

  it('日付を書いていない項目は、既定で出ない', () => {
    const { qa } = setup({ e1: '- [ ] 体裁のチェック\n- [ ] 予定 @2026-08-23\n' });
    expect(groups(qa)).toEqual(['今日(1)']);
  });

  it('小さな月に、今日の印と予定のある日の点が出る', () => {
    const { q } = setup({ e1: '- [ ] 予定 @2026-08-25\n' });
    expect(q('[data-pkc-field="schedule-month"]')?.textContent).toBe('2026年8月');
    expect(
      q('[data-pkc-drop-date="2026-08-23"][data-pkc-today]'),
      '今日に印が無い',
    ).not.toBeNull();
    expect(q('[data-pkc-drop-date="2026-08-25"][data-pkc-has]'), '予定の点が無い').not.toBeNull();
    // ⚠ 空振り防止:予定の無い日には点を付けない
    expect(q('[data-pkc-drop-date="2026-08-26"][data-pkc-has]')).toBeNull();
  });

  /**
   * 🔴 **これが双方向の本体。**
   * ⚠ 観測点は**保存された本文** ── 「札が動いた」だけを見ると、
   *   画面だけ動いて本文は元のままが緑で通る。
   */
  it('🔴 札を別の日へ落とすと、本文の日付が書き替わる', async () => {
    const { root, q, persisted, store } = setup({ e1: '- [ ] 見積を送る @2026-08-23\n' });
    const card = cardsOf(root, '2026-08-23')[0]!;
    dragTo(card, q('[data-pkc-drop-date="2026-08-27"]')!);
    await tick(20);
    expect(persisted, '本文が書かれていない').toHaveLength(1);
    expect(store['e1'], '日付が書き替わっていない').toBe('- [ ] 見積を送る @2026-08-27\n');
  });

  it('🔴 時刻は持ち越す(日を動かしただけで消えない)', async () => {
    const { root, q, store } = setup({ e1: '- [ ] 打合せ @2026-08-23 14:00\n' });
    dragTo(cardsOf(root, '2026-08-23')[0]!, q('[data-pkc-drop-date="2026-08-27"]')!);
    await tick(20);
    expect(store['e1']).toBe('- [ ] 打合せ @2026-08-27 14:00\n');
  });

  /**
   * 🔴 **置けるなら、外せる**(片道の操作を作らない)。
   * ⚠ 外せないと、間違えて置いた予定を**本文を開いて手で消す**まで戻せない。
   */
  it('🔴 「日付なし」へ落とすと、予定から外れる(項目は消えない)', async () => {
    /**
     * ⚠ **日付なしの項目を 1 件混ぜておく** ── 束は「0 件なら作らない」ので、
     *   混ぜないと**落とし先そのものが画面に無い**(この test が空振りする)。
     */
    const { root, q, qa, store } = setup({
      e1: '- [ ] 見積を送る @2026-08-23\n- [ ] 体裁\n',
    });
    q<HTMLElement>('[data-pkc-action="toggle-show-undated"]')!.click();
    await tick();
    expect(groups(qa), '前提が崩れている(日付なしの束が出ていない)').toEqual([
      '今日(1)',
      '日付なし(1)',
    ]);
    dragTo(
      cardsOf(root, '2026-08-23')[0]!,
      q('[data-pkc-region="schedule-group"][data-pkc-drop-date=""]')!,
    );
    await tick(20);
    // 🔑 **行は残る**(予定から外れるだけ ── 消さない)
    expect(store['e1'], '日付が外れていない(または項目ごと消えた)').toBe(
      '- [ ] 見積を送る\n- [ ] 体裁\n',
    );
    // ⚠ 画面でも「日付なし」へ移っている(本文だけ直って画面が古い、を作らない)
    expect(groups(qa)).toEqual(['日付なし(2)']);
  });

  it('🔴 日付のない項目を日へ落とすと、予定になる', async () => {
    const { root, q, store } = setup({ e1: '- [ ] 体裁だったもの\n' });
    q<HTMLElement>('[data-pkc-action="toggle-show-undated"]')!.click();
    await tick();
    const card = root.querySelector<HTMLElement>(
      '[data-pkc-region="schedule-group"][data-pkc-drop-date=""] [data-pkc-entry]',
    )!;
    dragTo(card, q('[data-pkc-drop-date="2026-08-27"]')!);
    await tick(20);
    expect(store['e1']).toBe('- [ ] 体裁だったもの @2026-08-27\n');
  });

  /** ⚠ **触っていないノートは 1 バイトも変わらない**(別ノートへの書込の検出点)。 */
  it('🔴 掴んだ札のノートだけが書き替わる', async () => {
    const { root, q, store, persisted } = setup({
      e1: '- [ ] 動かす @2026-08-23\n',
      e2: '- [ ] 触るな @2026-08-23\n',
    });
    const mine = cardsOf(root, '2026-08-23').find((c) => c.getAttribute('data-pkc-entry') === 'e1')!;
    dragTo(mine, q('[data-pkc-drop-date="2026-08-27"]')!);
    await tick(20);
    expect(persisted.map((p) => p.lid)).toEqual(['e1']);
    expect(store['e2'], '触っていないノートが変わった').toBe('- [ ] 触るな @2026-08-23\n');
  });

  /** ⚠ 落とせない所へ落としても**何も起きない**(黙って別の物を動かさない)。 */
  it('落とせない場所に落としても何も起きない', async () => {
    const { root, q, persisted } = setup({ e1: '- [ ] 見積 @2026-08-23\n' });
    dragTo(cardsOf(root, '2026-08-23')[0]!, q('[data-pkc-field="schedule-note"]')!);
    await tick(20);
    expect(persisted).toHaveLength(0);
  });

  /**
   * 🔴 **済んだ予定は隠れるが、戻せる**(2026-08-23、変異試験 S7 が教えた欠陥)。
   * ⚠ 直す前は黙って外すだけで、この面から戻す道が無かった ── 板は「完了」の
   *   見出しが戻す口を兼ねていたが、予定の面には列が無いので**落ちていた**。
   * 🔑 「置けるなら外せる」の裏返し(片道を作らない)。
   */
  it('🔴 済んだ予定は既定で隠れ、押すと戻る', async () => {
    const { q, qa } = setup({
      e1: '- [x] 済んだ @2026-08-23\n- [ ] まだ @2026-08-23\n',
    });
    expect(groups(qa), '済んだ行が予定に残っている').toEqual(['今日(1)']);
    const btn = q<HTMLButtonElement>('[data-pkc-action="toggle-show-done"]')!;
    // ⚠ 押す前に**何件戻るか**が分かる(押しても何も起きないボタンを出さない)
    expect(btn.textContent).toBe('済んだ予定も出す(1)');
    btn.click();
    await tick();
    expect(groups(qa), '押しても戻らない').toEqual(['今日(2)']);
    // ⚠ 対照群:もう一度押したら既定へ帰る(片道の切替になっていないこと)
    btn.click();
    await tick();
    expect(groups(qa)).toEqual(['今日(1)']);
  });

  /** ⚠ 済んだ物が 1 つも無ければ、戻す口は出さない(dead click を作らない)。 */
  it('済んだ予定が無ければ、切替は出さない', () => {
    const { q } = setup({ e1: '- [ ] まだ @2026-08-23\n' });
    expect(q<HTMLButtonElement>('[data-pkc-action="toggle-show-done"]')?.hidden).toBe(true);
  });

  /**
   * 🔴 **札は掴める**(双方向の入口)。
   * ⚠ ここは**属性を直に見る**しかない ── unit の drag は event を手で撃つので、
   *   `draggable` が false でも通ってしまう(ブラウザの門を通らない)。
   * 🔑 **本物の drag は smoke が見る**(`tests/smoke/schedule.smoke.spec.ts`)──
   *   この 1 行は「掴める形で出 している」ことだけを守る。
   */
  it('🔴 札は掴める形で出ている(本物の drag は smoke が見る)', () => {
    const { root } = setup({ e1: '- [ ] 見積 @2026-08-23\n' });
    expect(cardsOf(root, '2026-08-23')[0]?.draggable, '札が掴めない').toBe(true);
  });

  it('印を押すと、その行のチェックが反転する(既に在る道も生きている)', async () => {
    const { root, store } = setup({ e1: '- [ ] 見積 @2026-08-23\n' });
    cardsOf(root, '2026-08-23')[0]!
      .querySelector<HTMLInputElement>('[data-pkc-action="toggle-task"]')!
      .click();
    await tick(20);
    expect(store['e1']).toBe('- [x] 見積 @2026-08-23\n');
  });
});
