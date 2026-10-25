/**
 * 保存した検索(#1038 C1)の規則。**pure module**。
 *
 * 🔴 **記憶の置き場は端末ごと**(localStorage、`adapter/platform/saved-search-store.ts`)。
 * 「最近探した語」(`search-log.ts`)と**同じ判断**で、container に入れると書き出しに同乗し、
 * HTML を渡した相手に**こちらが何を探していたか**が並ぶ。設計は
 * `docs/development/saved-search-design-2026-10.md`。
 *
 * ## 何を憶えるか
 *
 * 「語 + 種類の札」の組だけ。⚠ **どのノートが出たかは持たない** ── 組から探し直せば
 * いまの本文で引き直せる(結果を写すと古い物が残る。`search-log.ts` と同じ)。
 *
 * ## 双方向(user 指示 2026-08-23「置けるなら外せる」)
 *
 * 保存(`addSavedSearch`)・名前を直す(`renameSavedSearch`)・削除(`removeSavedSearch`)・
 * 適用(画面側)の 4 つが対で在る。片道にしない。
 */
import { commandQueryOf } from '@features/palette/command-query';

/** 憶えておく件数。⚠ 12 件は見立て(左の列の 1 画面に収まる数)。 */
export const SAVED_SEARCH_MAX = 12;

/** 名前の長さの上限(字)。長い語をそのまま名前にして列を押し広げない。 */
export const SAVED_SEARCH_NAME_MAX = 40;

export interface SavedSearch {
  /** 端末の中で一意。名前を直しても変わらない(適用・削除の相手を指す)。 */
  readonly id: string;
  readonly name: string;
  /** 探す語(空もありうる ── 種類の札だけの絞り)。 */
  readonly query: string;
  /** 種類の札(archetype の綴り。並びは正規化して持つ)。 */
  readonly kinds: readonly string[];
}

/** 保存の中身として妥当な組を取り出す(壊れた JSON で画面ごと落とさない)。 */
export function parseSavedSearches(raw: string | null): SavedSearch[] {
  if (raw === null || raw === '') return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: SavedSearch[] = [];
  const ids = new Set<string>();
  for (const x of v) {
    if (typeof x !== 'object' || x === null) continue;
    const o = x as Record<string, unknown>;
    if (typeof o.id !== 'string' || o.id === '' || ids.has(o.id)) continue;
    if (typeof o.name !== 'string' || o.name.trim() === '') continue;
    if (typeof o.query !== 'string') continue;
    if (!Array.isArray(o.kinds) || !o.kinds.every((k) => typeof k === 'string' && k !== '')) continue;
    const kinds = normalizeKinds(o.kinds as string[]);
    if (o.query.trim() === '' && kinds.length === 0) continue;
    ids.add(o.id);
    out.push({ id: o.id, name: o.name.trim().slice(0, SAVED_SEARCH_NAME_MAX), query: o.query, kinds });
  }
  return out.slice(0, SAVED_SEARCH_MAX);
}

/** 種類の札を重複なし・綴り順にそろえる(同じ組を 2 つ憶えないための正規化)。 */
export function normalizeKinds(kinds: readonly string[]): string[] {
  return [...new Set(kinds)].sort();
}

/** いまの絞りが保存できる形か(語も札も無い / 操作を探す `>` は保存しない)。 */
export function isSavable(query: string, kinds: readonly string[]): boolean {
  if (commandQueryOf(query) !== null) return false;
  return query.trim() !== '' || kinds.length > 0;
}

/** 同じ組か(語は前後の空白を無視、札は順序を無視)。 */
export function sameSearch(
  a: { readonly query: string; readonly kinds: readonly string[] },
  b: { readonly query: string; readonly kinds: readonly string[] },
): boolean {
  const ka = normalizeKinds(a.kinds);
  const kb = normalizeKinds(b.kinds);
  return a.query.trim() === b.query.trim() && ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

/** 保存済みの中から同じ組を探す。 */
export function findSavedSearch(
  list: readonly SavedSearch[],
  query: string,
  kinds: readonly string[],
): SavedSearch | undefined {
  return list.find((s) => sameSearch(s, { query, kinds }));
}

/**
 * 名前の自動付け。語があれば語、札があれば「ノート・表」のように添える。
 * @param kindLabel 札の綴り → 画面の呼び名(`archetypeLabel`)
 */
export function autoSearchName(
  query: string,
  kinds: readonly string[],
  kindLabel: (archetype: string) => string,
): string {
  const q = query.trim();
  const k = normalizeKinds(kinds).map(kindLabel).join('・');
  const name = q !== '' && k !== '' ? `${q}(${k})` : q !== '' ? q : k;
  return clampName(name);
}

function clampName(name: string): string {
  const chars = [...name.trim()];
  return chars.length <= SAVED_SEARCH_NAME_MAX ? chars.join('') : `${chars.slice(0, SAVED_SEARCH_NAME_MAX - 1).join('')}…`;
}

export type AddResult =
  | { readonly kind: 'added'; readonly list: SavedSearch[]; readonly added: SavedSearch }
  /** 同じ組が既にある(2 つ憶えない)。 */
  | { readonly kind: 'exists'; readonly list: SavedSearch[]; readonly existing: SavedSearch }
  /** 語も札も無い / 操作を探す字 / 上限。 */
  | { readonly kind: 'refused'; readonly list: SavedSearch[]; readonly reason: 'empty' | 'full' };

/**
 * 保存する。**新しい順**(先頭に積む)。⚠ 元の配列を壊さない。
 * ⚠ 上限を超えるときは古い物を黙って捨てず、断る(`full`)── 消したくない検索が消える。
 */
export function addSavedSearch(
  list: readonly SavedSearch[],
  query: string,
  kinds: readonly string[],
  id: string,
  kindLabel: (archetype: string) => string,
): AddResult {
  if (!isSavable(query, kinds)) return { kind: 'refused', list: [...list], reason: 'empty' };
  const existing = findSavedSearch(list, query, kinds);
  if (existing !== undefined) return { kind: 'exists', list: [...list], existing };
  if (list.length >= SAVED_SEARCH_MAX) return { kind: 'refused', list: [...list], reason: 'full' };
  const added: SavedSearch = {
    id,
    name: autoSearchName(query, kinds, kindLabel),
    query: query.trim(),
    kinds: normalizeKinds(kinds),
  };
  return { kind: 'added', list: [added, ...list], added };
}

/** 名前を直す。空にしたら変えない(名前の無い行を作らない)。 */
export function renameSavedSearch(list: readonly SavedSearch[], id: string, name: string): SavedSearch[] {
  const next = clampName(name);
  if (next === '') return [...list];
  return list.map((s) => (s.id === id ? { ...s, name: next } : s));
}

/** 削除する。 */
export function removeSavedSearch(list: readonly SavedSearch[], id: string): SavedSearch[] {
  return list.filter((s) => s.id !== id);
}
