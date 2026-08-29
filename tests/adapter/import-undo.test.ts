/** @vitest-environment happy-dom */
/**
 * 🔴 **取り込みの戻り道**(#535 ②)。
 *
 * ⚠ 見ているのは「押せる口が在るか」ではなく **`DELETE_ENTRIES` が飛ぶか** ──
 *   名前だけの検査は中身を空にする変異を殺さない(CLAUDE.md §1)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codeOnly } from '../helpers/code-only';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { createImportUndo, importPanel } from '../../src/adapter/ui/actions/import-undo';
import { showNotices } from '../../src/adapter/ui/render/notices';

function make(): {
  undo: ReturnType<typeof createImportUndo>;
  sent: Dispatchable[];
  said: string[];
  cleared: number;
} {
  const sent: Dispatchable[] = [];
  const said: string[] = [];
  let cleared = 0;
  const undo = createImportUndo({
    dispatch: (a) => sent.push(a),
    notify: (m) => said.push(m),
    clear: () => {
      cleared += 1;
    },
  });
  return {
    undo,
    sent,
    said,
    get cleared() {
      return cleared;
    },
  } as never;
}

describe('取り込みの戻り道(#535 ②)', () => {
  it('🔴 取り込む前は、出す操作が無い(空の口を置かない)', () => {
    const h = make();
    expect(h.undo.pending()).toBeNull();
  });

  it('🔴 憶えた分を、ごみ箱へ入れる口が出る', () => {
    const h = make();
    h.undo.remember(['a', 'b', 'c']);
    const p = h.undo.pending();
    expect(p?.action).toBe('undo-import');
    // ⚠ 押す前の説明は「起きること」で書く(user 指示 2026-08-21)
    expect(p?.title, '件数と行き先が説明に無い').toContain('3 件');
    expect(p?.title).toContain('ごみ箱');
  });

  it('🔴 押すと DELETE_ENTRIES が、憶えた分ちょうど飛ぶ', () => {
    const h = make();
    h.undo.remember(['a', 'b']);
    h.undo.undo();
    expect(h.sent).toEqual([{ type: 'DELETE_ENTRIES', lids: ['a', 'b'] }]);
    // ⚠ **面を畳む**(戻した後に「取り消す」が残らない)
    expect(h.cleared, '注意の面を畳んでいない').toBe(1);
    expect(h.said.join(''), '何が起きたか言っていない').toContain('ごみ箱');
  });

  it('🔴 2 度押しても 2 度は走らない(200 件が 2 回消えない)', () => {
    const h = make();
    h.undo.remember(['a']);
    h.undo.undo();
    h.undo.undo();
    expect(h.sent).toHaveLength(1);
    expect(h.undo.pending(), '戻した後も口が残っている').toBeNull();
  });

  it('⚠ 憶え直すと、戻せるのは直前の 1 回だけ', () => {
    const h = make();
    h.undo.remember(['a', 'b']);
    h.undo.remember(['c']);
    h.undo.undo();
    expect(h.sent).toEqual([{ type: 'DELETE_ENTRIES', lids: ['c'] }]);
  });

  it('⚠ 0 件を憶えたら、口は出さない', () => {
    const h = make();
    h.undo.remember([]);
    expect(h.undo.pending()).toBeNull();
  });
});

describe('取込の後に出す面(#535 ②)', () => {
  it('🔴 注意が 0 件でも、戻り道が在れば面を出す', () => {
    const r = document.createElement('div');
    const act = { label: '取り消す', action: 'undo-import', title: 'ごみ箱へ入れます' };
    showNotices(r, '取り込みました', [], act);
    expect(r.hidden, '戻り道が在るのに面を畳んでいる').toBe(false);
    expect(r.querySelector('[data-pkc-action="undo-import"]')).not.toBeNull();
    // ⚠ 「(0 件)」と出さない ── ⚠ `textContent` はボタンの字も拾うので、
    //    見るのは**題の文字そのもの**(最初の text node)
    expect(r.querySelector('[data-pkc-field="notices-title"]')?.firstChild?.nodeValue).toBe(
      '取り込みました',
    );
  });

  it('🔴 どちらも無ければ、これまでどおり出さない(空の箱を置かない)', () => {
    const r = document.createElement('div');
    showNotices(r, 't', []);
    expect(r.hidden).toBe(true);
  });

  it('⚠ 「閉じる」はいちばん右のまま(押し慣れた場所を動かさない)', () => {
    const r = document.createElement('div');
    showNotices(r, 't', ['注意 1'], {
      label: '取り消す',
      action: 'undo-import',
      title: 'x',
    });
    const btns = [...r.querySelectorAll('[data-pkc-field="notices-title"] button')];
    expect(btns.map((b) => b.getAttribute('data-pkc-action'))).toEqual([
      'undo-import',
      'dismiss-notices',
    ]);
  });

  it('🔑 題は、注意が在るかで変わる(何も無いのに「注意」と言わない)', () => {
    expect(importPanel([], null).title).toBe('取り込みました');
    expect(importPanel(['x'], null).title).toBe('取込時の注意');
  });
});

/**
 * 🔴 **`main.ts` の配線を pin する**(CLAUDE.md §2)。
 *
 * ⚠ `main.ts` は原文を読む test からしか実行されないので、ここを消す変異は
 *   **全 test 緑のまま通る**。⚠ 弱い検査だと自覚して使う ── 守るのは
 *   「呼んでいるか」だけで、呼んだ結果は上の unit が見る。
 *
 * ⚠ **コメントを落としてから見る**(`codeOnly`)── 「在る」ことの主張は
 *   注釈に満たされる(2026-08-18 の #250 で踏んだ型)。
 */
