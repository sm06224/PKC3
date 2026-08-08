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
import { KanbanRenderer } from './kanban';
import { CalendarRenderer } from './calendar';
import { SettingsRenderer } from './settings';
import { FlagsRenderer } from './flags';
import { HelpRenderer } from './help';
import type { MarkdownClient } from '@adapter/platform/render/markdown-client';

type PaneView = 'detail' | 'kanban' | 'calendar' | 'settings' | 'flags' | 'help';

/**
 * 🔴 **ノートを映さない面**(P11)。ここに足し忘れると、その面は
 * `toPane` が `detail` へ落として**開いても本文が出る**(= 押しても何も起きない)。
 * ⚠ `app-state.ts` の `ASIDE_PANES` とは**別の表** ── あちらは「一覧を押したら
 * 中央をノートへ戻すか」、こちらは「中央に自分の器を持つか」。
 * 両方に足す必要があり、`tests/adapter/help-pane.test.ts` が食い違いを落とす。
 */
const ASIDE: ReadonlySet<ViewMode> = new Set<ViewMode>(['settings', 'flags', 'help']);

/**
 * 🔑 中央は**常に「開いているノート」**(P8 段⑤)。
 * ⚠ フォルダとアプリは「探し方」なので**左の列**へ移した(`browse.ts`)──
 * 中央のビューではなくなったので、ここでは detail へ落ちる。
 */
function toPane(view: ViewMode): PaneView {
  if (view === 'kanban' || view === 'calendar') return view;
  return ASIDE.has(view) ? (view as PaneView) : 'detail';
}

export class CenterRouter {
  private readonly panes: Record<PaneView, HTMLElement>;
  private readonly detail: DetailRenderer;
  private readonly kanban: KanbanRenderer;
  private readonly calendar: CalendarRenderer;
  private readonly settings: SettingsRenderer;
  private readonly flags: FlagsRenderer;
  private readonly help: HelpRenderer;
  private lastPane: PaneView = 'detail';

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
      kanban: pane('kanban'),
      calendar: pane('calendar'),
      settings: pane('settings'),
      flags: pane('flags'),
      help: pane('help'),
    };
    this.detail = new DetailRenderer(this.panes.detail, assets, markdown, onBodyChange ?? null);
    this.kanban = new KanbanRenderer(this.panes.kanban);
    this.calendar = new CalendarRenderer(this.panes.calendar, now);
    this.settings = new SettingsRenderer(this.panes.settings);
    this.flags = new FlagsRenderer(this.panes.flags);
    /**
     * ⚠ **同じ `markdown` を渡す**(面ごとに作らない)── worker lease が
     * その数だけ立ち、常駐が増える(P8 段⑲ と同じ判断)。
     */
    this.help = new HelpRenderer(this.panes.help, markdown ?? null);
  }

  render(state: AppState): void {
    const view = toPane(state.viewMode);
    if (view !== this.lastPane) {
      this.panes[this.lastPane].hidden = true;
      this.panes[view].hidden = false;
      this.lastPane = view;
    }
    if (view === 'detail') this.detail.render(state);
    else if (view === 'kanban') this.kanban.render(state);
    else if (view === 'settings') this.settings.render(state);
    else if (view === 'flags') this.flags.render();
    else if (view === 'help') this.help.render();
    else this.calendar.render(state);
  }

  /**
   * 外部画像の答え / 設定が変わった ── 次の `render()` で本文を描き直す
   * (2026-08-06)。⚠ 呼ぶだけでは描かれない ── 呼び側が `render(state)` を続ける
   * (state は動いていないので dispatcher の通知は来ない)。
   */
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

  invalidateDetail(): void {
    this.detail.invalidate();
  }

  /** 箱が「画像を CSP で止めた」と申告してきた ── 帯だけ出し直す。 */
  noteBlockedBox(lid: string, blocked: number): void {
    this.detail.noteBlockedBox(lid, blocked);
  }
}
