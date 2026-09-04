/**
 * center(detail region)の view router(P3-6)。
 *
 * 3 つの pane(detail / kanban / calendar)を**常駐**させ、切替は hidden の
 * 付け替えだけにする ── 各 renderer の断面指紋・キー付きノード再利用が view を
 * 跨いで生き続ける(切替のたびに 15k 件の作り直しをしない)。
 * 非 active pane には render を呼ばない(裏で毎 state 仕事をしない)──
 * active 化した瞬間の render が指紋差分で追いつく。
 */
import type { AppState, ViewMode } from '@adapter/state/app-state';
import { DetailRenderer, type AssetLender } from './detail';
import { SplitView } from './split-view';
import { SettingsRenderer } from './settings';
import { FlagsRenderer } from './flags';
import { HelpRenderer } from './help';
import { QueryRenderer } from './query';
import { ScrollMemory } from './scroll-memory';
import { DualFilerRenderer } from './dual-filer';
import { ScheduleRenderer } from './schedule';
import { ContactsRenderer } from './contacts';
import type { MarkdownClient } from '@adapter/platform/render/markdown-client';

type PaneView =
  | 'detail'
  | 'query'
  | 'schedule'
  | 'contacts'
  | 'dual'
  | 'settings'
  | 'flags'
  | 'help';

/**
 * 🔴 **ノートを映さない面**(P11)。ここに足し忘れると、その面は
 * `toPane` が `detail` へ落として**開いても本文が出る**(= 押しても何も起きない)。
 * ⚠ `app-state.ts` の `ASIDE_PANES` とは**別の表** ── あちらは「一覧を押したら
 * 中央をノートへ戻すか」、こちらは「中央に自分の器を持つか」。
 * 両方に足す必要があり、`tests/adapter/help-pane.test.ts` が食い違いを落とす。
 */
const ASIDE: ReadonlySet<ViewMode> = new Set<ViewMode>(['settings', 'flags', 'help', 'dual']);

/**
 * 🔴 **ノートを映すが、自分の器を持つ面**(集計 #184 / 予定表 #673 段②)。
 * aside ではない(一覧のノートを押した選択が**この面に留まる**)のに、本文へは
 * 落ちない ── 2 つ目の表である。⚠ ここに足し忘れると `toPane` が本文へ落として
 * 「開いたのに本文が出る」になる(`tests/adapter/help-pane.test.ts` が突合する)。
 */
const NOTE_PANES: ReadonlySet<ViewMode> = new Set<ViewMode>(['query', 'schedule', 'contacts']);

/**
 * 🔑 中央は**常に「開いているノート」**(P8 段⑤)。
 * ⚠ フォルダとアプリは「探し方」なので**左の列**へ移した(`browse.ts`)──
 * 中央のビューではなくなったので、ここでは detail へ落ちる。
 */
function toPane(view: ViewMode): PaneView {
  // ⚠ 集計(#184)/ 予定表(#673 段②)は**ノートを映す面**なので aside ではない
  //    ── 自分の器を持ったまま選択が中に留まる
  if (NOTE_PANES.has(view)) return view as PaneView;
  return ASIDE.has(view) ? (view as PaneView) : 'detail';
}

