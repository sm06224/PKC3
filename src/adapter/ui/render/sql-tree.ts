/**
 * 🔴 **SQL 画面の左の「スキーマの木」**(#1442 段②)。
 *
 * > pgAdmin / DBeaver のように、表 → 列(型・主キー・外部キー)を木で見て、名前を押すだけで欄へ入れる。
 *
 * ## 🔑 模型は新しく採らない
 *
 * 表と列の元は **つながり図(ER)と同じ `state.sqlPage.er.model`**(`SchemaModel`)── 採る道(sqlite / DuckDB の 3 route)も
 * 1 本のまま(§7)。違うのは**画面を開いた時点で自動で採る**こと(図を開くまで待たない)で、それは reducer 側の仕事。
 *
 * ## 操作(押す = 入れる)
 *
 * | 手 | 起きること |
 * |---|---|
 * | 表 / 列の名前を押す | 欄のキャレットの位置へ名前を入れる(表の 1 回押しは**ダブルクリックを待つ**ので少し遅れて入る) |
 * | 表をダブルクリック / Shift+Enter | `SELECT * FROM 表 LIMIT 20` を入れる(**入れるだけ**。走らせるのは user) |
 * | ▸ を押す / → ← / Space | 列を開く・畳む |
 * | ↑ ↓ Home End | 木の中を移る(ロービング tabindex。木全体で Tab 1 回) |
 * | Enter | 名前を入れる |
 *
 * ⚠ 描画器は**入れる先を知らない** ── `onInsert` で呼び側(`sql.ts`)へ渡す(欄・取り消しの作法はあちらが持つ)。
 * ⚠ 字は `textContent` で入れる(DB の名前を HTML として注入しない)。
 */
import type { SqlPageState } from '@adapter/state/app-state';
import { schemaKindLabel, type SchemaModel, type SchemaTable } from '@features/query/schema-digest';
import { selectFromTableSql, treeNameText } from '@features/query/sql-layout';

/** 表の 1 回押しがダブルクリックを待つ時間(ms)。 */
export const SQL_TREE_DBLCLICK_MS = 260;

export interface SqlTreeHooks {
  /** 欄へ字を入れる。`kind` は入れる字の前に足す空白・改行の決め方(`insertionWithSpacing`)。 */
  readonly onInsert: (text: string, kind: 'name' | 'statement') => void;
}

export interface SqlTreeView {
  readonly model: SchemaModel | null;
  readonly loading: boolean;
  readonly note: string;
  /** どの相手の木か(見出しの横に出す。空 = この PKC3)。 */
  readonly sourceLabel: string;
  /**
   * 🔴 **DuckDB の器へ頼む相手で、まだ構造を採っていないとき**の表の名前(`guest.tables`)。
   * ⚠ 採るには中身を全部読んで器を起こすので、選んだだけでは採らない(`erForSource`)── 名前だけを出し、列は ER 図を開くと出る。
   */
  readonly namesOnly: readonly string[] | null;
}

export interface SqlTreeHandle {
  readonly el: HTMLElement;
  paint(view: SqlTreeView): void;
}

const COUNT_FMT = new Intl.NumberFormat('ja-JP');

/** 絞り込みの比較は大文字小文字を区別しない(表名は ASCII でも日本語でも混ざる)。 */
function includes(hay: string, needle: string): boolean {
  return hay.toLowerCase().includes(needle);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  field: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.setAttribute('data-pkc-field', field);
  if (text !== undefined) e.textContent = text;
  return e;
}

