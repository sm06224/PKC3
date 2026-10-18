/**
 * 🔴 依頼 362: AI が既にあるノートに書き足しても、自分の「追記を元に戻す」を消さない。AI の分は別に戻せる。
 *
 * 守る主張:
 * ① AI の書き足し(`batch` = `AGENT_APPEND_BATCH`)は `lastAppend`(自分の追記)を上書きせず、`lastAgentAppend` に入る
 * ② 対照群: 印の無い追記(自分の追記)は、これまでどおり `lastAppend` を入れ替える
 * ③ `OP_NOTICE.agentUndo` は、材料が同じノートのときだけ知らせの字を控える
 * ④ `UNDO_AGENT_APPEND` は AI の分だけを戻し(自分の分は残る)、`UNDO_APPEND` は自分の分だけを戻す
 * ⑤ `appendAndSettle` は印を `APPEND_TO_ENTRY` → `REQUEST_APPEND` まで運ぶ
 * ⚠ reducer と Dispatcher は実物。effect(worker への書込)の ack は test が撃つ(`pdf-quote-into-note.test.ts` と同じ作法)。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import {
  AGENT_APPEND_BATCH,
  initialState,
  reduce,
  type DomainEvent,
} from '../../src/adapter/state/app-state';
import { appendAndSettle } from '../../src/adapter/state/append-settle';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const meta = (lid: string): EntryMeta => ({
  lid,
  title: `題-${lid}`,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

function rig(): { d: Dispatcher; events: DomainEvent[] } {
  const booted = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1'), meta('n2')], relations: [] }).state;
  const d = new Dispatcher(booted);
  const events: DomainEvent[] = [];
  d.onEvent((e) => events.push(e));
  return { d, events };
}

/** 追記を 1 本通す(錠 → ack)。`batch` を付ければ AI の書き足し。 */
function append(d: Dispatcher, lid: string, line: string, batch?: string): void {
  d.dispatch({ type: 'APPEND_TO_ENTRY', lid, text: line, heading: null, target: null, ...(batch === undefined ? {} : { batch }) });
  d.dispatch({
    type: 'ENTRY_APPENDED',
    lid,
    gen: d.getState().lockGen,
    body: line,
    status: null,
    date: null,
    archived: false,
    inserted: [line],
    insertedAt: 3,
    ...(batch === undefined ? {} : { batch }),
  });
}
const rewrites = (events: DomainEvent[]) =>
  events.filter((e): e is Extract<DomainEvent, { type: 'REQUEST_BODY_REWRITE' }> => e.type === 'REQUEST_BODY_REWRITE');

