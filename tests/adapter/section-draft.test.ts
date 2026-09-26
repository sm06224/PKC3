/** @vitest-environment happy-dom */
/**
 * 🔴 **章だけの下書き ── reducer(#1044 段2)**。
 *
 * ⚠ ここは**純粋な reducer だけ**を見る(DOM は見ない) ── 箱の DOM への
 * 差し込みは `tests/adapter/section-box-flow.test.ts` と実ブラウザ smoke が見る。
 *
 * 観測点は「開く / 保存する / 保存が断られる / やめる」で state がどう動くか、
 * および「章の欄が開いている間、他の書込がどう扱われるか」(#1043 の門の拡張)。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import {
  bodyWriteBlockReason,
  guardSectionDraftTransition,
  hasUnsavedTyping,
  initialState,
  reduce,
  SECTION_DRAFT_CLOSED_BY_SYSTEM_NOTICE,
  SECTION_DRAFT_NOTE,
  SECTION_SAVE_MISMATCH_NOTE,
  unsavedTypingLidOf,
  type AppState,
  type Dispatchable,
} from '../../src/adapter/state/app-state';

function meta(lid: string): EntryMeta {
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
  };
}

const DOC = [
  '# 議事録', // line 0
  '', // 1
  '前置き。', // 2
  '', // 3
  '## 決定事項', // 4
  '', // 5
  '- 牛乳を買う', // 6
  '', // 7
  '## 次回', // 8
  '', // 9
  '来週。', // 10
].join('\n');

/** SYS_BOOTED → SELECT_ENTRY → BODY_LOADED まで進めた state(`n1` を開いている)。 */
function booted(body = DOC, lids: readonly string[] = ['n1', 'n2']): AppState {
  let s = reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: lids.map(meta),
    relations: [],
  }).state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state;
  return reduce(s, { type: 'BODY_LOADED', lid: 'n1', body }).state;
}

describe('OPEN_SECTION_DRAFT(#1044 段2)', () => {
  it('🔴 押した見出しの行から、章を控える(見出し行を含む・次の見出しの手前まで)', () => {
    const s = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    expect(s.sectionDraft, '下書きが開いていない').not.toBeNull();
    expect(s.sectionDraft!.lid).toBe('n1');
    expect(s.sectionDraft!.heading).toBe('決定事項');
    expect(s.sectionDraft!.original).toBe(['## 決定事項', '', '- 牛乳を買う', ''].join('\n'));
    // ⚠ アプリ全体は編集中にならない(設計 doc の中核の主張)
    expect(s.phase).toBe('ready');
  });

  it('🔴 末尾の章(次の見出しが無い)は、本文の末尾まで控える', () => {
    const s = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 8 }).state;
    expect(s.sectionDraft!.heading).toBe('次回');
    expect(s.sectionDraft!.original).toBe(['## 次回', '', '来週。'].join('\n'));
  });

  it('🔴 見出しが引けない行を押しても、断って開かない(見出しが 1 つも無い本文)', () => {
    const s = reduce(booted('ただの段落だけの本文です。\n'), {
      type: 'OPEN_SECTION_DRAFT',
      lid: 'n1',
      line: 0,
    }).state;
    expect(s.sectionDraft, '見出しが無いのに開いた').toBeNull();
    expect(s.error ?? '', '断った理由が出ていない').toContain('章の範囲を読めませんでした');
  });

  it('🔴 phase が ready でなければ開かない(無言で何もしない)', () => {
    const editing = reduce(booted(), { type: 'START_EDIT' }).state;
    const s = reduce(editing, { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    expect(s.sectionDraft).toBeNull();
  });

  it('🔴 openBody が別のノートを持っているときは開かない', () => {
    const s = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n2', line: 4 }).state;
    expect(s.sectionDraft).toBeNull();
  });

  /**
   * 🔴 **二重に開かない。ただし無言にしない**(#1044 段2、F-E)。
   *
   * ⚠ 直す前は無言で何もしなかった(`{ state, events: [] }`)── 同じノートの
   *   **別の見出し**で「この章を編集する」を押すと、押した人には何も起きない
   *   ように見えた(dead click)。binder(`startSectionEditAt`)が
   *   `leaveSectionDraftOrAsk` と同じ 3 択を先に通すので、ここへ来るのは
   *   **その門を通らずに撃った**とき(防波堤) ── だから可視の理由を出す。
   */
  it('🔴 二重に開かない。可視の理由を出す(#1044 段2、F-E)', () => {
    const opened = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    const again = reduce(opened, { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 8 });
    // ⚠ 1 つ目の章のまま(2 つ目の章に差し替わっていない)
    expect(again.state.sectionDraft!.heading).toBe('決定事項');
    expect(again.state.error, '無言のまま(押しても何も起きない)').toBe(SECTION_DRAFT_NOTE);
  });
});

/**
 * 🔴 **`SAVE_SECTION_DRAFT` は「保存中」の印を立てて要求を出すだけ**
 *   (#1044 段2 3巡目の修理、S1)。
 *
 * ⚠ 直す前はここで `state.openBody.body` を土台に探し直し・比較・差し替えまで
 *   一気にやっていた ── その一致判定(見出しの名前で探す / 0 個・2 個以上は断る /
 *   原文と一致するか)は **`replaceSectionByHeading`(features 層の純関数)へ移した**
 *   (test は `tests/features/append-target.test.ts`)。ここで見るのは reducer が
 *   「本文を土台にせず、要求を出すだけ」になったこと ── 実際に disk から読み直して
 *   差し替えるところは effect(`store-effects.ts`)の仕事で、`SECTION_SAVED` /
 *   `SECTION_SAVE_FAILED` の ack で戻ってくる(下の describe を参照)。
 */
describe('SAVE_SECTION_DRAFT(#1044 段2 3巡目の修理、S1)', () => {
  const opened = (line = 4): AppState =>
    reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line }).state;

  it('🔴 「保存中」の印を立て、本文を載せない要求(REQUEST_SECTION_SAVE)を出す', () => {
    const s0 = opened();
    const newText = ['## 決定事項', '', '- 牛乳を買う', '- パンを買う'].join('\n');
    const r = reduce(s0, { type: 'SAVE_SECTION_DRAFT', text: newText });
    expect(r.state.sectionDraft, '保存中に箱が消えた').not.toBeNull();
    expect(r.state.sectionDraft!.saving, '保存中の印が立っていない').toBe(true);
    // ⚠ 一致判定はもう reducer の仕事ではない ── openBody はここでは 1 バイトも動かない
    expect(r.state.openBody).toBe(s0.openBody);
    const ev = r.events.find((e) => e.type === 'REQUEST_SECTION_SAVE');
    expect(ev, 'REQUEST_SECTION_SAVE が飛んでいない').toBeDefined();
    const req = ev as Extract<typeof ev, { type: 'REQUEST_SECTION_SAVE' }>;
    expect(req.lid).toBe('n1');
    expect(req.heading).toBe('決定事項');
    expect(req.original).toBe(s0.sectionDraft!.original);
    expect(req.text).toBe(newText);
    expect(req.title).toBe('t-n1');
    expect(req.archetype).toBe('text');
    // ⚠ 本文(disk から読み直す元)は event に載っていない
    expect(req).not.toHaveProperty('body');
  });

  it('🔴 二重押しは黙って捨てる(追記の writeLock と同じ作法)', () => {
    const s0 = reduce(opened(), { type: 'SAVE_SECTION_DRAFT', text: 'x' }).state;
    expect(s0.sectionDraft!.saving, '前提が崩れている(保存中になっていない)').toBe(true);
    const r = reduce(s0, { type: 'SAVE_SECTION_DRAFT', text: 'y' });
    expect(r.state).toBe(s0);
    expect(r.events, '二重押しで要求が 2 通目飛んだ').toEqual([]);
  });

  it('🔴 下書きが無いのに撃たれても、無言で何もしない(防波堤)', () => {
    const s0 = booted();
    const r = reduce(s0, { type: 'SAVE_SECTION_DRAFT', text: 'x' });
    expect(r.state).toBe(s0);
    expect(r.events).toEqual([]);
  });

  it('🔴 phase が ready でなければ断る(要求を出さない)', () => {
    // ⚠ 章の欄と全文編集は同時に開かないので、STARTEDIT では作れない ── phase を
    //   手で崩して「あり得るがまだ来ていない」窓を作る(F-D の test と同じ作法)
    const s0 = { ...opened(), phase: 'error' as const };
    const r = reduce(s0, { type: 'SAVE_SECTION_DRAFT', text: 'x' });
    expect(r.state.sectionDraft, '断ったのに下書きが消えた').not.toBeNull();
    expect(r.state.sectionDraft!.saving, '断ったのに保存中になった').toBe(false);
    expect(r.events).toEqual([]);
    expect(r.state.error ?? '').toContain('「ノートを保存し直す」を押してから');
  });
});

