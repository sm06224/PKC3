/** @vitest-environment happy-dom */
/**
 * 🔴 閉じていないコードブロックの中へ、ノートの末尾に足さない(タイマーの記録・追記欄・PDF の引用・AI の書き足し)。
 *
 * ## user の物語
 * 本文がコードブロック(```)を閉じないまま終わっているノートで、タイマーを止める。⚠ 直す前は
 * 「書きました」と出たのに、足した 1 行は**コードの字になって画面に出なかった**。
 * いまは足さずに理由を出す(タイマーは計った時間も一緒に言う ── 失うのは時間だから)。
 *
 * ## 守るもの
 * ① 書込側(画面に本文が無いノート) ② 画面側(本文が出ているノート)③ 閉じていれば足す(対照群)
 * ④ 追記先の見出しを選んだ回は対象外 ⑤ `appendAndSettle` が理由を返す(タイマーの文面がそれを出す)
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { APPEND_OPEN_BLOCK_REFUSAL, APPEND_TEXT_OPEN_BLOCK_REFUSAL, type DomainEvent } from '../../src/adapter/state/app-state';
import { connectStoreEffects, type StorePort } from '../../src/adapter/state/store-effects';
import { appendAndSettle, appendAvailability } from '../../src/adapter/state/append-settle';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const tick = (ms = 10): Promise<unknown> => new Promise((r) => setTimeout(r, ms));
const meta = (lid: string): EntryMeta => ({
  lid, title: 't-' + lid, archetype: 'text', createdAt: null, updatedAt: null, entryOrder: 1,
  status: null, date: null, archived: false, bodyChars: null,
});

function bench(initial: string) {
  const disk: Record<string, string> = { a: initial };
  let writes = 0;
  const port = {
    ...stubRevisionOps(),
    getBody: async (lid: string) => disk[lid] ?? null,
    renameEntry: async () => stubStamps(),
    persistEntry: async (e: { lid: string; body: string }) => {
      writes += 1;
      disk[e.lid] = e.body;
      return stubStamps();
    },
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  } as unknown as StorePort;
  const d = new Dispatcher();
  const events: DomainEvent[] = [];
  d.onEvent((e) => events.push(e));
  connectStoreEffects(d, port);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
  return { d, disk, events, writes: () => writes };
}

const OPEN_FENCE = '手順\n\n```js\nlet a = 1;\n';
const OPEN_COLONS = ':::format{.pkc-place x=1 y=1}\nhello';

describe('末尾が閉じていないブロックの中へは足さない', () => {
  it('🔴 ① 書込側: 画面に本文が無いノートでも、disk の本文が開いたままなら足さず理由を出す', async () => {
    for (const body of [OPEN_FENCE, OPEN_COLONS]) {
      const b = bench(body);
      b.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'a', text: '- 10:00-10:30 作業', heading: null, target: null });
      await tick(30);
      expect(b.disk['a'], '足してしまった(コードの字になる)').toBe(body);
      expect(b.writes(), '書込が走った').toBe(0);
      expect(b.d.getState().error).toBe(APPEND_OPEN_BLOCK_REFUSAL);
      expect(b.d.getState().writeLock, '錠を握ったまま').toBeNull();
      expect(b.events.some((e) => e.type === 'APPEND_SETTLED' && !e.ok)).toBe(true);
    }
  });

  it('🔴 ② 画面側: 本文が出ているノートは押した時点で断る(書込の依頼を出さない)', () => {
    const b = bench(OPEN_FENCE);
    b.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    b.d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: OPEN_FENCE });
    b.events.length = 0;
    b.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'a', text: '追記', heading: null, target: null });
    expect(b.events.some((e) => e.type === 'REQUEST_APPEND')).toBe(false);
    expect(b.d.getState().error).toBe(APPEND_OPEN_BLOCK_REFUSAL);
  });

  it('⚠ ③ 対照群: 閉じていれば足す', async () => {
    const b = bench('手順\n\n```js\nlet a = 1;\n```\n');
    b.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'a', text: '追記した行', heading: null, target: null });
    await tick(30);
    expect(b.disk['a']).toContain('追記した行');
    expect(b.d.getState().error).toBeNull();
  });

  it('⚠ ④ 追記先の見出しを選んだ回は、この門の対象外(末尾へ足す回だけ断る)', async () => {
    const body = '# 決定事項\n\n中身\n\n```js\nlet a = 1;\n';
    const b = bench(body);
    b.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'a', text: '追記した行', heading: null, target: { slug: 'x', level: 1 } as never });
    await tick(30);
    expect(b.d.getState().error, '末尾へ足す回の断り文が出た').not.toBe(APPEND_OPEN_BLOCK_REFUSAL);
  });

  it('🔴 ⑤ appendAndSettle が理由を返す(タイマーは計った時間と一緒に出す)', async () => {
    const b = bench(OPEN_FENCE);
    const r = await appendAndSettle(b.d, 'a', '- 作業', null, 500);
    expect(r).toEqual({ ok: false, reason: 'failed', error: APPEND_OPEN_BLOCK_REFUSAL });
  });
});

describe('🔴 足す文そのものが閉じていないブロックで終わるなら足さない(以後の追記が全部断られるのを防ぐ)', () => {
  it('本文は閉じているのに、足す文が ``` / ~~~ / ::: を開いたまま終わる回は断り、本文は変わらない', async () => {
    for (const text of ['説明\n```js\nlet a = 1;', '~~~\nx', ':::format{.pkc-place x=1 y=1}\nhello']) {
      const b = bench('手順\n');
      b.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'a', text, heading: null, target: null });
      await tick(30);
      expect(b.disk['a'], text).toBe('手順\n');
      expect(b.writes()).toBe(0);
      expect(b.d.getState().error).toBe(APPEND_TEXT_OPEN_BLOCK_REFUSAL);
      expect(b.d.getState().writeLock, '錠を握ったまま').toBeNull();
    }
  });

  it('⚠ 対照群: 自分で閉じている文は足せ、その後の追記も通る(詰まない)', async () => {
    const b = bench('手順\n');
    b.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'a', text: '```js\nlet a = 1;\n```', heading: null, target: null });
    await tick(30);
    expect(b.disk['a']).toContain('let a = 1;');
    b.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'a', text: '次の行', heading: null, target: null });
    await tick(30);
    expect(b.disk['a']).toContain('次の行');
  });

  it('appendAndSettle(AI の書き足しの口)が理由を返す', async () => {
    const b = bench('手順\n');
    const r = await appendAndSettle(b.d, 'a', '```\nx', null, 500);
    expect(r).toEqual({ ok: false, reason: 'failed', error: APPEND_TEXT_OPEN_BLOCK_REFUSAL });
  });
});

describe('🔴 A5: appendAvailability ── 投げる前に断りを見る(user の画面のエラーを汚さない)', () => {
  it('在る=ok / 無い=gone / 編集中の自分のノート=busy(別のノートは ok)/ 書込中=busy。見るだけで state.error を立てない', () => {
    const b = bench('x');
    expect(appendAvailability(b.d.getState(), 'a')).toBe('ok');
    expect(appendAvailability(b.d.getState(), 'zzz')).toBe('gone');
    b.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    b.d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: 'x' });
    b.d.dispatch({ type: 'START_EDIT' });
    expect(b.d.getState().phase, '前提: 編集に入った').toBe('editing');
    expect(appendAvailability(b.d.getState(), 'a')).toBe('busy');
    expect(b.d.getState().error, '見ただけで画面にエラーが出た').toBeNull();
  });
});
