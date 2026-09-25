/**
 * 🔴 **編集中でも、他ノートの書込を止めない**(C6 / #1043)。
 *
 * ⚠ 直す前は、本文を書き換える reducer の 7 case が `state.phase !== 'ready'`
 *   **だけ**を見て、編集中は**編集中のノートと無関係な別ノートの書込まで**
 *   捨てていた(7 case は無言 / `bodyRewriteGate` と予定表の日付・繰り返しの
 *   3 case は声には出していたが、判定はやはり phase だけだった)。ここは 3 段で見る:
 *   ① `bodyWriteBlockReason` 単体(lid の判定そのもの)
 *   ② reducer の各 case(ready / editing+別 lid / editing+同じ lid / error)
 *   ③ 走査による全数 pin(直したはずの 7 case が「無言」の形へ戻っていないか、
 *      かつ**まだ触っていない残り**が変わっていないか)
 *
 * ⚠ **binder(実クリック)の側は別 file が持つ**(押した所と効く先が一致するかは
 *   あちらの領分):`csv-cell-edit.test.ts`(`edit-cell` / `shape-cell`)、
 *   `center-pane.test.ts`(`toggle-task` の横に留めた枠)、
 *   `table-format-menu.test.ts`(`applyTableFormat`)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codeOnly } from '../helpers/code-only';
import {
  bodyWriteBlockReason,
  initialState,
  reduce,
  type AppState,
} from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';

function meta(lid: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'todo',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: 'open',
    date: null,
    archived: false,
    bodyChars: null,
    ...over,
  };
}

function booted(metas: EntryMeta[]): AppState {
  return reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] }).state;
}

/**
 * phase を `editing` にし、`openBody.lid` を指定する。
 * ⚠ 実装の不変量(`START_EDIT`)どおり、editing は必ず `openBody` を伴う形にする
 *   ── そうしないと fixture が実物より緩い状態を作り、検査が空振りする
 *   (CLAUDE.md §1「検査の主張そのものが成り立たない」の裏を突かない)。
 */
function editing(state: AppState, lid: string): AppState {
  return {
    ...state,
    phase: 'editing',
    openBody: { lid, body: 'x', baseline: 'x', persisted: 'x', diskAhead: false },
  };
}

describe('bodyWriteBlockReason(C6 / #1043) ── lid で判定する', () => {
  const s0 = booted([meta('n1'), meta('n2')]);

  it('ready なら誰にも断らない', () => {
    expect(bodyWriteBlockReason(s0, 'n1')).toBeNull();
    expect(bodyWriteBlockReason(s0, 'n2')).toBeNull();
  });

  it('editing + 編集中のノート自身 → 断る(前置きは編集中の字)', () => {
    expect(bodyWriteBlockReason(editing(s0, 'n1'), 'n1')).toBe('編集を終了してから');
  });

  it('editing + 別ノート → 断らない(横に留めた枠を止めない)', () => {
    expect(bodyWriteBlockReason(editing(s0, 'n1'), 'n2')).toBeNull();
  });

  it('error phase → lid に関わらず断る(出口は「再保存」だけ)', () => {
    const s: AppState = { ...s0, phase: 'error' };
    expect(bodyWriteBlockReason(s, 'n1')).toContain('再保存');
    expect(bodyWriteBlockReason(s, 'n2')).toContain('再保存');
  });

  it('initializing → lid に関わらず断る', () => {
    const s: AppState = { ...s0, phase: 'initializing' };
    expect(bodyWriteBlockReason(s, 'n1')).not.toBeNull();
    expect(bodyWriteBlockReason(s, 'n2')).not.toBeNull();
  });
});

interface CaseSpec {
  name: string;
  action: (lid: string) => Record<string, unknown>;
  /** 成功したときの `rewrite.kind`(TOGGLE_TODO_STATUS だけ形が違うので別枠)。 */
  rewriteKind: string;
}

