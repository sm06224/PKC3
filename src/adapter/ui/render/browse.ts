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
import { ScheduleRenderer } from './schedule';
import { ContactsRenderer } from './contacts';

// 🔑 型と既定は `browse-mode.ts` が持つ(#240 段⑤)── 既定が 4 か所に散っていた
export type { BrowseMode } from './browse-mode';
import { DEFAULT_BROWSE_MODE, type BrowseMode } from './browse-mode';
import { KindBarRenderer } from './kind-bar';

/**
 * タブ。⚠ 文言は「探し方」を表す(「詳細」のような場所の名前にしない)。
 * ⚠ 図案は**ここに持たない** ── `icons.ts` の `BROWSE_ICONS` が正本
 * (P9 段③。絵文字の表が 3 か所に散っていたのを 1 つに寄せた)。
 */
export const BROWSE_TABS: readonly { mode: BrowseMode; label: string }[] = [
  { mode: 'list', label: '一覧' },
  { mode: 'filer', label: 'フォルダ' },
  { mode: 'launcher', label: 'アプリ' },
  /**
   * 🔴 **予定**(#292 段③。user 指示 2026-08-23)。
   * ⚠ ここに置くのは、上の表が「**左 = ノート全体**」と決めているからである ──
   *   予定はノート全体を横断して見るもので、**中央(本文)を退かす理由が無い**。
   */
  { mode: 'schedule', label: '予定' },
  /**
   * 🔴 **連絡先**(#278 段①。user 指示 2026-08-19)。
   * ⚠ ここに置くのは、上の表が「**左 = ノート全体**」と決めているからである ──
   *   連絡先は**ノート**なので、閉じても失う物が無い(#292 段⑤ の見分け方)。
   */
  { mode: 'contacts', label: '連絡先' },
] as const;

export class BrowseRouter {
  private readonly panes: Record<BrowseMode, HTMLElement>;
  private readonly list: SidebarRenderer;
  /**
   * 🔴 **種類の札は面ではなく器が描く**(#478)── 帯は左の列(shell)に在り、
   *   面をまたいで居座るので、**開いている面に関係なく毎回**描き直す。
   */
  private readonly kindBar: KindBarRenderer;
  private readonly filer: FilerRenderer;
  private readonly launcher: LauncherRenderer;
  private readonly schedule: ScheduleRenderer;
  private readonly contacts: ContactsRenderer;
  /**
   * 🔑 **面ごとに位置を覚える**(P8 段⑫。user 指示「サイドバーも同じ、
   * スクロールが発生するすべての画面が対象だよ」)。3 つの面が**同じ器**を
   * 使い回しているので、覚えないとタブを行き来しただけで位置が混ざる。
   */
  private readonly scroll: ScrollMemory;
  /** 探す欄(面の外に在る ── どの面でも見えている)。 */
  private readonly filterInput: HTMLInputElement | null;
  private last: BrowseMode;

  /**
   * @param initial 最初に出す探し方(#240 段⑤)。⚠ **器の hidden も同じ値で組む** ──
   *   ここを 'list' 固定にしていたので、既定を変えると**タブは選ばれているのに
   *   中身は一覧のまま**という食い違いが出た(段⑤ の実装中に実際に踏んだ)。
   */
  constructor(
    sidebar: HTMLElement,
    host: HTMLElement,
    initial: BrowseMode = DEFAULT_BROWSE_MODE,
    /** ⚠ test 注入用(既定は実時刻)── 「今日」を面ごとに読まない。 */
    now?: () => Date,
  ) {
    this.last = initial;
    const pane = (mode: BrowseMode): HTMLElement => {
      const el = document.createElement('div');
      el.setAttribute('data-pkc-browse-pane', mode);
      if (mode !== initial) el.hidden = true;
      host.append(el);
      return el;
    };
    // ⚠ 一覧だけは既存の region(`entry-list`)をそのまま使う ── 行の再利用と
    // 絞り込みの指紋がそこに載っているので、器を作り替えない
    this.panes = {
      list: host.querySelector<HTMLElement>('[data-pkc-region="entry-list"]') ?? pane('list'),
      filer: pane('filer'),
      launcher: pane('launcher'),
      schedule: pane('schedule'),
      contacts: pane('contacts'),
    };
    // ⚠ 一覧は既存の region を使い回すので、`pane()` の hidden 制御を通らない ──
    //    初期が一覧でないときは**ここで隠す**(隠し忘れると 2 面が重なって出る)
    if (initial !== 'list') this.panes.list.hidden = true;
    this.scroll = new ScrollMemory(host);
    /**
     * 🔴 **探す欄は面の外にある**(2026-08-29、#536 ②)。⚠ 面の中の renderer に
     *   同期を持たせると、**その面を開いていない間は古い字が残る** ──
     *   すぐ下の `kindBar`(#478)と同じ理由である。
     */
    this.filterInput = sidebar.querySelector<HTMLInputElement>(
      '[data-pkc-field="entry-filter"]',
    );
    this.list = new SidebarRenderer(sidebar);
    this.kindBar = new KindBarRenderer(sidebar);
    this.filer = new FilerRenderer(this.panes.filer);
    this.launcher = new LauncherRenderer(this.panes.launcher);
    this.schedule = new ScheduleRenderer(this.panes.schedule, now);
    this.contacts = new ContactsRenderer(this.panes.contacts);
  }

  render(state: AppState, mode: BrowseMode): void {
    // 🔑 面 = 探し方 × 「絞り込み中かどうか」。⚠ 絞り込んだ結果は先頭からが正しく、
    //    戻したときに元の位置へ帰るのが欲しい振る舞い
    // ⚠ **種類の絞りも「絞り込み中」に数える**(#411)── 数えないと、札を押した
    //    ときだけスクロールが前の位置のまま残る(語で絞ったときと振る舞いが違う)
    const filtering = state.filterQuery !== '' || state.kindFilter.size > 0;
    const key = `${mode}|${filtering ? 'q' : ''}`;
    // ① 🔴 **中身を書き換える前に**退避する ── 描いた後だと、縮んで 0 に
    //    丸められた値を保存してしまう(実測でそう外した)
    this.scroll.park();
    if (mode !== this.last) {
      this.panes[this.last].hidden = true;
      this.panes[mode].hidden = false;
      this.last = mode;
    }
    // 🔴 **札の帯は面に関係なく描く**(#478)── 面の中の renderer に持たせると、
    //    その面を開いていない間は**古い DOM のまま**になり、押しても嘘をつく。
    this.kindBar.render(state, mode);
    /**
     * 🔴 **絞りの字も面に関係なく合わせる**(#536 ②)。
     * ⚠ 打鍵中は `value === filterQuery` なので書き戻しは起きない(caret を壊さない)。
     */
    if (this.filterInput !== null && this.filterInput.value !== state.filterQuery)
      this.filterInput.value = state.filterQuery;
    // ⚠ 非 active な面には render を呼ばない(裏で毎 state 仕事をしない)
    if (mode === 'list') this.list.render(state);
    else if (mode === 'filer') this.filer.render(state);
    else if (mode === 'schedule') this.schedule.render(state);
    else if (mode === 'contacts') this.contacts.render(state);
    else this.launcher.render(state);
    // 🔑 **中身を入れ終わってから**位置を合わせる(空の器に書いても丸められる)。
    // ⚠ 面 = 探し方 × 「絞り込み中かどうか」── 絞り込んだ結果は先頭からが正しく、
    //    戻したときに元の位置へ帰るのが欲しい振る舞い
    // ② 🔴 **中身を入れ終わってから**戻す(空の器に書いても丸められる)
    this.scroll.use(key);
  }
}
