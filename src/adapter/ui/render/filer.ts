/**
 * filer view の最小核(P3-7b): breadcrumb + explorer table の read-only ビュー。
 *
 * - scope = 選択が folder ならそれ / 最近傍祖先 folder / root(PKC2 と同じ)
 * - 一覧は scope 直下(root scope なら正準親なし)を entryOrder 順で
 * - folder click = その folder を選択(= scope が移る)、非 folder click = 選択
 *   (SELECT_ENTRY 1 本 ── scope と selection を別 state にしない。PKC2 で
 *   両者を混ぜた結果 lastFilerScopeLid という補助状態が要った教訓は、
 *   「scope は selection の純関数」に振り切ることで回避する)
 * - relation 作成 UI / subset profile(表示レンズ)/ DnD は持ち込まない
 *
 * 差分規律: scope・一覧内容が変わったときだけ table を作り直す。選択だけの
 * 変化(scope 不変)は data-pkc-selected の属性 patch のみ(P3-7b review #2 ──
 * 15k 平置き root で選択 1 クリック = 60,009 createElement の反例を封鎖)。
 * ⚠ 既知の限界: 一覧変化時の rebuild は O(scope 直下)で、平置き container の
 * root scope では「scope 直下 = 全 entry」になる。keyed 行再利用(sidebar 方式)
 * は P6 import で平置き大 container が現実になった時に計測してから入れる。
 */
import type { EntryMeta, Relation } from '@core/model/entry-meta';
import type { AppState } from '@adapter/state/app-state';
import {
  getStructuralChildren,
  getRootEntries,
  getAncestorFolders,
  resolveFilerScope,
} from '@features/relation/tree';
import { matchesTitle, normalizeQuery } from '@features/filter/title-filter';
// 🔑 種別の呼び名は **1 本**(P8 段⑲)── かつてここだけ独自表を持ち、
//    同じノートがフォルダ画面では「シート」、他の全画面では「表」と出ていた
import { archetypeLabel } from './sidebar';
// ⚠ 日付の切り方は `features/datetime/stored-date` が正本(情報列・一覧の行と共有)。
//    ここに 3 つ目の parse を置いていたので寄せた(規則は 1 つ ── CLAUDE.md)
import { formatStoredDate } from '@features/datetime/stored-date';



export class FilerRenderer {
  private readonly region: HTMLElement;
  private readonly rows = new Map<string, HTMLTableRowElement>();
  private lastMetas: ReadonlyMap<string, EntryMeta> | null = null;
  private lastRelations: readonly Relation[] | null = null;
  private lastSelected: string | null = null;
  private lastScopeLid: string | null = null;
  /** ⚠ 絞り込みも指紋の一部(review M-3 ── 絞り込み中にファイラだけ全件出ていた)。 */
  private lastFilter: string | null = null;
  /** ゴミ箱 panel の断面(参照比較 ── P5b で指紋に加わった次元)。 */
  private lastTrash: AppState['trashPanel'] = null;

  constructor(region: HTMLElement) {
    this.region = region;
  }

