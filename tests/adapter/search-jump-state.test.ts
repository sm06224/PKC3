/**
 * 🔴 **「探す」から本文の当たった所へ送る ── 控え(`state.searchJump`)の寿命**(#1102 段①)。
 *
 * ## user から見た物語
 *
 * 「探す」で押した行のノートが開き、当たった語が塗られて「1/4 件 ‹ ›」が出る。
 * ‹ › で送り、× か `Esc` で消す。**ノートを変えたら / 編集を始めたら消える**
 * (塗りが別のノートの本文に残ったり、書いている最中の本文に塗りが乗ったりしない)。
 *
 * ## 守るもの
 *
 * ① 選んでいるノートのときだけ始まる / 読む画面(`ready`)のときだけ / 空の語では始まらない
 * ② 送りは**進んだ回数**を積む(数で畳むのは描く側)/ 世代が進む(同じ語でもう一度でも送り直せる)
 * ③ 🔴 **消えるのは「結果の形」で決まる** ── 選択が動く / 編集に入る / 章の欄が開く、**どの経路でも**
 *    (`reduce()` の外側 1 か所)。個別の action を見張っていないことを、複数の経路で見る
 * ④ 断る回は state を 1 ビットも動かさない(参照も同じ)。⚠ **例外は「そのノートを編集中」**
 *    ── 黙って捨てず `notice` に 1 行置く(#1206 D9)
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';

const meta = (lid: string): EntryMeta => ({
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
});

/** a を開いて本文が届いた状態(b も在る)。 */
function opened(): AppState {
  let s = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a'), meta('b')],
    relations: [],
  }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
  return reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '会議の議事録' }).state;
}

const start = (s: AppState, lid = 'a', query = '会議'): AppState =>
  reduce(s, { type: 'SEARCH_JUMP_START', lid, query }).state;

describe('SEARCH_JUMP_START: 始まる条件', () => {
  it('🔴 選んでいるノートで始まる(語は整える・世代 1・送り 0)', () => {
    const s = start(opened(), 'a', '  会議  ');
    expect(s.searchJump).toEqual({ lid: 'a', query: '会議', step: 0, gen: 1 });
  });

  it('🔴 選んでいないノートには塗らない(対照群: 選んでいる a は始まる)', () => {
    const before = opened();
    expect(start(before, 'a').searchJump).not.toBeNull();
    const refused = reduce(before, { type: 'SEARCH_JUMP_START', lid: 'b', query: '会議' });
    expect(refused.state, '断る回は state を動かさない(参照ごと同じ)').toBe(before);
  });

  it('🔴 編集中は塗らない ── 黙らず、画面下の 1 行で理由を言う(#1206 D9)', () => {
    const editing = reduce(opened(), { type: 'START_EDIT' }).state;
    expect(editing.phase, '前提: 編集に入っている').toBe('editing');
    expect(editing.notice, '前提: 直前まで知らせは無い').toBeNull();
    const r = reduce(editing, { type: 'SEARCH_JUMP_START', lid: 'a', query: '会議' });
    expect(r.state.searchJump, '塗らない').toBeNull();
    expect(r.state.notice).toBe('編集を終えると、当たった所に色が付きます');
    expect(r.state.phase, '編集は続く').toBe('editing');
  });

  it('🔴 知らせるのは「そのノートを編集中」のときだけ(対照群: 読む画面・別のノート・空の語は知らせない)', () => {
    const ready = opened();
    expect(ready.phase, '前提: 読む画面').toBe('ready');
    expect(start(ready).notice, 'ready なら塗れるので知らせない').toBeNull();
    const editing = reduce(ready, { type: 'START_EDIT' }).state;
    // 別のノート宛て ── 塗れない理由は画面に既に在る。黙って参照ごと同じ
    const other = reduce(editing, { type: 'SEARCH_JUMP_START', lid: 'b', query: '会議' });
    expect(other.state).toBe(editing);
    // 空の語 ── 言う意味が無い
    const blank = reduce(editing, { type: 'SEARCH_JUMP_START', lid: 'a', query: '  ' });
    expect(blank.state).toBe(editing);
  });

  it('空の語・空白だけの語では始まらない', () => {
    const before = opened();
    expect(reduce(before, { type: 'SEARCH_JUMP_START', lid: 'a', query: '' }).state).toBe(before);
    expect(reduce(before, { type: 'SEARCH_JUMP_START', lid: 'a', query: '   ' }).state).toBe(before);
  });

  it('🔴 もう一度始めると世代が進む(同じ語でも、同じ位置へ送り直せる)', () => {
    const once = start(opened());
    const twice = start(once);
    expect(twice.searchJump?.gen).toBe(2);
    expect(twice.searchJump?.step).toBe(0);
  });
});

