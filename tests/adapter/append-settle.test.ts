/**
 * 書き足して、disk に着いたかまで待つ口(`appendAndSettle`。#1407 段④ で PDF の引用から取り出した)。
 * 結末の大半は `pdf-quote-into-note.test.ts` が通す ── ここは取り出した口だけが持つ約束を見る。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, reduce, type DomainEvent } from '../../src/adapter/state/app-state';
import { appendAndSettle } from '../../src/adapter/state/append-settle';
import type { EntryMeta } from '../../src/core/model/entry-meta';

function meta(lid: string, archetype: string): EntryMeta {
  return {
    lid,
    title: `題-${lid}`,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const NO_TIMERS = { setTimer: () => 0, clearTimer: () => undefined };

describe('appendAndSettle', () => {
  it('🔴 前から残っている断り文を、この依頼の理由として返さない(理由の付かない断りは null)', async () => {
    const booted = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 'text')], relations: [] }).state;
    const d = new Dispatcher({ ...booted, error: '前の操作の断り' });
    // 無いノートへの書き足しは、reducer が理由を付けずに断る(錠も動かない)
    const r = await appendAndSettle(d, 'gone', 'x', null, 1000, NO_TIMERS);
    expect(r).toEqual({ ok: false, reason: 'refused', error: null });
  });

  it('見出しをそのまま追記の依頼に載せる(ログの日時の節)', async () => {
    const booted = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('log', 'textlog')], relations: [] }).state;
    const d = new Dispatcher(booted);
    const events: DomainEvent[] = [];
    d.onEvent((e) => events.push(e));
    void appendAndSettle(d, 'log', '終えた', '## 2026-10-10 12:00:00', 1000, NO_TIMERS);
    const req = events.find((e) => e.type === 'REQUEST_APPEND') as { heading?: string | null } | undefined;
    expect(req, '追記の依頼が出ていない').toBeDefined();
    expect(req!.heading).toBe('## 2026-10-10 12:00:00');
  });
});
