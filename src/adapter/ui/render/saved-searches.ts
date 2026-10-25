/**
 * 🔴 **保存した検索の帯**(#1038 C1)。設計 `docs/development/saved-search-design-2026-10.md`。
 *
 * > user の物語: 毎週「請求書」+ 種類「ノート・表」で絞っている。毎回、語を打って札を押し直している。
 *
 * - **1 クリックで保存**(`save-search`)── 名前は自動(語 + 札)で、後から直せる(`rename-saved-search`)
 * - 一覧から**再適用**(`apply-saved-search`)・**削除**(`delete-saved-search`)── 片道にしない
 *
 * ## 置き場は 2 か所(1 つの描き手を `scope` で使い分ける)
 *
 * | scope | 置き場 | 保存する物 | 適用すると |
 * |---|---|---|---|
 * | `filter` | 左の列の種類の札の下(`kind-bar` の隣) | 左の欄の語 + 種類の札 | 左の欄の語と札を置き換える |
 * | `page` | 探す面の欄の下 | 探す面の語(札は無い) | 探す面の欄の語を置き換える |
 *
 * ⚠ 保存先は 1 つ(`appSavedSearches`。端末ごと)── どちらの置き場からでも同じ一覧が見える。
 *   `page` では語の無い組(札だけ)は適用しても何も起きないので出さない(dead click を作らない)。
 * ⚠ 表示は `textContent` だけ(語は user の入力 ── HTML として読まない)。
 */
import type { AppState } from '@adapter/state/app-state';
import { appSavedSearches, type SavedSearchStore } from '@adapter/platform/saved-search-store';
import { archetypeLabel } from '@features/flavor/archetype-label';
import { findSavedSearch, isSavable, sameSearch, type SavedSearch } from '@features/history/saved-search';
import { buildPressedButton } from './choice-buttons';

export type SavedSearchScope = 'filter' | 'page';

/** 押した要素が運ぶ置き場の属性(binder が読む。綴りはここ 1 か所)。 */
export const SAVED_SCOPE_ATTR = 'data-pkc-saved-scope';
/** 適用・名前を直す・削除が運ぶ、保存した検索の id。 */
export const SAVED_ID_ATTR = 'data-pkc-saved-search';

/** いまの絞り(語 + 札)。置き場ごとに読む元が違う ── 読み方はここ 1 か所。 */
export function currentSearchOf(
  state: AppState,
  scope: SavedSearchScope,
): { query: string; kinds: string[] } {
  return scope === 'filter'
    ? { query: state.filterQuery, kinds: [...state.kindFilter] }
    : { query: state.searchPage.query, kinds: [] };
}

/** 保存した検索を、画面で説明する 1 行(マウスを載せたときの字)。 */
export function describeSavedSearch(s: SavedSearch): string {
  const parts: string[] = [];
  if (s.query.trim() !== '') parts.push(`語「${s.query}」`);
  if (s.kinds.length > 0) parts.push(`種類 ${s.kinds.map(archetypeLabel).join('・')}`);
  return parts.join(' + ');
}

export class SavedSearchBar {
  private lastPrint = '';
  private lastState: AppState | null = null;
  /** 一覧(`<details>`)を開いているか ── 描き直しても開いたままにする。 */
  private open = false;
  private readonly off: () => void;

  constructor(
    private readonly host: HTMLElement,
    private readonly scope: SavedSearchScope,
    private readonly store: SavedSearchStore = appSavedSearches,
  ) {
    host.setAttribute(SAVED_SCOPE_ATTR, scope);
    host.hidden = true;
    // 別のタブの書込・自分の操作で一覧が変わったら描き直す(状態が動かなくても)
    this.off = store.onChange(() => {
      if (this.lastState !== null) this.render(this.lastState);
    });
  }

  dispose(): void {
    this.off();
  }

  render(state: AppState): void {
    this.lastState = state;
    const all = this.store.list();
    // 探す面では語の無い組(札だけ)は適用しても何も起きないので出さない
    const items = this.scope === 'page' ? all.filter((s) => s.query.trim() !== '') : all;
    const cur = currentSearchOf(state, this.scope);
    const savable = isSavable(cur.query, cur.kinds);
    const exists = savable && findSavedSearch(all, cur.query, cur.kinds) !== undefined;
    const showSave = savable && !exists;
    const print = JSON.stringify([
      showSave,
      this.open,
      items.map((s) => [s.id, s.name, s.query, s.kinds, sameSearch(s, cur)]),
    ]);
    if (print === this.lastPrint) return; // 姿が同じ ── DOM に触れない(押している最中に作り直さない)
    this.lastPrint = print;
    const hide = !showSave && items.length === 0;
    this.host.hidden = hide;
    this.host.textContent = '';
    if (hide) return;

    if (showSave) {
      const save = document.createElement('button');
      save.type = 'button';
      save.setAttribute('data-pkc-action', 'save-search');
      save.setAttribute('data-pkc-field', 'saved-search-save');
      save.setAttribute(SAVED_SCOPE_ATTR, this.scope);
      save.textContent = 'この検索を保存';
      save.title =
        this.scope === 'filter'
          ? 'いまの語と種類の絞りを保存します(名前は自動で付き、あとから直せます)'
          : 'いま打った語を保存します(名前は自動で付き、あとから直せます)';
      this.host.append(save);
    }
    if (items.length === 0) return;

    const details = document.createElement('details');
    details.setAttribute('data-pkc-field', 'saved-search-list');
    details.open = this.open;
    details.addEventListener('toggle', () => {
      // ⚠ 描き直しで `open` を入れ直すときの toggle は、値が同じなので指紋を動かさない
      if (details.open === this.open) return;
      this.open = details.open;
      this.lastPrint = '';
    });
    const summary = document.createElement('summary');
    summary.textContent = `保存した検索(${items.length})`;
    details.append(summary);
    for (const s of items) {
      const row = document.createElement('div');
      row.setAttribute('data-pkc-field', 'saved-search-row');
      const apply = buildPressedButton({
        action: 'apply-saved-search',
        dataAttr: SAVED_ID_ATTR,
        value: s.id,
        label: s.name,
        pressed: sameSearch(s, cur),
        title: `${describeSavedSearch(s)} で探します`,
      });
      apply.setAttribute(SAVED_SCOPE_ATTR, this.scope);
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.setAttribute('data-pkc-action', 'rename-saved-search');
      rename.setAttribute('data-pkc-field', 'saved-search-rename');
      rename.setAttribute(SAVED_ID_ATTR, s.id);
      rename.textContent = '名前を直す';
      rename.title = `「${s.name}」の名前を直します`;
      const del = document.createElement('button');
      del.type = 'button';
      del.setAttribute('data-pkc-action', 'delete-saved-search');
      del.setAttribute('data-pkc-field', 'saved-search-delete');
      del.setAttribute(SAVED_ID_ATTR, s.id);
      del.textContent = '削除';
      del.title = `保存した検索「${s.name}」を削除します(再び同じ絞りにして保存できます)`;
      row.append(apply, rename, del);
      details.append(row);
    }
    this.host.append(details);
  }
}