/**
 * 🔴 **章の保存が disk に着いた ack(SECTION_SAVED / SECTION_SAVE_FAILED)**
 *   (#1044 段2 3巡目の修理、S1)。⚠ effect が {@link replaceSectionByHeading}
 *   を当てた**結果**をここへ運ぶ ── 一致判定そのものは features 層の純関数の
 *   test(`tests/features/append-target.test.ts`)が見る。
 */
describe('SECTION_SAVED / SECTION_SAVE_FAILED(#1044 段2 3巡目の修理、S1)', () => {
  const saving = (line = 4): AppState =>
    reduce(reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line }).state, {
      type: 'SAVE_SECTION_DRAFT',
      text: ['## 決定事項', '', '- 牛乳を買う', '- パンを買う'].join('\n'),
    }).state;

  it('🔴 SECTION_SAVED ── 下書きを閉じ、openBody / entryMetas を新しい本文で組み直す', () => {
    const s0 = saving();
    const newBody = [
      '# 議事録',
      '',
      '前置き。',
      '',
      '## 決定事項',
      '',
      '- 牛乳を買う',
      '- パンを買う',
      '## 次回',
      '',
      '来週。',
    ].join('\n');
    const r = reduce(s0, {
      type: 'SECTION_SAVED',
      lid: 'n1',
      gen: s0.lockGen,
      heading: '決定事項',
      body: newBody,
      status: null,
      date: null,
      archived: false,
    });
    expect(r.state.sectionDraft, '保存後も下書きが残っている').toBeNull();
    expect(r.state.openBody!.body).toBe(newBody);
    expect(r.state.openBody!.persisted).toBe(newBody);
    expect(r.state.openBody!.diskAhead).toBe(false);
    // ⚠ ほかの章(見出しと中身)は 1 バイトも変わっていない
    expect(r.state.openBody!.body).toContain('前置き。');
    expect(r.state.openBody!.body).toContain('## 次回');
    expect(r.state.openBody!.body).toContain('来週。');
  });

  it('🔴 SECTION_SAVED ── 世代の合わない ack は捨てる(強制解放の後着)', () => {
    const s0 = saving();
    const r = reduce(s0, {
      type: 'SECTION_SAVED',
      lid: 'n1',
      gen: s0.lockGen + 1,
      heading: '決定事項',
      body: 'よそから来た本文',
      status: null,
      date: null,
      archived: false,
    });
    expect(r.state).toBe(s0);
    expect(r.events).toEqual([]);
  });

  it('🔴 SECTION_SAVED ── 下書きが既に閉じている(別の窓で消えた等)なら捨てる', () => {
    const s0 = saving();
    const closed = { ...s0, sectionDraft: null };
    const r = reduce(closed, {
      type: 'SECTION_SAVED',
      lid: 'n1',
      gen: s0.lockGen,
      heading: '決定事項',
      body: 'よそから来た本文',
      status: null,
      date: null,
      archived: false,
    });
    expect(r.state).toBe(closed);
  });

  it('🔴 SECTION_SAVE_FAILED ── 保存中の印を解き、理由を出す。箱と書きかけは残す', () => {
    const s0 = saving();
    const r = reduce(s0, {
      type: 'SECTION_SAVE_FAILED',
      lid: 'n1',
      gen: s0.lockGen,
      heading: '決定事項',
      error: 'この章は別の場所で書き換えられました ── 書きかけをコピーしてから、開き直してください',
    });
    expect(r.state.sectionDraft, '断ったのに下書きが消えた').not.toBeNull();
    expect(r.state.sectionDraft!.saving, '保存中の印が解けていない').toBe(false);
    expect(r.state.sectionDraft!.heading, '断ったのに見出しが変わった').toBe('決定事項');
    expect(r.state.openBody).toBe(s0.openBody); // ⚠ 断ったので openBody は 1 バイトも動かない
    expect(r.state.error ?? '').toContain('別の場所で書き換えられました');
  });

  it('🔴 SECTION_SAVE_FAILED ── 世代の合わない ack は捨てる', () => {
    const s0 = saving();
    const r = reduce(s0, {
      type: 'SECTION_SAVE_FAILED',
      lid: 'n1',
      gen: s0.lockGen + 1,
      heading: '決定事項',
      error: 'よそからの断り',
    });
    expect(r.state).toBe(s0);
  });
});

describe('CANCEL_SECTION_DRAFT(#1044 段2)', () => {
  it('🔴 書かずに閉じる(本文は 1 バイトも変わらない)', () => {
    const s0 = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    const body0 = s0.openBody!.body;
    const r = reduce(s0, { type: 'CANCEL_SECTION_DRAFT' });
    expect(r.state.sectionDraft).toBeNull();
    expect(r.state.openBody!.body).toBe(body0);
    expect(r.events).toEqual([]);
  });

  it('🔴 下書きが無ければ無言で何もしない', () => {
    const s0 = booted();
    const r = reduce(s0, { type: 'CANCEL_SECTION_DRAFT' });
    expect(r.state).toBe(s0);
  });

  /**
   * 🔴 **保存中は黙って捨てる**(#1044 段2 3巡目の修理、S1)。
   * ⚠ `saving` の間に閉じさせると、あとから届く保存の ack が「もう居ない draft」
   *   を当てようとする(身元検査で巻き戻りは起きないが、押した意図とずれる)。
   */
  it('🔴 保存中は黙って捨てる(saving: true の間は閉じない)', () => {
    const opened = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    const s0 = reduce(opened, { type: 'SAVE_SECTION_DRAFT', text: 'x' }).state;
    expect(s0.sectionDraft!.saving, '前提が崩れている(保存中になっていない)').toBe(true);
    const r = reduce(s0, { type: 'CANCEL_SECTION_DRAFT' });
    expect(r.state).toBe(s0);
    expect(r.events).toEqual([]);
  });
});

