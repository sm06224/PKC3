/** @vitest-environment happy-dom */
/**
 * 🔴 **押せない理由を添える先を探すとき、一覧の行の中は歩かない**(#1087)。
 *
 * ## 何が起きていたか
 *
 * 左の列は状態が動くたび(ノートを選ぶ / 編集の 1 打鍵ごと)、添える先を `querySelectorAll` で
 * **左の列の全体**から探していた。行の中には添える先が 1 つも無いのに、行の数に比例して全部の行を
 * 歩いていた(915 行・happy-dom で 1 回あたり約 34 ms。実ブラウザでの値は測っていない)。
 *
 * ## 🔑 直し
 *
 * 行の塊(`<tbody>`)の中へは入らない木の歩き方に替えた。⚠ **見つかる物は同じ**でなければならない ──
 * 下の 1 本目が「従来の全体検索」と全数で突き合わせる(空の一覧の「+ ノートを作る」も含む)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { BLOCKABLE_SELECTOR, BrowseRouter } from '../../src/adapter/ui/render/browse';

function meta(i: number): EntryMeta {
  return {
    lid: 'n' + i,
    title: '題名 ' + i,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: i,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const booted = (n: number): AppState =>
  reduce(initialState, {
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: Array.from({ length: n }, (_, i) => meta(i)),
    relations: [],
  }).state;

function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  const regions = buildShell(root);
  const browse = new BrowseRouter(regions.sidebar, regions.browseHost);
  const found = (): HTMLElement[] => (browse as unknown as { blockables(): HTMLElement[] }).blockables();
  /** 従来の探し方(左の列の全体から選択子 1 本)+ 「+ ノート」。 */
  const expected = (): HTMLElement[] => {
    const run = regions.sidebar.querySelector<HTMLElement>('[data-pkc-field="create-run"]');
    return [
      ...(run === null ? [] : [run]),
      ...regions.sidebar.querySelectorAll<HTMLElement>(BLOCKABLE_SELECTOR),
    ];
  };
  return { browse, found, expected, render: (s: AppState) => browse.render(s, 'filer'), root };
}

beforeEach(() => {
  document.body.textContent = '';
  vi.restoreAllMocks();
});

const sameElements = (a: HTMLElement[], b: HTMLElement[]): boolean =>
  a.length === b.length && a.every((el, i) => el === b[i]);

describe('押せない理由を添える先の探し方(#1087)', () => {
  it('🔴 行が並んでいる一覧でも、従来の全体検索と同じ物が同じ順で見つかる', () => {
    const { found, expected, render } = setup();
    render(booted(40));
    const want = expected();
    expect(want.length, '前提: 添える先が 1 つも無い(突き合わせが空振り)').toBeGreaterThan(3);
    expect(sameElements(found(), want)).toBe(true);
  });

  it('🔴 1 件も無い一覧の「+ ノートを作る」も見つかる(行の塊の外に在る)', () => {
    const { found, expected, render, root } = setup();
    render(booted(0));
    const start = root.querySelector<HTMLElement>('[data-pkc-field="empty-start-create"]');
    expect(start, '前提: 空の一覧の作る口が出ていない').not.toBeNull();
    const got = found();
    expect(got).toContain(start);
    expect(sameElements(got, expected())).toBe(true);
  });

  it('🔴 行の数に比例して歩かない(行を 300 件並べても、選択子を当てた要素数は行数より少ない)', () => {
    const { found, render } = setup();
    render(booted(300));
    const spy = vi.spyOn(Element.prototype, 'matches');
    found();
    expect(spy.mock.calls.length, '行の中まで歩いている').toBeLessThan(300);
    // 対照群: 歩く数が 0 でもこの test が通ってしまわないこと(木は歩いている)
    expect(spy.mock.calls.length).toBeGreaterThan(0);
  });
});
