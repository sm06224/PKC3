/** @vitest-environment happy-dom */
/**
 * 🔴 **開いているノートを閉じて、コレクションへ戻る**(#1032)。
 *
 * ## なぜ要るか(実測)
 *
 * ⚠ ノートを 1 件でも選ぶと中央は**そのノート**になり、コレクションの操作
 * (閲覧用 HTML / 持ち歩ける HTML 1 枚 / Markdown / 構成をコピー)へは
 * **読み込み直す以外に戻れなかった**(2026-09-21 の捨て probe:作って保存した直後は
 * `collection-pane` が 0 件、`page.reload()` の後は 1 件)。
 * 🔑 「選択を解除」(`CLEAR_SELECTION`)が外すのは**印**だけで、開いているノート
 * (`selectedLid`)には触らない ── 命令(`DESELECT_ENTRY`)は在るのに、
 * **撃つ口が画面に 1 つも無かった**。
 *
 * ## 守る主張
 *
 * 1. **一覧の「何も無い所」を押すと閉じる**(3 つの器すべて)
 * 2. ⚠ **行やボタンの上では閉じない**(押した物が別に在るのに、開いている物まで失わない)
 * 3. ⚠ **開いていなければ何も起きない**(空の dispatch を撃たない)
 * 4. 右クリックのメニューが出ている間は、コマンドが**譲る**(`Escape` の取り合い)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import {
  bindActions,
  ROW_HOST_REGIONS,
  ROW_HOST_SELECTOR,
  runGlobalCommand,
} from '../../src/adapter/ui/actions/binder';
import { FilerRenderer } from '../../src/adapter/ui/render/filer';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { openContextMenu } from '../../src/adapter/ui/render/context-menu';

function meta(lid: string, order: number): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: order,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}
const METAS = [meta('a', 1), meta('b', 2)];

interface Mounted {
  readonly root: HTMLElement;
  readonly d: Dispatcher;
  readonly host: HTMLElement;
}

function mount(): Mounted {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  bindActions(root, d);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
  const filer = new FilerRenderer(regions.browseHost);
  d.onState((st) => filer.render(st));
  filer.render(d.getState());
  return { root, d, host: regions.browseHost };
}

/** その器の「何も無い所」= 器そのものを押す(行にも押し所にも当たらない)。 */
function clickBlank(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('一覧の何も無い所を押すと、開いているノートが閉じる(#1032)', () => {
  it('🔴 左の列の余白を押すと閉じる', () => {
    const m = mount();
    m.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    expect(m.d.getState().selectedLid, '前提: 開いていない').toBe('a');
    // 🔴 押すのは**左の列の器**(`browse-host`)── 表そのものは中身の高さしか無く、
    //   user が「何も無い所」と思って押す場所は**表の外**である(実測 2026-09-21:
    //   表 53px / その下 126px)。⚠ 1 稿目は表を押しており、実ブラウザでは
    //   ほぼ効かないまま unit だけ緑だった(CLAUDE.md §2)。
    expect(m.host.getAttribute('data-pkc-region'), '前提: 左の列の器ではない').toBe('browse-host');
    clickBlank(m.host);
    expect(m.d.getState().selectedLid, '余白を押しても閉じない').toBeNull();
  });

  /**
   * ⚠ **3 つの器を全部見る** ── 左の列はタブで中身が変わるので、1 つ落とすと
   *   「そのタブの user だけ戻れない」という、いちばん外しやすい形になる
   *   (`binder.ts` が同じ 3 つを名指しした前例:2026-09-09 の UX レビュー)。
   */
  /**
   * 🔴 **器の表は等値で pin する**(#1032)。
   * ⚠ 1 稿目は「binder.ts の字面にその名前が在るか」で見ていたが、**その名前は
   *   file の別の所にも在る**ので、判定から 1 つ落としても緑のままだった
   *   (変異試験 M2 が SURVIVED で教えた ── CLAUDE.md §1「範囲が広すぎる」)。
   * 🔑 だから**正本の配列そのもの**を見る ── 行を掴む判定も、この直しも、
   *   同じ配列を読む(§7)。
   */
  it('🔴 行を掴む器は 3 つ(等値。1 つ落としたら落ちる)', () => {
    expect([...ROW_HOST_REGIONS]).toEqual(['filer-table', 'dual-table', 'entry-list']);
    for (const r of ROW_HOST_REGIONS) {
      expect(ROW_HOST_SELECTOR, `${r} が選択子に入っていない`).toContain(
        `[data-pkc-region="${r}"]`,
      );
    }
  });

  it('⚠ 行の上では閉じない(押した物が別に在る)', () => {
    const m = mount();
    m.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    const row = m.host.querySelector<HTMLElement>('[data-pkc-entry="b"]');
    expect(row, '行が無い(空振り)').not.toBeNull();
    row!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(m.d.getState().selectedLid, '行を押したのに閉じた').toBe('b');
  });

  it('⚠ 何も開いていなければ、余白を押しても状態は動かない', () => {
    const m = mount();
    expect(m.d.getState().selectedLid, '前提: 何か開いている').toBeNull();
    let notified = 0;
    m.d.onState(() => (notified += 1));
    clickBlank(m.host);
    expect(notified, '空の dispatch を撃っている').toBe(0);
  });
});

describe('近道 / パレットからも閉じられる(#1032)', () => {
  const run = (m: Mounted, dry = false): boolean =>
    runGlobalCommand(
      'deselect-entry',
      m.root,
      m.d,
      new KeymapStore(null),
      () => undefined,
      () => undefined,
      dry,
    );

  it('🔴 開いていれば効く', () => {
    const m = mount();
    m.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    expect(run(m), '受け手が無い').toBe(true);
    expect(m.d.getState().selectedLid).toBeNull();
  });

  /**
   * 🔴 **押せないときは `false`** ── パレットはこの答えを読んで行を `disabled` に
   *   するので、`true` を返すと「押せるのに何も起きない」(無言の dead click)になる。
   */
  it('🔴 何も開いていなければ断る(パレットが押せない行として出せる)', () => {
    const m = mount();
    expect(run(m, true), '開いていないのに押せると答えた').toBe(false);
  });

  /**
   * 🔴 **右クリックのメニューが出ている間は譲る**(`Escape` の取り合い)。
   * ⚠ 先に閉じてしまうと、「メニューを取り消しただけ」のつもりの user が
   *   **読んでいたノートまで失う**。
   */
  it('🔴 メニューが出ている間は譲る', () => {
    const m = mount();
    m.d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
    openContextMenu(m.root, { x: 10, y: 10 }, [{ action: 'show-history', label: '履歴' }], null);
    expect(run(m), 'メニューが出ているのに閉じた').toBe(false);
    expect(m.d.getState().selectedLid, 'メニューの裏でノートが閉じた').toBe('a');
  });
});