/**
 * 🔴 **FORCE_RELEASE_LOCK が章の保存中にも効く**(#1044 段2 4巡目の修理、T1)。
 *
 * ⚠ 直す前は `writeLock` / `tileWrite` しか見ておらず、`sectionDraft.saving`
 *   が `true` のまま詰まると逃げ道が無かった(押せるボタンは無い・離れる操作は
 *   `guardSectionDraftTransition` が断り続ける)。
 * 🔑 追記の `writeLock` と同じ「打ち切る」を移す:`saving` を解くだけで
 *   **箱と書きかけ(`sectionDraft` そのもの)は残す**(discard しない)。
 */
describe('FORCE_RELEASE_LOCK は章の保存中にも効く(#1044 段2 4巡目の修理、T1)', () => {
  const saving = (line = 4): AppState =>
    reduce(reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line }).state, {
      type: 'SAVE_SECTION_DRAFT',
      text: '## 決定事項\n\n打ちかけ',
    }).state;

  it('🔴 saving: true → FORCE_RELEASE_LOCK → saving が false、lid/heading/original は 1 バイトも変わらない', () => {
    const s0 = saving();
    const r = reduce(s0, { type: 'FORCE_RELEASE_LOCK', discardDraft: false });
    expect(r.state.sectionDraft, '打ち切ったのに箱が消えた').not.toBeNull();
    expect(r.state.sectionDraft!.saving, '打ち切ったのに保存中の印が残っている').toBe(false);
    expect(r.state.sectionDraft!.lid).toBe(s0.sectionDraft!.lid);
    expect(r.state.sectionDraft!.heading).toBe(s0.sectionDraft!.heading);
    expect(r.state.sectionDraft!.original).toBe(s0.sectionDraft!.original);
    // 🔑 世代は必ず上がる(後着の ack を無視するための本体)
    expect(r.state.lockGen).toBe(s0.lockGen + 1);
  });

  it('🔴 打ち切った後、古い世代の SECTION_SAVED が届いても無視される(画面と disk が食い違わない)', () => {
    const s0 = saving();
    const released = reduce(s0, { type: 'FORCE_RELEASE_LOCK', discardDraft: false }).state;
    const r = reduce(released, {
      type: 'SECTION_SAVED',
      lid: 'n1',
      gen: s0.lockGen, // ⚠ 打ち切り前の(もう古い)世代
      heading: '決定事項',
      body: 'よそから来た本文(遅れて届いた ack)',
      status: null,
      date: null,
      archived: false,
    });
    expect(r.state, '古い世代の ack を受け入れてしまった').toBe(released);
  });

  it('🔴 打ち切った後、古い世代の SECTION_SAVE_FAILED も無視される', () => {
    const s0 = saving();
    const released = reduce(s0, { type: 'FORCE_RELEASE_LOCK', discardDraft: false }).state;
    const r = reduce(released, {
      type: 'SECTION_SAVE_FAILED',
      lid: 'n1',
      gen: s0.lockGen,
      heading: '決定事項',
      error: '遅れて届いた断り',
    });
    expect(r.state).toBe(released);
  });

  it('対照群: saving: false(保存中でない)ときは、sectionDraft を 1 バイトも触らない', () => {
    const s0 = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    expect(s0.sectionDraft!.saving, '前提が崩れている(保存中になっている)').toBe(false);
    const r = reduce(s0, { type: 'FORCE_RELEASE_LOCK', discardDraft: false });
    expect(r.state.sectionDraft).toBe(s0.sectionDraft);
  });

  it('対照群: sectionDraft が無いときは、追記の writeLock だけがいつもどおり解ける', () => {
    const s0 = { ...booted(), writeLock: { lid: 'n1' } };
    const r = reduce(s0, { type: 'FORCE_RELEASE_LOCK', discardDraft: false });
    expect(r.state.writeLock).toBeNull();
    expect(r.state.sectionDraft).toBeNull();
  });
});

/**
 * 🔴 **断った字は、正しく操作した後は消える**(#1044 段2 2巡目の修理、R5)。
 *
 * ⚠ 直す前は `SECTION_DRAFT_NOTE` / `SECTION_DRAFT_RELOADING_NOTE` を
 *   `state.error` に置いたきり、`SAVE_SECTION_DRAFT` 成功 / `CANCEL_SECTION_DRAFT` /
 *   `OPEN_SECTION_DRAFT` 成功のどれでも消えなかった(消えるのは別のノートを
 *   選んだときだけ)。⚠ **無関係な error は消さない**(握りつぶさない)ことを
 *   対照群で確かめる。
 */
describe('断った字は、正しく操作した後は消える(#1044 段2 2巡目の修理、R5)', () => {
  it('🔴 二重に開いて断られた後、章の編集をやめる(CANCEL)と断り文が消える', () => {
    const s0 = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    const denied = reduce(s0, { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 8 }).state;
    expect(denied.error, '前提が崩れている(断られていない)').toBe(SECTION_DRAFT_NOTE);
    const r = reduce(denied, { type: 'CANCEL_SECTION_DRAFT' });
    expect(r.state.error, 'やめたのに断り文が残っている').toBeNull();
    expect(r.state.sectionDraft).toBeNull();
  });

  it('🔴 二重に開いて断られた後、章の保存を要求すると断り文が消える(要求の時点で消える)', () => {
    const s0 = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    const denied = reduce(s0, { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 8 }).state;
    expect(denied.error, '前提が崩れている(断られていない)').toBe(SECTION_DRAFT_NOTE);
    const r = reduce(denied, {
      type: 'SAVE_SECTION_DRAFT',
      text: '## 決定事項\n\n- 牛乳を買う\n- パンを買う',
    });
    // ⚠ 保存は effect 化された(S1)── ここで消えるのは保存の**成功**ではなく
    //   「保存を要求した」こと。ack(SECTION_SAVED)を待たずに断り文は消える。
    expect(r.state.sectionDraft, '要求したのに下書きが消えた').not.toBeNull();
    expect(r.state.sectionDraft!.saving, '要求したのに保存中の印が立っていない').toBe(true);
    expect(r.state.error, '要求したのに断り文が残っている').toBeNull();
  });

  it('🔴 全文編集を試みて断られた後、同じノートの別の見出しを開くと断り文が消える', () => {
    const s0 = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    const denied = reduce(s0, { type: 'START_EDIT' }).state;
    expect(denied.error, '前提が崩れている(断られていない)').toBe(SECTION_DRAFT_NOTE);
    // ⚠ CANCEL してから、別の見出し(line 8)を開き直す(binder の 3 択と同じ手順)
    const cancelled = reduce(denied, { type: 'CANCEL_SECTION_DRAFT' }).state;
    const r = reduce(cancelled, { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 8 });
    expect(r.state.sectionDraft!.heading).toBe('次回');
    expect(r.state.error, '開けたのに断り文が残っている').toBeNull();
  });

  it('🔴 別タブの再読込で openBody が一瞬 null の窓でも、保存の要求は断らない(#1044 段2 3巡目の修理、S1)', () => {
    const s0 = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    // openBody が一瞬 null になる窓(F-D の test と同じ作り方)
    const reloading = reduce(s0, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: ['n1', 'n2'].map(meta),
      relations: [],
    }).state;
    expect(reloading.openBody, '窓が再現できていない(前提が崩れている)').toBeNull();
    /**
     * ⚠ **3 巡目の修理で `SECTION_DRAFT_RELOADING_NOTE` は無くなった** ── 保存は
     *   もう `openBody` を見ない(disk から読み直す)ので、この窓で断る理由が消えた。
     */
    const r = reduce(reloading, {
      type: 'SAVE_SECTION_DRAFT',
      text: '## 決定事項\n\n- 牛乳を買う\n- パンを買う',
    });
    expect(r.state.sectionDraft, 'openBody が無いだけで下書きが消えた').not.toBeNull();
    expect(r.state.sectionDraft!.saving, 'openBody が無いだけで断られた(要求が出ていない)').toBe(
      true,
    );
    expect(r.state.error, 'openBody が無いだけで断った').toBeNull();
    expect(r.events.some((e) => e.type === 'REQUEST_SECTION_SAVE'), '読み直し中でも要求は出る').toBe(
      true,
    );
  });

  it('対照群: 章の欄と無関係な error は、やめても保存しても消えない(握りつぶさない)', () => {
    const s0 = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    const unrelated = { ...s0, error: '一覧を取り直せませんでした: network error' };
    const cancelled = reduce(unrelated, { type: 'CANCEL_SECTION_DRAFT' });
    expect(cancelled.state.error, '無関係な知らせを消してしまった').toBe(
      '一覧を取り直せませんでした: network error',
    );
    const s1 = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    const unrelated2 = { ...s1, error: '一覧を取り直せませんでした: network error' };
    const saved = reduce(unrelated2, {
      type: 'SAVE_SECTION_DRAFT',
      text: '## 決定事項\n\n- 牛乳を買う\n- パンを買う',
    });
    expect(saved.state.error, '無関係な知らせを消してしまった').toBe(
      '一覧を取り直せませんでした: network error',
    );
  });
});

