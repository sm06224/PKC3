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
    // 削除を**先に**行う ── stale ノードが cursor に残ると、それ以降の全行が
    // insertBefore(move)になる(review A-2: 先頭 1 行削除で 14,999 move の実測)
    const wanted = new Set<string>();
    for (const lid of state.order) if (state.entryMetas.has(lid)) wanted.add(lid);
    for (const [lid, row] of this.rows) {
      if (!wanted.has(lid)) {
        row.remove();
        this.rows.delete(lid);
      }
    }

    let cursor: ChildNode | null = this.list.firstChild;
    for (const lid of state.order) {
      const meta = state.entryMetas.get(lid);
      if (!meta) continue;
      let row = this.rows.get(lid);
      if (!row) {
        row = this.createRow(meta);
        this.rows.set(lid, row);
      } else {
        this.patchRow(row, meta);
      }
      // 既に正位置ならノードを動かさない(move も DOM 操作なので避ける)。
      // ⚠ 既知の限界: 「先頭行を末尾へ move」型の並べ替えは O(n) move になる
      // (LIS なし cursor 方式の本質)。reorder UI が入る P3-6/7 で計測して判断
      if (cursor === row) {
        cursor = row.nextSibling;
      } else {
        this.list.insertBefore(row, cursor);
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
