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
import { FilerRenderer } from './filer';
import { LauncherRenderer } from './launcher';
import { SettingsRenderer } from './settings';

type PaneView = 'detail' | 'kanban' | 'calendar' | 'filer' | 'launcher' | 'settings';

/** ⚠ かつて launcher は detail へ fallback していた(P7b 段⑩ で実体を持った)。 */
function toPane(view: ViewMode): PaneView {
  return view === 'kanban' ||
    view === 'calendar' ||
    view === 'filer' ||
    view === 'launcher' ||
    view === 'settings'
    ? view
    : 'detail';
}

export class CenterRouter {
  private readonly panes: Record<PaneView, HTMLElement>;
  private readonly detail: DetailRenderer;
  private readonly kanban: KanbanRenderer;
  private readonly calendar: CalendarRenderer;
  private readonly filer: FilerRenderer;
  private readonly launcher: LauncherRenderer;
  private readonly settings: SettingsRenderer;
  private lastPane: PaneView = 'detail';

  constructor(region: HTMLElement, now?: () => Date, assets: AssetLender | null = null) {
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
      filer: pane('filer'),
      launcher: pane('launcher'),
      settings: pane('settings'),
    };
    this.detail = new DetailRenderer(this.panes.detail, assets);
    this.kanban = new KanbanRenderer(this.panes.kanban);
    this.calendar = new CalendarRenderer(this.panes.calendar, now);
    this.filer = new FilerRenderer(this.panes.filer);
    this.launcher = new LauncherRenderer(this.panes.launcher);
    this.settings = new SettingsRenderer(this.panes.settings);
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
    else if (view === 'filer') this.filer.render(state);
    else if (view === 'launcher') this.launcher.render(state);
    else if (view === 'settings') this.settings.render(state);
    else this.calendar.render(state);
  }
}