describe('章の欄が開いている間の門(#1043 の拡張・#1044 段2)', () => {
  it('🔴 同じノートの本文の書込は断る。別のノートは自由(#1043)', () => {
    const s = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    expect(bodyWriteBlockReason(s, 'n1')).toBe(SECTION_DRAFT_NOTE);
    expect(bodyWriteBlockReason(s, 'n2'), '別のノートまで止めている').toBeNull();
  });

  it('🔴 同じノートで全文編集を始めようとすると、可視の理由で断る(下書きは消えない)', () => {
    const s0 = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    const r = reduce(s0, { type: 'START_EDIT' });
    expect(r.state.phase, '全文編集に入ってしまった').toBe('ready');
    expect(r.state.sectionDraft, '下書きが消えた').not.toBeNull();
    expect(r.state.error).toBe(SECTION_DRAFT_NOTE);
  });
});

/**
 * 🔴 **reduce() の外側 1 か所で、章の欄が開いている間そのノートから離れる遷移を止める**
 * (#1044 段2、F-A)。
 *
 * ⚠ 個別の action を 1 つずつ塞がない ── 判定は「selectedLid が draft.lid から
 *   動いたか」「entryMetas から draft.lid が消えたか」の**結果の形**だけを見る
 *   (`guardSectionDraftTransition`。CLAUDE.md §7「次に選択を動かす case を足した
 *   人が忘れられない形」)。
 */
describe('章の欄を離れる遷移を reduce() の外側で止める(#1044 段2、F-A)', () => {
  /** `booted()` に、戻れる履歴を 1 段足す(NAV_HISTORY 用)。 */
  function bootedWithHistory(): AppState {
    let s = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: ['n1', 'n2'].map(meta),
      relations: [],
    }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'n2' }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state;
    return reduce(s, { type: 'BODY_LOADED', lid: 'n1', body: DOC }).state;
  }

  const draftOpened = (): AppState =>
    reduce(bootedWithHistory(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;

  /**
   * 🔑 **selectedLid を動かす case / entry を消す case を、grep で全数数え上げた
   *   代表**(報告の表に全数を出す)。ここは代表の 7 つを table-driven で撃つ。
   */
  const USER_CASES: readonly { name: string; action: Dispatchable }[] = [
    { name: 'DESELECT_ENTRY', action: { type: 'DESELECT_ENTRY' } },
    { name: 'MESSAGES_READ', action: { type: 'MESSAGES_READ', lid: 'sys-messages' } },
    { name: 'DELETE_ENTRY(下書きのノート)', action: { type: 'DELETE_ENTRY', lid: 'n1' } },
    {
      name: 'DELETE_ENTRIES(下書きのノートを含む)',
      action: { type: 'DELETE_ENTRIES', lids: ['n1', 'n2'] },
    },
    { name: 'NAV_HISTORY(back)', action: { type: 'NAV_HISTORY', dir: 'back' } },
    { name: 'SELECT_ENTRY(別ノートを直に撃つ)', action: { type: 'SELECT_ENTRY', lid: 'n2' } },
    {
      name: 'CREATE_ENTRY',
      action: { type: 'CREATE_ENTRY', archetype: 'text', lid: 'n3', title: '新規' },
    },
  ];

  it.each(USER_CASES)('🔴 $name は丸ごと断る(error 以外 state は 1 バイトも動かない・下書きが残る)', ({ action }) => {
    const s0 = draftOpened();
    const r = reduce(s0, action);
    // 🔑 変わってよいのは `error` だけ(丸ごと断る = 押す前の state + 断り文)
    expect(r.state).toEqual({ ...s0, error: SECTION_DRAFT_NOTE, sectionAdvisory: SECTION_DRAFT_NOTE });
    expect(r.state.sectionDraft, '断ったのに下書きが消えた').not.toBeNull();
    expect(r.events, '断ったのに副作用が飛んだ').toEqual([]);
  });

  it('🔴 CANCEL_SECTION_DRAFT で閉じた後は、別のノートで OPEN_SECTION_DRAFT が効く(詰まない)', () => {
    const s0 = draftOpened();
    const s1 = reduce(s0, { type: 'CANCEL_SECTION_DRAFT' }).state;
    expect(s1.sectionDraft).toBeNull();
    const s2 = reduce(s1, { type: 'SELECT_ENTRY', lid: 'n2' }).state;
    const s3 = reduce(s2, { type: 'BODY_LOADED', lid: 'n2', body: '## べつの章\n\n中身\n' }).state;
    const s4 = reduce(s3, { type: 'OPEN_SECTION_DRAFT', lid: 'n2', line: 0 });
    expect(s4.state.sectionDraft, '別のノートで開けない(無言で捨てた門が詰まっている)').not.toBeNull();
    expect(s4.state.sectionDraft!.lid).toBe('n2');
    expect(s4.state.error, '開けたのに断り文が残っている').not.toBe(SECTION_DRAFT_NOTE);
  });

  it('🔴 system command(SYS_BOOTED で下書きのノートが消えた)は受け入れ、下書きを閉じて知らせる', () => {
    const s0 = draftOpened();
    const r = reduce(s0, { type: 'SYS_BOOTED', cid: 'c1', metas: ['n2'].map(meta), relations: [] });
    // ⚠ system の結果は「受け入れる」── SYS_BOOTED 自身の遷移は動く
    expect(r.state.entryMetas.has('n1'), 'system の結果まで断った').toBe(false);
    expect(r.state.sectionDraft, '下書きが残っている(画面が固まる)').toBeNull();
    expect(r.state.notice, '画面の言葉で知らせていない').toBe(SECTION_DRAFT_CLOSED_BY_SYSTEM_NOTICE);
  });

  /**
   * 🔴 **system 分岐でも、章の欄自身の断り文は消す**(#1044 段2 3巡目の修理、S4)。
   *
   * ⚠ 直す前は `result.state.error` をそのまま持ち越していた ── 直前に user の
   *   action が断られて `error: SECTION_DRAFT_NOTE` が残っている状態で system
   *   command が下書きを閉じても、その断り文が `notice`(「別の場所の操作で…」)と
   *   **同時に**画面へ残った(2 つの面(`error` / `notice`)は別々に消えるので、
   *   どちらも出るのは正しく操作した後も画面が古い理由を言い続ける形)。
   */
  /**
   * ⚠ **`reduce()` は使わない** ── `SYS_BOOTED` 自身が `error: null` を無条件に
   *   置くので、`reduce()` 越しに見ると「`clearedSectionDraftAdvisory` が消したのか、
   *   `SYS_BOOTED` 自身がそう作っているのか」を見分けられない(上の
   *   「entryGone 単独の枝」の group と同じ理由で、`guardSectionDraftTransition`
   *   を直に呼ぶ)。
   */
  it('🔴 system command が下書きを閉じるとき、直前に残っていた SECTION_DRAFT_NOTE も消える(S4)', () => {
    // ⚠ `sectionAdvisory` も揃える(#1044 段2 5巡目の修理、U3)── 「章の欄自身が
    //   置いた字」であることは、いまは字の中身ではなく `sectionAdvisory` との
    //   等値で判定するので、control する回はここも合わせて作る。
    const before = { ...draftOpened(), error: SECTION_DRAFT_NOTE, sectionAdvisory: SECTION_DRAFT_NOTE };
    const afterMetas = new Map(before.entryMetas);
    afterMetas.delete('n1');
    // ⚠ system の結果そのものは(この test の主張と無関係な)error を持ち越す体
    const afterState: AppState = { ...before, entryMetas: afterMetas, error: SECTION_DRAFT_NOTE };
    const result = guardSectionDraftTransition(
      before,
      { type: 'MESSAGES_UNREAD_SET', count: 1 },
      { state: afterState, events: [] },
    );
    expect(result.state.sectionDraft, '下書きが残っている').toBeNull();
    expect(result.state.notice, '画面の言葉で知らせていない').toBe(
      SECTION_DRAFT_CLOSED_BY_SYSTEM_NOTICE,
    );
    expect(result.state.error, '章の欄自身の断り文が残っている').toBeNull();
  });

  it('対照群: system command が下書きを閉じても、無関係な error は握りつぶさない(S4)', () => {
    const before = { ...draftOpened(), error: '一覧を取り直せませんでした: network error' };
    const afterMetas = new Map(before.entryMetas);
    afterMetas.delete('n1');
    const afterState: AppState = {
      ...before,
      entryMetas: afterMetas,
      error: '一覧を取り直せませんでした: network error',
    };
    const result = guardSectionDraftTransition(
      before,
      { type: 'MESSAGES_UNREAD_SET', count: 1 },
      { state: afterState, events: [] },
    );
    expect(result.state.sectionDraft).toBeNull();
    expect(result.state.error, '無関係な知らせを消してしまった').toBe(
      '一覧を取り直せませんでした: network error',
    );
  });

  describe('対照群 ── 下書きが無い state では、同じ action がそのまま通る', () => {
    it.each(USER_CASES)('$name', ({ action }) => {
      const s0 = bootedWithHistory();
      const r = reduce(s0, action);
      expect(r.state.error, '下書きが無いのに断られた').not.toBe(SECTION_DRAFT_NOTE);
    });
  });
});