describe('SEARCH_JUMP_STEP / END', () => {
  it('次 / 前は進んだ回数を積み、世代を進める(負にもなる ── 畳むのは描く側)', () => {
    let s = start(opened());
    s = reduce(s, { type: 'SEARCH_JUMP_STEP', by: 1 }).state;
    s = reduce(s, { type: 'SEARCH_JUMP_STEP', by: 1 }).state;
    expect(s.searchJump).toMatchObject({ step: 2, gen: 3 });
    s = reduce(s, { type: 'SEARCH_JUMP_STEP', by: -1 }).state;
    s = reduce(s, { type: 'SEARCH_JUMP_STEP', by: -1 }).state;
    s = reduce(s, { type: 'SEARCH_JUMP_STEP', by: -1 }).state;
    expect(s.searchJump).toMatchObject({ step: -1, gen: 6 });
  });

  it('塗っていないときの送りは何もしない(参照ごと同じ)', () => {
    const before = opened();
    expect(reduce(before, { type: 'SEARCH_JUMP_STEP', by: 1 }).state).toBe(before);
  });

  it('終わりは控えを消す。塗っていなければ何もしない', () => {
    const s = start(opened());
    expect(reduce(s, { type: 'SEARCH_JUMP_END' }).state.searchJump).toBeNull();
    const before = opened();
    expect(reduce(before, { type: 'SEARCH_JUMP_END' }).state).toBe(before);
  });
});

describe('🔴 控えは「結果の形」で消える(どの経路でも)', () => {
  it('別のノートを選ぶと消える(対照群: 同じノートを選び直しても残る)', () => {
    const s = start(opened());
    expect(reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state.searchJump).not.toBeNull();
    expect(reduce(s, { type: 'SELECT_ENTRY', lid: 'b' }).state.searchJump).toBeNull();
  });

  it('選択を外す経路(`DESELECT_ENTRY`)でも消える ── 個別の case を見張っていない', () => {
    const s = start(opened());
    expect(reduce(s, { type: 'DESELECT_ENTRY' }).state.searchJump).toBeNull();
  });

  it('編集に入ると消える', () => {
    const s = start(opened());
    const editing = reduce(s, { type: 'START_EDIT' }).state;
    expect(editing.phase, '前提: 編集に入っている').toBe('editing');
    expect(editing.searchJump).toBeNull();
  });

  it('編集をやめて戻っても塗りは戻らない(消えたままで、勝手に再開しない)', () => {
    let s = start(opened());
    s = reduce(s, { type: 'START_EDIT' }).state;
    s = reduce(s, { type: 'CANCEL_EDIT' }).state;
    expect(s.phase).toBe('ready');
    expect(s.searchJump).toBeNull();
  });

  it('章の欄を開くと消える(読む画面の一部が編集の欄になる)', () => {
    const s = start(opened());
    const withDraft = {
      ...s,
      sectionDraft: { lid: 'a', heading: '見出し', original: '', saving: false },
    } as unknown as AppState;
    // 別の action(控えに無関係)を 1 つ通すだけで、結果の形を見て消える
    const r = reduce(withDraft, { type: 'SEARCH_JUMP_STEP', by: 1 });
    expect(r.state.searchJump).toBeNull();
  });
});
