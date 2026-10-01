/**
 * 🔴 **フォルダ面に出る行を決める 1 か所**(#240 段②)。
 *
 * ⚠ ここを分けた理由は**範囲選択**である ── `Shift` の範囲は「**表示している並び**」で
 * 採らなければならない(doc §3-2)。描く側(`render/filer.ts`)と選ぶ側(reducer)が
 * 別々に並びを組むと、**目で見た範囲と選ばれる範囲が違う**という、いちばん気づけない
 * 食い違いになる(CLAUDE.md §7「同じ判定が複数の場所にある」)。
 *
 * ⚠ 並び順(#183)を**ここで掛ける**。直す前、フォルダ面は並び順を 1 度も見ておらず、
 * 一覧タブで「題名順」に変えてもフォルダの中は作成順のままだった ── 既定をフォルダに
 * する(段⑤)前に、**効かない操作子を既定の面に出さない**ために揃える。
 */
import type { EntryMeta, Relation } from '@core/model/entry-meta';
import {
  getFlatDescendants,
  getRootEntries,
  getStructuralChildren,
  resolveCanonicalParents,
} from './tree';
import { entryFilterOf, matchesEntry } from '@features/filter/title-filter';
import { sortOrder, type EntrySort } from '@features/filter/entry-sort';
import { SMART_ARCHETYPE } from '@features/smart/smart-spec';

export interface FilerListOptions {
  /** 絞り込みの語(**生の入力**。正規化はここでやる ── 呼び手ごとに書かない)。 */
  readonly filterQuery: string;
  /** 本文が当たった lid(`null` = まだ返っていない)。 */
  readonly searchHits: ReadonlySet<string> | null;
  readonly sort: EntrySort;
  /**
   * 降順か。⚠ **省略可にしない** ── 範囲選択(`Shift`)は「表示している並び」で
   * 採るので、渡し忘れた経路だけ**逆順で範囲を採る**ことになる(目で見た範囲と
   * 選ばれる範囲が食い違う、いちばん気づけない形)。
   */
  readonly sortDesc: boolean;
  /**
   * 🔴 **最近開いた時刻**(#215 残り①)── lid → epoch ミリ秒。無い lid は `0`。
   * ⚠ **省略可にしない** ── `sortDesc` / `kinds` と同じ理由で、渡し忘れた面だけ
   *   「最近開いた順」が静かに lid 順になる(選べるのに効かない)。
   */
  readonly openedAt: ReadonlyMap<string, number>;
  /**
   * 🔴 **種類の絞り(#411)。空 = 絞らない。**
   * ⚠ **省略可にしない** ── `sortDesc` と同じ理由である。渡し忘れた面だけ
   *   絞りが黙って外れ、「面を変えたら全部出た」という形で user に届く。
   */
  readonly kinds: ReadonlySet<string>;
  /**
   * 🔴 **スマートフォルダの当たり**(#421 段①)。`undefined` / `null` = まだ届いていない。
   *
   * ⚠ **現在地がスマートフォルダのときだけ見る** ── ふつうのフォルダに渡しても
   *   無視する(呼び手が場所ごとに分岐を書かなくて済む)。
   * ⚠ **まだ届いていないときは 0 件を返す** ── 「集めています…」と出すのは
   *   描く側の仕事である(0 件と「まだ」の区別は state が持っている)。
   */
  readonly smartLids?: readonly string[] | null;
}

/**
 * 🔴 **その場所の当たりを引く口は 1 つ**(#421 段①)。スマートフォルダでなければ
 * `null`(= 見ない)。⚠ 呼び手ごとに `smartHits.get(...)` を書くと、書き忘れた
 * 面だけ**空のスマートフォルダ**に見える(§7)。
 */
export const smartLidsOf = (
  scopeLid: string | null,
  smartHits: ReadonlyMap<string, { readonly lids: readonly string[] }>,
): readonly string[] | null => (scopeLid === null ? null : (smartHits.get(scopeLid)?.lids ?? null));

/**
 * フォルダの表の行を決める材料。
 *
 * 🔴 **`flatten` は省略可にしない**(#813 段②)── 描く側・範囲選択・鍵の行送りは
 *   同じ並びを見なければならない。渡し忘れた経路だけ**階層どおりの行**で数えると、
 *   「中まで全部出す」を入れたとき**目で見た範囲と選ばれる範囲が食い違う**。
 */