  render(state: AppState): void {
    const listChanged =
      state.entryMetas !== this.lastMetas ||
      state.relations !== this.lastRelations ||
      state.filterQuery !== this.lastFilter;
    const selectionChanged = state.selectedLid !== this.lastSelected;
    const trashChanged = state.trashPanel !== this.lastTrash;
    if (!listChanged && !selectionChanged && !trashChanged) return;

    const scope = resolveFilerScope(state.selectedLid, state.entryMetas, state.relations);
    const scopeLid = scope?.lid ?? null;

    if (!listChanged && !trashChanged && scopeLid === this.lastScopeLid) {
      // 選択だけの変化(scope 不変)── 属性 patch のみで済ませる
      if (this.lastSelected) {
        this.rows.get(this.lastSelected)?.removeAttribute('data-pkc-selected');
      }
      if (state.selectedLid) {
        this.rows.get(state.selectedLid)?.setAttribute('data-pkc-selected', '');
      }
      this.lastSelected = state.selectedLid;
      return;
    }

    this.lastMetas = state.entryMetas;
    this.lastRelations = state.relations;
    this.lastSelected = state.selectedLid;
    this.lastScopeLid = scopeLid;
    this.lastTrash = state.trashPanel;
    this.lastFilter = state.filterQuery;

    // ⚠ 絞り込みは**全部の面**に同じ規則で効かせる(review M-3)。
    // scope(どのフォルダを見ているか)は動かさない ── 絞るのは**中身**だけ
    const q = normalizeQuery(state.filterQuery);
    const list = (
      scope
        ? getStructuralChildren(scope.lid, state.entryMetas, state.relations)
        : getRootEntries(state.entryMetas, state.relations)
    ).filter((m) => matchesTitle(m.title, q));

    this.region.textContent = '';
    this.rows.clear();

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
        // crumb セグメントはそれ自身が entry(folder)を表す要素 ── data-pkc-entry
        // の適用対象(P3-7a 規約が禁じるのは delete / toggle 等の操作ボタン直付け)
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
    for (const m of list) {
      const tr = document.createElement('tr');
      tr.setAttribute('data-pkc-entry', m.lid);
      tr.setAttribute('data-pkc-action', 'select-entry');
      tr.setAttribute('data-pkc-archetype', m.archetype);
      if (m.lid === state.selectedLid) tr.setAttribute('data-pkc-selected', '');
      const name = document.createElement('td');
      name.setAttribute('data-pkc-field', 'title');
      name.textContent = (m.archetype === 'folder' ? '📁 ' : '') + m.title;
      const kind = document.createElement('td');
      kind.textContent = archetypeLabel(m.archetype);
      const updated = document.createElement('td');
      // ⚠ 生の SQLite UTC 文字列(`2026-08-03 13:11:39`)を出さない。
      // 見出しが「更新日」なのに時刻まで出ていた ── 日付だけに落とす
      updated.textContent = formatStoredDate(m.updatedAt, '');
      tr.append(name, kind, updated);
      tbody.append(tr);
      this.rows.set(m.lid, tr);
    }
    table.append(thead, tbody);
    this.region.append(table);

    if (list.length === 0) {
      const empty = document.createElement('p');
      empty.setAttribute('data-pkc-field', 'filer-empty');
      // ⚠ 「空」と「絞り込みで消えた」を混ぜない(ランチャーと同じ理由)
      empty.textContent =
        q !== ''
          ? '絞り込みに一致するものがありません'
          : scope
            ? 'このフォルダは空です'
            : 'まだ何もありません';
      this.region.append(empty);
    }

    // ── ゴミ箱(P5b)── filer の常設導線。一覧は明示ロード(SHOW_TRASH)
    const trashBar = document.createElement('div');
    trashBar.setAttribute('data-pkc-region', 'filer-trash');
    if (!state.trashPanel) {
      const open = document.createElement('button');
      open.type = 'button';
      open.setAttribute('data-pkc-action', 'show-trash');
      open.textContent = 'ゴミ箱';
      trashBar.append(open);
    } else {
      const head = document.createElement('div');
      const label = document.createElement('span');
      label.textContent =
        state.trashPanel.items.length === 0
          ? 'ゴミ箱は空です'
          : `ゴミ箱 ${state.trashPanel.items.length} 件`;
      const close = document.createElement('button');
      close.type = 'button';
      close.setAttribute('data-pkc-action', 'hide-trash');
      close.textContent = '閉じる';
      head.append(label, close);
      if (state.trashPanel.items.length > 0) {
        const purge = document.createElement('button');
        purge.type = 'button';
        purge.setAttribute('data-pkc-action', 'purge-trash');
        purge.textContent = '空にする';
        head.append(purge);
      }
      trashBar.append(head);
      const ul = document.createElement('ul');
      for (const t of state.trashPanel.items) {
        const li = document.createElement('li');
        li.setAttribute('data-pkc-trash-entry', t.entryLid);
        const text = document.createElement('span');
        text.textContent = `${t.title ?? '(無題)'}(${
          archetypeLabel(t.archetype ?? '')
        } / ${t.createdAt ?? ''})`;
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.setAttribute('data-pkc-action', 'restore-trash');
        restore.setAttribute('data-pkc-rev-id', t.revId);
        restore.setAttribute('data-pkc-trash-lid', t.entryLid);
        restore.textContent = '復元';
        li.append(text, restore);
        ul.append(li);
      }
      trashBar.append(ul);
    }
    this.region.append(trashBar);
  }
}
