/**
 * filer view の最小核(P3-7b): breadcrumb + explorer table の read-only ビュー。
 *
 * - scope = 選択が folder ならそれ / 最近傍祖先 folder / root(PKC2 と同じ)
 * - 一覧は scope 直下(root scope なら structural 親なし)を entryOrder 順で
 * - folder click = その folder を選択(= scope が移る)、非 folder click = 選択
 *   (SELECT_ENTRY 1 本 ── scope と selection を別 state にしない。PKC2 で
 *   両者を混ぜた結果 lastFilerScopeLid という補助状態が要った教訓は、
 *   「scope は selection の純関数」に振り切ることで回避する)
 * - relation 作成 UI / subset profile(表示レンズ)/ DnD は持ち込まない ──
 *   profile は resolveProfile() の seam だけ将来のために残す(実装しない)
 * - 指紋: (entryMetas, relations, selectedLid)の参照。一覧規模は O(scope 直下)
 *   なので変化時は table ごと作り直す
 */
import type { EntryMeta, Relation } from '@core/model/entry-meta';
import type { AppState } from '@adapter/state/app-state';
import {
  getStructuralChildren,
  getRootEntries,
  getAncestorFolders,
  resolveFilerScope,
} from '@features/relation/tree';

const ARCHETYPE_LABELS: Record<string, string> = {
  text: 'ノート',
  todo: 'Todo',
  textlog: 'ログ',
  spreadsheet: 'シート',
  folder: 'フォルダ',
  attachment: '添付',
  form: 'フォーム',
};

export class FilerRenderer {
  private readonly region: HTMLElement;
  private lastMetas: ReadonlyMap<string, EntryMeta> | null = null;
  private lastRelations: readonly Relation[] | null = null;
  private lastSelected: string | null = null;

  constructor(region: HTMLElement) {
    this.region = region;
  }

  render(state: AppState): void {
    if (
      state.entryMetas === this.lastMetas &&
      state.relations === this.lastRelations &&
      state.selectedLid === this.lastSelected
    )
      return;
    this.lastMetas = state.entryMetas;
    this.lastRelations = state.relations;
    this.lastSelected = state.selectedLid;

    const scope = resolveFilerScope(state.selectedLid, state.entryMetas, state.relations);
    const rows = scope
      ? getStructuralChildren(scope.lid, state.entryMetas, state.relations)
      : getRootEntries(state.entryMetas, state.relations);

    this.region.textContent = '';

    // breadcrumb: root / …祖先… / scope
    const crumb = document.createElement('nav');
    crumb.setAttribute('data-pkc-region', 'filer-breadcrumb');
    const rootSeg = document.createElement('button');
    rootSeg.type = 'button';
    rootSeg.setAttribute('data-pkc-action', 'filer-root');
    rootSeg.textContent = 'ルート';
    crumb.append(rootSeg);
    if (scope) {
      const chain = [
        ...getAncestorFolders(scope.lid, state.entryMetas, state.relations).reverse(),
        scope,
      ];
      for (const seg of chain) {
        crumb.append(document.createTextNode(' / '));
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-pkc-entry', seg.lid);
        btn.setAttribute('data-pkc-action', 'select-entry');
        btn.textContent = seg.title;
        crumb.append(btn);
      }
    }
    this.region.append(crumb);

    const table = document.createElement('table');
    table.setAttribute('data-pkc-region', 'filer-table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const h of ['名前', '種別', '更新日']) {
      const th = document.createElement('th');
      th.textContent = h;
      hr.append(th);
    }
    thead.append(hr);
    const tbody = document.createElement('tbody');
    for (const m of rows) {
      const tr = document.createElement('tr');
      tr.setAttribute('data-pkc-entry', m.lid);
      tr.setAttribute('data-pkc-action', 'select-entry');
      tr.setAttribute('data-pkc-archetype', m.archetype);
      if (m.lid === state.selectedLid) tr.setAttribute('data-pkc-selected', '');
      const name = document.createElement('td');
      name.setAttribute('data-pkc-field', 'title');
      name.textContent = (m.archetype === 'folder' ? '📁 ' : '') + m.title;
      const kind = document.createElement('td');
      kind.textContent = ARCHETYPE_LABELS[m.archetype] ?? m.archetype;
      const updated = document.createElement('td');
      updated.textContent = m.updatedAt ?? '';
      tr.append(name, kind, updated);
      tbody.append(tr);
    }
    table.append(thead, tbody);
    this.region.append(table);

    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.setAttribute('data-pkc-field', 'filer-empty');
      empty.textContent = scope ? '(このフォルダは空です)' : '(entry がありません)';
      this.region.append(empty);
    }
  }
}