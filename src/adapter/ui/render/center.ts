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
import { SettingsRenderer } from './settings';
import { FlagsRenderer } from './flags';
import { HelpRenderer } from './help';
import { QueryRenderer } from './query';
import { ScrollMemory } from './scroll-memory';
import { DualFilerRenderer } from './dual-filer';
import type { MarkdownClient } from '@adapter/platform/render/markdown-client';

type PaneView =
  | 'detail'
  | 'query'
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
 * 🔑 中央は**常に「開いているノート」**(P8 段⑤)。
 * ⚠ フォルダとアプリは「探し方」なので**左の列**へ移した(`browse.ts`)──
 * 中央のビューではなくなったので、ここでは detail へ落ちる。
 */
function toPane(view: ViewMode): PaneView {
  // ⚠ 集計(#184)は**ノートを映す面**なので aside ではない ── 自分の器を
  //    持ったまま選択が中に留まる
  if (view === 'query') return view;
  return ASIDE.has(view) ? (view as PaneView) : 'detail';
}

export class CenterRouter {
  private readonly panes: Record<PaneView, HTMLElement>;
  private readonly detail: DetailRenderer;
  private readonly settings: SettingsRenderer;
  private readonly flags: FlagsRenderer;
  private readonly help: HelpRenderer;
  private readonly query: QueryRenderer;
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
    this.detail = new DetailRenderer(this.panes.detail, assets, markdown, onBodyChange ?? null);
    /**
     * ⚠ **`now` は板にも渡す**(2026-08-23)。札の日付は「今年なら `MM/DD`」で
     *   出すので、渡さないと test が**年を跨いだ日に落ちる**
     *   (CLAUDE.md「『今年』は引数で渡す」)。
     */
    this.query = new QueryRenderer(this.panes.query);
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
      this.lastPane = view;
    }
    // 🔑 帯は**本文以外のとき**だけ出す(本文は「閉じる」対象ではない)
    this.bar.hidden = view === 'detail';
    if (view === 'detail') this.detail.render(state);
    else if (view === 'query') this.query.render(state);
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
