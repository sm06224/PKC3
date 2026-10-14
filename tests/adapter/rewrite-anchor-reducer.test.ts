/** @vitest-environment happy-dom */
/**
 * 🔴 **書換の目印を運ぶ reducer の口 + 閉じていないブロックの断り**(#1087)。
 *
 * ① `MOVE_BLOCK` / `UNDO_MOVE` / `INSERT_LINES` が、落とし先の行(`toBeforeLine`)/ 落とした所の目印
 *    (`anchor`)を書換へ運ぶ
 * ② 閉じていない付箋・線の「消す」/ 後ろに閉じていないブロックがある本文での線引きは、
 *    **押した時点で本当の理由を言う**(書込側の断りは「本文が変わっている(開き直してください)」で、
 *    開き直しても直らない)。判定は書込側と同じ関数(`placeBlockUnclosed` / `endsInsideOpenBlock`)
 *
 * 観測点は reducer の戻り(`events` と `state.error`)。対照群は同じ台で「閉じていれば通る」。
 */
import { describe, expect, it } from 'vitest';
import {
  initialState,
  PLACE_CONNECT_OPEN_REFUSAL,
  PLACE_LINE_REMOVE_OPEN_REFUSAL,
  PLACE_REMOVE_OPEN_REFUSAL,
  reduce,
  type AppState,
  type Dispatchable,
} from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { applyBodyRewrite, type BodyRewrite } from '../../src/features/markdown/body-rewrite';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const meta = (lid: string): EntryMeta => ({
  lid,
  title: lid,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

function stateWith(body: string): AppState {
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  return d.getState();
}

const rewriteOf = (events: readonly { type: string }[]): BodyRewrite | null => {
  const ev = events.find((e) => e.type === 'REQUEST_BODY_REWRITE') as { rewrite: BodyRewrite } | undefined;
  return ev === undefined ? null : ev.rewrite;
};

describe('MOVE_BLOCK / UNDO_MOVE / INSERT_LINES が目印を運ぶ', () => {
  const BODY = ['# 題', '', '段落 A', '', '段落 B', '', '段落 C', ''].join('\n');

  it('🔴 MOVE_BLOCK:落とし先の行の中身を、画面の本文から捕える', () => {
    const r = reduce(stateWith(BODY), { type: 'MOVE_BLOCK', lid: 'n1', start: 2, end: 2, toBefore: 6 });
    expect(rewriteOf(r.events)).toMatchObject({ kind: 'move-lines', toBefore: 6, toBeforeLine: '段落 C' });
  });

  it('🔴 MOVE_BLOCK:末尾(行数と等しい toBefore)は null ── 範囲の外は撃たない', () => {
    const n = BODY.split('\n').length;
    expect(rewriteOf(reduce(stateWith(BODY), { type: 'MOVE_BLOCK', lid: 'n1', start: 2, end: 2, toBefore: n }).events)).toMatchObject({
      toBefore: n,
      toBeforeLine: null,
    });
    expect(
      rewriteOf(reduce(stateWith(BODY), { type: 'MOVE_BLOCK', lid: 'n1', start: 2, end: 2, toBefore: n + 1 }).events),
      '範囲外の落とし先で撃った',
    ).toBeNull();
  });

  it('🔴 UNDO_MOVE:覚えていた落とし先の行を、そのまま運ぶ', () => {
    const s: AppState = {
      ...stateWith(BODY),
      lastMove: { lid: 'n1', start: 2, end: 2, toBefore: 6, lines: ['段落 A'], toBeforeLine: '段落 C' },
    };
    expect(rewriteOf(reduce(s, { type: 'UNDO_MOVE' }).events)).toMatchObject({
      kind: 'move-lines',
      toBeforeLine: '段落 C',
    });
  });

  it('🔴 INSERT_LINES:落とした所の目印を書換へ載せる', () => {
    const anchor = { line: 2, text: '段落 A' };
    const r = reduce(stateWith(BODY), {
      type: 'INSERT_LINES',
      lid: 'n1',
      toBefore: 2,
      lines: ['[相手](entry:n2)'],
      anchor,
    });
    expect(rewriteOf(r.events)).toMatchObject({ kind: 'insert-lines', anchor });
  });
});

describe('閉じていない付箋・線の「消す」は、押した時点で理由を言う', () => {
  const CLOSED = ':::format{.pkc-place x=0 y=0 w=100 h=60}\nA\n:::\n';
  const UNCLOSED = ':::format{.pkc-place x=0 y=0 w=100 h=60}\nA\n'; // 閉じが無い = 末尾まで飲む
  const LINE_CLOSED = ':::format{.pkc-line from=a to=b}\n:::\n';
  const LINE_UNCLOSED = ':::format{.pkc-line from=a to=b}\n';
  const act = (body: string, action: Dispatchable) => reduce(stateWith(body), action);

  it('🔴 付箋:閉じていなければ、書込を頼まず理由を出す(書込側の断りは開き直しても直らない)', () => {
    // 前提:書込側(`applyBodyRewrite`)はこの形を断る ── 断る理由が実在する
    expect(
      applyBodyRewrite(UNCLOSED, { kind: 'place-remove', line: 0, openLine: UNCLOSED.split('\n')[0]! }),
    ).toBeNull();
    const r = act(UNCLOSED, { type: 'REMOVE_PLACE', lid: 'n1', line: 0 });
    expect(r.events, '閉じていないのに書込を頼んだ').toEqual([]);
    expect(r.state.error).toBe(PLACE_REMOVE_OPEN_REFUSAL);
    // 対照群 ── 閉じていれば頼む
    const ok = act(CLOSED, { type: 'REMOVE_PLACE', lid: 'n1', line: 0 });
    expect(rewriteOf(ok.events)).toMatchObject({ kind: 'place-remove', line: 0 });
    expect(ok.state.error ?? null).toBeNull();
  });

  it('🔴 線:閉じていなければ理由を出す / 対照群は閉じていれば頼む', () => {
    const r = act(LINE_UNCLOSED, { type: 'REMOVE_PLACE_LINE', lid: 'n1', line: 0 });
    expect(r.events).toEqual([]);
    expect(r.state.error).toBe(PLACE_LINE_REMOVE_OPEN_REFUSAL);
    expect(rewriteOf(act(LINE_CLOSED, { type: 'REMOVE_PLACE_LINE', lid: 'n1', line: 0 }).events)).toMatchObject({
      kind: 'place-line-remove',
    });
  });

  it('⚠ 付箋と線の字は取り違えない(押した物の名前で言う)', () => {
    expect(PLACE_REMOVE_OPEN_REFUSAL).toContain('付箋');
    expect(PLACE_LINE_REMOVE_OPEN_REFUSAL).toContain('線');
    expect(PLACE_REMOVE_OPEN_REFUSAL).not.toBe(PLACE_LINE_REMOVE_OPEN_REFUSAL);
  });
});

describe('後ろに閉じていないブロックがある本文での線引きは、押した時点で理由を言う', () => {
  const TWO = [
    ':::format{.pkc-place x=0 y=0 w=100 h=60}', // 0
    '左',
    ':::',
    '',
    ':::format{.pkc-place x=300 y=0 w=100 h=60}', // 4
    '右',
    ':::',
    '',
  ].join('\n');
  const connect = (body: string) =>
    reduce(stateWith(body), {
      type: 'CONNECT_PLACE',
      lid: 'n1',
      line: 0,
      toLine: 4,
      fromAnchor: null,
      toAnchor: null,
    });

  it('🔴 末尾に閉じていない ``` が在れば、書込を頼まず理由を出す', () => {
    const tail = `${TWO}\n\`\`\`\nコード\n`;
    // 前提:書込側(`applyBodyRewrite`)はこの形の線引きを断る
    const rw = {
      kind: 'place-connect' as const,
      from: { line: 0, openLine: TWO.split('\n')[0]! },
      to: { line: 4, openLine: TWO.split('\n')[4]! },
      fromAnchor: null,
      toAnchor: null,
    };
    expect(applyBodyRewrite(tail, rw)).toBeNull();
    const r = connect(tail);
    expect(r.events, '閉じていないのに書込を頼んだ').toEqual([]);
    expect(r.state.error).toBe(PLACE_CONNECT_OPEN_REFUSAL);
    // 対照群 ── 閉じていれば頼む
    expect(rewriteOf(connect(TWO).events)).toMatchObject({ kind: 'place-connect' });
  });

  it('編集中の断りは、そちらの理由を残す(閉じていない理由で上書きしない)', () => {
    const tail = `${TWO}\n\`\`\`\nコード\n`;
    const s = { ...stateWith(tail), phase: 'editing' as const, openBody: { ...stateWith(tail).openBody!, lid: 'n1' } };
    const r = reduce(s, { type: 'CONNECT_PLACE', lid: 'n1', line: 0, toLine: 4, fromAnchor: null, toAnchor: null });
    expect(r.events).toEqual([]);
    expect(r.state.error, '編集中の理由が消えた').not.toBe(PLACE_CONNECT_OPEN_REFUSAL);
    expect(r.state.error ?? '').not.toBe('');
    expect(initialState.error ?? null).toBeNull();
  });
});
