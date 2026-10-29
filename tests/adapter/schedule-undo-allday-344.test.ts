/** @vitest-environment happy-dom */
/**
 * 🔴 **予定を外す / 動かす → 元に戻す で、終日・期間・繰り返しが落ちない**(台帳 #344 の残り。レビューの指摘)。
 *
 * 取り消しが「日付と時刻」だけを戻すと、`@日付 終日` の `終日`、ノートの `date: 開始..終わり` / `毎週` / `終日` が
 * 黙って消える。ここでは本物の道(binder の `unschedule-task` / `dropTaskCard` → reducer → 本文の書換 → 走査し直し →
 * `schedule-undo-move`)を通して、**本文が原文のバイト列に戻る**ことを見る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { noteTimeOf, taskCardsOf, type NoteTime } from '../../src/features/schedule/task-cards';
import { extractSchedule } from '../../src/features/schedule/schedule-keys';
import { dropTaskCard } from '../../src/adapter/ui/render/schedule-drag';
import { clearMoveOffer, scheduleUndoShown } from '../../src/adapter/ui/render/schedule-undo';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const meta = (date: string | null): EntryMeta => ({
  lid: 'a',
  title: 't',
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date,
  archived: false,
  bodyChars: null,
});

function wired(initialBody: string) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  let body = initialBody;
  const boot = (): void => {
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta(extractSchedule(body).date)], relations: [] });
    const nt = noteTimeOf('a', body);
    d.dispatch({
      type: 'SET_TASK_SCAN',
      scan: {
        cards: taskCardsOf('a', body),
        ...(nt === null ? {} : { noteTimes: [nt] as readonly NoteTime[] }),
        totalNotes: 1,
        scannedNotes: 1,
        truncated: false,
      },
    });
  };
  boot();
  d.onEvent((e) => {
    if (e.type !== 'REQUEST_BODY_REWRITE') return;
    body = applyBodyRewrite(body, e.rewrite) ?? body;
    boot();
  });
  bindActions(root, d, { busy: () => false });
  const card = document.createElement('article');
  card.setAttribute('data-pkc-entry', 'a');
  const off = document.createElement('button');
  off.setAttribute('data-pkc-action', 'unschedule-task');
  card.append(off);
  root.append(card);
  const undo = document.createElement('button');
  undo.setAttribute('data-pkc-action', 'schedule-undo-move');
  root.append(undo);
  return { d, root, card, off, undo, body: () => body };
}

beforeEach(() => {
  vi.useFakeTimers();
  clearMoveOffer();
});
afterEach(() => {
  clearMoveOffer();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('日付なしへ外して → 元に戻す で原文に戻る (#344)', () => {
  it('🔴 行 `@日付 終日`', async () => {
    const original = '- [ ] 夏季休暇 @2026-08-25 終日';
    const w = wired(original);
    const mark = document.createElement('input');
    mark.setAttribute('data-pkc-task-line', '0');
    w.card.prepend(mark);
    w.off.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.body(), '前提: 外れている').toBe('- [ ] 夏季休暇');
    expect(scheduleUndoShown('予定から外しました')).toBe(true);
    w.undo.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.body(), '`終日` が戻らない').toBe(original);
  });

  it.each([
    ['期間', '---\ndate: 2026-08-25..2026-08-27\n---\n本文'],
    ['毎週', '---\ndate: 2026-08-25 毎週\n---\n本文'],
    ['時刻つき毎週', '---\ndate: 2026-08-25 14:00 毎週\n---\n本文'],
    ['終日', '---\ndate: 2026-08-25 終日\n---\n本文'],
  ])('🔴 ノート `date:` %s', async (_n, original) => {
    const w = wired(original);
    w.card.setAttribute('data-pkc-whole-note', '');
    w.off.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.body(), '前提: 外れている').not.toContain('date:');
    expect(scheduleUndoShown('予定から外しました')).toBe(true);
    w.undo.click();
    await vi.advanceTimersByTimeAsync(0);
    // ⚠ 時刻の `:` を含む値は、書き手が YAML の都合で引用符を付ける(値は同じ ── 引用符だけを外して比べる)
    expect(w.body().replace(/"/g, ''), '期間・繰り返し・終日が戻らない').toBe(original);
  });
});

describe('ノートを動かす → 元に戻す / 知らせの文 (#344)', () => {
  const dropNote = (w: ReturnType<typeof wired>, from: string, to: string, repeat = ''): void =>
    dropTaskCard(w.d, { lid: 'a', line: '', from, repeat }, to, w.root);

  it('🔴 期間のノート: 掴んだ日が落とした日に来るよう開始と終わりが動き、知らせが出て、元に戻すで原文', async () => {
    const original = '---\ndate: 2026-08-25..2026-08-27\n---\n本文';
    const w = wired(original);
    dropNote(w, '2026-08-26', '2026-09-02');
    await vi.advanceTimersByTimeAsync(0);
    expect(w.body()).toContain('date: 2026-09-01..2026-09-03');
    expect(w.d.getState().notice ?? '', '期間のノートを動かしたのに知らせが出ない(動かした後の姿が走査と食い違う)').toContain('へ動かしました');
    w.undo.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.body()).toBe(original);
  });

  it('🔴 繰り返しのノートは、知らせで「毎週の規則ごと動かしました」と言う', async () => {
    const original = '---\ndate: 2026-08-25 毎週\n---\n本文';
    const w = wired(original);
    dropNote(w, '2026-08-25', '2026-08-27', 'week');
    await vi.advanceTimersByTimeAsync(0);
    expect(w.body()).toContain('2026-08-27');
    expect(w.d.getState().notice).toBe('8/27(木) へ動かしました(毎週の規則ごと動かしました)');
    w.undo.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.body()).toBe(original);
  });

  it('対照群: 繰り返しでないノートの知らせに「規則ごと」は出ない', async () => {
    const w = wired('---\ndate: 2026-08-25\n---\n本文');
    dropNote(w, '2026-08-25', '2026-08-27');
    await vi.advanceTimersByTimeAsync(0);
    expect(w.d.getState().notice).toBe('8/27(木) へ動かしました');
  });
});