/**
 * 🔴 **章の欄が開いたままなら、system command は自身の断り文を消さない**
 *   (#1044 段2 4巡目の修理、T2)。
 *
 * ⚠ 実物の物語:「章を保存する」を押し、別の窓が同じ章を書き換えていたので
 *   `SECTION_SAVE_FAILED`(`SECTION_SAVE_MISMATCH_NOTE`)で断られる ── 画面に
 *   「この章は別の場所で書き換えられました…」が出る。⚠ その**まさに原因になった
 *   別窓の書込**を見た `SYS_BOOTED` が数百 ms 後に届き、`error: null` を無条件に
 *   置くので、直す前は断り文が画面から**約 250ms で消えていた**(user 目線
 *   レビューの撮影で実測)。
 * 🔑 ここは `movedAway` も `entryGone` も false(章の欄は閉じない側)の
 *   `SYS_BOOTED` を通し、断り文が生き残ることを見る。
 */
describe('章の欄が開いたまま届く system command は、自身の断り文を消さない(#1044 段2 4巡目の修理、T2)', () => {
  /** OPEN_SECTION_DRAFT → SAVE_SECTION_DRAFT → SECTION_SAVE_FAILED(mismatch)まで進めた state。 */
  function failedSave(): AppState {
    const opened = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    const saving = reduce(opened, {
      type: 'SAVE_SECTION_DRAFT',
      text: '## 決定事項\n\n打ちかけ',
    }).state;
    return reduce(saving, {
      type: 'SECTION_SAVE_FAILED',
      lid: 'n1',
      gen: saving.lockGen,
      heading: '決定事項',
      error: SECTION_SAVE_MISMATCH_NOTE,
    }).state;
  }

  it('🔴 SYS_BOOTED(同じ container・選択を保つ)が届いても、保存を断った理由の字が残る', () => {
    const s0 = failedSave();
    expect(s0.error, '前提が崩れている(断られていない)').toBe(SECTION_SAVE_MISMATCH_NOTE);
    expect(s0.sectionDraft, '前提が崩れている(下書きが消えた)').not.toBeNull();

    // まさに断りの原因になった別タブの書込を見た再読込(同じ container・同じ選択)
    const r = reduce(s0, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: ['n1', 'n2'].map(meta),
      relations: [],
    });
    expect(r.state.selectedLid, '前提が崩れている(選択が動いた)').toBe('n1');
    expect(r.state.sectionDraft, '前提が崩れている(下書きが閉じた)').not.toBeNull();
    // 🔴 本丸:SYS_BOOTED 自身は無条件に error: null を置くが、章の欄の断り文は残る
    expect(r.state.error, '断り文が SYS_BOOTED で消えた').toBe(SECTION_SAVE_MISMATCH_NOTE);
  });

  it('対照群:章の欄の断り文でない error は、SYS_BOOTED で今までどおり消える', () => {
    const s0 = { ...failedSave(), error: '一覧を取り直せませんでした: network error' };
    const r = reduce(s0, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: ['n1', 'n2'].map(meta),
      relations: [],
    });
    expect(r.state.sectionDraft, '前提が崩れている(下書きが閉じた)').not.toBeNull();
    expect(r.state.error, '無関係な error まで守ってしまった(SYS_BOOTED の既定を変えた)').toBeNull();
  });

  it('対照群:断り文が無ければ(error: null)、そのまま null', () => {
    const opened = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    expect(opened.error).toBeNull();
    const r = reduce(opened, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: ['n1', 'n2'].map(meta),
      relations: [],
    });
    expect(r.state.error).toBeNull();
    expect(r.state.sectionDraft, '前提が崩れている(下書きが閉じた)').not.toBeNull();
  });

  it('対照群:章の欄が閉じる回(system が movedAway/entryGone を作る)は、S4 の既存の作法のまま', () => {
    const s0 = failedSave();
    // 別タブが下書きのノートそのものを消した(entryGone)
    const r = reduce(s0, { type: 'SYS_BOOTED', cid: 'c1', metas: ['n2'].map(meta), relations: [] });
    expect(r.state.sectionDraft, '下書きが残っている').toBeNull();
    expect(r.state.notice).toBe(SECTION_DRAFT_CLOSED_BY_SYSTEM_NOTICE);
    // 🔑 閉じる回は clearedSectionDraftAdvisory が既に断り文を消す(S4 の作法)
    expect(r.state.error, '閉じたのに断り文が残っている').toBeNull();
  });

  it('対照群:user の action(system command でない)は、この経路を通らない(既存どおり丸ごと断る)', () => {
    const s0 = failedSave();
    const r = reduce(s0, { type: 'DESELECT_ENTRY' });
    // 🔑 「丸ごと断る」形(error だけ SECTION_DRAFT_NOTE に置き換わる)は変わらない
    expect(r.state).toEqual({ ...s0, error: SECTION_DRAFT_NOTE, sectionAdvisory: SECTION_DRAFT_NOTE });
  });
});

