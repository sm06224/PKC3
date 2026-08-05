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
import { ScrollMemory } from './scroll-memory';
import { FilerRenderer } from './filer';
import { LauncherRenderer } from './launcher';

export type BrowseMode = 'list' | 'filer' | 'launcher';

/**
 * タブ。⚠ 文言は「探し方」を表す(「詳細」のような場所の名前にしない)。
 * ⚠ 図案は**ここに持たない** ── `icons.ts` の `BROWSE_ICONS` が正本
 * (P9 段③。絵文字の表が 3 か所に散っていたのを 1 つに寄せた)。
 */
export const BROWSE_TABS: readonly { mode: BrowseMode; label: string }[] = [
  { mode: 'list', label: '一覧' },
  { mode: 'filer', label: 'フォルダ' },
  { mode: 'launcher', label: 'アプリ' },
] as const;

export class BrowseRouter {
  private readonly panes: Record<BrowseMode, HTMLElement>;
  private readonly list: SidebarRenderer;
  private readonly filer: FilerRenderer;
  private readonly launcher: LauncherRenderer;
  /**
   * 🔑 **面ごとに位置を覚える**(P8 段⑫。user 指示「サイドバーも同じ、
   * スクロールが発生するすべての画面が対象だよ」)。3 つの面が**同じ器**を
   * 使い回しているので、覚えないとタブを行き来しただけで位置が混ざる。
   */
  private readonly scroll: ScrollMemory;
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
    this.scroll = new ScrollMemory(host);
    this.list = new SidebarRenderer(sidebar);
    this.filer = new FilerRenderer(this.panes.filer);
    this.launcher = new LauncherRenderer(this.panes.launcher);
  }

  render(state: AppState, mode: BrowseMode): void {
    // 🔑 面 = 探し方 × 「絞り込み中かどうか」。⚠ 絞り込んだ結果は先頭からが正しく、
    //    戻したときに元の位置へ帰るのが欲しい振る舞い
    const key = `${mode}|${state.filterQuery === '' ? '' : 'q'}`;
    // ① 🔴 **中身を書き換える前に**退避する ── 描いた後だと、縮んで 0 に
    //    丸められた値を保存してしまう(実測でそう外した)
    this.scroll.park();
    if (mode !== this.last) {
      this.panes[this.last].hidden = true;
      this.panes[mode].hidden = false;
      this.last = mode;
    }
    // ⚠ 非 active な面には render を呼ばない(裏で毎 state 仕事をしない)
    if (mode === 'list') this.list.render(state);
    else if (mode === 'filer') this.filer.render(state);
    else this.launcher.render(state);
    // 🔑 **中身を入れ終わってから**位置を合わせる(空の器に書いても丸められる)。
    // ⚠ 面 = 探し方 × 「絞り込み中かどうか」── 絞り込んだ結果は先頭からが正しく、
    //    戻したときに元の位置へ帰るのが欲しい振る舞い
    // ② 🔴 **中身を入れ終わってから**戻す(空の器に書いても丸められる)
    this.scroll.use(key);
  }
}