const CASES: CaseSpec[] = [
  { name: 'TOGGLE_TASK', action: (lid) => ({ type: 'TOGGLE_TASK', lid, line: 0 }), rewriteKind: 'task' },
  {
    name: 'SET_CSV_CELL',
    action: (lid) => ({ type: 'SET_CSV_CELL', lid, line: 1, col: 0, value: 'x' }),
    rewriteKind: 'csv-cell',
  },
  {
    name: 'SET_CSV_SHAPE',
    action: (lid) => ({ type: 'SET_CSV_SHAPE', lid, line: 1, col: 0, what: 'row', mode: 'add' }),
    rewriteKind: 'csv-shape',
  },
  {
    name: 'SET_TABLE_FORMAT',
    action: (lid) => ({ type: 'SET_TABLE_FORMAT', lid, line: 0, to: 'csv' }),
    rewriteKind: 'table-format',
  },
  {
    name: 'MATERIALIZE_REPEAT',
    action: (lid) => ({ type: 'MATERIALIZE_REPEAT', lid, line: 0, date: '2026-09-25' }),
    rewriteKind: 'repeat-done',
  },
  {
    name: 'MOVE_REPEAT_OCCURRENCE',
    action: (lid) => ({
      type: 'MOVE_REPEAT_OCCURRENCE',
      lid,
      line: 0,
      from: '2026-09-25',
      to: '2026-09-26',
    }),
    rewriteKind: 'repeat-move',
  },
  /**
   * ⚠ 予定表の残り 3 つ(行の予定 / 繰り返し / ノートの日付)も同じ門(#1043 の着地前に足した)。
   *   直す前は phase だけで断っており、予定表で「この回だけ」は動くのに
   *   「全部ずらす」(= SET_TASK_DATE)は断られる食い違いが在った。
   */
  {
    name: 'SET_TASK_DATE',
    action: (lid) => ({ type: 'SET_TASK_DATE', lid, line: 0, date: '2026-09-26', until: null }),
    rewriteKind: 'line-date',
  },
  {
    name: 'SET_TASK_REPEAT',
    action: (lid) => ({ type: 'SET_TASK_REPEAT', lid, line: 0, repeat: null }),
    rewriteKind: 'line-date',
  },
  {
    name: 'SET_ENTRY_DATE',
    action: (lid) => ({ type: 'SET_ENTRY_DATE', lid, date: '2026-09-26' }),
    rewriteKind: 'frontmatter',
  },
];

describe('reducer の 9 case(TOGGLE_TODO_STATUS は形が違うので下に別枠) ── C6 / #1043', () => {
  const metas = [meta('n1'), meta('n2')];

  for (const c of CASES) {
    describe(c.name, () => {
      it('① ready → 今までどおり書く', () => {
        const r = reduce(booted(metas), c.action('n1') as never);
        expect(r.events).toHaveLength(1);
        expect(r.events[0]).toMatchObject({
          type: 'REQUEST_BODY_REWRITE',
          lid: 'n1',
          rewrite: { kind: c.rewriteKind },
        });
      });

      it('② editing + 別ノート → 書く(横に留めた枠を止めない)', () => {
        const s = editing(booted(metas), 'n1');
        const r = reduce(s, c.action('n2') as never);
        expect(r.events).toHaveLength(1);
        expect(r.events[0]).toMatchObject({ type: 'REQUEST_BODY_REWRITE', lid: 'n2' });
        expect(r.state.error ?? null, '別ノートなのに断られた').toBeNull();
      });

      it('③ editing + 編集中のノート自身 → 書かず、断り文が出る', () => {
        const s = editing(booted(metas), 'n1');
        const r = reduce(s, c.action('n1') as never);
        expect(r.events, '編集中のノート自身なのに書いた').toEqual([]);
        expect(r.state.error ?? '').toContain('編集を終了してから');
      });

      it('④ error phase → 書かず、「再保存」の字(lid に関わらず)', () => {
        const s: AppState = { ...booted(metas), phase: 'error' };
        const r = reduce(s, c.action('n2') as never);
        expect(r.events).toEqual([]);
        expect(r.state.error ?? '').toContain('再保存');
      });
    });
  }
});

/**
 * 🔴 **TOGGLE_TODO_STATUS は形が違うので別枠**(rewrite が `frontmatter` で、
 *   todo 以外は今までどおり no-op)。
 */