/**
 * 🔴 **「章の欄自身の断り文」の判定は、字の中身ではなく `sectionAdvisory` との
 *   等値で行う**(#1044 段2 5巡目の修理、U3)。
 *
 * ⚠ 直す前は固定 5 文言の `Set` だった ── `REQUEST_SECTION_SAVE` の catch-all
 *   (例外の `String(e)` を埋め込む、**中身が動く字**「章を保存できませんでした: <e>」)
 *   は集合に入れられないので漏れ、保存が成功した後も画面には**古い catch-all の
 *   失敗の字が残った**。ここは T2(SYS_BOOTED での生存)を catch-all でも見る +
 *   「保存し直して消える」経路 + 「たまたま字が一致しただけでは消さない」対照群。
 */
describe('章の欄自身の断り文は、字の中身ではなく sectionAdvisory との等値で判定する(#1044 段2 5巡目の修理、U3)', () => {
  /** 中身が動く体の catch-all(`store-effects.ts` の `fail(章を保存できませんでした: ${String(e)})` と同じ形)。 */
  const CATCH_ALL = '章を保存できませんでした: TypeError: disk unavailable';

  /** OPEN_SECTION_DRAFT → SAVE_SECTION_DRAFT → SECTION_SAVE_FAILED(catch-all)まで進めた state。 */
  function failedSaveCatchAll(): AppState {
    const opened = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    const saving = reduce(opened, {
      type: 'SAVE_SECTION_DRAFT',
      text: '## 決定事項\n\n打ちかけ',
    }).state;
    return reduce(saving, {
      type: 'SECTION_SAVE_FAILED',
      lid: 'n1',
      gen: saving.lockGen,
      heading: '決定事項',
      error: CATCH_ALL,
    }).state;
  }

  it('🔴 catch-all で失敗 → もう一度保存して成功すると、古い catch-all の断り文が消える', () => {
    const s0 = failedSaveCatchAll();
    expect(s0.error, '前提が崩れている(断られていない)').toBe(CATCH_ALL);
    expect(s0.sectionAdvisory, '前提が崩れている(控えていない)').toBe(CATCH_ALL);

    // 要求した時点で断り文が消える(R5 と同じ寿命 ── ack を待たない)
    const requesting = reduce(s0, {
      type: 'SAVE_SECTION_DRAFT',
      text: '## 決定事項\n\n- 牛乳を買う\n- パンを買う',
    });
    expect(requesting.state.error, '要求したのに catch-all の断り文が残っている').toBeNull();
    expect(requesting.state.sectionAdvisory, '要求したのに控えが残っている').toBeNull();

    const saved = reduce(requesting.state, {
      type: 'SECTION_SAVED',
      lid: 'n1',
      gen: requesting.state.lockGen,
      heading: '決定事項',
      body: '## 決定事項\n\n- 牛乳を買う\n- パンを買う',
      status: null,
      date: null,
      archived: false,
    });
    expect(saved.state.error, '保存できたのに catch-all の断り文が残っている').toBeNull();
    expect(saved.state.sectionDraft, '保存できたのに下書きが残っている').toBeNull();
  });

  it('🔴 SYS_BOOTED(章の欄が閉じない側)が届いても、catch-all の断り文は残る(T2 の catch-all 版)', () => {
    const s0 = failedSaveCatchAll();
    const r = reduce(s0, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: ['n1', 'n2'].map(meta),
      relations: [],
    });
    expect(r.state.selectedLid, '前提が崩れている(選択が動いた)').toBe('n1');
    expect(r.state.sectionDraft, '前提が崩れている(下書きが閉じた)').not.toBeNull();
    // 🔴 本丸:SYS_BOOTED 自身は無条件に error: null を置くが、catch-all の断り文は残る
    expect(r.state.error, 'catch-all の断り文が SYS_BOOTED で消えた').toBe(CATCH_ALL);
  });

  it('対照群:同じ字でも sectionAdvisory と一致しなければ、章の欄自身の断り文として消さない', () => {
    // ⚠ 章の欄が「いま」置いたのではなく、たまたま同じ文言の無関係な error が
    //   乗っている体(sectionAdvisory は OPEN_SECTION_DRAFT 成功時のまま null)。
    const opened = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    expect(opened.sectionAdvisory, '前提が崩れている(控えが残っている)').toBeNull();
    const coincidence = { ...opened, error: CATCH_ALL };
    const r = reduce(coincidence, { type: 'CANCEL_SECTION_DRAFT' });
    expect(
      r.state.error,
      '章の欄が置いていない字まで、たまたま字が一致しただけで消した',
    ).toBe(CATCH_ALL);
  });
});

/**
 * 🔴 **`entryGone` 単独の枝**(movedAway が false のまま entry だけ消える)
 * (#1044 段2 2巡目の修理、R6。変異試験 A3 が生き延びた分)。
 *
 * ⚠ いまの reducer のどの action からもこの組合せは**単独では起きない**
 *   (entry を消す既存の case は選択も一緒に動くのが普通)。「結果の形だけを
 *   見る」という `guardSectionDraftTransition` の主張そのものを守るには、
 *   `reduce()` を経由せず**手で組んだ前後の state**を直に渡して確かめる。
 */
