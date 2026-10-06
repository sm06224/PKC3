/** @vitest-environment happy-dom */
/**
 * 🔴 **コード枠だけの下書き ── reducer(#1044 段3)**。
 *
 * ⚠ ここは**純粋な reducer だけ**を見る(DOM は見ない) ── 箱の DOM への
 * 差し込みは `tests/adapter/code-box-flow.test.ts` と実ブラウザ smoke が見る。
 *
 * 🔑 **段2(`tests/adapter/section-draft.test.ts`)の守りが、種類を変えても同じ 1 本の
 *   機構(`sectionDraft` field / `guardSectionDraftTransition` / `sectionDraftBlockedResult` /
 *   `clearedSectionDraftAdvisory`)で効くこと**が、この file 全体の観測点である。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import {
  bodyWriteBlockReason,
  CODE_DRAFT_CLOSED_BY_SYSTEM_NOTICE,
  CODE_DRAFT_NOTE,
  CODE_SAVE_MISMATCH_NOTE,
  guardSectionDraftTransition,
  hasUnsavedTyping,
  initialState,
  isCodeDraft,
  reduce,
  SECTION_DRAFT_NOTE,
  unsavedTypingLidOf,
  type AppState,
  type CodeDraft,
} from '../../src/adapter/state/app-state';

/** このファイルはコード枠の下書きだけを組む。 */
function codeDraftOf(state: AppState): CodeDraft {
  const d = state.sectionDraft;
  if (d === null || !isCodeDraft(d)) throw new Error('前提が崩れている(コード枠の下書きが無い)');
  return d;
}

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
  '# note', // 0
  '', // 1
  '```js', // 2
  'const a = 1;', // 3
  '```', // 4
  '', // 5
  '続き', // 6
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

describe('OPEN_CODE_DRAFT(#1044 段3)', () => {
  it('🔴 開きの行から、枠の中身だけを控える(開き・閉じの行は含まない)', () => {
    const s = reduce(booted(), { type: 'OPEN_CODE_DRAFT', lid: 'n1', line: 2 }).state;
    expect(s.sectionDraft, '下書きが開いていない').not.toBeNull();
    expect(codeDraftOf(s).lid).toBe('n1');
    expect(codeDraftOf(s).line).toBe(2);
    expect(codeDraftOf(s).openLine).toBe('```js');
    expect(codeDraftOf(s).original).toBe('const a = 1;');
    // ⚠ アプリ全体は編集中にならない(章と同じ中核の主張)
    expect(s.phase).toBe('ready');
  });

  it('🔴 frontmatter が在る本文でも、`line` は剥がした側の基準で開く(frontmatterLineCount で足す)', () => {
    // frontmatter は 3 行(--- / date: … / ---)。DOM の `line` は
    // 剥がした側の基準(`OPEN_SECTION_DRAFT` と同じ規約)なので、生の body では
    // 枠の開きの行(剥がした側の行 2)は frontmatter の行数(3)を足した
    // 生の行 5 で一致することを見る。
    const withFrontmatter = ['---', 'date: 2026-09-26', '---'].join('\n') + '\n' + DOC;
    const s = reduce(booted(withFrontmatter), { type: 'OPEN_CODE_DRAFT', lid: 'n1', line: 2 }).state;
    expect(s.sectionDraft, '開けなかった(frontmatter のずらしが効いていない)').not.toBeNull();
    expect(codeDraftOf(s).line).toBe(5); // 3(frontmatter) + 2
    expect(codeDraftOf(s).original).toBe('const a = 1;');
  });

  it('🔴 開きの行以外(枠の中の行)を押しても開かない', () => {
    const s = reduce(booted(), { type: 'OPEN_CODE_DRAFT', lid: 'n1', line: 3 }).state;
    expect(s.sectionDraft, '開きの行以外で開いた').toBeNull();
    expect(s.error ?? '').toContain('このコードブロックを編集できませんでした');
  });

  it('🔴 枠でない行を押しても、断って開かない', () => {
    const s = reduce(booted(), { type: 'OPEN_CODE_DRAFT', lid: 'n1', line: 0 }).state;
    expect(s.sectionDraft).toBeNull();
    expect(s.error ?? '').toContain('このコードブロックを編集できませんでした');
  });

  it('🔴 phase が ready でなければ開かない(無言で何もしない)', () => {
    const editing = reduce(booted(), { type: 'START_EDIT' }).state;
    const s = reduce(editing, { type: 'OPEN_CODE_DRAFT', lid: 'n1', line: 2 }).state;
    expect(s.sectionDraft).toBeNull();
  });

  it('🔴 openBody が別のノートを持っているときは開かない', () => {
    const s = reduce(booted(), { type: 'OPEN_CODE_DRAFT', lid: 'n2', line: 2 }).state;
    expect(s.sectionDraft).toBeNull();
  });

  it('🔴 二重に開かない。可視の理由(コードを編集中は使えません)を出す', () => {
    const opened = reduce(booted(), { type: 'OPEN_CODE_DRAFT', lid: 'n1', line: 2 }).state;
    const again = reduce(opened, { type: 'OPEN_CODE_DRAFT', lid: 'n1', line: 2 });
    expect(again.state.error, '無言のまま(押しても何も起きない)').toBe(CODE_DRAFT_NOTE);
  });

  it('🔴 章の欄が開いている間に、この lid でコード枠を開こうとすると「章」で断る', () => {
    const withSection = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 0 }).state;
    const r = reduce(withSection, { type: 'OPEN_CODE_DRAFT', lid: 'n1', line: 2 });
    // ⚠ いま開いている下書きの種類(章)で断り文が決まる ── これから開こうとして
    //   いる種類(コード)ではない(§9)。
    expect(r.state.error).toBe(SECTION_DRAFT_NOTE);
    expect(r.state.sectionDraft, '章の欄が消えた').not.toBeNull();
  });
});