describe('TOGGLE_TODO_STATUS ── C6 / #1043', () => {
  const metas = [meta('n1'), meta('n2')];

  it('① ready → 今までどおり書く', () => {
    const r = reduce(booted(metas), { type: 'TOGGLE_TODO_STATUS', lid: 'n1' } as never);
    expect(r.events).toEqual([
      expect.objectContaining({ type: 'REQUEST_BODY_REWRITE', lid: 'n1' }),
    ]);
  });

  it('② editing + 別ノート → 書く', () => {
    const s = editing(booted(metas), 'n1');
    const r = reduce(s, { type: 'TOGGLE_TODO_STATUS', lid: 'n2' } as never);
    expect(r.events).toHaveLength(1);
    expect(r.state.error ?? null).toBeNull();
  });

  it('③ editing + 編集中のノート自身 → 書かず、断り文が出る', () => {
    const s = editing(booted(metas), 'n1');
    const r = reduce(s, { type: 'TOGGLE_TODO_STATUS', lid: 'n1' } as never);
    expect(r.events).toEqual([]);
    expect(r.state.error ?? '').toContain('編集を終了してから');
  });

  it('④ error phase → 書かず、「再保存」の字', () => {
    const s: AppState = { ...booted(metas), phase: 'error' };
    const r = reduce(s, { type: 'TOGGLE_TODO_STATUS', lid: 'n1' } as never);
    expect(r.events).toEqual([]);
    expect(r.state.error ?? '').toContain('再保存');
  });
});

/**
 * 🔴 **`bodyRewriteGate`(板・本文の塊など)も同じ判定へ変えた**(C6 / #1043)。
 * ⚠ 代表として `MOVE_BLOCK` で見る ── 10 個の呼び手は皆 `bodyRewriteGate` 1 本を
 *   通るので、ここが緑なら残りも同じ判定を通っている(§7「判定を 1 か所へ寄せる」)。
 */
describe('bodyRewriteGate(板・本文の塊)── C6 / #1043', () => {
  const metas = [meta('n1', { archetype: 'text' }), meta('n2', { archetype: 'text' })];
  const move = (lid: string) => ({ type: 'MOVE_BLOCK', lid, start: 0, end: 0, toBefore: 2 });

  it('① ready → 今までどおり、画面に出ている本文から組んで書く', () => {
    let s = booted(metas);
    s = { ...s, openBody: { lid: 'n1', body: 'a\nb\nc', baseline: 'a\nb\nc', persisted: 'a\nb\nc', diskAhead: false } };
    const r = reduce(s, move('n1') as never);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: 'REQUEST_BODY_REWRITE', lid: 'n1' });
  });

  it('② editing + 別ノート(横に留めた枠 = splitBodies)→ 書く', () => {
    let s = editing(booted(metas), 'n1');
    // ⚠ 横に留めた枠の本文は `splitBodies` に入る(`screenBodyOf` の 2 つ目の器)
    s = { ...s, splitBodies: new Map([['n2', 'x\ny\nz']]) };
    const r = reduce(s, move('n2') as never);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: 'REQUEST_BODY_REWRITE', lid: 'n2' });
    expect(r.state.error ?? null, '別ノートなのに断られた').toBeNull();
  });

  it('③ editing + 編集中のノート自身 → 書かず、断り文が出る', () => {
    const s = editing(booted(metas), 'n1');
    const r = reduce(s, move('n1') as never);
    expect(r.events).toEqual([]);
    expect(r.state.error ?? '').toContain('編集を終了してから');
  });

  it('④ error phase → 書かず、「再保存」の字', () => {
    const s: AppState = { ...booted(metas), phase: 'error' };
    const r = reduce(s, move('n1') as never);
    expect(r.events).toEqual([]);
    expect(r.state.error ?? '').toContain('再保存');
  });
});

/**
 * 🔴 **走査で全数 pin する**(#1043 の依頼)。
 *
 * `state.phase !== 'ready'` だけを見て `{ state, events: [] }` を無言で返す
 * case を reducer 全体から拾い、①直した 7 case が**この形から消えている**
 * ②まだ触っていない残り(35 件。C6 の対象外 ── 理由は下の一覧)が**変わって
 * いない**ことを、既知リストとの等値で見る。
 *
 * ⚠ **codeOnly を先に通す**(コメントに満たされて空振りしない ── CLAUDE.md §1 の
 *   5 度目・10 度目と同じ罠)。
 * ⚠ 増減があったら**この test が落ちる** ── 「無言 case を新しく足した」も
 *   「既知の 35 件のどれかを直した」も、ここへ来て一覧を書き換える。
 */