export interface FilerRowsOptions extends FilerListOptions {
  /**
   * 「中まで全部出す」(#813 段②)。入のとき、いまの場所の**配下を階層をまたいで全部**
   * 平らに出す(ルートなら全件)。切 = 直下だけ(いままでどおり)。
   * ⚠ スマートフォルダの中は**切り替えの対象外**(中身は条件の当たりで、もともと平ら)。
   * ⚠ 2 ペインの面は常に `false` を渡す(この入り切りは左の列の「フォルダ」だけのもの)。
   */
  readonly flatten: boolean;
}

/**
 * いま見ているフォルダに出る行(絞り込み済み・並べ替え済み)。
 * @param scopeLid `null` = ルート
 */
export function filerRows(
  scopeLid: string | null,
  entryMetas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
  opts: FilerRowsOptions,
): EntryMeta[] {
  /**
   * 🔴 **スマートフォルダの中身は「条件で当たったもの」**(#421 段①)。
   * ⚠ 手で入れた子は**見ない** ── そもそも入れられない(入れ物の中身が
   *   2 種類になると「消したのに残る」が起きる)。
   * ⚠ 消えた lid は落とす(当たりを集めた後にゴミ箱へ入れられることがある)。
   */
  const base =
    scopeLid !== null && entryMetas.get(scopeLid)?.archetype === SMART_ARCHETYPE
      ? (opts.smartLids ?? [])
          .map((lid) => entryMetas.get(lid))
          .filter((m): m is EntryMeta => m !== undefined)
      : opts.flatten
        ? getFlatDescendants(scopeLid, entryMetas, relations)
        : scopeLid === null
          ? getRootEntries(entryMetas, relations)
          : getStructuralChildren(scopeLid, entryMetas, relations);
  const filter = entryFilterOf(opts.filterQuery, opts.searchHits, opts.kinds);
  const shown = base.filter((m) => matchesEntry(m, filter));
  // ⚠ 並べ替えは lid の列で行う(規則は `sortOrder` 1 か所)── ここで比較を書き直さない
  const byLid = new Map(shown.map((m) => [m.lid, m]));
  return sortOrder(
    shown.map((m) => m.lid),
    (lid) => byLid.get(lid),
    opts.sort,
    opts.sortDesc,
    (lid) => opts.openedAt.get(lid) ?? 0,
  )
    .map((lid) => byLid.get(lid))
    .filter((m): m is EntryMeta => m !== undefined);
}

/**
 * 🔴 **「中まで全部出す」の行に添える親フォルダの名前**(#813 残り。🟣 Gemini 裁定 2026-10-01 = A)。
 *
 * 平らに出すと、階層が見えなくなって「どこの物か」が読めない ── 行の題名の右に
 * **親フォルダの名前**を添える。lid → 親の題名。**載っていない lid は添えない**。
 *
 * - 切(`flatten: false`)= 空(直下だけなので親は自明)
 * - **いま見ているフォルダの直下の行**には出さない(親 = いま見ているフォルダで冗長)。
 *   出すのは**孫以深**(親がいまの場所と違う行)だけ
 * - ルートで入 = 直下(親が無い行)には出さず、**フォルダの中に居る行**だけ出す
 * - スマートフォルダの中 = 空(`filerRows` が平らの切替を見ない場所 ── 中身は条件の当たりで、
 *   親の名前を添える意味が無い)
 *
 * ⚠ 親は**正準親**(`resolveCanonicalParents` 1 本)で引く ── 木の読み方を 2 本にしない(§7)。
 * ⚠ 題名が空の親は添えない(字が無い物を「─」だけで出さない)。
 */
export function flatParentNames(
  scopeLid: string | null,
  rows: readonly EntryMeta[],
  entryMetas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
  flatten: boolean,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (!flatten) return out;
  if (scopeLid !== null && entryMetas.get(scopeLid)?.archetype === SMART_ARCHETYPE) return out;
  const parentOf = resolveCanonicalParents(entryMetas, relations);
  for (const m of rows) {
    const parent = parentOf.get(m.lid);
    if (parent === undefined || parent === scopeLid) continue;
    const title = entryMetas.get(parent)?.title ?? '';
    if (title !== '') out.set(m.lid, title);
  }
  return out;
}