export class CenterRouter {
  private readonly panes: Record<PaneView, HTMLElement>;
  private readonly detail: DetailRenderer;
  /**
   * 🔴 **横に並べる器**(#505 段②)。⚠ 何も留めていなければ**器も作らない**ので、
   * 既定の画面は 1 バイトも変わらない。
   */
  private readonly split: SplitView;
  private readonly settings: SettingsRenderer;
  private readonly flags: FlagsRenderer;
  private readonly help: HelpRenderer;
  private readonly query: QueryRenderer;
  /**
   * 🔴 **予定表**(#673 段②)。⚠ 左の列(`browse.ts`)と**同じ class** ──
   * 描き方を 2 つ作らない(PKC2 が「同じ markdown を 5 面が別経路で描く」で
   * 構造的な Gap を抱えたのと同じ道になる)。器だけが違う。
   */
  private readonly schedule: ScheduleRenderer;
  /** 🔴 **連絡先**(#278 段③)── 予定表と同じく、左の列と**同じ class**。 */
  private readonly contacts: ContactsRenderer;
  private readonly dual: DualFilerRenderer;
  private lastPane: PaneView = 'detail';
  /**
   * 🔴 **面を開いて戻ったら、同じ場所に戻る**(user 目線レビュー U-4、2026-08-22)。
   *
   * ⚠ 面は**同じスクロール箱の中**で `hidden` を付け替える。だから
   * **開いた面が箱より短いと、`scrollTop` がその場で 0 に丸められる** ──
   * 戻して中身が伸びても、丸められた 0 は帰ってこない。
   *
   * 実測(1440×900・300 段落のノート):
   *
   * | | scrollHeight | scrollTop |
   * |---|---|---|
   * | 本文 | 9651 | 1000 |
   * | **カレンダーを開いている間** | **626**(= clientHeight) | **0 に丸められる** |
   * | 本文へ戻った後 | 9651 に戻る | **0 のまま** |
   * | ヘルプを開いている間 | 4039 | 1000(**長いので偶然残る**) |
   *
   * 🔑 だから「面を開くと必ず飛ぶ」ではなく「**開いた面が短いと飛ぶ**」が正しい ──
   *   ヘルプで残るのは偶然であり、マニュアルが短くなれば同じように飛ぶ。
   * 🔑 `scroll-memory.ts` は user 指示 2026-08-03「**スクロールが発生するすべての
   *   画面が対象だよ**」で作られたのに、**中央だけ付いていなかった**
   *   (一覧・情報ペイン・設定のログの 3 か所には在る)。
   */
  private readonly scroll: ScrollMemory;
  /**
   * 🔴 **開いている面の題名と、閉じる口**(user 目線レビュー U-3 / U-7、2026-08-22)。
   *
   * ⚠ 直す前、開いた面を**閉じる押しボタンは 1 つも無かった**。効く道は 2 つだけ:
   *   ①**アプリ**タブへ戻って同じタイルをもう一度押す ② `Alt+1`
   *   ── ①は左の列がフォルダ一覧に変わっていると**そのタイルが見えていない**し、
   *   ②は**画面のどこにも出ていない**。つまり user から見て「閉じ方が無い」。
   * ⚠ しかも「もう一度押すと閉じる」という規則を、**押す物が一切示していない**
   *   (組み込みタイルには「いま開いている」印すら付かない)。
   * ⚠ 面の題名も**集計にしか無かった** ── 「同じものが常に同じ場所にある」
   *   (user 指示 2026-08-03「業務画面」)から外れていた。
   *
   * 🔑 だから **1 本の帯を中央に置き、全部の面で同じ位置に題名と × を出す**。
   *   ⚠ 面ごとに実装しない ── 8 面ぶん書くと、また 1 面だけ抜ける。
   */
  private readonly bar: HTMLElement;

