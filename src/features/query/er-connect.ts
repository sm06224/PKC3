/**
 * 🔴 **ER の図で、自分でキーどうしを繋ぐ**(#918 段⑤d-1)。**pure**。
 *
 * > user 報告 2026-09-16:「**er のキー同士の掛け合わせとかちゃんと描きたいのに
 * > できないんだが**」
 *
 * ## 🔴 線は「宣言された外部キー」からしか作られなかった
 *
 * `erLayout` が引く線は、DB が持つ `FOREIGN KEY` の宣言だけを読む。csv / xlsx を
 * 取り込んだ相手や、外部キーを 1 本も宣言していない `.sqlite` では、
 * **線が必ず 0 本**になり、繋ぐ手段が画面に無かった。
 *
 * 🔑 だからここでは「押した 2 つの列を、自分で `SchemaLink` にする」判定だけを持つ。
 * ⚠ **`erLayout` も `erSql` も 1 行も変えない** ── 自分で作った `SchemaLink` は
 *   宣言された物と同じ形なので、両方にそのまま渡せる。
 */

import type { SchemaLink, SchemaModel } from './schema-digest';

/** 「ここから」の 1 列。 */
export interface ErPendingFrom {
  readonly table: string;
  readonly column: string;
}

export type ErPickResult =
  /** 1 列目を押した(まだ相手を待っている)。 */
  | { readonly kind: 'from'; readonly pendingFrom: ErPendingFrom }
  /** 同じ列をもう一度押した(やめる)。 */
  | { readonly kind: 'cancel' }
  /** 押したが、繋げない理由がある。⚠ **そのまま画面に出す字**。 */
  | { readonly kind: 'denied'; readonly why: string }
  /** 繋がりが 1 本できた。 */
  | { readonly kind: 'linked'; readonly link: SchemaLink };

/** 同じ名前か(sqlite の名前は大小を区別しない。`er-sql.ts` の `same` と同じ規則)。 */
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * 向きを問わず同じ繋がりか。
 * ⚠ `A→B` と `B→A` は**同じ関係**として扱う ── 向きだけ変えて登録し直せてしまうと、
 *   同じ 2 列の間に線が重なって描かれる(押しても消せない線が増えるだけになる)。
 */
function sameLink(a: SchemaLink, b: SchemaLink): boolean {
  const forward =
    same(a.from, b.from) &&
    same(a.fromColumn, b.fromColumn) &&
    same(a.to, b.to) &&
    same(a.toColumn, b.toColumn);
  const backward =
    same(a.from, b.to) &&
    same(a.fromColumn, b.toColumn) &&
    same(a.to, b.from) &&
    same(a.toColumn, b.fromColumn);
  return forward || backward;
}

/**
 * 🔴 **「繋ぐ」モード中に列を押した結果を決める**(#918 段⑤d-1)。
 *
 * ⚠ `model` は `null` になりうる(採る前 / 採れなかった)── そのときは
 *   「もう繋がっているか」を `mine` だけで見る(宣言された繋がりは無い扱い)。
 */
export function pickErConnection(
  model: SchemaModel | null,
  mine: readonly SchemaLink[],
  pendingFrom: ErPendingFrom | null,
  table: string,
  column: string,
): ErPickResult {
  if (pendingFrom === null) {
    return { kind: 'from', pendingFrom: { table, column } };
  }
  if (same(pendingFrom.table, table) && same(pendingFrom.column, column)) {
    return { kind: 'cancel' };
  }
  if (same(pendingFrom.table, table)) {
    return { kind: 'denied', why: '同じ表の中では繋げません' };
  }
  const link: SchemaLink = {
    from: pendingFrom.table,
    fromColumn: pendingFrom.column,
    to: table,
    toColumn: column,
  };
  const declared = model?.links ?? [];
  if ([...declared, ...mine].some((l) => sameLink(l, link))) {
    return { kind: 'denied', why: 'その 2 つはもう繋がっています' };
  }
  return { kind: 'linked', link };
}
