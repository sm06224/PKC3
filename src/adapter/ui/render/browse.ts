/**
 * 左の列 ── **探す場所**(P8 段⑤)。
 *
 * > user 指摘 2026-08-03「**上のメニューと左ペインのメニューにかぶりがある /
 * > 分けもなくて、扱いにくい**」
 *
 * 🔴 かぶりの原因は「**どこに何を置くかの規則が無かった**」こと。決めた規則:
 *
 * | 場所 | 扱うもの | 持つ操作 |
 * |---|---|---|
 * | 上の帯 | アプリ全体 | 設定だけ |
 * | **左** | **ノート全体** | 探す・作る・入れる・出す・片づける |
 * | 中央 | いま開いているもの | 編集・保存 |
 * | 右 | 選んでいるもの | 書き出す・履歴・削除 |
 *
 * 🔑 そして **フォルダとアプリは「見る場所」ではなく「探し方」**である。
 * だから中央のビューではなく、**この列のタブ**にした ── 中央は常に
 * 「いま開いているノート」を出す(業務画面の作法:同じものが常に同じ場所にある)。
 *
 * ⚠ 描画器は使い回す(`FilerRenderer` / `LauncherRenderer`)── 置き場所が
 * 変わっただけで、中身の意味論は変えていない。
 */
import type { AppState } from '@adapter/state/app-state';
import { SidebarRenderer } from './sidebar';
import { FilerRenderer } from './filer';
import { LauncherRenderer } from './launcher';

export type BrowseMode = 'list' | 'filer' | 'launcher';

/** タブ。⚠ 文言は「探し方」を表す(「詳細」のような場所の名前にしない)。 */
export const BROWSE_TABS: readonly { mode: BrowseMode; label: string; icon: string }[] = [
  { mode: 'list', label: '一覧', icon: '📄' },
  { mode: 'filer', label: 'フォルダ', icon: '📁' },
  { mode: 'launcher', label: 'アプリ', icon: '🚀' },
] as const;

export class BrowseRouter {
  private readonly panes: Record<BrowseMode, HTMLElement>;
  private readonly list: SidebarRenderer;
  private readonly filer: FilerRenderer;
  private readonly launcher: LauncherRenderer;
  private last: BrowseMode = 'list';

  constructor(sidebar: HTMLElement, host: HTMLElement) {
    const pane = (mode: BrowseMode): HTMLElement => {
      const el = document.createElement('div');
      el.setAttribute('data-pkc-browse-pane', mode);
      if (mode !== 'list') el.hidden = true;
      host.append(el);
      return el;
    };
    // ⚠ 一覧だけは既存の region(`entry-list`)をそのまま使う ── 行の再利用と
    // 絞り込みの指紋がそこに載っているので、器を作り替えない
    this.panes = {
      list: host.querySelector<HTMLElement>('[data-pkc-region="entry-list"]') ?? pane('list'),
      filer: pane('filer'),
      launcher: pane('launcher'),
    };
    this.list = new SidebarRenderer(sidebar);
    this.filer = new FilerRenderer(this.panes.filer);
    this.launcher = new LauncherRenderer(this.panes.launcher);
  }

  render(state: AppState, mode: BrowseMode): void {
    if (mode !== this.last) {
      this.panes[this.last].hidden = true;
      this.panes[mode].hidden = false;
      this.last = mode;
    }
    // ⚠ 非 active な面には render を呼ばない(裏で毎 state 仕事をしない)
    if (mode === 'list') this.list.render(state);
    else if (mode === 'filer') this.filer.render(state);
    else this.launcher.render(state);
  }
}