  constructor(
    region: HTMLElement,
    now?: () => Date,
    assets: AssetLender | null = null,
    /** markdown を描く口。⚠ **アプリでは 1 個を共有する**(P8 段⑲)──
     *  面ごとに作ると worker lease がその数だけ立ち、常駐が増える。 */
    markdown?: MarkdownClient,
    /**
     * 🔴 **本文が変わったことを外へ知らせる**(2026-08-05。ライブエディタ S5)。
     * ⚠ renderer は dispatch しない(層規約)── 投げるのは `main.ts` の仕事。
     */
    onBodyChange?: (body: string) => void,
  ) {
    const pane = (view: PaneView): HTMLElement => {
      const el = document.createElement('div');
      el.setAttribute('data-pkc-view-pane', view);
      if (view !== 'detail') el.hidden = true;
      region.append(el);
      return el;
    };
    this.panes = {
      detail: pane('detail'),
      query: pane('query'),
      schedule: pane('schedule'),
      contacts: pane('contacts'),
      dual: pane('dual'),
      settings: pane('settings'),
      flags: pane('flags'),
      help: pane('help'),
    };
    this.bar = document.createElement('div');
    this.bar.setAttribute('data-pkc-region', 'pane-bar');
    this.bar.hidden = true;
    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('data-pkc-action', 'close-pane');
    close.setAttribute('aria-label', '閉じて本文へ戻る');
    // ⚠ 字も出す ── 記号だけだと「何が閉じるのか」が読めない
    close.textContent = '× 閉じる';
    close.title = '閉じて本文へ戻る';
    this.bar.append(close);
    region.prepend(this.bar);
    this.scroll = new ScrollMemory(region);
    /**
     * ⚠ **`now` は板にも渡す**(2026-08-23)。札の日付は「今年なら `MM/DD`」で
     *   出すので、渡さないと test が**年を跨いだ日に落ちる**
     *   (CLAUDE.md「『今年』は引数で渡す」)。
     */
    this.query = new QueryRenderer(this.panes.query);
    // ⚠ `now` は左の列の予定と同じ口で渡す ── 「今日」を面ごとに読まない
    this.schedule = new ScheduleRenderer(this.panes.schedule, now);
    this.contacts = new ContactsRenderer(this.panes.contacts);
    this.dual = new DualFilerRenderer(this.panes.dual);
    this.settings = new SettingsRenderer(this.panes.settings);
    this.flags = new FlagsRenderer(this.panes.flags);
    /**
     * ⚠ **同じ `markdown` を渡す**(面ごとに作らない)── worker lease が
     * その数だけ立ち、常駐が増える(P8 段⑲ と同じ判断)。
     */
    this.help = new HelpRenderer(this.panes.help, markdown ?? null);
    /**
     * ⚠ **最初の鍵をここで立てる。** `park()` は鍵が `null` だと**黙って何もしない**
     *   ので、立てないと「初めて面を開いたとき」の位置が保存されない ──
     *   つまり **1 回目だけ必ず飛ぶ**(実測でそうなった)。
     * 🔑 この時点の `scrollTop` は 0 なので、`use()` が動かす物は無い。
     */
    /**
     * 🔴 **留めた枠は、主の枠と同じ `DetailRenderer` で描く**(#505 段②)。
     * ⚠ 描き方を 2 つ作らない ── PKC2 が「同じ markdown を 5 面が別経路で描く」で
     * 構造的な Gap を抱えたのと同じ道になる。
     * ⚠ `onBodyChange` は渡さない(留めた枠は書かない)。
     */
    this.split = new SplitView(
      this.panes.detail,
      /**
       * ⚠ **主の器は `SplitView` が作る**(2026-08-29)── 器の同一性は
       * `DetailRenderer` の前提で、後から差し替えられない。並べ始めてから
       * 器を移す形にしたら、主の描画が**枠ごと消していた**(test が捕まえた)。
       */
      /**
       * ⚠ **印は面へ焼く**(2026-08-29)── 面の外(段組みの判定と `app.css` の
       * 直接の子セレクタ)が読むので、器の中に隠すと当たらなくなる。
       */
      (host) =>
        new DetailRenderer(
          host,
          assets,
          markdown,
          onBodyChange ?? null,
          undefined,
          undefined,
          undefined,
          null,
          this.panes.detail,
        ),
      (host, lid) =>
        new DetailRenderer(host, assets, markdown, null, undefined, undefined, undefined, lid),
    );
    this.detail = this.split.main;
    this.scroll.use('detail');
  }

