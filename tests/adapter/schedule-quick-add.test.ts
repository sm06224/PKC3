/** @vitest-environment happy-dom */
/**
 * #402 ②: **予定の面から、その場でやることを足す**。
 *
 * > user の物語: 予定タブで今週を眺めている。「木曜に見積を出す」を足したい。
 * > いまは足す口が無い ── ノートを開く(または作る)→ 本文に
 * > `- [ ] 見積を出す @2026-08-28` と**手で書く** → 予定タブへ戻る。
 *
 * 🔴 **正本は本文のまま**(user 指示 2026-08-23「面は映すだけにしない ── 双方向」)。
 *   面が別のデータを持つのではなく、**面から本文へ書く**。
 *
 * 観測点は **disk に着いた本文**(画面だけ変わって保存されない、を作らない)。
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { ScheduleRenderer } from '../../src/adapter/ui/render/schedule';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';
import { todayNoteTitle } from '../../src/features/schedule/today-note';
import { taskCardsOf } from '../../src/features/schedule/task-cards';

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
    ...over,
  };
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.textContent = '';
});

function setup(metas: EntryMeta[], bodies: Record<string, string>) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  buildShell(root);
  const host = document.createElement('div');
  root.append(host);
  const sched = new ScheduleRenderer(host);
  d.onState((s) => sched.render(s));
  bindActions(root, d);
  const disk = { ...bodies };
  const persisted: EntryUpsert[] = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => disk[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      persisted.push(e);
      disk[e.lid] = e.body;
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  // ⚠ 予定は**左の列の面**(`BrowseMode`)であって `ViewMode` ではない ──
  //    ここでは描画器を直に回す(`schedule-view.test.ts` と同じ作法)
  /**
   * ⚠ **札は走査の結果から出る** ── 本文を disk に置いただけでは 1 枚も出ない
   *   (走査は保存のたびに自動では走らない)。`schedule-view.test.ts` と同じ作法で
   *   ここに流し込む。
   */
  const cards = Object.entries(bodies).flatMap(([lid, body]) => taskCardsOf(lid, body));
  d.dispatch({
    type: 'SET_TASK_SCAN',
    scan: { cards, totalNotes: 1, scannedNotes: 1, truncated: false },
  });
  const q = <T extends HTMLElement>(s: string): T | null => root.querySelector<T>(s);
  return { root, d, disk, persisted, q };
}

function type(s: ReturnType<typeof setup>, text: string, date = ''): void {
  s.q<HTMLInputElement>('[data-pkc-field="schedule-quick-text"]')!.value = text;
  s.q<HTMLInputElement>('[data-pkc-field="schedule-quick-date"]')!.value = date;
}

const TODAY = todayNoteTitle(new Date());

