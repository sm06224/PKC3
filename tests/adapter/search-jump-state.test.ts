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
    expect(s.searchJump).toEqual({ lid: 'a', query: '会議', step: 0, gen: 1, origin: 'find' });
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

/**
 * 🔴 **左の列の欄に語が入っている間に行を押す = もう 1 つの起点**(#1102 段②。Gemini 裁定 = A)
 *
 * user から見た物語:左の列の欄に語を打って絞る → 当たったノートの行を押す → 本文が「探す」から
 * 開いたときと同じように、当たった語の所へ送られて塗られる。**欄の語を消すと塗りも消える**。
 * 「探す」から来た塗りは、欄を触っても消えない(欄は持ち主ではない)。
 *
 * ⚠ 段①の部品(`searchJump` / 帯 / 描画)をそのまま使う ── ここで見るのは「起点が増えた」ことと
 *   「消え方が起点で違う」ことだけ。
 */
describe('🔴 左の列の欄の語で始まる(段②)', () => {
  const typed = (s: AppState, q: string): AppState =>
    reduce(s, { type: 'SET_ENTRY_FILTER', query: q }).state;
  const press = (s: AppState, lid: string): AppState =>
    reduce(s, { type: 'SELECT_ENTRY', lid }).state;

  it('欄に語がある間に別のノートの行を押すと、「探す」と同じ形の控えができる(語は整える・起点は filter)', () => {
    const s = press(typed(opened(), '  議事録  '), 'b');
    expect(s.selectedLid, '前提: 押した行が開いている').toBe('b');
    expect(s.searchJump).toEqual({ lid: 'b', query: '議事録', step: 0, gen: 1, origin: 'filter' });
  });

  it('🔴 対照群: 欄が空 / 空白だけなら撃たない(「探す」から来た塗りにも触らない)', () => {
    expect(press(opened(), 'b').searchJump).toBeNull();
    expect(press(typed(opened(), '   '), 'b').searchJump).toBeNull();
    const found = start(opened()); // 探す起点で a を塗っている
    expect(press(found, 'a').searchJump, '空の欄で同じ行を押しても、探す起点の塗りは残る').toBe(
      found.searchJump,
    );
  });

  it('`>` で始まる欄は操作を探している ── 本文の語ではないので塗らない', () => {
    expect(press(typed(opened(), '>保存'), 'b').searchJump).toBeNull();
    expect(press(typed(opened(), '＞保存'), 'b').searchJump).toBeNull();
  });

  it('🔴 欄に打っただけでは塗らない(開いているノートがあっても、「行を押す」が起点)', () => {
    const s = typed(opened(), '会議');
    expect(s.selectedLid, '前提: ノートは開いている').toBe('a');
    expect(s.searchJump).toBeNull();
  });

  it('🔴 本文が畳まれている面(探す面)では撃たない / 本文へ戻る面(設定)では撃つ', () => {
    const inSearch = { ...typed(opened(), '会議'), viewMode: 'search' as const };
    const stay = press(inSearch, 'b');
    expect(stay.viewMode, '前提: 探す面は行を押しても中央に留まる').toBe('search');
    expect(stay.searchJump, '見えない本文には塗らない').toBeNull();
    const inSettings = { ...typed(opened(), '会議'), viewMode: 'settings' as const };
    const back = press(inSettings, 'b');
    expect(back.viewMode, '前提: 設定は行を押すと本文へ戻る').toBe('detail');
    expect(back.searchJump).toMatchObject({ lid: 'b', origin: 'filter' });
  });

  it('断られた選択では撃たない(編集中は行を押しても動かない / 塗らない)', () => {
    const editing = reduce(typed(opened(), '会議'), { type: 'START_EDIT' }).state;
    const r = reduce(editing, { type: 'SELECT_ENTRY', lid: 'b' });
    expect(r.state.selectedLid, '前提: 断られて動いていない').toBe('a');
    expect(r.state, '断られた押しは state を参照ごと動かさない').toBe(editing);
    expect(r.state.searchJump).toBeNull();
    expect(r.state.notice, '行を押しただけで「編集を終えると…」を出さない').toBeNull();
  });

  it('すでに開いている行をもう一度押すと、世代が進む(同じ語でも送り直せる)', () => {
    const once = press(typed(opened(), '会議'), 'a');
    expect(once.searchJump).toMatchObject({ origin: 'filter', gen: 1 });
    expect(press(once, 'a').searchJump).toMatchObject({ origin: 'filter', gen: 2 });
  });

  it('🔴 欄の語を消すと塗りも消える(語を消す / 空白だけにする、どちらでも)', () => {
    const s = press(typed(opened(), '会議'), 'a');
    expect(s.searchJump, '前提: 塗っている').not.toBeNull();
    expect(typed(s, '').searchJump).toBeNull();
    expect(typed(s, '   ').searchJump, '空白だけも「空」').toBeNull();
    expect(typed(s, '会').searchJump, '対照群: 別の語に変えただけなら消えない').not.toBeNull();
  });

  it('🔴 「探す」起点の塗りは、欄の語を消しても残る(欄は持ち主ではない)', () => {
    const found = start(typed(opened(), '会議')); // 欄に語が在るまま、探すから塗る
    expect(found.searchJump?.origin).toBe('find');
    expect(typed(found, '').searchJump, '欄を空にしても残る').toMatchObject({ origin: 'find' });
  });

  it('🔴 後に押した起点が勝つ(塗りは 1 つ)', () => {
    const byField = press(typed(opened(), '会議'), 'a');
    const byFind = start(byField, 'a', '議事録');
    expect(byFind.searchJump).toMatchObject({ origin: 'find', query: '議事録', gen: 2 });
    // 逆順:探す起点の塗りの上で、欄の語で行を押すと欄が勝つ
    const back = press(byFind, 'a');
    expect(back.searchJump).toMatchObject({ origin: 'filter', query: '会議', gen: 3 });
  });

  it('送り(‹ ›)は起点を保つ(欄起点の塗りは、送っても欄起点のまま)', () => {
    const s = reduce(press(typed(opened(), '会議'), 'a'), { type: 'SEARCH_JUMP_STEP', by: 1 }).state;
    expect(s.searchJump).toMatchObject({ origin: 'filter', step: 1 });
    expect(typed(s, '').searchJump).toBeNull();
  });
});
