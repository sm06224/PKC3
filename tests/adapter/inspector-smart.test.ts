/** @vitest-environment happy-dom */
/**
 * 🔴 **どのスマートフォルダに集まっているかを、情報ペインに出す**(#283 P1
 * 「所属の札」)。
 *
 * ## なぜ要るのか ── **user には自力で計算できない**
 *
 * 入れ物は条件を複数持てる(`smart-tags: [請求, 未処理]`)ので、
 * 自分のタグを眺めても「**どこに集まっているか**」は分からない。
 * ⚠ すぐ上の「タグ」の札とは**別物**である ── あちらは「その語で探す」、
 * こちらは「**実際に並んでいる入れ物へ飛ぶ**」。
 *
 * ## 🔴 いちばん大事なのは「**「無し」と書かない**」ほう
 *
 * 引き当ては `state.smartHits`(既に集めた結果)から**同期で**行う ──
 * 入れ物の条件は**入れ物の本文**に在るので、全数で答えるには選ぶたびに
 * `getBody` を N 本読むことになる。
 * ⚠ その代わり、**まだ集めていない入れ物は「集めていない」と区別できない**。
 * 🔑 だから 1 つも無いときは**行ごと畳む** ── 「無し」と書くと、
 *   実際には集まっているのに**無いと嘘をつく**(#284 で踏んだ型)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { EMPTY_SMART } from '../../src/features/smart/smart-spec';

function meta(lid: string, order: number, title: string, archetype = 'text'): EntryMeta {
  return {
    lid,
    title,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const METAS = [
  meta('s1', 1, 'ぬ・請求', 'smart'),
  meta('s2', 2, 'あ・未処理', 'smart'),
  meta('n1', 3, 'ノート 1'),
  meta('n2', 4, 'ノート 2'),
];

function ready(): AppState {
  return reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] })
    .state;
}

/** 入れ物 `smartLid` が `lids` を集めた、という状態にする。 */
function scanned(s: AppState, smartLid: string, lids: string[]): AppState {
  return reduce(s, {
    type: 'SMART_SCANNED',
    lid: smartLid,
    lids,
    total: lids.length,
    spec: EMPTY_SMART,
  }).state;
}

beforeEach(() => {
  document.body.textContent = '';
});

function rig() {
  const root = document.createElement('div');
  document.body.append(root);
  const inspector = new InspectorRenderer(buildShell(root).inspector);
  const chips = (): string[] =>
    [...root.querySelectorAll('[data-pkc-field="inspector-smart-hit"]')].map(
      (e) => e.textContent ?? '',
    );
  const box = (): HTMLElement | null =>
    root.querySelector('[data-pkc-field="inspector-smart"]');
  return { root, inspector, chips, box };
}

describe('情報ペインの「集まり先」', () => {
  it('🔴 集めている入れ物が札で出て、押すとそこへ飛べる形になっている', () => {
    const r = rig();
    let s = scanned(ready(), 's1', ['n1', 'n2']);
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state;
    r.inspector.render(s);
    expect(r.chips(), '集まり先が出ていない').toEqual(['ぬ・請求']);

    // 🔑 **飛べる形になっている**(押す先を持たない札は、ただの字である)
    const chip = r.root.querySelector('[data-pkc-field="inspector-smart-hit"]')!;
    expect(chip.getAttribute('data-pkc-action'), '押しても何も起きない札').toBe('select-entry');
    expect(chip.getAttribute('data-pkc-entry'), '飛ぶ先が入っていない').toBe('s1');
  });

  /**
   * 🔴 **これがこの機能のいちばん大事な性質**である。
   * ⚠ 「無し」と書く実装は、**集めていないだけの入れ物**を「集めていない」と
   *   断定する ── user は「入れたはずなのに入っていない」を見る。
   */
  it('🔴 まだ 1 つも集めていないときは、行ごと畳む(「無し」と書かない)', () => {
    const r = rig();
    // ⚠ 空振り防止 ── 選んではいる(器そのものは在る)
    r.inspector.render(reduce(ready(), { type: 'SELECT_ENTRY', lid: 'n1' }).state);
    expect(r.box(), '器ごと無い(この test は何も見ていない)').not.toBeNull();
    expect(r.box()!.hidden, '集めていないのに行が出ている').toBe(true);
    expect(r.box()!.textContent, '「無し」と書いている').toBe('');
    // 🔑 見出し(`<dt>`)も一緒に畳む ── 値だけ消すと空の見出しが残る
    const dt = r.box()!.previousElementSibling as HTMLElement;
    expect(dt.hidden, '見出しだけ残っている').toBe(true);
  });

  it('⚠ 集めていても自分が入っていなければ畳む', () => {
    const r = rig();
    let s = scanned(ready(), 's1', ['n2']);
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state;
    r.inspector.render(s);
    expect(r.chips()).toEqual([]);
    expect(r.box()!.hidden).toBe(true);
  });

  /**
   * 🔴 **集め直したら、その場で出る。**
   * ⚠ 情報ペインは**指紋を持たない**(状態が動くたび描く)のが意図だが、
   *   将来 `smartHits` を見ない指紋が入ると、**集め終わっても札が出ない**
   *   という、押しても画面が 1 ドットも変わらない形になる(#411 / #478 と同じ型)。
   */
  it('🔴 集め終わったら、その場で札が出る', () => {
    const r = rig();
    let s = reduce(ready(), { type: 'SELECT_ENTRY', lid: 'n1' }).state;
    r.inspector.render(s);
    expect(r.chips(), '前提: まだ出ていない').toEqual([]);
    s = scanned(s, 's1', ['n1']);
    r.inspector.render(s);
    expect(r.chips(), '集め終わったのに札が出ない').toEqual(['ぬ・請求']);
  });

  /**
   * 🔑 **並びは題名順**。⚠ `Map` の順は**集めた順**なので、
   *   同じ状態でも入れ物を開いた順で札が並び替わる(画面が理由なく動く)。
   */
  it('🔑 札の並びは題名順(集めた順で動かない)', () => {
    const r = rig();
    // ⚠ わざと「ぬ」→「あ」の順に集める(Map の順と題名順が食い違う形)
    let s = scanned(scanned(ready(), 's1', ['n1']), 's2', ['n1']);
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state;
    r.inspector.render(s);
    expect(r.chips(), '集めた順のまま出ている').toEqual(['あ・未処理', 'ぬ・請求']);
  });

  /** ⚠ 入れ物が自分自身を集めていても、飛ぶ先にはしない。 */
  it('⚠ 自分自身は出さない', () => {
    const r = rig();
    let s = scanned(ready(), 's1', ['s1', 'n1']);
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 's1' }).state;
    r.inspector.render(s);
    expect(r.chips(), '自分自身へ飛ぶ札が出ている').toEqual([]);
  });
});