describe('#402 ② 予定の面から足す', () => {
  it('🔴 今日のノートに、チェック項目として書かれる', async () => {
    const s = setup([meta('t1', { title: TODAY })], { t1: 'きょうのメモ\n' });
    await tick();
    type(s, '見積を出す', '2026-08-28');
    s.q('[data-pkc-action="schedule-quick-add"]')!.click();
    await tick();
    expect(s.disk['t1'], 'disk に届いていない').toContain('- [ ] 見積を出す @2026-08-28');
    // ⚠ もとの本文は残る
    expect(s.disk['t1']).toContain('きょうのメモ');
  });

  it('⚠ 日付を空にすると、日付なしで書かれる(予定なしのやること)', async () => {
    const s = setup([meta('t1', { title: TODAY })], { t1: 'メモ\n' });
    await tick();
    type(s, 'あとでやる');
    s.q('[data-pkc-action="schedule-quick-add"]')!.click();
    await tick();
    expect(s.disk['t1']).toContain('- [ ] あとでやる');
    expect(s.disk['t1'], '空の日付が書かれた').not.toContain('@\n');
  });

  it('🔴 今日のノートが無ければ作ってから書く(新しい入れ物を作らない)', async () => {
    const s = setup([meta('other', { title: 'べつのノート' })], { other: 'x\n' });
    await tick();
    type(s, '見積を出す', '2026-08-28');
    s.q('[data-pkc-action="schedule-quick-add"]')!.click();
    await tick();
    const today = [...s.d.getState().entryMetas.values()].find((m) => m.title === TODAY);
    expect(today, '今日のノートが作られていない').toBeDefined();
    expect(s.disk[today!.lid], '作ったノートに書かれていない').toContain('- [ ] 見積を出す');
  });

  /**
   * 🔴 **面を奪わない**(#300「補助が主の作業領域を奪わない」)。
   * ⚠ 予定は**左の列の面**なので、見るのは「中央が本文のまま」である ──
   *   1 稿目は `viewMode` が `'schedule'` になることを期待していたが、
   *   `'schedule'` は `ViewMode` に無い(tsc が止めた)。**期待のほうが誤り**だった。
   */
  it('🔴 中央の面を奪わない(予定を眺めたまま足せる)', async () => {
    const s = setup([meta('t1', { title: TODAY })], { t1: 'メモ\n' });
    await tick();
    const before = s.d.getState().viewMode;
    type(s, 'あれをやる', '2026-08-28');
    s.q('[data-pkc-action="schedule-quick-add"]')!.click();
    await tick();
    expect(s.d.getState().viewMode, '中央の面が切り替わった').toBe(before);
    // 🔑 編集にも入らない(本文へ飛ばされない)
    expect(s.d.getState().phase, '編集に入った').toBe('ready');
  });

  it('🔑 通ったら欄が空になる(続けて足せる)', async () => {
    const s = setup([meta('t1', { title: TODAY })], { t1: 'メモ\n' });
    await tick();
    type(s, 'ひとつ', '2026-08-28');
    s.q('[data-pkc-action="schedule-quick-add"]')!.click();
    await tick();
    expect(s.q<HTMLInputElement>('[data-pkc-field="schedule-quick-text"]')!.value).toBe('');
  });

  it('🔴 空のまま押したら理由が出る(押して無反応にしない)', async () => {
    const s = setup([meta('t1', { title: TODAY })], { t1: 'メモ\n' });
    await tick();
    type(s, '   ', '2026-08-28');
    s.q('[data-pkc-action="schedule-quick-add"]')!.click();
    await tick();
    expect(s.d.getState().error ?? '', '無言で終わった').toContain('やることを入力');
    expect(s.disk['t1'], '断ったのに書いた').toBe('メモ\n');
  });

  it('⚠ 断ったときは打った字を残す', async () => {
    const s = setup([meta('t1', { title: TODAY })], { t1: 'メモ\n' });
    await tick();
    const field = s.q<HTMLInputElement>('[data-pkc-field="schedule-quick-text"]')!;
    field.value = '  ';
    s.q('[data-pkc-action="schedule-quick-add"]')!.click();
    await tick();
    expect(field.value, '断ったのに欄を空にした').toBe('  ');
  });
});

describe('#402 ② その日の束から足す', () => {
  it('🔴 束の「+」を押すと、上の欄にその日が入る(書かない)', async () => {
    const s = setup([meta('t1', { title: TODAY })], {
      t1: '- [ ] さきの予定 @2026-09-10\n',
    });
    // 札が出るまで待つ(本文の走査が要る)
    await tick(50);
    const plus = s.q('[data-pkc-action="schedule-quick-here"]');
    expect(plus, '束の「+」が出ていない(前提が崩れた)').not.toBeNull();
    const before = s.disk['t1'];
    plus!.click();
    await tick();
    expect(
      s.q<HTMLInputElement>('[data-pkc-field="schedule-quick-date"]')!.value,
      '日付が入っていない',
    ).toBe(plus!.getAttribute('data-pkc-quick-date'));
    // 🔴 **押しただけでは書かない**(欄を埋めるだけ)
    expect(s.disk['t1'], '押しただけで書き込んだ').toBe(before);
  });

  it('🔴 束の見出しの字に「+」が混ざらない(読み上げ・写しが汚れる)', async () => {
    const s = setup([meta('t1', { title: TODAY })], {
      t1: '- [ ] さきの予定 @2026-09-10\n',
    });
    await tick(50);
    const label = s.q('[data-pkc-field="schedule-group-text"]');
    expect(label, '束の見出しが出ていない(前提が崩れた)').not.toBeNull();
    expect(label!.textContent ?? '', '見出しの字に印が混ざっている').not.toContain('+');
  });
});
