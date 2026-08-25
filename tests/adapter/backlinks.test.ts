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

/**
 * 🔴 **図に本文のリンクが載っているか**(#186 段③)。
 *
 * ⚠ **部品だけでなく繋ぎを見る** ── `relation-map.ts` が破線を描けることは
 * `relation-map.test.ts` が見ているが、**情報ペインがそれを渡していなければ**
 * user には 1 本も出ない(2026-08-24 に `titleFromBody` で踏んだ型)。
 * 🔑 だからここでは **`InspectorRenderer` を通して**見る。
 */
describe('つながりの図に本文のリンクが載る (#186 段③)', () => {
  function paint(s: AppState): HTMLElement {
    const region = document.createElement('div');
    document.body.append(region);
    new InspectorRenderer(region).render(s);
    return region;
  }
  const edges = (r: HTMLElement): string[] =>
    [...r.querySelectorAll('[data-pkc-field="relation-map-edge"]')].map(
      (l) => l.getAttribute('data-pkc-relation-kind') ?? '',
    );

  /** 出ていく側 ── いま開いている本文の `entry:` から。**新しい問い合わせは 0**。 */
  it('🔴 いま開いている本文が指している先が、辺になる', () => {
    let s = reduce(booted(['a', 'b']), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '[b へ](entry:b)\n' }).state;
    s = reduce(s, { type: 'BACKLINKS_LOADED', lid: 'a', lids: [], truncated: false }).state;
    expect(edges(paint(s)), '本文のリンクが図に載っていない').toEqual(['body-link']);
  });

  /** 入ってくる側 ── 参照元の一覧(#348)から。こちらも**新しい問い合わせは 0**。 */
  it('🔴 参照元も辺になる(向きは相手 → 自分)', () => {
    let s = reduce(booted(['a', 'b']), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '本文だけ\n' }).state;
    s = reduce(s, { type: 'BACKLINKS_LOADED', lid: 'a', lids: ['b'], truncated: false }).state;
    const r = paint(s);
    expect(edges(r)).toEqual(['body-link']);
    // ⚠ 節点は 2 つ(中心 + 相手)── 図として成立していることまで見る
    expect(r.querySelectorAll('[data-pkc-field="relation-map-node"]')).toHaveLength(1);
  });

  /**
   * 🔴 **pkc:// の自分あても辺になる**(#379)。
   * ⚠ 情報ペインが `state.cid` を渡していなければ、`bodyLinkTargets` を直しても
   *   **1 本も出ない** ── 部品ではなく**繋ぎ**を見る。
   */
  it('🔴 pkc:// の自分あても辺になる', () => {
    let s = reduce(booted(['a', 'b']), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '[b へ](pkc://c1/entry/b)\n' }).state;
    s = reduce(s, { type: 'BACKLINKS_LOADED', lid: 'a', lids: [], truncated: false }).state;
    expect(edges(paint(s)), 'cid が渡っていない(pkc:// が辺にならない)').toEqual(['body-link']);
  });

  /**
   * ⚠ **対照群** ── リンクが無ければ 1 本も出ない(「常に 1 本引く」実装を許さない)。
   * 🔑 そして**行ごと畳む**(点 1 つを図と呼ばない)。
   */
  it('⚠ リンクが無ければ図そのものを出さない', () => {
    let s = reduce(booted(['a', 'b']), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: 'ただの本文\n' }).state;
    s = reduce(s, { type: 'BACKLINKS_LOADED', lid: 'a', lids: [], truncated: false }).state;
    const r = paint(s);
    expect(edges(r)).toEqual([]);
    expect(r.querySelector('[data-pkc-field="relation-map"]')).toBe(null);
  });

  /**
   * ⚠ 自分自身へのリンクで、点 1 つの図を作らない。
   * 🔑 落としているのは**情報ペインではなく `buildNeighbourhood`**(自己辺の除去)。
   *   ⚠ 2026-08-25 に情報ペイン側にも同じ判定を書いていたが、変異試験 L9 が
   *   SURVIVED で **no-op** だと教えたので消した ── ここが見るのは
   *   「どこで落としたか」ではなく「**画面にどう出るか**」である。
   */
  it('⚠ 自分へのリンクだけでは図にならない', () => {
    let s = reduce(booted(['a', 'b']), { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body: '[自分](entry:a)\n' }).state;
    s = reduce(s, { type: 'BACKLINKS_LOADED', lid: 'a', lids: [], truncated: false }).state;
    expect(edges(paint(s))).toEqual([]);
    expect(paint(s).querySelector('[data-pkc-field="relation-map"]')).toBe(null);
  });

  /**
   * 🔴 **開いている本文が別のノートのものなら使わない。**
   *
   * ⚠ **いまの reducer ではこの state にならない**(`SELECT_ENTRY` が
   *   `openBody: null` にする)── 実際、`reduce` で組んだ筋では変異が生き延びた。
   * 🔑 だから **state を直に組んで**、そのガードだけが答えを決める場面で見る。
   *   ⚠ これは「起きない場面の test」ではなく、**この面が reducer の不変条件に
   *   寄りかからない**ことの pin である(すぐ上の参照元が
   *   `back.lid !== meta.lid` を見ているのと同じ作法。片方だけ守ると
   *   非対称が残る ── §7)。
   */
  it('🔴 別のノートの本文を、いまのノートのリンクとして出さない', () => {
    let s = reduce(booted(['a', 'b', 'c']), { type: 'SELECT_ENTRY', lid: 'b' }).state;
    s = reduce(s, { type: 'BACKLINKS_LOADED', lid: 'b', lids: [], truncated: false }).state;
    // ⚠ 手で崩す ── `a` の本文を持ったまま `b` を選んでいる状態
    const crossed: AppState = {
      ...s,
      openBody: { lid: 'a', body: '[c へ](entry:c)\n', baseline: '', persisted: '', diskAhead: false },
    };
    expect(edges(paint(crossed)), '前のノートの本文からリンクを作っている').toEqual([]);
    // 対照群 ── 持ち主が合っていれば、ちゃんと辺になる(「常に空」で通る実装を許さない)
    const owned: AppState = {
      ...s,
      openBody: { lid: 'b', body: '[c へ](entry:c)\n', baseline: '', persisted: '', diskAhead: false },
    };
    expect(edges(paint(owned))).toEqual(['body-link']);
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