describe('guardSectionDraftTransition: entryGone 単独の枝(#1044 段2 2巡目の修理、R6)', () => {
  function draftState(): AppState {
    return {
      ...booted(),
      sectionDraft: { lid: 'n1', heading: '決定事項', original: 'x', saving: false },
    };
  }

  it('🔴 user の action ── selectedLid は同じ・entryMetas から draft.lid だけ消えた → 断る', () => {
    const before = draftState();
    expect(before.entryMetas.has('n1'), '前提が崩れている').toBe(true);
    const afterMetas = new Map(before.entryMetas);
    afterMetas.delete('n1');
    // ⚠ selectedLid は「同じ」(#1044 段2「entryGone 単独」の定義そのもの)
    const afterState: AppState = { ...before, entryMetas: afterMetas };
    const result = guardSectionDraftTransition(
      before,
      { type: 'SET_VIEW_MODE', mode: 'detail' }, // user action・SECTION_DRAFT_OWN_ACTIONS でない
      { state: afterState, events: [] },
    );
    // 🔑 断る = 押す前の state + 断り文(entryMetas の消えも戻す)
    expect(result.state).toEqual({ ...before, error: SECTION_DRAFT_NOTE, sectionAdvisory: SECTION_DRAFT_NOTE });
    expect(result.state.entryMetas.has('n1'), '断ったのに消えた結果を受け入れた').toBe(true);
    expect(result.events).toEqual([]);
  });

  it('🔴 system command ── 同じ形(entryGone 単独)でも、結果を受け入れて知らせて閉じる', () => {
    const before = draftState();
    const afterMetas = new Map(before.entryMetas);
    afterMetas.delete('n1');
    const afterState: AppState = { ...before, entryMetas: afterMetas };
    const result = guardSectionDraftTransition(
      before,
      { type: 'MESSAGES_UNREAD_SET', count: 1 }, // system command
      { state: afterState, events: [] },
    );
    expect(result.state.entryMetas.has('n1'), 'system の結果まで断った').toBe(false);
    expect(result.state.sectionDraft, '下書きが残っている').toBeNull();
    expect(result.state.notice).toBe(SECTION_DRAFT_CLOSED_BY_SYSTEM_NOTICE);
  });

  it('対照群: entryMetas も selectedLid も動いていなければ、素通りする(結果そのまま)', () => {
    const before = draftState();
    const afterState: AppState = { ...before }; // 何も変わっていない
    const passthrough: { state: AppState; events: [] } = { state: afterState, events: [] };
    const result = guardSectionDraftTransition(before, { type: 'SET_VIEW_MODE', mode: 'detail' }, passthrough);
    expect(result).toBe(passthrough);
  });
});

/**
 * 🔴 **RESTORE_TRASH / RESTORE_REVISION は起点で断る**(#1044 段2 2巡目の修理、R2)。
 *
 * ⚠ どちらも `guardSectionDraftTransition`(reduce() の外側 1 か所)では捕まらない
 * ── 自分自身は `selectedLid` を動かさず、効果層へ `REQUEST_TRASH_RESTORE` /
 * `REQUEST_RESTORE` を頼むだけ(実際に選択を動かす `ENTRY_RESTORED` は**後から**
 * system command として届く)。直す前はここを素通りし、`ENTRY_RESTORED` が届いた
 * 時点で `guardSectionDraftTransition` の system 側の枝(「知らせて閉じる」)を
 * 通ってしまい、断り文が「別の場所で消えたか入れ替わった」という事実と違う理由に
 * なっていた(実際は user 自身のこの操作が引き起こした)。
 */
describe('RESTORE_TRASH / RESTORE_REVISION は起点で断る(#1044 段2 2巡目の修理、R2)', () => {
  it('🔴 RESTORE_TRASH ── 章の欄が開いていれば断る(state は 1 バイトも動かない)', () => {
    const s0 = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    const r = reduce(s0, { type: 'RESTORE_TRASH', entryLid: 'trashed-1', revId: 'rev-1' });
    expect(r.state).toEqual({ ...s0, error: SECTION_DRAFT_NOTE, sectionAdvisory: SECTION_DRAFT_NOTE });
    expect(r.state.sectionDraft, '断ったのに下書きが消えた').not.toBeNull();
    expect(r.events, '断ったのに REQUEST_TRASH_RESTORE が飛んだ').toEqual([]);
  });

  it('対照群: RESTORE_TRASH ── 章の欄が無ければ通る(REQUEST_TRASH_RESTORE が飛ぶ)', () => {
    const s0 = booted();
    const r = reduce(s0, { type: 'RESTORE_TRASH', entryLid: 'trashed-1', revId: 'rev-1' });
    expect(r.state.error, '下書きが無いのに断られた').not.toBe(SECTION_DRAFT_NOTE);
    expect(r.events.some((e) => e.type === 'REQUEST_TRASH_RESTORE')).toBe(true);
  });

  it('🔴 RESTORE_REVISION ── 章の欄が開いていれば断る(state は 1 バイトも動かない)', () => {
    const s0 = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    const r = reduce(s0, { type: 'RESTORE_REVISION', revId: 'rev-1' });
    expect(r.state).toEqual({ ...s0, error: SECTION_DRAFT_NOTE, sectionAdvisory: SECTION_DRAFT_NOTE });
    expect(r.state.sectionDraft, '断ったのに下書きが消えた').not.toBeNull();
    expect(r.events, '断ったのに REQUEST_RESTORE が飛んだ').toEqual([]);
  });

  it('対照群: RESTORE_REVISION ── 章の欄が無ければ通る(REQUEST_RESTORE が飛ぶ)', () => {
    const s0 = booted();
    const r = reduce(s0, { type: 'RESTORE_REVISION', revId: 'rev-1' });
    expect(r.state.error, '下書きが無いのに断られた').not.toBe(SECTION_DRAFT_NOTE);
    expect(r.events.some((e) => e.type === 'REQUEST_RESTORE')).toBe(true);
  });
});

/**
 * 🔴 **file をドロップした本文の書込も、章の欄が開いていれば断る**
 * (#1044 段2 2巡目の修理、R11)。
 *
 * ⚠ `attach.ts` の `putAssetIntoNote` は、落とした所が解けた回は `INSERT_LINES`
 *   (`bodyRewriteGate` 経由で `bodyWriteBlockReason` を通る ── 既に守られている)、
 *   **解けなかった回(末尾へ落ちる)は `APPEND_TO_ENTRY`** を撃つ。直す前は
 *   `APPEND_TO_ENTRY` が `phase` と `writeLock` しか見ておらず、章の欄は
 *   `phase` を `ready` のまま保つので**素通りしていた**(下書きの原文のすぐ下へ
 *   本文が直に書き換わり、下書きは気づかない)。
 */
describe('file を落とした本文の書込も断る(#1044 段2 2巡目の修理、R11)', () => {
  it('🔴 APPEND_TO_ENTRY ── 章の欄が開いているノート自身へは断る(state は 1 バイトも動かない)', () => {
    const s0 = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    const r = reduce(s0, {
      type: 'APPEND_TO_ENTRY',
      lid: 'n1',
      text: '![猫](asset:x)',
      heading: null,
      target: null,
    });
    expect(r.state).toEqual({ ...s0, error: SECTION_DRAFT_NOTE, sectionAdvisory: SECTION_DRAFT_NOTE });
    expect(r.state.sectionDraft, '断ったのに下書きが消えた').not.toBeNull();
    expect(r.events, '断ったのに REQUEST_APPEND が飛んだ').toEqual([]);
  });

  it('🔴 APPEND_TO_ENTRY ── 別ノートへは通る(横に留めた枠を止めない、C6 と同じ判断)', () => {
    const s0 = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    const r = reduce(s0, {
      type: 'APPEND_TO_ENTRY',
      lid: 'n2',
      text: '![猫](asset:x)',
      heading: null,
      target: null,
    });
    expect(r.state.error, '別ノートなのに断られた').not.toBe(SECTION_DRAFT_NOTE);
    expect(r.events.some((e) => e.type === 'REQUEST_APPEND' && e.lid === 'n2')).toBe(true);
  });

  it('対照群: APPEND_TO_ENTRY ── 章の欄が無ければ、いつもどおり通る', () => {
    const s0 = booted();
    const r = reduce(s0, {
      type: 'APPEND_TO_ENTRY',
      lid: 'n1',
      text: '![猫](asset:x)',
      heading: null,
      target: null,
    });
    expect(r.state.error, '下書きが無いのに断られた').not.toBe(SECTION_DRAFT_NOTE);
    expect(r.events.some((e) => e.type === 'REQUEST_APPEND' && e.lid === 'n1')).toBe(true);
  });

  it('🟢 INSERT_LINES ── すでに守られている(既存の bodyRewriteGate 経路)。対照群として確かめる', () => {
    const s0 = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    const r = reduce(s0, {
      type: 'INSERT_LINES',
      lid: 'n1',
      toBefore: 0,
      lines: ['![猫](asset:x)'],
      anchor: { line: 0, text: DOC.split('\n')[0]! },
    });
    expect(r.state.error ?? '', '断り文が出ていない').toContain('章を編集中');
    expect(r.state.sectionDraft, '断ったのに下書きが消えた').not.toBeNull();
    expect(r.events, '断ったのに書いた').toEqual([]);
  });
});