describe('SAVE_CODE_DRAFT(#1044 段3。SAVE_SECTION_DRAFT と全く同じ形)', () => {
  const opened = (line = 2): AppState =>
    reduce(booted(), { type: 'OPEN_CODE_DRAFT', lid: 'n1', line }).state;

  it('🔴 「保存中」の印を立て、本文を載せない要求(REQUEST_CODE_SAVE)を出す', () => {
    const s0 = opened();
    const r = reduce(s0, { type: 'SAVE_CODE_DRAFT', text: 'const a = 2;' });
    expect(r.state.sectionDraft, '保存中に箱が消えた').not.toBeNull();
    expect(codeDraftOf(r.state).saving).toBe(true);
    const req = r.events.find((e) => e.type === 'REQUEST_CODE_SAVE');
    expect(req, '要求が出ていない').toBeDefined();
    if (req?.type === 'REQUEST_CODE_SAVE') {
      expect(req.lid).toBe('n1');
      expect(req.line).toBe(2);
      expect(req.openLine).toBe('```js');
      expect(req.original).toBe('const a = 1;');
      expect(req.quote).toBe(0);
      expect(req.text).toBe('const a = 2;');
      // 🔑 本文そのものは event に載らない(disk から読み直す作法)
      expect(Object.keys(req)).not.toContain('body');
    }
  });

  it('🔴 二重押しは黙って捨てる(saving 中の再送)', () => {
    const s0 = reduce(opened(), { type: 'SAVE_CODE_DRAFT', text: 'const a = 2;' }).state;
    const r = reduce(s0, { type: 'SAVE_CODE_DRAFT', text: 'const a = 3;' });
    expect(r.events.length, '二重に要求を出した').toBe(0);
  });

  it('🔴 章の欄が開いているときに撃たれても、黙って捨てる(防波堤)', () => {
    const s0 = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 0 }).state;
    const r = reduce(s0, { type: 'SAVE_CODE_DRAFT', text: 'x' });
    expect(r.events.length).toBe(0);
    expect(r.state).toBe(s0);
  });
});

describe('CODE_SAVED / CODE_SAVE_FAILED(#1044 段3)', () => {
  const opened = (): AppState => reduce(booted(), { type: 'OPEN_CODE_DRAFT', lid: 'n1', line: 2 }).state;
  const saving = (): AppState => reduce(opened(), { type: 'SAVE_CODE_DRAFT', text: 'const a = 2;' }).state;

  it('🔴 保存できたら、下書きを閉じて本文を差し替える', () => {
    const s0 = saving();
    const newBody = DOC.replace('const a = 1;', 'const a = 2;');
    const r = reduce(s0, {
      type: 'CODE_SAVED',
      lid: 'n1',
      gen: s0.lockGen,
      line: 2,
      openLine: '```js',
      quote: 0,
      body: newBody,
      status: null,
      date: null,
      archived: false,
    });
    expect(r.state.sectionDraft, '保存できたのに下書きが残っている').toBeNull();
    expect(r.state.openBody?.body).toBe(newBody);
  });

  it('🔴 世代の合わない ack は無視する(強制解放の後着)', () => {
    const s0 = saving();
    const r = reduce(s0, {
      type: 'CODE_SAVED',
      lid: 'n1',
      gen: s0.lockGen + 1,
      line: 2,
      openLine: '```js',
      quote: 0,
      body: 'x',
      status: null,
      date: null,
      archived: false,
    });
    expect(r.state).toBe(s0);
  });

  it('🔴 身元(line/openLine/quote)の合わない ack は無視する', () => {
    const s0 = saving();
    const r = reduce(s0, {
      type: 'CODE_SAVED',
      lid: 'n1',
      gen: s0.lockGen,
      line: 99,
      openLine: '```js',
      quote: 0,
      body: 'x',
      status: null,
      date: null,
      archived: false,
    });
    expect(r.state).toBe(s0);
  });

  it('🔴 断られたら saving を解き、断り文を控える(箱・書きかけは残す)', () => {
    const s0 = saving();
    const r = reduce(s0, {
      type: 'CODE_SAVE_FAILED',
      lid: 'n1',
      gen: s0.lockGen,
      line: 2,
      openLine: '```js',
      quote: 0,
      error: CODE_SAVE_MISMATCH_NOTE,
    });
    expect(r.state.sectionDraft, '断られたのに下書きが消えた').not.toBeNull();
    expect(codeDraftOf(r.state).saving).toBe(false);
    expect(r.state.error).toBe(CODE_SAVE_MISMATCH_NOTE);
  });
});

