/** @vitest-environment happy-dom */
/**
 * 🔴 **このノートを参照しているのはどれか**(#348、user 裁定 2026-08-23)。
 *
 * **user の物語**: ノート A を開いている。参照している側が分からないので探し直す ──
 * **書けば書くほど、書いたことが見つからなくなる**。
 *
 * ⚠ 探し方(`entry:<lid>` を LIKE で当てる)は `tests/adapter/storage-worker.test.ts`。
 * ここが見るのは **state の畳み方**と**画面**である。
 */
import { describe, expect, it } from 'vitest';
import type { AppState } from '../../src/adapter/state/app-state';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';

function meta(lid: string, title = 't-' + lid): EntryMeta {
  return {
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
  };
}

const booted = (lids: string[]): AppState =>
  reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: lids.map((l) => meta(l)),
    relations: [],
  }).state;

describe('バックリンクの要求 (#348)', () => {
  /**
   * 🔴 **選択が動いた 1 か所で引く** ── case ごとに撃つと、次に選択を動かす
   * case を足した人が忘れる(履歴を 1 か所へ寄せたのと同じ理由)。
   */
  it('🔴 ノートを選ぶと引きに行く', () => {
    const s = booted(['a', 'b']);
    const { events } = reduce(s, { type: 'SELECT_ENTRY', lid: 'b' });
    expect(events).toContainEqual({ type: 'REQUEST_BACKLINKS', lid: 'b' });
  });

  /**
   * 🔴 **切り替えたら前の結果はその場で捨てる** ── 残すと、新しいノートの下に
   * **前のノートの参照元**が数百 ms 出る。
   */
  it('🔴 選び直したら、前の結果を残さない', () => {
    let s = booted(['a', 'b']);
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BACKLINKS_LOADED', lid: 'a', lids: ['b'], truncated: false }).state;
    expect(s.backlinks?.lids).toEqual(['b']);
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'b' }).state;
    expect(s.backlinks, '前のノートの参照元が残っている').toBeNull();
  });

  /**
   * 🔴 **遅れて届いた別のノートの分は捨てる** ── 切り替えた直後に前の答えが
   * 着くと、**別のノートの一覧**がその場に出る。
   */
  it('🔴 遅れて届いた別のノートの答えは捨てる', () => {
    let s = booted(['a', 'b']);
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'b' }).state;
    s = reduce(s, { type: 'BACKLINKS_LOADED', lid: 'a', lids: ['x'], truncated: false }).state;
    expect(s.backlinks, '別のノートの答えを受け入れた').toBeNull();
  });

  it('⚠ 同じノートの答えは受け取る(空振り防止)', () => {
    let s = booted(['a', 'b']);
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'b' }).state;
    s = reduce(s, { type: 'BACKLINKS_LOADED', lid: 'b', lids: ['a'], truncated: true }).state;
    expect(s.backlinks).toEqual({ lid: 'b', lids: ['a'], truncated: true });
  });
});

describe('バックリンクの表示 (#348)', () => {
  function paint(s: AppState): HTMLElement {
    const region = document.createElement('div');
    document.body.append(region);
    new InspectorRenderer(region).render(s);
    return region;
  }
  const box = (r: HTMLElement): HTMLElement =>
    r.querySelector<HTMLElement>('[data-pkc-field="inspector-backlinks"]')!;

  /**
   * 🔴 **「まだ」と「無い」を区別する** ── 混ぜると「無し」を出したまま
   * 結果に追いつかない(user は「参照されていない」と読む)。
   */
  it('🔴 引いている最中は「無し」と言わない', () => {
    const s = reduce(booted(['a', 'b']), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    expect(box(paint(s)).textContent).toContain('調べています');
  });

  it('🔴 0 件なら「無し」', () => {
    let s = reduce(booted(['a', 'b']), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BACKLINKS_LOADED', lid: 'a', lids: [], truncated: false }).state;
    expect(box(paint(s)).textContent).toBe('無し');
  });

  /** ⚠ 相手は**押せる**(辿れないと、一覧しても行き止まりになる)。 */
  it('🔴 参照元が押せる形で並ぶ', () => {
    let s = reduce(booted(['a', 'b']), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BACKLINKS_LOADED', lid: 'a', lids: ['b'], truncated: false }).state;
    const btn = box(paint(s)).querySelector<HTMLButtonElement>(
      '[data-pkc-field="inspector-backlink"]',
    );
    expect(btn, '押せる形になっていない').not.toBeNull();
    expect(btn!.getAttribute('data-pkc-action'), '押しても動かない').toBe('select-entry');
    expect(btn!.getAttribute('data-pkc-entry'), '行き先が無い').toBe('b');
    expect(btn!.textContent, '題名が出ていない').toBe('t-b');
  });

  /**
   * ⚠ **消すボタンは置かない**(裁定の形)── これは user が張った辺ではなく、
   * 本文のリンクから拾ったものなので、消すには本文を直す。
   */
  it('⚠ 消すボタンは置かない(手で張った関係とは別物)', () => {
    let s = reduce(booted(['a', 'b']), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BACKLINKS_LOADED', lid: 'a', lids: ['b'], truncated: false }).state;
    expect(
      box(paint(s)).querySelector('[data-pkc-action="remove-relation"]'),
      '本文から拾ったものに消すボタンを置いた',
    ).toBeNull();
  });

  /** 🔴 **切ったら言う**(黙って切ると user は「これで全部」と読む)。 */
  it('🔴 切ったときは、そう言う', () => {
    let s = reduce(booted(['a', 'b']), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BACKLINKS_LOADED', lid: 'a', lids: ['b'], truncated: true }).state;
    expect(box(paint(s)).textContent, '切ったのに言わない').toContain('ほかにも');
  });

  /** ⚠ 相手が消えていても**黙って空にしない**(何が壊れているか分かる形)。 */
  it('⚠ 相手が消えていても、空欄にしない', () => {
    let s = reduce(booted(['a']), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BACKLINKS_LOADED', lid: 'a', lids: ['gone'], truncated: false }).state;
    expect(box(paint(s)).textContent).toContain('見つかりません');
  });
});
