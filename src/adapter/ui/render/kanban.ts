/**
 * kanban の差分描画(P3-6)。sidebar と同じ規律:
 * - 断面指紋(entryMetas / order / selectedLid の参照)一致なら DOM 不触
 * - カードは lid キーで再利用。削除 pass が先(cursor 汚染による全行 move 防止)
 * - body は読まない ── 抽出列(status / archived)だけで組む
 */
import type { EntryMeta } from '@core/model/entry-meta';
import type { AppState } from '@adapter/state/app-state';
import {
  groupTodosByStatus,
  KANBAN_COLUMNS,
  type KanbanStatus,
} from '@features/kanban/kanban-data';
import { matchesTitle, normalizeQuery } from '@features/filter/title-filter';
import { setIcon, type IconName } from './icons';

export class KanbanRenderer {
  private readonly region: HTMLElement;
  private readonly cards = new Map<string, HTMLElement>();
  /** カードごとの描画済み meta 参照(sidebar と同じ行粒度 skip)。 */
  private readonly cardMeta = new Map<string, EntryMeta>();
  private columns: Record<KanbanStatus, HTMLElement> | null = null;
  private lastMetas: ReadonlyMap<string, EntryMeta> | null = null;
  private lastOrder: readonly string[] | null = null;
  private lastSelected: string | null = null;
  /** ⚠ 絞り込みも指紋の一部(review M-3 ── 絞っても盤面が変わらないのは嘘)。 */
  private lastFilter: string | null = null;

  constructor(region: HTMLElement) {
    this.region = region;
  }

  render(state: AppState): void {
    if (
      state.entryMetas === this.lastMetas &&
      state.order === this.lastOrder &&
      state.filterQuery === this.lastFilter &&
      state.selectedLid === this.lastSelected
    )
      return;

    const columns = this.ensureColumns();
    // 🔑 絞り込みは**全部の面**に同じ規則で効かせる(review M-3)。初版は
    // サイドバーとランチャーだけが効いており、「りんご」と書かれた欄の隣で
    // 盤面が全件を出していた ── 画面が嘘をつく
    const q = normalizeQuery(state.filterQuery);
    const ordered: EntryMeta[] = [];
    for (const lid of state.order) {
      const m = state.entryMetas.get(lid);
      if (m && matchesTitle(m.title, q)) ordered.push(m);
    }
    const grouped = groupTodosByStatus(ordered);

    // 削除 pass を先に(sidebar review A-2 と同じ理由)
    const wanted = new Set<string>();
    for (const col of KANBAN_COLUMNS)
      for (const m of grouped[col.status]) wanted.add(m.lid);
    for (const [lid, card] of this.cards) {
      if (!wanted.has(lid)) {
        card.remove();
        this.cards.delete(lid);
        this.cardMeta.delete(lid);
      }
    }
    // 列を移ったカードも**先に**移動元列から外す ── 残った実ノードが cursor を
    // 汚すと、そのカード以降の全カードが insertBefore(move)になる
    // (P3-6a review #1: open 先頭 1 枚のトグルで後続 ~749 枚が move する実測)
    for (const col of KANBAN_COLUMNS) {
      const host = columns[col.status];
      for (const m of grouped[col.status]) {
        const card = this.cards.get(m.lid);
        if (card && card.parentNode !== null && card.parentNode !== host) card.remove();
      }
    }

    for (const col of KANBAN_COLUMNS) {
      const host = columns[col.status];
      let cursor: ChildNode | null = host.firstChild;
      for (const meta of grouped[col.status]) {
        let card = this.cards.get(meta.lid);
        if (!card) {
          card = this.createCard(meta);
          this.cards.set(meta.lid, card);
          this.cardMeta.set(meta.lid, meta);
        } else if (this.cardMeta.get(meta.lid) !== meta) {
          this.patchCard(card, meta);
          this.cardMeta.set(meta.lid, meta);
        }
        if (meta.lid === state.selectedLid) card.setAttribute('data-pkc-selected', '');
        else card.removeAttribute('data-pkc-selected');
        if (cursor === card) {
          cursor = card.nextSibling;
        } else {
          host.insertBefore(card, cursor);
        }
      }
    }

    this.lastMetas = state.entryMetas;
    this.lastOrder = state.order;
    this.lastFilter = state.filterQuery;
    this.lastSelected = state.selectedLid;
  }

  private ensureColumns(): Record<KanbanStatus, HTMLElement> {
    if (this.columns) return this.columns;
    const cols = {} as Record<KanbanStatus, HTMLElement>;
    for (const col of KANBAN_COLUMNS) {
      const section = document.createElement('section');
      section.setAttribute('data-pkc-region', 'kanban-column');
      section.setAttribute('data-pkc-kanban-status', col.status);
      const heading = document.createElement('h3');
      heading.textContent = col.label;
      const host = document.createElement('div');
      host.setAttribute('data-pkc-region', 'kanban-cards');
      section.append(heading, host);
      this.region.append(section);
      cols[col.status] = host;
    }
    this.columns = cols;
    return cols;
  }

  private createCard(meta: EntryMeta): HTMLElement {
    const card = document.createElement('article');
    card.setAttribute('data-pkc-entry', meta.lid);
    card.setAttribute('data-pkc-action', 'select-entry');
    // data-pkc-entry はカード(entry を表す要素)にのみ ── binder は closest で引く
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.setAttribute('data-pkc-action', 'toggle-todo');
    toggle.setAttribute('aria-label', '状態を切り替え');
    // ⚠ 図案の器として印を付ける(CSS の 1.15em 固定がここに当たる)
    toggle.setAttribute('data-pkc-icon', '');
    const title = document.createElement('span');
    title.setAttribute('data-pkc-field', 'title');
    const date = document.createElement('span');
    date.setAttribute('data-pkc-field', 'date');
    card.append(toggle, title, date);
    this.patchCard(card, meta);
    return card;
  }

  private patchCard(card: HTMLElement, meta: EntryMeta): void {
    const done = meta.status === 'done';
    const toggle = card.querySelector<HTMLElement>('[data-pkc-action="toggle-todo"]');
    // ⚠ 図案は単色 SVG(P9 段③)。⚠ `textContent` で書かない ── 子ごと消える
    const want: IconName = done ? 'check-box' : 'box';
    if (toggle && toggle.getAttribute('data-pkc-icon-name') !== want) {
      toggle.setAttribute('data-pkc-icon-name', want);
      setIcon(toggle, want);
    }
    const title = card.querySelector('[data-pkc-field="title"]');
    if (title && title.textContent !== meta.title) title.textContent = meta.title;
    const date = card.querySelector('[data-pkc-field="date"]');
    const dateText = meta.date ?? '';
    if (date && date.textContent !== dateText) date.textContent = dateText;
  }
}