describe('CANCEL_CODE_DRAFT(#1044 段3)', () => {
  it('🔴 書かずに閉じる', () => {
    const s0 = reduce(booted(), { type: 'OPEN_CODE_DRAFT', lid: 'n1', line: 2 }).state;
    const r = reduce(s0, { type: 'CANCEL_CODE_DRAFT' });
    expect(r.state.sectionDraft).toBeNull();
  });

  it('🔴 保存中は黙って捨てる(saving の間はやめられない)', () => {
    const opened = reduce(booted(), { type: 'OPEN_CODE_DRAFT', lid: 'n1', line: 2 }).state;
    const s0 = reduce(opened, { type: 'SAVE_CODE_DRAFT', text: 'x' }).state;
    const r = reduce(s0, { type: 'CANCEL_CODE_DRAFT' });
    expect(r.state.sectionDraft, '保存中なのに閉じた').not.toBeNull();
  });

  it('🔴 章の欄が開いているときに撃たれても無視する(種類が違う)', () => {
    const s0 = reduce(booted(), { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 0 }).state;
    const r = reduce(s0, { type: 'CANCEL_CODE_DRAFT' });
    expect(r.state.sectionDraft, '章の欄が消えた').not.toBeNull();
  });
});

describe('コード枠の欄が開いている間の門(#1043 の拡張・#1044 段3)', () => {
  it('🔴 同じノートの本文の書き込みは「コード」で断る。別のノートは自由', () => {
    const s = reduce(booted(), { type: 'OPEN_CODE_DRAFT', lid: 'n1', line: 2 }).state;
    expect(bodyWriteBlockReason(s, 'n1')).toBe(CODE_DRAFT_NOTE);
    expect(bodyWriteBlockReason(s, 'n2'), '別のノートまで止めている').toBeNull();
  });

  it('🔴 同じノートで全文編集を始めようとすると、可視の理由で断る(下書きは消えない)', () => {
    const s0 = reduce(booted(), { type: 'OPEN_CODE_DRAFT', lid: 'n1', line: 2 }).state;
    const r = reduce(s0, { type: 'START_EDIT' });
    expect(r.state.phase, '全文編集に入ってしまった').toBe('ready');
    expect(r.state.sectionDraft, '下書きが消えた').not.toBeNull();
    expect(r.state.error).toBe(CODE_DRAFT_NOTE);
  });
});

/**
 * 🔴 **段2(`guardSectionDraftTransition`)の外側の門が、コード枠でも同じように効く**
 * (#1044 段3)。⚠ 判定は種類に依らない(action の種類ではなく「結果の形」を見る)
 * ので、章の test と同じ主張をコード枠で当て直すだけでよい。
 */
describe('コード枠の欄を離れる遷移を reduce() の外側で止める(#1044 段3)', () => {
  it('🔴 user の action ── 選択を別のノートへ動かそうとすると、丸ごと断る', () => {
    const s0 = reduce(booted(), { type: 'OPEN_CODE_DRAFT', lid: 'n1', line: 2 }).state;
    const naive = { ...s0, selectedLid: 'n2' as string | null };
    const r = guardSectionDraftTransition(s0, { type: 'SELECT_ENTRY', lid: 'n2' }, { state: naive, events: [] });
    expect(r.state.selectedLid, 'user の action なのに選択が動いた').toBe('n1');
    expect(r.state.error).toBe(CODE_DRAFT_NOTE);
    expect(r.state.sectionDraft, '断ったのに下書きが消えた').not.toBeNull();
  });

  it('🔴 system command ── 結果は受け入れ、下書きを閉じて「コード」の字で知らせる', () => {
    const s0 = reduce(booted(), { type: 'OPEN_CODE_DRAFT', lid: 'n1', line: 2 }).state;
    const naive = { ...s0, selectedLid: 'n2' as string | null };
    const r = guardSectionDraftTransition(
      s0,
      { type: 'SYS_BOOTED', cid: 'c2', metas: [], relations: [] },
      { state: naive, events: [] },
    );
    expect(r.state.sectionDraft, 'system の結果なのに下書きが残った').toBeNull();
    expect(r.state.notice).toBe(CODE_DRAFT_CLOSED_BY_SYSTEM_NOTICE);
  });
});

