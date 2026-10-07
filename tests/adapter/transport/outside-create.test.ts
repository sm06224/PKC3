/** @vitest-environment happy-dom */
/**
 * ノートを外から作る道 ── `pkc.createEntry`(C-4 / C-3)も AI の `pkc_create_note` も通る 1 本(#1407)。
 *
 * 本物の `Dispatcher` + reducer で通す(`CREATE_ENTRY` が何を動かし、何を断るかは reducer の仕事)。
 *
 * 守る主張:
 * 1. 🔴 許可した相手(origin)は、読んでいる本文・選択・絞り込みを動かさない(編集中でも作れて、編集は続く)
 * 2. 🔴 本当に作られたかを見る ── 作られていなければ null を返し、知らせも出さない
 * 3. 合図の相手(capture)は目の前へ編集の形で出す(従来どおり)
 * 4. 知らせの字: AI は「作りました」/ C-4 の origin は「取り込みました」のまま。「開く」が付く
 */
import { describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '@core/model/entry-meta';
import { Dispatcher } from '@adapter/state/dispatcher';
import {
  AGENT_ORIGIN_LABEL,
  createEntryFromOutside,
  outsideCreatedText,
  type OutsideCreateDeps,
} from '@adapter/transport/outside-create';

const meta = (lid: string, title: string): EntryMeta => ({
  lid,
  title,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: 0,
});

function booted(): Dispatcher {
  const d = new Dispatcher();
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a', '議事録'), meta('b', '資料')] as never,
    relations: [],
  });
  return d;
}

function depsOf(d: Dispatcher, lids: string[] = ['new1', 'rel1']) {
  const notified: string[] = [];
  let i = 0;
  const deps: OutsideCreateDeps = {
    dispatch: (a) => d.dispatch(a),
    hasEntry: (lid) => d.getState().entryMetas.has(lid),
    notifyOpen: (m, lid) => d.dispatch({ type: 'OP_NOTICE', message: m, open: lid }),
    notify: (m) => void notified.push(m),
    generateLid: () => lids[i++] ?? `gen${String(i)}`,
  };
  return { deps, notified };
}

const INPUT = { title: '外から', body: '本文です' };

describe('createEntryFromOutside', () => {
  it('🔴 許可した相手(origin)は、読んでいる本文・選択・絞り込みを動かさない', () => {
    const d = booted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '# A\n' });
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '議' });
    const before = d.getState();
    const { deps } = depsOf(d);
    const lid = createEntryFromOutside(deps, INPUT, 'https://a.test', 'origin');
    const after = d.getState();
    expect(lid).toBe('new1');
    expect(after.entryMetas.get('new1')?.title).toBe('外から');
    expect(after.selectedLid, '読んでいる本文が新しいノートへ退いた').toBe('a');
    expect(after.openBody).toBe(before.openBody);
    expect(after.filterQuery, '絞り込みが外れた').toBe('議');
    expect(after.phase).toBe('ready');
  });

  it('🔴 AI(origin)も同じ ── 編集中でも作れて、編集は続く(編集中だと黙って作られない、を起こさない)', () => {
    const d = booted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '# A\n' });
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '台の前提: 編集中になっていない').toBe('editing');
    const { deps } = depsOf(d);
    const lid = createEntryFromOutside(deps, INPUT, AGENT_ORIGIN_LABEL, 'origin');
    expect(lid).toBe('new1');
    expect(d.getState().entryMetas.has('new1')).toBe(true);
    expect(d.getState().phase, '編集が止まった').toBe('editing');
    expect(d.getState().selectedLid).toBe('a');
  });

  it('🔴 本当に作られたかを見る: 作られなければ null を返し、知らせも出さない', () => {
    // 起動の途中(SYS_BOOTED の前)── reducer は何も言わずに断る
    const d = new Dispatcher();
    const { deps, notified } = depsOf(d);
    expect(createEntryFromOutside(deps, INPUT, AGENT_ORIGIN_LABEL, 'origin')).toBeNull();
    expect(createEntryFromOutside(deps, INPUT, 'https://a.test', 'capture')).toBeNull();
    expect(d.getState().notice).toBeNull();
    expect(notified).toEqual([]);
  });

  it('ID が既存と衝突して作られなかったときも null(防波堤)', () => {
    const d = booted();
    const { deps } = depsOf(d, ['a', 'rel1']);
    expect(createEntryFromOutside(deps, INPUT, AGENT_ORIGIN_LABEL, 'origin')).toBeNull();
    expect(d.getState().notice).toBeNull();
  });

  it('知らせ: AI は「作りました」/ C-4 の origin は「取り込みました」。「開く」の相手は作ったノート', () => {
    const d = booted();
    const { deps } = depsOf(d, ['n1', 'r1', 'n2', 'r2']);
    createEntryFromOutside(deps, INPUT, AGENT_ORIGIN_LABEL, 'origin');
    expect(d.getState().notice).toBe('ブラウザの AI がノートを作りました:『外から』');
    expect(d.getState().noticeOpen).toBe('n1');
    createEntryFromOutside(deps, INPUT, 'https://a.test', 'origin');
    expect(d.getState().notice).toBe('https://a.test から 1 件取り込みました:『外から』');
    expect(d.getState().noticeOpen).toBe('n2');
  });

  it('🔴 合図の相手(capture)は目の前へ編集の形で出す。「開く」は付けず、従来の字のまま', () => {
    const d = booted();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    const { deps, notified } = depsOf(d);
    const lid = createEntryFromOutside(deps, INPUT, 'https://news.test', 'capture');
    expect(lid).toBe('new1');
    const st = d.getState();
    expect(st.selectedLid, '合図の相手は新しいノートが目の前に出る').toBe('new1');
    expect(st.phase).toBe('editing');
    expect(notified).toEqual(['https://news.test から取り込みました。保存すると残ります:『外から』']);
    expect(st.notice, 'capture に「開く」の知らせが付いた').toBeNull();
  });

  it('作った中身(題名・本文)がそのまま入る', () => {
    const d = booted();
    const { deps } = depsOf(d);
    const dispatch = vi.spyOn(deps, 'dispatch');
    createEntryFromOutside(deps, INPUT, AGENT_ORIGIN_LABEL, 'origin');
    expect(dispatch.mock.calls[0]![0]).toMatchObject({
      type: 'CREATE_ENTRY',
      archetype: 'text',
      title: '外から',
      body: '本文です',
      keepSelection: true,
      edit: false,
    });
  });

  it('知らせの字は純関数でも同じ', () => {
    expect(outsideCreatedText(AGENT_ORIGIN_LABEL, 'origin', 'x')).toBe('ブラウザの AI がノートを作りました:『x』');
    expect(outsideCreatedText('o', 'capture', 'x')).toContain('保存すると残ります');
    expect(outsideCreatedText('o', 'origin', 'x')).toBe('o から 1 件取り込みました:『x』');
  });
});