/**
 * 🔴 **SWAP_OPEN_ENTRY の部分適用**(#1044 段2 2巡目の修理、R10)。
 *
 * ⚠ 直す前は「選択の移動は断られるが `splitLids`(枠の並び)だけ書き換わる」──
 *   `SWAP_OPEN_ENTRY` の case が**先に**枠を差し替えた state を組み、その state を
 *   内側の `reduce()`(= 章の欄の門)へ渡していた。内側の `reduce()` が
 *   `SELECT_ENTRY` を断って `{ ...渡した state, error }` を返しても、
 *   **渡した state にはすでに枠の差し替えが焼き込まれている** ── 選択は動かない
 *   のに枠だけ入れ替わる。
 * 🔑 直しは「枠を触る前に、選択が本当に動けるかを試し撃ちする」形(binder.ts の
 *   注記を参照)。
 */
describe('SWAP_OPEN_ENTRY の部分適用(#1044 段2 2巡目の修理、R10)', () => {
  it('🔴 章の欄が開いていれば、選択も splitLids も 1 バイトも動かさずに断る', () => {
    let s = booted(DOC, ['n1', 'n2', 'n3']);
    s = reduce(s, { type: 'PIN_SPLIT_ENTRY', lid: 'n3' }).state;
    s = reduce(s, { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    expect(s.splitLids, '前提が崩れている(枠に留めていない)').toContain('n3');
    expect(s.selectedLid, '前提が崩れている(n1 を選んでいない)').toBe('n1');

    const r = reduce(s, { type: 'SWAP_OPEN_ENTRY', lid: 'n3' });

    expect(r.state.selectedLid, '断ったのに選択が動いた').toBe('n1');
    expect(r.state.splitLids, '断ったのに枠が入れ替わった(部分適用)').toEqual(s.splitLids);
    expect(r.state.error).toBe(SECTION_DRAFT_NOTE);
    expect(r.state.sectionDraft, '断ったのに下書きが消えた').not.toBeNull();
  });

  it('対照群: 章の欄が無ければ、いつもどおり入れ替わる', () => {
    let s = booted(DOC, ['n1', 'n2', 'n3']);
    s = reduce(s, { type: 'PIN_SPLIT_ENTRY', lid: 'n3' }).state;
    expect(s.selectedLid).toBe('n1');

    const r = reduce(s, { type: 'SWAP_OPEN_ENTRY', lid: 'n3' });

    expect(r.state.selectedLid, '入れ替わっていない').toBe('n3');
    expect(r.state.splitLids, '降ろした側(n1)が枠に入っていない').toContain('n1');
    expect(r.state.error, '対照群なのに断られた').not.toBe(SECTION_DRAFT_NOTE);
  });
});

/**
 * 🔴 **「null章を保存してください」を作らない**(#1044 段2、F-D)。
 *
 * ⚠ `SYS_BOOTED` は選択を保つとき `openBody: null` にしてから `REQUEST_BODY` を
 *   頼み直す(`BODY_LOADED` が戻すまでの窓)── 直す前は、この窓で「章を保存する」を
 *   押すと断り文に文字列 `"null"` が混ざった(`phaseBlockReason('ready') === null`)。
 */
describe('SAVE_SECTION_DRAFT の断り文に "null" を混ぜない(#1044 段2、F-D)', () => {
  it('🔴 別タブの再読込で openBody が一瞬 null になった窓でも、詰まない', () => {
    const s0 = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    // 別タブが書いたことを見た SYS_BOOTED(同じ container・同じ選択)
    const r1 = reduce(s0, { type: 'SYS_BOOTED', cid: 'c1', metas: ['n1', 'n2'].map(meta), relations: [] });
    expect(r1.state.openBody, '窓が再現できていない(前提が崩れている)').toBeNull();
    expect(r1.state.sectionDraft, '下書きが消えた').not.toBeNull();
    // ⚠ 頼み直しが本当に飛んでいる(詰みではない証拠)
    expect(
      r1.events.some((e) => e.type === 'REQUEST_BODY' && e.lid === 'n1'),
      '読み直しを頼んでいない(詰み)',
    ).toBe(true);
    // ⚠ このタイミングで「章を保存する」を押した(openBody がまだ戻っていない)。
    //   ⚠ 3 巡目の修理(S1)で保存はもう openBody を見ないので、ここは断らず
    //   要求(saving: true)を出す ── それでも "null" が混ざらないことは変わらず守る。
    const r2 = reduce(r1.state, { type: 'SAVE_SECTION_DRAFT', text: 'x' });
    expect(r2.state.error ?? '').not.toContain('null');
    expect(r2.state.sectionDraft, '下書きが消えた').not.toBeNull();
    expect(r2.state.sectionDraft!.saving, 'openBody が無いだけで断られた').toBe(true);
    // 🔑 窓の後、本文は本当に戻ってくる(詰みではない)
    const r3 = reduce(r1.state, { type: 'BODY_LOADED', lid: 'n1', body: DOC });
    expect(r3.state.openBody?.body, '本文が戻ってこない(詰み)').toBe(DOC);
    expect(r3.state.sectionDraft, '読み直しで下書きが消えた').not.toBeNull();
  });
});

/**
 * 🔴 **「書きかけを守る」判定を 1 か所に寄せる**(#1044 段2、F-C)。
 *
 * ⚠ `main.ts`(`onContainerWiped` / 更新の案内 / `onEditRevoked`)は test から
 *   実行されないので、判定は取り出したこの 2 関数側で test する(CLAUDE.md §2)。
 */
describe('hasUnsavedTyping / unsavedTypingLidOf(#1044 段2、F-C)', () => {
  it('🔴 どちらも開いていなければ false / null', () => {
    const s = booted();
    expect(hasUnsavedTyping(s)).toBe(false);
    expect(unsavedTypingLidOf(s)).toBeNull();
  });

  it('🔴 全文編集中なら true / openBody.lid', () => {
    const s = reduce(booted(), { type: 'START_EDIT' }).state;
    expect(s.phase, '前提が崩れている(編集に入れていない)').toBe('editing');
    expect(hasUnsavedTyping(s)).toBe(true);
    expect(unsavedTypingLidOf(s)).toBe('n1');
  });

  it('🔴 章の欄が開いていれば true / sectionDraft.lid(phase は ready のまま)', () => {
    const s = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 4 }).state;
    expect(s.phase, 'アプリ全体が編集中になった(前提が崩れている)').toBe('ready');
    expect(hasUnsavedTyping(s)).toBe(true);
    expect(unsavedTypingLidOf(s)).toBe('n1');
  });
});
