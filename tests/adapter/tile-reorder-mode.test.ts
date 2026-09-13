/** @vitest-environment happy-dom */
/**
 * 🔴 **並べ替えモード**(#857 段①b-2。user 裁定 2026-09-13「長押しで並べ替えモード」)。
 *
 * ## なぜ要るか
 *
 * 段① で並べ替えを戻したが、入口は**掴んで落とす**と**右クリックの「上へ / 下へ」**の
 * 2 つで、どちらもマウスが要る ── `long-press.ts` が `pointerType === 'mouse'` を
 * **受けない**と決めているのは、裏を返せば**指だけの端末に入口が 1 つも無い**という
 * ことである(実測:タイルの上で長押ししても `dual-row` にしか当たらなかった)。
 *
 * 🔴 守る主張:
 * 1. **指で長押しするとモードに入り**、押したタイルに印が付く
 * 2. **マウスの長押しでは入らない**(対照群 ── マウスは右クリックが入口)
 * 3. モード中は**2 回押しても開かない**(並べ替え中に窓が開いて本文が入れ替わらない)
 * 4. モード中だけ**「上へ」「下へ」**が出る ── **動かせるタイルにだけ**
 * 5. 「完了」で抜ける。⚠ **抜けた直後の 1 タップでは開かない**(数が汚れていない)
 * 6. 「上へ」を押すと**実際に並びが変わる**(押し所と受け手が繋がっている)
 * 7. **絞り込みを打つとモードが落ちる**(出したまま「押しても効かない」を作らない)
 * 8. 右クリックのメニューに**入口と出口の両方**が出る(片道にしない)
 *
 * ⚠ happy-dom は時計を進めない ── `vi.useFakeTimers()` で `setTimeout` と
 *   `Date.now()` を一緒に進める(`long-press.test.ts` と同じ作法)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { LauncherRenderer } from '../../src/adapter/ui/render/launcher';
import { LONG_PRESS_MS } from '../../src/adapter/ui/actions/long-press';
import { withBuiltinTiles, type LauncherTile } from '../../src/features/launcher/tiles';

function meta(lid: string, order: number): EntryMeta {
  return {
    lid,
    title: lid,
    archetype: 'attachment',
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

/** 動かせるタイル 2 枚(同じ群)+ 組み込み。 */
const TILES = (): LauncherTile[] =>
  withBuiltinTiles(
    [
      { lid: 'a1', title: '電卓', group: '', kind: 'url', url: 'https://a.test/', order: 0 },
      { lid: 'a2', title: '地図', group: '', kind: 'url', url: 'https://b.test/', order: 1 },
    ],
    { office: false },
  );

let root: HTMLElement;
let region: HTMLElement;
let d: Dispatcher;
let opened: string[];
let detach: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);
  region = document.createElement('div');
  root.append(region);
  const r = new LauncherRenderer(region);
  d = new Dispatcher();
  opened = [];
  detach = bindActions(root, d, { openTile: (lid) => void opened.push(lid) });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a1', 1), meta('a2', 2)],
    relations: [],
  });
  d.dispatch({ type: 'LAUNCHER_TILES_LOADED', tiles: TILES() });
  d.onState(() => r.render(d.getState()));
  r.render(d.getState());
});

afterEach(() => {
  detach();
  vi.useRealTimers();
});

const tileEl = (lid: string): HTMLElement => {
  const el = region.querySelector<HTMLElement>(`[data-pkc-tile="${lid}"]`);
  // ⚠ 空振り防止 ── 描けていなければ、以下の assert は何も見ていない
  expect(el, `タイル ${lid} が描かれていない`).not.toBeNull();
  return el!;
};
/** モード中に出る「上へ」「下へ」(その lid のもの)。 */
const moveBtns = (lid: string): HTMLElement[] => [
  ...region.querySelectorAll<HTMLElement>(
    `[data-pkc-field="tile-move"][data-pkc-tile="${lid}"]`,
  ),
];
const done = (): HTMLElement | null =>
  region.querySelector<HTMLElement>('[data-pkc-field="launcher-reorder-done"]');
const order = (): string[] =>
  (d.getState().launcherTiles ?? []).filter((t) => !t.lid.startsWith('builtin:')).map((t) => t.lid);
const press = (lid: string): void => void tileEl(lid).click();
/** 指で長押しする(離す前に時計を進める)。 */
const longPress = (lid: string, kind: 'touch' | 'mouse' = 'touch', ms = LONG_PRESS_MS): void => {
  tileEl(lid).dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: kind,
      button: 0,
      clientX: 0,
      clientY: 0,
    }),
  );
  vi.advanceTimersByTime(ms);
};
const rightClick = (lid: string): void => {
  tileEl(lid).dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }),
  );
};
const menuLabels = (): string[] =>
  [...root.querySelectorAll('[data-pkc-region="context-menu"] button')].map(
    (b) => b.textContent ?? '',
  );