/**
 * 🔴 **一覧タブに出る行**(#1038 台帳③ 段 G、C13)。⚠ `filerRows` と**同じ理由**で
 * 1 か所にする(このファイル冒頭の docstring)── 描く側(`sidebar.ts`)と選ぶ側
 * (reducer の `SELECT_RANGE`)が別々に並びを組むと、目で見た範囲と選ばれる範囲が
 * 食い違う。
 *
 * ⚠ **`filerRows` とは「見る集合」が違う**── フォルダの表はフォルダの構造
 *   (`scopeLid` の直下)だけを見るが、一覧タブは**フォルダ構造を見ない flat な
 *   並び**(`order` に載っている全件)である。だから `scopeLid` を渡さない ──
 *   渡せる引数を作ると「一覧なのにフォルダ構造で絞られる」を作り込むことになる。
 * @param order 一覧に**存在する**全 lid(絞り込み前。`AppState.order`)
 */
export function listRows(
  order: readonly string[],
  entryMetas: ReadonlyMap<string, EntryMeta>,
  opts: FilerListOptions,
): EntryMeta[] {
  const base = order
    .map((lid) => entryMetas.get(lid))
    .filter((m): m is EntryMeta => m !== undefined);
  const filter = entryFilterOf(opts.filterQuery, opts.searchHits, opts.kinds);
  const shown = base.filter((m) => matchesEntry(m, filter));
  // ⚠ 並べ替えは lid の列で行う(規則は `sortOrder` 1 か所)── ここで比較を書き直さない
  const byLid = new Map(shown.map((m) => [m.lid, m]));
  return sortOrder(
    shown.map((m) => m.lid),
    (lid) => byLid.get(lid),
    opts.sort,
    opts.sortDesc,
    (lid) => opts.openedAt.get(lid) ?? 0,
  )
    .map((lid) => byLid.get(lid))
    .filter((m): m is EntryMeta => m !== undefined);
}

/**
 * 🔴 **いま見えている行に絞った印**(#240 の着地前レビュー 2)。
 *
 * ⚠ 印(`selection`)は行が見えなくなっても残る ── 絞り込みで消えた / 別タブが
 * 消した(`SYS_BOOTED` でも落ちるが、絞り込みは落ちない)。残ったまま
 * 「まとめてゴミ箱へ」を押すと、**画面に無いものが消える**。
 * 🔑 だから「帯に出す数」「まとめて消す対象」「掴んで運ぶ対象」は
 * **全部この 1 本**を通す ── 数と対象が食い違うと、確認の文言が嘘になる。
 */
export function visibleSelection(
  rows: readonly EntryMeta[],
  selection: readonly string[],
): string[] {
  const shown = new Set(rows.map((m) => m.lid));
  return selection.filter((lid) => shown.has(lid));
}

/**
 * 🔴 **操作の相手**(2026-08-19 の作り直し。設計 doc §3 行 H)。
 *
 * > **印が 1 つでも在ればその印、無ければカーソルの行。**
 *
 * ⚠ **この規則が無いと、カーソルが飾りになる。** `↑↓` を印から切り離した瞬間、
 *   「矢印で目当ての行まで下りて F6」という古典 4 実装(Total Commander /
 *   Double Commander / FAR / Krusader)で最も多い手が、
 *   **「移すものを選んでください」で断られ続ける**動線に変わる。
 * 🔑 **写す / 移す / ゴミ箱 / 操作行の件数**が全部ここを通る ── 数と相手が
 *   食い違うと、ボタンの説明(「いま 1 件」)が嘘になる(CLAUDE.md §7)。
 * ⚠ 相手は必ず**いま表に出ている行**に絞る(`visibleSelection` と同じ理由)──
 *   絞り込みで消えた印や、消えた行を指したままのカーソルを動かさない。
 */
export function operationTargets(
  rows: readonly EntryMeta[],
  selection: readonly string[],
  cursor: string | null,
): string[] {
  const marked = visibleSelection(rows, selection);
  if (marked.length > 0) return marked;
  return cursor !== null && rows.some((m) => m.lid === cursor) ? [cursor] : [];
}

/**
 * 表示順で `from` と `to` の間を採る(両端を含む)。
 * ⚠ どちらかが見えていないときは **`to` だけ**を返す ── 見えていない行を
 * 巻き込んで消す事故を作らない。
 */
export function rangeInRows(
  rows: readonly EntryMeta[],
  from: string | null,
  to: string,
): string[] {
  const lids = rows.map((m) => m.lid);
  const b = lids.indexOf(to);
  if (b < 0) return [];
  const a = from === null ? -1 : lids.indexOf(from);
  if (a < 0) return [to];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return lids.slice(lo, hi + 1);
}