describe('hasUnsavedTyping / unsavedTypingLidOf はコード枠の下書きも見る(#1044 段3)', () => {
  it('🔴 コード枠が開いている間、打ちかけ有りと answers', () => {
    const s = reduce(booted(), { type: 'OPEN_CODE_DRAFT', lid: 'n1', line: 2 }).state;
    expect(hasUnsavedTyping(s)).toBe(true);
    expect(unsavedTypingLidOf(s)).toBe('n1');
  });
});

/**
 * 🔴 **FORCE_RELEASE_LOCK はコード枠の保存中にも効く**(#1044 段2 T1 の続き ── 段3)。
 *
 * 🔑 実装(`app-state.ts` の `FORCE_RELEASE_LOCK`)は `state.sectionDraft?.saving`
 *   だけを見て `saving: false` へ倒しているので、章とコードで**同じコードが**動く
 *   (種類ごとの分岐は要らない)。⚠ ここが確かめるのは「本当にそうなっているか」──
 *   段2 の T1(`section-draft.test.ts`)と全く同じ 5 本を、コード枠で当て直す。
 */
describe('FORCE_RELEASE_LOCK はコード枠の保存中にも効く(#1044 段3)', () => {
  const saving = (line = 2): AppState =>
    reduce(reduce(booted(), { type: 'OPEN_CODE_DRAFT', lid: 'n1', line }).state, {
      type: 'SAVE_CODE_DRAFT',
      text: 'const a = 2;',
    }).state;

  it('🔴 saving: true → FORCE_RELEASE_LOCK → saving が false、lid/line/openLine/original は 1 バイトも変わらない', () => {
    const s0 = saving();
    const r = reduce(s0, { type: 'FORCE_RELEASE_LOCK', discardDraft: false });
    expect(r.state.sectionDraft, '打ち切ったのに箱が消えた').not.toBeNull();
    expect(r.state.sectionDraft!.saving, '打ち切ったのに保存中の印が残っている').toBe(false);
    expect(r.state.sectionDraft!.lid).toBe(s0.sectionDraft!.lid);
    expect(codeDraftOf(r.state).line).toBe(codeDraftOf(s0).line);
    expect(codeDraftOf(r.state).openLine).toBe(codeDraftOf(s0).openLine);
    expect(codeDraftOf(r.state).quote).toBe(codeDraftOf(s0).quote);
    expect(r.state.sectionDraft!.original).toBe(s0.sectionDraft!.original);
    // 🔑 世代は必ず上がる(後着の ack を無視するための本体)
    expect(r.state.lockGen).toBe(s0.lockGen + 1);
  });

  it('🔴 打ち切った後、古い世代の CODE_SAVED が届いても無視される(画面と disk が食い違わない)', () => {
    const s0 = saving();
    const released = reduce(s0, { type: 'FORCE_RELEASE_LOCK', discardDraft: false }).state;
    const d = codeDraftOf(s0);
    const r = reduce(released, {
      type: 'CODE_SAVED',
      lid: 'n1',
      gen: s0.lockGen, // ⚠ 打ち切り前の(もう古い)世代
      line: d.line,
      openLine: d.openLine,
      quote: d.quote,
      body: 'よそから来た本文(遅れて届いた ack)',
      status: null,
      date: null,
      archived: false,
    });
    expect(r.state, '古い世代の ack を受け入れてしまった').toBe(released);
  });

  it('🔴 打ち切った後、古い世代の CODE_SAVE_FAILED も無視される', () => {
    const s0 = saving();
    const released = reduce(s0, { type: 'FORCE_RELEASE_LOCK', discardDraft: false }).state;
    const d = codeDraftOf(s0);
    const r = reduce(released, {
      type: 'CODE_SAVE_FAILED',
      lid: 'n1',
      gen: s0.lockGen,
      line: d.line,
      openLine: d.openLine,
      quote: d.quote,
      error: '遅れて届いた断り',
    });
    expect(r.state).toBe(released);
  });

  it('対照群: saving: false(保存中でない)ときは、sectionDraft を 1 バイトも触らない', () => {
    const s0 = reduce(booted(), { type: 'OPEN_CODE_DRAFT', lid: 'n1', line: 2 }).state;
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