  render(state: AppState): void {
    const view = toPane(state.viewMode);
    const switched = view !== this.lastPane;
    if (switched) {
      // ① 🔴 **入れ替える前に退避する**(`scroll-memory.ts` の 2 手のうち①)。
      //    ⚠ 後にすると、短い面で 0 に丸められた値を保存してしまう
      this.scroll.park();
      this.panes[this.lastPane].hidden = true;
      this.panes[view].hidden = false;
      /**
       * 🔴 **ヘルプから出たことを伝える**(#531 H3)── あちらは
       * **しばらく戻って来なければマニュアルの中身を手放す**(実測 6,385 節点が返る)。
       * ⚠ **その場では捨てない**(入れ直しは 243〜279ms)。判定は `HelpRenderer` が持つ
       *   ── ここは「出た」という事実だけを渡す(§7:2 か所で数えない)。
       */
      if (this.lastPane === 'help') this.help.onHidden();
      this.lastPane = view;
    }
    // 🔑 帯は**本文以外のとき**だけ出す(本文は「閉じる」対象ではない)
    this.bar.hidden = view === 'detail';
    if (view === 'detail') this.split.render(state);
    else if (view === 'query') this.query.render(state);
    else if (view === 'schedule') this.schedule.render(state);
    else if (view === 'contacts') this.contacts.render(state);
    else if (view === 'dual') this.dual.render(state);
    else if (view === 'settings') this.settings.render(state);
    else if (view === 'flags') this.flags.render();
    // ⚠ ヘルプにも**コンテナ id を渡す**(Issue #100 段①)── マニュアルも
    //    この面と同じ document に描かれる文書なので、`pkc://` の扱いを本文と
    //    揃える(渡し忘れると、この面だけ「別の PKC」に見える)
    // ⚠ **最後は本文**(#292 段⑤ でカレンダーを外した)── 面を足したのに
    //    ここへ足し忘れると、`PaneView` の網羅で tsc が落ちる形にはならないので
    //    「開いたのに何も描かれない」になる。足したら必ずここにも 1 行足す
    else this.help.render(state.cid ?? '');
    // ② 🔴 **面が入れ替わったときだけ戻す**(2 手のうち②)。
    if (switched) this.restoreScroll(view);
  }

  /**
   * 🔴 **入ってきた面の位置へ戻す**(user 目線レビュー U-4)。
   *
   * ⚠ **入れ替わったときだけ呼ぶ。** 毎 render 呼んではいけない ──
   *   `ScrollMemory.use` は `?? 0` なので、**覚えていない面では位置を 0 に潰す**。
   *
   * 🔑 **1 回で足りる**(変異試験で確かめた)── 面の中身は `hidden` を外すだけで
   *   壊していないので、見せた瞬間に `scrollHeight` が戻る。
   *   ⚠ 初稿はここで「ワーカーで描くから届くまで数フレーム粘る」と書いて
   *   retry を積んでいたが、**その retry を外しても smoke は落ちなかった** =
   *   no-op だった(CLAUDE.md「『これが無いと壊れる』と書く前に、外して壊れるのを見る」)。
   *   飛んでいた本当の原因は**最初の鍵が立っていなかった**ことだけである。
   */
  private restoreScroll(view: PaneView): void {
    this.scroll.use(view);
  }

  /**
   * フラグの切替(P11)。⚠ **renderer は dispatch しない**(層規約)ので、
   * 呼ぶのは配線側(`main.ts`)。state は動かないため通知も来ない ──
   * 面の中身は `FlagsRenderer` が自分で映し直す。
   */
  setFlag(name: string, on: boolean): void {
    this.flags.setFlag(name, on);
  }

  resetFlags(): void {
    this.flags.resetFlags();
  }

  /**
   * 外部画像の答え / 設定が変わった ── 次の `render()` で本文を描き直す
   * (2026-08-06)。⚠ 呼ぶだけでは描かれない ── 呼び側が `render(state)` を続ける
   * (state は動いていないので dispatcher の通知は来ない)。
   *
   * ⚠ この注記は P11 で `setFlag` の doc が間に挿し込まれ、**別のメソッドの
   *   説明に見える位置**へ流れていた(2026-08-08 に戻した)。
   */
  invalidateDetail(): void {
    this.detail.invalidate();
  }

  /**
   * 箱が「CSP で止めた」と申告してきた ── 帯だけ出し直す。
   *
   * 🔴 **`kinds` を optional にしない**(#528 段③、2026-08-28 に踏んだ)。
   *   ⚠ 初稿は `detail` 側だけ `kinds: readonly string[] = []` と既定を持たせたので、
   *     **この中継と `main.ts` が種別を落としたまま tsc が黙った** ── 箱は正しく
   *     申告し、帯を組む側も正しく組むのに、**間の 2 段で消えて画面には何も出ない**。
   *   🔑 必須にすると、配線を 1 段でも落とした瞬間に型で落ちる(CLAUDE.md §7
   *     「待ちの口は optional にしない」の同じ形)。
   */
  noteBlockedBox(lid: string, blocked: number, kinds: readonly string[]): void {
    this.detail.noteBlockedBox(lid, blocked, kinds);
  }
}