describe('無言で捨てる case の全数 pin ── C6 / #1043', () => {
  const STATE = codeOnly(readFileSync('src/adapter/state/app-state.ts', 'utf-8'));

  /**
   * ⚠ `[^)]*` で `||` の追加条件(`state.writeLock` 等)まで拾うが、
   *   `&&` で繋いだ条件(`RENAME_ENTRY_TITLE` の「ready でも editing でもなければ」)
   *   は**別物**なので拾わない ── あちらは元から editing 中も通す作り。
   */
  const SILENT_RE =
    /if \(state\.phase !== 'ready'(?:\s*\|\|[^)]*)?\)\s*\n?\s*return \{ state, events: \[\] \};/;

  function silentPhaseOnlyCases(src: string): Set<string> {
    const out = new Set<string>();
    const parts = src.split(/\n {4}case '/);
    for (const part of parts.slice(1)) {
      const name = /^([A-Z_]+)'/.exec(part)?.[1];
      if (name === undefined) continue;
      const body = part.split(/\n {4}case '/)[0]!;
      if (SILENT_RE.test(body)) out.add(name);
    }
    return out;
  }

  it('⚠ 走査が空振りしていない(既知の残りを拾えている)', () => {
    // ⚠ 空振り防止 ── 走査そのものが 0 件を返す壊れ方をしていないか
    expect(silentPhaseOnlyCases(STATE).size).toBeGreaterThan(10);
  });

  it('直した 7 case は、この「無言」の形から消えている', () => {
    const silent = silentPhaseOnlyCases(STATE);
    for (const name of [
      'TOGGLE_TASK',
      'SET_CSV_CELL',
      'SET_CSV_SHAPE',
      'SET_TABLE_FORMAT',
      'MATERIALIZE_REPEAT',
      'MOVE_REPEAT_OCCURRENCE',
      'TOGGLE_TODO_STATUS',
    ]) {
      expect(silent.has(name), `${name} がまだ無言のまま`).toBe(false);
    }
  });

  /**
   * 🔴 **残り 35 件は今回の対象外**。理由は 3 つに分かれる:
   * ① **lid で 1 件に絞れない**(複数の lid・全件・app 全体に効く ──
   *    選択 / フィルタ / 一覧の並び替え / タイル・グループの並び替え 等)
   * ② **本文の書換ではない**(削除・関係・タグ・履歴・ゴミ箱・スマート集計・
   *    添付の差し替え等 ── 対応するなら別 issue)
   * ③ **本文を書き換えるが、主のノートの物**(追記 / 追記を元に戻す /
   *    移動を元に戻す / 外部画像の取り込み)── 押せる経路が編集中に在るかを
   *    確かめてから直す(#1051)
   * ⚠ このリストが増減したら、それは①C6 の対象を増やした ②既存の case を
   *   書き換えた、のどちらかである ── どちらでもここを書き直す。
   */
  it('残り 35 件は変わっていない(増減があれば、この一覧を見直す)', () => {
    const silent = silentPhaseOnlyCases(STATE);
    const known = [
      'ADD_RELATION',
      'ADOPT_EXTERNAL_IMAGES',
      'APPEND_TO_ENTRY',
      'ASK_TAG_SUGGESTIONS',
      'BULK_TAG',
      'CREATE_ENTRY',
      'DELETE_ENTRIES',
      'DELETE_ENTRY',
      'DESELECT_ENTRY',
      'ENTRY_RESTORED',
      'MOVE_APP_GROUP',
      'MOVE_ENTRY_ORDER',
      'OFFICE_ASSET_SAVED',
      'PREVIEW_REVISION',
      'PURGE_TRASH',
      'REMOVE_RELATION',
      'RESET_APP_GROUP_ORDER',
      'RESTORE_REVISION',
      'RESTORE_TRASH',
      'REVISION_LIST_LOADED',
      'ROW_RENAME_BEGIN',
      'SELECT_ALL',
      'SELECT_RANGE',
      'SET_APP_GROUP_ICON',
      'SET_APP_TILE',
      'SET_ENTRY_PARENT',
      'SET_SCOPE',
      'SHOW_HISTORY',
      'SMART_COND',
      'SMART_FIELD',
      'SMART_TAGS',
      'START_EDIT',
      'TOGGLE_SELECT',
      'UNDO_APPEND',
      'UNDO_MOVE',
    ].sort();
    expect([...silent].sort()).toEqual(known);
  });
});
