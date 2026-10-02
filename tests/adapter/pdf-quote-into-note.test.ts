/**
 * 窓から届いた「ノートへ引く」を、本体が**親ノートの末尾へ追記**する(#275 段①)。
 *
 * 守るもの:①引く先は結びついたノート(無ければ添付自身)②書くのは**既存の追記**(`REQUEST_APPEND`)で、
 * 頁番号と添付名が引用に付く ③追記が断られる回(保存中 / 編集中)は**通ったことにしない**
 * ④窓の言い分(lid)を信じない(`session.lid` から本体が解く)。
 * ⚠ reducer と Dispatcher は**実物**(effect の書込は `REQUEST_APPEND` の発火までを見る)。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, reduce, type DomainEvent } from '../../src/adapter/state/app-state';
import { quoteIntoNote } from '../../src/adapter/platform/pdf/quote-into-note';
import type { PdfSession } from '../../src/adapter/platform/pdf/pdf-window';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';

function meta(lid: string, archetype: string, title = `題-${lid}`): EntryMeta {
  return {
    lid,
    title,
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
function rel(id: string, fromLid: string, toLid: string, kind: string): Relation {
  return { id, fromLid, toLid, kind, createdAt: null, updatedAt: null };
}

function rig(metas: EntryMeta[], relations: Relation[]): {
  d: Dispatcher;
  events: DomainEvent[];
  notes: string[];
} {
  const booted = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations }).state;
  const d = new Dispatcher(booted);
  const events: DomainEvent[] = [];
  d.onEvent((e) => events.push(e));
  return { d, events, notes: [] };
}
const session = (lid: string | null, name = '報告書.pdf'): PdfSession => ({
  token: 't',
  assetKey: 'k',
  name,
  lid,
});
const appended = (events: DomainEvent[]) =>
  events.filter((e): e is Extract<DomainEvent, { type: 'REQUEST_APPEND' }> => e.type === 'REQUEST_APPEND');

describe('quoteIntoNote', () => {
  it('結びついたノートの末尾へ、頁番号と添付名つきの引用として追記する', () => {
    const g = rig(
      [meta('att', 'attachment'), meta('memo', 'text', 'メモ')],
      [rel('r1', 'memo', 'att', 'semantic')],
    );
    const r = quoteIntoNote(g.d, session('att'), '結論は\n次のとおり', 7, (t) => g.notes.push(t));
    const ev = appended(g.events);
    expect(ev).toHaveLength(1);
    expect(ev[0]?.lid).toBe('memo');
    expect(ev[0]?.text).toBe('> 結論は\n> 次のとおり (p.7、報告書.pdf)');
    expect(ev[0]?.target).toBeNull(); // 末尾
    expect(r).toEqual({ ok: true, message: '「メモ」の末尾へ引きました(7 頁)' });
    expect(g.notes).toEqual(['「メモ」の末尾へ引きました(7 頁)']);
  });

  it('結びついたノートが無ければ、添付のノート自身へ追記する', () => {
    const g = rig([meta('att', 'attachment', '添付題')], []);
    const r = quoteIntoNote(g.d, session('att'), 'x', 1, (t) => g.notes.push(t));
    expect(appended(g.events)[0]?.lid).toBe('att');
    expect(r.ok).toBe(true);
  });

  it('頁番号を落とさない(出典の頁がそのまま本文に載る)', () => {
    const g = rig([meta('att', 'attachment')], []);
    quoteIntoNote(g.d, session('att'), 'x', 42, () => undefined);
    expect(appended(g.events)[0]?.text).toContain('(p.42、報告書.pdf)');
  });

  it('lid を持たない窓・消えたノート・空の選びは、書かずに理由を返す', () => {
    const g = rig([meta('att', 'attachment')], []);
    expect(quoteIntoNote(g.d, session(null), 'x', 1, () => undefined).ok).toBe(false);
    expect(quoteIntoNote(g.d, session('gone'), 'x', 1, () => undefined).ok).toBe(false);
    expect(quoteIntoNote(g.d, session('att'), '  \n ', 1, () => undefined).ok).toBe(false);
    expect(appended(g.events)).toEqual([]);
  });

  it('🔴 追記が断られる回(書込中)は、通ったことにしない ── 状態の行にも出さない', () => {
    const g = rig([meta('att', 'attachment')], []);
    const first = quoteIntoNote(g.d, session('att'), 'a', 1, (t) => g.notes.push(t));
    expect(first.ok).toBe(true);
    // 錠が掛かったまま(書込の結果がまだ戻っていない)2 つ目を引く
    const second = quoteIntoNote(g.d, session('att'), 'b', 1, (t) => g.notes.push(t));
    expect(second.ok).toBe(false);
    expect(second.message.length).toBeGreaterThan(0);
    expect(appended(g.events)).toHaveLength(1);
    expect(g.notes).toHaveLength(1);
  });

  it('編集中のノート自身へは引けない(別のノートへの追記は通る)', () => {
    const g = rig(
      [meta('att', 'attachment'), meta('memo', 'text', 'メモ')],
      [rel('r1', 'memo', 'att', 'semantic')],
    );
    // memo を編集中にする(`START_EDIT` の不変量どおり openBody を伴う)
    const st = g.d.getState();
    const editing = {
      ...st,
      phase: 'editing' as const,
      openBody: { lid: 'memo', body: 'x', baseline: 'x', persisted: 'x', diskAhead: false },
    };
    const d2 = new Dispatcher(editing);
    const ev: DomainEvent[] = [];
    d2.onEvent((e) => ev.push(e));
    const r = quoteIntoNote(d2, session('att'), 'x', 1, () => undefined);
    expect(r.ok).toBe(false);
    expect(appended(ev)).toEqual([]);
  });
});