describe('AI の書き足しは、自分の「追記を元に戻す」を消さない(依頼 362)', () => {
  it('① 自分の追記のあとに AI が同じノートへ書き足しても、lastAppend は自分の分のまま。AI の分は lastAgentAppend', () => {
    const { d } = rig();
    append(d, 'n1', '自分の行');
    append(d, 'n1', 'AI の行', AGENT_APPEND_BATCH);
    const s = d.getState();
    expect(s.lastAppend).toMatchObject({ lid: 'n1', lines: ['自分の行'] });
    expect(s.lastAgentAppend).toEqual({ lid: 'n1', lines: ['AI の行'], at: 3 });
  });

  it('② 対照群: 印の無い追記は、これまでどおり lastAppend を入れ替える(AI の分には触れない)', () => {
    const { d } = rig();
    append(d, 'n1', 'AI の行', AGENT_APPEND_BATCH);
    append(d, 'n1', '一つ目');
    append(d, 'n1', '二つ目');
    const s = d.getState();
    expect(s.lastAppend).toMatchObject({ lines: ['二つ目'] });
    expect(s.lastAgentAppend).toMatchObject({ lines: ['AI の行'] });
  });

  it('③ OP_NOTICE.agentUndo は、材料が同じノートのときだけ知らせの字を控える', () => {
    const { d } = rig();
    append(d, 'n1', 'AI の行', AGENT_APPEND_BATCH);
    d.dispatch({ type: 'OP_NOTICE', message: '別のノートの知らせ', open: 'n2', agentUndo: true });
    expect(d.getState().lastAgentAppend?.notice, '別のノートの知らせの字を控えた').toBeUndefined();
    d.dispatch({ type: 'OP_NOTICE', message: 'AI が書き足しました', open: 'n1', agentUndo: true });
    expect(d.getState().lastAgentAppend?.notice).toBe('AI が書き足しました');
    expect(d.getState().noticeOpen).toBe('n1');
    // 対照群: agentUndo を付けない知らせは字を控えない
    const { d: d2 } = rig();
    append(d2, 'n1', 'AI の行', AGENT_APPEND_BATCH);
    d2.dispatch({ type: 'OP_NOTICE', message: 'ふつうの知らせ', open: 'n1' });
    expect(d2.getState().lastAgentAppend?.notice).toBeUndefined();
  });

  it('④ UNDO_AGENT_APPEND は AI の行だけを戻す。自分の分は残り、UNDO_APPEND で別に戻せる', () => {
    const { d, events } = rig();
    append(d, 'n1', '自分の行');
    append(d, 'n1', 'AI の行', AGENT_APPEND_BATCH);
    d.dispatch({ type: 'UNDO_AGENT_APPEND' });
    const first = rewrites(events).at(-1)!;
    expect(first.rewrite).toEqual({ kind: 'undo-append', lines: ['AI の行'], at: 3 });
    expect(d.getState().lastAgentAppend, '1 手で使い切る').toBeNull();
    expect(d.getState().lastAppend, '自分の分が消えた').toMatchObject({ lines: ['自分の行'] });
    // 2 度押しても何も起きない
    const before = rewrites(events).length;
    d.dispatch({ type: 'UNDO_AGENT_APPEND' });
    expect(rewrites(events)).toHaveLength(before);
    // 自分の分は自分の口で戻る
    d.dispatch({ type: 'UNDO_APPEND' });
    expect(rewrites(events).at(-1)!.rewrite).toMatchObject({ kind: 'undo-append', lines: ['自分の行'] });
  });

  it('④ 編集中のノートへは戻さず、断る理由を言い、材料を残す(編集を終えてから押し直せる)', () => {
    const { d } = rig();
    append(d, 'n1', 'AI の行', AGENT_APPEND_BATCH);
    // 実物の不変量どおり、editing は openBody を伴う形にする(body-write-block-lid.test.ts と同じ作り)
    const editing = {
      ...d.getState(),
      phase: 'editing' as const,
      openBody: { lid: 'n1', body: 'x', baseline: 'x', persisted: 'x', diskAhead: false },
    };
    const r = reduce(editing, { type: 'UNDO_AGENT_APPEND' });
    expect(r.events.filter((e) => e.type === 'REQUEST_BODY_REWRITE')).toEqual([]);
    expect(r.state.lastAgentAppend, '断った回なのに材料を捨てた').not.toBeNull();
    expect(r.state.error, '断る理由を言わなかった').toContain('書き足しを元に戻してください');
  });

  it('⑤ appendAndSettle は印を REQUEST_APPEND まで運ぶ(省略すれば印は付かない)', async () => {
    const { d, events } = rig();
    const timers = { setTimer: () => 0, clearTimer: () => undefined };
    void appendAndSettle(d, 'n1', '字', null, 1000, timers, AGENT_APPEND_BATCH);
    const req = events.find((e) => e.type === 'REQUEST_APPEND') as Extract<DomainEvent, { type: 'REQUEST_APPEND' }>;
    expect(req.batch).toBe(AGENT_APPEND_BATCH);
    const { d: d2, events: ev2 } = rig();
    void appendAndSettle(d2, 'n1', '字', null, 1000, timers);
    const req2 = ev2.find((e) => e.type === 'REQUEST_APPEND') as Extract<DomainEvent, { type: 'REQUEST_APPEND' }>;
    expect(req2.batch).toBeUndefined();
  });
});
