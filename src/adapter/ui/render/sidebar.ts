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
  /** 行ごとの描画済み meta 参照 ── 1 件の meta 変更で 15k 行を patch 歩行しない
   *  (patch は querySelector を伴うので、参照一致で丸ごと skip する)。 */
  private readonly rowMeta = new Map<string, EntryMeta>();
  private lastMetas: ReadonlyMap<string, EntryMeta> | null = null;
  private lastOrder: readonly string[] | null = null;
  private lastSelected: string | null = null;
  /** ⚠ 絞り込みも**指紋の一部** ── 入れないと、絞っても行が減らない。 */
  private lastFilter: string | null = null;

  constructor(sidebarRegion: HTMLElement) {
    const list = sidebarRegion.querySelector<HTMLElement>(
      '[data-pkc-region="entry-list"]',
    );
    if (!list) throw new Error('sidebar shell missing entry-list region');
    this.list = list;
  }

  render(state: AppState): void {
    // ⚠ 絞り込みを指紋に入れる。当初は metas / order だけを見ており、
    // **絞り込みを変えても `reconcileRows` が走らなかった**(smoke で実際に踏んだ)
    const listChanged =
      state.entryMetas !== this.lastMetas ||
      state.order !== this.lastOrder ||
      state.filterQuery !== this.lastFilter;
    const selectionChanged = state.selectedLid !== this.lastSelected;
    if (!listChanged && !selectionChanged) return; // 指紋一致 ── DOM に触れない

    if (listChanged) this.reconcileRows(state);
    if (listChanged || selectionChanged) this.patchSelection(state.selectedLid);

    this.lastMetas = state.entryMetas;
    this.lastOrder = state.order;
    this.lastFilter = state.filterQuery;
    this.lastSelected = state.selectedLid;
  }

  private reconcileRows(state: AppState): void {
    // 削除を**先に**行う ── stale ノードが cursor に残ると、それ以降の全行が
    // insertBefore(move)になる(review A-2: 先頭 1 行削除で 14,999 move の実測)
    /**
     * 🔑 絞り込み(P7b 段⑨c、user 指示「導線を再考」)。**常駐 meta の題名だけ**を
     * 見る ── 本文は常駐していないので、全文検索をここでやると全 body の読込が要る
     * (それは別の段で、SQL 側に持たせる)。
     *
     * ⚠ 隠すのではなく**外す** ── `hidden` で残すと、行数を数える test や
     * 「見えている中で n 番目」の操作が静かにずれる。
     * ⚠ 判定は**この 1 パスだけ**でやる。当初は下の cursor ループの中で
     * 消していて、**先に取った `cursor` が消えたノードを指す**ため以降の
     * 挿入位置が壊れた(絞り込んでも行が減らない ── smoke で実際に踏んだ)。
     */
    const q = state.filterQuery.trim().toLowerCase();
    const visible: string[] = [];
    const wanted = new Set<string>();
    for (const lid of state.order) {
      const meta = state.entryMetas.get(lid);
      if (!meta) continue;
      if (q !== '' && !meta.title.toLowerCase().includes(q)) continue;
      wanted.add(lid);
      visible.push(lid);
    }
    for (const [lid, row] of this.rows) {
      if (!wanted.has(lid)) {
        row.remove();
        this.rows.delete(lid);
        this.rowMeta.delete(lid);
      }
    }

    let cursor: ChildNode | null = this.list.firstChild;
    for (const lid of visible) {
      const meta = state.entryMetas.get(lid);
      if (!meta) continue;
      let row = this.rows.get(lid);
      if (!row) {
        row = this.createRow(meta);
        this.rows.set(lid, row);
        this.rowMeta.set(lid, meta);
      } else if (this.rowMeta.get(lid) !== meta) {
        this.patchRow(row, meta);
        this.rowMeta.set(lid, meta);
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