describe('並べ替えモード(#857 段①b-2)', () => {
  it('🔴 ① 指の長押しでモードに入り、押したタイルに印が付く', () => {
    expect(d.getState().launcherReorder, '前提が崩れている(最初から入っている)').toBe(false);
    longPress('a1');
    expect(d.getState().launcherReorder, '長押しで入れない(指だけの端末に道が無い)').toBe(true);
    expect(d.getState().launcherPick, 'どれを長押ししたのか画面に残らない').toBe('a1');
  });

  it('🔴 ② マウスの長押しでは入らない(対照群 ── 押しっぱなしは drag の始まり)', () => {
    longPress('a1', 'mouse');
    expect(d.getState().launcherReorder).toBe(false);
  });

  it('⚠ ②b 500ms 前に離したら入らない', () => {
    longPress('a1', 'touch', LONG_PRESS_MS - 1);
    expect(d.getState().launcherReorder).toBe(false);
    vi.advanceTimersByTime(1);
    expect(d.getState().launcherReorder).toBe(true);
  });

  it('🔴 ③ モード中は 2 回押しても開かない(印だけ動く)', () => {
    d.dispatch({ type: 'SET_LAUNCHER_REORDER', on: true });
    press('a2');
    press('a2');
    expect(opened, '並べ替えている最中に窓が開いた').toEqual([]);
    expect(d.getState().launcherPick, '押しても印すら動かない(無反応に見える)').toBe('a2');
  });

  it('🔴 ④ 「上へ」「下へ」はモード中だけ、動かせるタイルにだけ出る', () => {
    expect(moveBtns('a1'), 'モードでないのに押し所が出ている').toEqual([]);
    d.dispatch({ type: 'SET_LAUNCHER_REORDER', on: true });
    expect(moveBtns('a1').map((b) => b.textContent), '「上へ」「下へ」が出ていない').toEqual([
      '上へ',
      '下へ',
    ]);
    expect(moveBtns('builtin:dual'), '動かせない組み込みにも押し所を出した').toEqual([]);
  });

  it('🔴 ⑤ 「完了」で抜ける ── 抜けた直後の 1 タップでは開かない', () => {
    d.dispatch({ type: 'SET_LAUNCHER_REORDER', on: true });
    press('a1');
    const btn = done();
    expect(btn, '出口が画面に無い(入ったきり出られない)').not.toBeNull();
    btn!.click();
    expect(d.getState().launcherReorder).toBe(false);
    press('a1');
    expect(opened, 'モード中の押しが「1 回目」に数えられていた').toEqual([]);
    press('a1');
    expect(opened, '抜けた後に 2 回押しても開かない').toEqual(['a1']);
  });

  it('🔴 ⑥ 「上へ」を押すと実際に並びが変わる(押し所と受け手が繋がっている)', () => {
    expect(order(), '前提が崩れている').toEqual(['a1', 'a2']);
    d.dispatch({ type: 'SET_LAUNCHER_REORDER', on: true });
    const up = moveBtns('a2')[0];
    expect(up?.textContent).toBe('上へ');
    up!.click();
    expect(order(), '押しても並びが変わらない').toEqual(['a2', 'a1']);
  });

  it('⚠ ⑥b いちばん上で「上へ」を押したら、理由を言う(無言で終わらせない)', () => {
    d.dispatch({ type: 'SET_LAUNCHER_REORDER', on: true });
    moveBtns('a1')[0]!.click();
    expect(d.getState().error, '端で押したのに何も言わない').toContain('いちばん上');
  });

  it('🔴 ⑦ 絞り込みを打つとモードが落ちる(押しても効かない物を出したままにしない)', () => {
    d.dispatch({ type: 'SET_LAUNCHER_REORDER', on: true });
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '電' });
    expect(d.getState().launcherReorder, '絞り込んでもモードに居座った').toBe(false);
    expect(done(), '出口だけ残った').toBeNull();
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '' });
    expect(d.getState().launcherReorder, '解除しただけで勝手に入り直した').toBe(false);
  });

  it('🔴 ⑦b 絞り込み中に長押ししても、入らずに理由を言う', () => {
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '電' });
    longPress('a1');
    expect(d.getState().launcherReorder).toBe(false);
    expect(d.getState().error, '無言で断った(押しても何も起きないに見える)').toContain(
      '絞り込みを消してから',
    );
  });

  it('🔴 ⑧ 右クリックのメニューに、入口と出口の両方が出る', () => {
    rightClick('a1');
    expect(menuLabels(), 'マウスの入口が無い').toContain('並べ替える');
    d.dispatch({ type: 'SET_LAUNCHER_REORDER', on: true });
    rightClick('a1');
    expect(menuLabels(), '出口がメニューに無い(片道の操作)').toContain('並べ替えをやめる');
    expect(menuLabels(), '入口と出口が同時に出ている').not.toContain('並べ替える');
  });

  it('🔴 ⑨ 長押しの直後の click は捨てる(離しただけで数が進まない)', () => {
    longPress('a1');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    tileEl('a1').dispatchEvent(ev);
    expect(ev.defaultPrevented, '長押しの直後の click を素通りさせた').toBe(true);
    expect(opened).toEqual([]);
  });
});
