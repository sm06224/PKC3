/** @vitest-environment happy-dom */
/**
 * 🔴 **アプリは 2 回押すと開く**(#857 段①b。user 裁定 2026-09-13
 * 「開くのはダブルタップに変更」)。
 *
 * ## なぜ配線の test を別に置くか
 *
 * 起動そのもの(`launchTile`)も、タイルの並べ替えも、それぞれの test が見ている。
 * ⚠ **その間の配線**(押した回数を数えて開く / 1 回目は印を付ける)は誰も通らない
 * ── 実際、2 段にした日に **unit 9654 件が全部緑のまま**だった
 * (CLAUDE.md §7「A と B が合意していることは、どちらの test にも書けない」)。
 *
 * 🔴 **1 回で開いていた頃に戻すと、ここが落ちる**ことが、この file の存在理由である。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { LauncherRenderer } from '../../src/adapter/ui/render/launcher';
import { withBuiltinTiles, type LauncherTile } from '../../src/features/launcher/tiles';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: lid,
    archetype: 'attachment',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

/** entry 由来のタイル 1 枚 + 組み込み。 */
const TILES = (): LauncherTile[] =>
  withBuiltinTiles(
    [{ lid: 'a1', title: '電卓', group: '', kind: 'url', url: 'https://a.test/' }],
    { office: false },
  );

interface Harness {
  d: Dispatcher;
  /** 開いた lid(`openTile` が呼ばれた順)。 */
  opened: string[];
  press(lid: string): void;
  picked(): string | null;
  /** その lid のボタンに押した印が出ているか。 */
  marked(lid: string): boolean;
}

function setup(): Harness {
  const root = document.createElement('div');
  document.body.append(root);
  const region = document.createElement('div');
  root.append(region);
  const r = new LauncherRenderer(region);
  const d = new Dispatcher();
  const opened: string[] = [];
  bindActions(root, d, { openTile: (lid) => void opened.push(lid) });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a1')], relations: [] });
  d.dispatch({ type: 'LAUNCHER_TILES_LOADED', tiles: TILES() });
  d.onState(() => r.render(d.getState()));
  r.render(d.getState());
  const press = (lid: string): void => {
    const btn = region.querySelector<HTMLElement>(`[data-pkc-tile="${lid}"]`);
    // ⚠ 空振り防止 ── 描けていなければ、以下の assert は何も見ていない
    expect(btn, `タイル ${lid} が描かれていない`).not.toBeNull();
    btn!.click();
  };
  return {
    d,
    opened,
    press,
    picked: () => d.getState().launcherPick,
    marked: (lid) =>
      region.querySelector(`[data-pkc-tile="${lid}"]`)?.hasAttribute('data-pkc-selected') === true,
  };
}

describe('アプリは 2 回押すと開く(#857 段①b)', () => {
  beforeEach(() => {
    document.body.textContent = '';
  });

  it('🔴 1 回押しただけでは開かない ── 印が付くだけ', () => {
    const h = setup();
    h.press('a1');
    expect(h.opened, '1 回で開いた(掴み損ねが窓を開ける)').toEqual([]);
    expect(h.picked(), '印が付いていない(押しても無反応に見える)').toBe('a1');
    expect(h.marked('a1'), '画面に印が出ていない').toBe(true);
  });

  it('🔴 2 回押すと開く', () => {
    const h = setup();
    h.press('a1');
    h.press('a1');
    expect(h.opened).toEqual(['a1']);
  });

  it('🔴 entry を持つタイルは、1 回目で右の列にも出る', () => {
    const h = setup();
    h.press('a1');
    expect(h.d.getState().selectedLid, '押したノートが選ばれていない').toBe('a1');
  });

  /**
   * 🔴 **組み込みは entry を持たない** ── `selectedLid` は 1 ミリも動かないので、
   * ⚠ 印を別に持っていないと**1 回目が完全な無反応**になる。
   */
  it('🔴 組み込みでも 1 回目に印が付く(無反応にしない)', () => {
    const h = setup();
    h.press('builtin:dual');
    expect(h.opened).toEqual([]);
    expect(h.marked('builtin:dual'), '組み込みだけ印が出ない').toBe(true);
    expect(h.d.getState().selectedLid, '存在しない lid を選択に入れた').toBeNull();
    h.press('builtin:dual');
    expect(h.opened).toEqual(['builtin:dual']);
  });

  it('⚠ 別のタイルを挟んだら、数え直す(1 回ずつが 2 回押しに化けない)', () => {
    const h = setup();
    h.press('a1');
    h.press('builtin:dual');
    h.press('a1');
    expect(h.opened, '別のタイルを挟んだのに開いた').toEqual([]);
    expect(h.picked()).toBe('a1');
  });

  /**
   * ⚠ **3 回目を「もう一度」と数えない** ── 数えると、素早く 3 回押したときに
   * 窓が 2 枚開く(閉じるのは user の手間である)。
   */
  it('⚠ 素早く 3 回押しても、開くのは 1 枚', () => {
    const h = setup();
    h.press('a1');
    h.press('a1');
    h.press('a1');
    expect(h.opened).toEqual(['a1']);
  });
});
