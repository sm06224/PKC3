/**
 * sidebar の差分描画(P3 設計メモ §2)。
 *
 * - **断面指紋**: entryMetas / order は reducer が変更時のみ新しい参照を作るので、
 *   参照同一性が指紋になる。指紋一致なら DOM に一切触れない
 *   (PKC2「編集の開始・確定でサイドバー全行再構築」= 体感の主因、の構造対策)
 * - **行は lid キーで再利用**: 一覧が変わっても既存行ノードを patch して使い回す。
 *   再生成は新規 lid のみ
 * - **選択変更は属性 patch のみ**(2 行の data-pkc-selected を付け替える)
 */
import type { EntryMeta } from '@core/model/entry-meta';
import type { AppState } from '@adapter/state/app-state';

export class SidebarRenderer {
  private readonly list: HTMLElement;
  private readonly rows = new Map<string, HTMLLIElement>();
  private lastMetas: ReadonlyMap<string, EntryMeta> | null = null;
  private lastOrder: readonly string[] | null = null;
  private lastSelected: string | null = null;

  constructor(sidebarRegion: HTMLElement) {
    const list = sidebarRegion.querySelector<HTMLElement>(
      '[data-pkc-region="entry-list"]',
    );
    if (!list) throw new Error('sidebar shell missing entry-list region');
    this.list = list;
  }

  render(state: AppState): void {
    const listChanged =
      state.entryMetas !== this.lastMetas || state.order !== this.lastOrder;
    const selectionChanged = state.selectedLid !== this.lastSelected;
    if (!listChanged && !selectionChanged) return; // 指紋一致 ── DOM に触れない

    if (listChanged) this.reconcileRows(state);
    if (listChanged || selectionChanged) this.patchSelection(state.selectedLid);

    this.lastMetas = state.entryMetas;
    this.lastOrder = state.order;
    this.lastSelected = state.selectedLid;
  }

  private reconcileRows(state: AppState): void {
    const seen = new Set<string>();
    let cursor: ChildNode | null = this.list.firstChild;
    for (const lid of state.order) {
      const meta = state.entryMetas.get(lid);
      if (!meta) continue;
      seen.add(lid);
      let row = this.rows.get(lid);
      if (!row) {
        row = this.createRow(meta);
        this.rows.set(lid, row);
      } else {
        this.patchRow(row, meta);
      }
      // 既に正位置ならノードを動かさない(move も DOM 操作なので避ける)
      if (cursor === row) {
        cursor = row.nextSibling;
      } else {
        this.list.insertBefore(row, cursor);
      }
    }
    for (const [lid, row] of this.rows) {
      if (!seen.has(lid)) {
        row.remove();
        this.rows.delete(lid);
      }
    }
  }

  private createRow(meta: EntryMeta): HTMLLIElement {
    const row = document.createElement('li');
    row.setAttribute('data-pkc-entry', meta.lid);
    row.setAttribute('data-pkc-action', 'select-entry');
    const title = document.createElement('span');
    title.setAttribute('data-pkc-field', 'title');
    title.textContent = meta.title;
    row.append(title);
    row.setAttribute('data-pkc-archetype', meta.archetype);
    return row;
  }

  private patchRow(row: HTMLLIElement, meta: EntryMeta): void {
    const title = row.querySelector('[data-pkc-field="title"]');
    if (title && title.textContent !== meta.title) title.textContent = meta.title;
    if (row.getAttribute('data-pkc-archetype') !== meta.archetype)
      row.setAttribute('data-pkc-archetype', meta.archetype);
  }

  private patchSelection(selected: string | null): void {
    if (this.lastSelected && this.lastSelected !== selected) {
      this.rows.get(this.lastSelected)?.removeAttribute('data-pkc-selected');
    }
    if (selected) this.rows.get(selected)?.setAttribute('data-pkc-selected', '');
  }
}