describe('main.ts の配線(#535 ②)', () => {
  const main = codeOnly(readFileSync('src/main.ts', 'utf-8'));

  it('🔴 取り込んだ id を憶える口が繋がっている', () => {
    expect(main, 'imported が importUndo へ繋がっていない').toContain(
      'imported: (lids) => importUndo.remember(lids)',
    );
  });

  it('🔴 OS から開いた md の経路でも憶える(imported を上書きしている側)', () => {
    /**
     * ⚠ こちらは `imported` を**上書きする**ので、既定の配線が効かない ──
     *   忘れると「OS から開いた md だけ戻せない」が**静かに**残る。
     * 🔑 上書きしている当の block の中に在ることまで見る(file 全体で数えると、
     *   既定の配線 1 件に満たされる ── CLAUDE.md §1)。
     */
    const at = main.indexOf('const handle = handles[i];');
    expect(at, '上書きしている block が無い(前提が崩れている)').toBeGreaterThan(-1);
    const block = main.slice(Math.max(0, at - 400), at);
    expect(block, '上書き側で記憶を呼んでいない').toContain('importUndo.remember(lids)');
  });

  it('🔴 押す口(undoImport)が繋がっている', () => {
    expect(main, 'undoImport が繋がっていない').toContain('undoImport: () => importUndo.undo()');
  });

  it('🔴 注意の面は、戻り道を渡して出す', () => {
    expect(main, 'report が戻り道を渡していない').toContain('importUndo.pending()');
    expect(main, '題を importPanel から採っていない').toContain('importPanel(notes,');
  });
});

/**
 * 🔴 **消したノートを、集めた一覧に残さない**(#535 ② の途中で smoke が捕まえた)。
 *
 * ⚠ これは**取り込みの機能ではなく、既存の欠陥**である ── 消す経路
 * (`removeEntryFromState`)が `taskScan` / `contactScan` / `snippetScan` を
 * 1 バイトも触っていなかったので、**消したノートが予定・連絡先・雛形に残り続けて**いた。
 * 🔑 snapshot を読み直す経路には落とす処理(`keepContacts`)が在ったので、
 *   **片側だけ在る非対称**だった(CLAUDE.md「片側を直したら反対側を疑う」)。
 *
 * ⚠ 3 つとも同じ形なので **3 つとも**見る ── 1 つだけ見ると、
 *   残り 2 つを壊す変異が生き延びる(2026-08-24 の「門を N 個置いたら N 通り」)。
 */
describe('消したノートを、集めた一覧から落とす', () => {
  const base = () => {
    return {
      ...initialState,
      phase: 'ready' as const,
      entryMetas: new Map([
        ['a', { lid: 'a', title: 'A', archetype: 'text' } as never],
        ['b', { lid: 'b', title: 'B', archetype: 'text' } as never],
      ]),
      order: ['a', 'b'],
      taskScan: { cards: [{ lid: 'a' }, { lid: 'b' }], totalNotes: 2, scannedNotes: 2, truncated: false },
      contactScan: { cards: [{ lid: 'a' }, { lid: 'b' }], total: 2, truncated: false },
      snippetScan: { items: [{ lid: 'a' }, { lid: 'b' }], total: 2, truncated: false },
    } as never as AppState;
  };

  it('🔴 予定・連絡先・雛形の 3 つとも、消した分が落ちる', () => {
    const { state } = reduce(base(), { type: 'DELETE_ENTRIES', lids: ['a'] });
    expect(state.taskScan?.cards.map((c) => c.lid), '予定に残っている').toEqual(['b']);
    expect(state.contactScan?.cards.map((c) => c.lid), '連絡先に残っている').toEqual(['b']);
    expect(state.snippetScan?.items.map((i) => i.lid), '雛形に残っている').toEqual(['b']);
  });

  it('⚠ 一覧に載っていないノートを消しても、**同じ参照**のまま(描画の指紋を壊さない)', () => {
    /**
     * 🔴 **居ない lid を渡してはいけない**(2026-08-29、変異試験 N5 が SURVIVED で教えた)。
     * ⚠ `DELETE_ENTRIES` は**居ないものを先に落とす**ので、
     *   `removeEntryFromState` に**一度も入らない** ── 参照が同じなのは
     *   「壊していない」からではなく「**通っていない**」からになる(CLAUDE.md §2)。
     * 🔑 だから **entryMetas には居るが、どの一覧にも載っていない** lid を消す。
     */
    const before = {
      ...base(),
      entryMetas: new Map([
        ...base().entryMetas,
        ['c', { lid: 'c', title: 'C', archetype: 'text' } as never],
      ]),
      order: ['a', 'b', 'c'],
    } as never as AppState;
    const { state } = reduce(before, { type: 'DELETE_ENTRIES', lids: ['c'] });
    // ⚠ 前提: 本当に消えた(通っていないなら下の assert は何も見ていない)
    expect(state.entryMetas.has('c'), '前提: 消えていない(経路を通っていない)').toBe(false);
    expect(state.taskScan, '要らない作り直しをしている').toBe(before.taskScan);
    expect(state.contactScan).toBe(before.contactScan);
    expect(state.snippetScan).toBe(before.snippetScan);
  });

  it('⚠ 集めていない(null)ときは、そのまま null', () => {
    const st = { ...base(), taskScan: null, contactScan: null, snippetScan: null } as AppState;
    const { state } = reduce(st, { type: 'DELETE_ENTRIES', lids: ['a'] });
    expect(state.taskScan).toBeNull();
    expect(state.contactScan).toBeNull();
    expect(state.snippetScan).toBeNull();
  });
});