export function createSqlTree(hooks: SqlTreeHooks): SqlTreeHandle {
  const root = document.createElement('aside');
  root.setAttribute('data-pkc-region', 'sql-tree');
  root.setAttribute('aria-label', 'スキーマ');

  const head = el('div', 'sql-tree-head');
  const title = el('span', 'sql-tree-title', 'スキーマ');
  const source = el('span', 'sql-tree-source');
  head.append(title, source);

  const filter = el('input', 'sql-tree-filter');
  filter.type = 'search';
  filter.placeholder = '表・列を絞り込む';
  filter.setAttribute('aria-label', '表・列を絞り込む');
  filter.autocomplete = 'off';
  filter.spellcheck = false;

  const status = el('p', 'sql-tree-note');
  status.setAttribute('role', 'status');
  status.hidden = true;

  const list = el('div', 'sql-tree-list');
  list.setAttribute('role', 'tree');
  list.setAttribute('aria-label', '表と列');
  root.append(head, filter, status, list);

  /** 開いている表(名前)。⚠ 相手が変わったら捨てる(別の DB の表と同じ名前が開いて見えない)。 */
  let expanded = new Set<string>();
  let model: SchemaModel | null = null;
  let query = '';
  /** 焦点を持つ 1 本(ロービング)。`table:<名前>` / `col:<名前>\t<列>`。 */
  let activeKey: string | null = null;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let lastSource = '\u0000';
  let namesKey = '';

  const keyOfTable = (t: string): string => `table:${t}`;
  const keyOfCol = (t: string, c: string): string => `col:${t}\t${c}`;

  const visibleTables = (m: SchemaModel): { table: SchemaTable; open: boolean; cols: SchemaTable['columns'] }[] => {
    const out: { table: SchemaTable; open: boolean; cols: SchemaTable['columns'] }[] = [];
    for (const t of m.tables) {
      if (query === '') {
        out.push({ table: t, open: expanded.has(t.name), cols: t.columns });
        continue;
      }
      const hitName = includes(t.name, query);
      const hitCols = t.columns.filter((c) => includes(c.name, query));
      if (!hitName && hitCols.length === 0) continue;
      // 🔑 列だけに当たったときは**自動で開く**(当たった列が見える)。表名に当たったときは畳んだまま
      out.push({ table: t, open: hitCols.length > 0 && !hitName ? true : expanded.has(t.name), cols: hitName ? t.columns : hitCols });
    }
    return out;
  };

  function fkColumns(m: SchemaModel, table: string): Set<string> {
    const s = new Set<string>();
    for (const l of m.links) if (l.from === table) s.add(l.fromColumn);
    return s;
  }

  function build(): void {
    const hadFocus = list.contains(document.activeElement);
    list.textContent = '';
    if (model === null) return;
    const rows = visibleTables(model);
    if (rows.length === 0) {
      status.hidden = false;
      status.textContent = query === '' ? '表がありません' : '一致する表・列がありません';
      return;
    }
    status.hidden = true;
    status.textContent = '';
    const keys: string[] = [];
    for (const { table, open, cols } of rows) {
      const row = document.createElement('div');
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', '1');
      row.setAttribute('aria-expanded', open ? 'true' : 'false');
      row.setAttribute('data-pkc-field', 'sql-tree-table');
      row.setAttribute('data-pkc-name', table.name);
      row.setAttribute('data-pkc-kind', table.kind);
      row.setAttribute('data-pkc-tree-key', keyOfTable(table.name));
      row.title = `${table.name}(${schemaKindLabel(table.kind)}。押すと名前、ダブルクリックで SELECT 文を欄へ入れます)`;
      const chev = el('span', 'sql-tree-chevron', open ? '▾' : '▸');
      chev.setAttribute('aria-hidden', 'true');
      const name = el('span', 'sql-tree-name', table.name);
      const kind = el('span', 'sql-tree-kind', schemaKindLabel(table.kind));
      row.append(chev, name, kind);
      if (table.rows !== null) row.append(el('span', 'sql-tree-rows', COUNT_FMT.format(table.rows)));
      list.append(row);
      keys.push(keyOfTable(table.name));
      if (!open) continue;
      const fks = fkColumns(model, table.name);
      for (const c of cols) {
        const col = document.createElement('div');
        col.setAttribute('role', 'treeitem');
        col.setAttribute('aria-level', '2');
        col.setAttribute('data-pkc-field', 'sql-tree-column');
        col.setAttribute('data-pkc-name', table.name);
        col.setAttribute('data-pkc-col', c.name);
        col.setAttribute('data-pkc-tree-key', keyOfCol(table.name, c.name));
        const bits = [c.type === '' ? '型なし' : c.type];
        if (c.primaryKey) bits.push('主キー');
        if (fks.has(c.name)) bits.push('外部キー');
        if (c.notNull) bits.push('NOT NULL');
        col.title = `${table.name}.${c.name}(${bits.join(' / ')})。押すと列名を欄へ入れます`;
        col.append(el('span', 'sql-tree-colname', c.name));
        col.append(el('span', 'sql-tree-type', c.type === '' ? '' : c.type));
        if (c.primaryKey) {
          const pk = el('span', 'sql-tree-badge', 'PK');
          pk.setAttribute('data-pkc-badge', 'pk');
          col.append(pk);
        }
        if (fks.has(c.name)) {
          const fk = el('span', 'sql-tree-badge', 'FK');
          fk.setAttribute('data-pkc-badge', 'fk');
          col.append(fk);
        }
        list.append(col);
        keys.push(keyOfCol(table.name, c.name));
      }
    }
    // ロービング: いまの焦点が消えていたら先頭へ。⚠ 焦点を持っていたなら取り戻す
    if (activeKey === null || !keys.includes(activeKey)) activeKey = keys[0] ?? null;
    for (const item of items()) {
      item.tabIndex = item.getAttribute('data-pkc-tree-key') === activeKey ? 0 : -1;
    }
    if (hadFocus) focusKey(activeKey);
  }

  const items = (): HTMLElement[] => [...list.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  function focusKey(k: string | null): void {
    if (k === null) return;
    for (const item of items()) {
      const on = item.getAttribute('data-pkc-tree-key') === k;
      item.tabIndex = on ? 0 : -1;
      if (on) item.focus();
    }
    activeKey = k;
  }

  const nameOf = (it: HTMLElement): string => it.getAttribute('data-pkc-name') ?? '';
  const isTable = (it: HTMLElement): boolean => it.getAttribute('data-pkc-field') === 'sql-tree-table';

  function insertName(it: HTMLElement): void {
    const col = it.getAttribute('data-pkc-col');
    hooks.onInsert(treeNameText(col ?? nameOf(it)), 'name');
  }
  function toggle(table: string, want?: boolean): void {
    const open = want ?? !expanded.has(table);
    if (open) expanded.add(table);
    else expanded.delete(table);
    activeKey = keyOfTable(table);
    build();
  }
  function cancelPending(): void {
    if (pending !== null) clearTimeout(pending);
    pending = null;
  }

  list.addEventListener('click', (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    const it = target?.closest<HTMLElement>('[role="treeitem"]') ?? null;
    if (it === null) return;
    activeKey = it.getAttribute('data-pkc-tree-key');
    if (isTable(it)) {
      // ▸ を押したら開閉だけ(名前は入れない)
      if (target?.closest('[data-pkc-field="sql-tree-chevron"]') !== null) {
        cancelPending();
        toggle(nameOf(it));
        focusKey(activeKey);
        return;
      }
      // ⚠ ダブルクリックの 1 回目で名前を入れてしまわない ── 少し待ち、2 回目が来たらそちらへ
      cancelPending();
      if (ev.detail >= 2) return;
      pending = setTimeout(() => {
        pending = null;
        insertName(it);
      }, SQL_TREE_DBLCLICK_MS);
      return;
    }
    insertName(it);
  });
  list.addEventListener('dblclick', (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    const it = target?.closest<HTMLElement>('[data-pkc-field="sql-tree-table"]') ?? null;
    if (it === null) return;
    if (target?.closest('[data-pkc-field="sql-tree-chevron"]') !== null) return;
    cancelPending();
    hooks.onInsert(selectFromTableSql(nameOf(it)), 'statement');
  });
  list.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const cur = ev.target instanceof Element ? ev.target.closest<HTMLElement>('[role="treeitem"]') : null;
    if (cur === null) return;
    const all = items();
    const at = all.indexOf(cur);
    const go = (i: number): void => {
      const to = all[Math.max(0, Math.min(all.length - 1, i))];
      if (to !== undefined) focusKey(to.getAttribute('data-pkc-tree-key'));
    };
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        go(at + 1);
        return;
      case 'ArrowUp':
        ev.preventDefault();
        go(at - 1);
        return;
      case 'Home':
        ev.preventDefault();
        go(0);
        return;
      case 'End':
        ev.preventDefault();
        go(all.length - 1);
        return;
      case 'ArrowRight':
        if (!isTable(cur)) return;
        ev.preventDefault();
        if (cur.getAttribute('aria-expanded') !== 'true') {
          toggle(nameOf(cur), true);
          focusKey(keyOfTable(nameOf(cur)));
        } else go(at + 1);
        return;
      case 'ArrowLeft':
        ev.preventDefault();
        if (isTable(cur)) {
          if (cur.getAttribute('aria-expanded') === 'true') {
            toggle(nameOf(cur), false);
            focusKey(keyOfTable(nameOf(cur)));
          }
        } else focusKey(keyOfTable(nameOf(cur)));
        return;
      case ' ':
        if (!isTable(cur)) return;
        ev.preventDefault();
        toggle(nameOf(cur));
        focusKey(keyOfTable(nameOf(cur)));
        return;
      case 'Enter':
        ev.preventDefault();
        cancelPending();
        if (isTable(cur) && ev.shiftKey) hooks.onInsert(selectFromTableSql(nameOf(cur)), 'statement');
        else insertName(cur);
        return;
      default:
    }
  });
  filter.addEventListener('input', () => {
    query = filter.value.trim().toLowerCase();
    build();
  });
  // 絞り込み欄で Esc = 空にする(片道にしない)
  filter.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && filter.value !== '') {
      ev.stopPropagation();
      filter.value = '';
      query = '';
      build();
    }
    if (ev.key === 'ArrowDown') {
      const first = items()[0];
      if (first !== undefined) {
        ev.preventDefault();
        focusKey(first.getAttribute('data-pkc-tree-key'));
      }
    }
  });

  return {
    el: root,
    paint(view: SqlTreeView): void {
      const label = view.sourceLabel;
      if (source.textContent !== label) source.textContent = label;
      source.title = label;
      // 相手が変わったら開いていた表を捨てる(同名の別の表が開いて見えない)
      if (label !== lastSource) {
        lastSource = label;
        expanded = new Set<string>();
        activeKey = null;
        cancelPending();
      }
      if (view.model === null && view.namesOnly !== null && !view.loading && view.namesOnly.length > 0) {
        // 名前だけの木。⚠ 同じ名前の並びなら作り直さない(開閉・焦点を残す)
        const key = view.namesOnly.join('\u0001');
        if (namesKey === key && model !== null) return;
        namesKey = key;
        model = namesModel(view.namesOnly);
        build();
        status.hidden = false;
        status.textContent = '列は「ER 図」を開くと読み込まれます(DuckDB で読むため、開くまで読みません)';
        return;
      }
      namesKey = '';
      if (view.model === null) {
        model = null;
        list.textContent = '';
        status.hidden = false;
        status.textContent = view.loading
          ? '構造を読み込んでいます…'
          : view.note !== ''
            ? view.note
            : '構造はまだ読み込んでいません';
        root.setAttribute('aria-busy', view.loading ? 'true' : 'false');
        return;
      }
      root.setAttribute('aria-busy', view.loading ? 'true' : 'false');
      // ⚠ 模型は同一性で見る(採り直したときだけ別の物)。同じ物なら木を作り直さない(開閉・焦点・転がりを残す)
      if (model === view.model) return;
      model = view.model;
      build();
    },
  };
}

/** `er` の部分から木へ渡す見え方を作る(1 か所)。 */
export function treeViewOf(
  er: SqlPageState['er'],
  sourceLabel: string,
  namesOnly: readonly string[] | null,
): SqlTreeView {
  return { model: er.model, loading: er.loading, note: er.note, sourceLabel, namesOnly };
}

/** 名前だけの木(DuckDB の相手)。列は持たないので展開の印も出さない。 */
function namesModel(names: readonly string[]): SchemaModel {
  return {
    tables: names.map((name) => ({ name, kind: 'table' as const, rows: null, columns: [] })),
    links: [],
  };
}
