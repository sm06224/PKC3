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

/**
 * 🔴 **線が 1 本も無い画面で、理由と次の一手を言う**(#918 段⑤d-3)。**pure**。
 *
 * ## なぜ要るか
 *
 * 段⑤d-1 で「繋ぐ」を足したが、⚠ **線が 0 本の画面は、何も言わないままだった** ──
 * user から見ると「箱は出たのに線が出ない = 壊れている」としか読めず、
 * 最初の報告(「ちゃんと描きたいのにできないんだが」)と**同じ所へ戻る**。
 *
 * 🔑 だから **0 本である理由**と、**次に何を押せばよいか**を字にする。
 * ⚠ 「繋ぐ」が既に入のときは**次の一手を書かない** ── すぐ下の案内
 *   (`connectHintOf`)が同じことを言うので、2 度言うと読み飛ばされる。
 *
 * @returns 出す字。`''` なら**何も出さない**。
 */
export function erZeroLinesWhy(input: {
  /** 図に出ている四角の数。 */
  readonly boxes: number;
  /** DB が宣言した繋がりの数。 */
  readonly declared: number;
  /** 自分で引いた繋がりの数。 */
  readonly mine: number;
  /** 線にできずに落ちた繋がりの数。 */
  readonly dropped: number;
  /** 「繋ぐ」が入か。 */
  readonly connecting: boolean;
}): string {
  const { boxes, declared, mine, dropped, connecting } = input;
  if (boxes === 0) return '';
  // ⚠ 相手が 1 つしかないなら「繋ぐ」を勧めてはいけない ── 同じ表の中は繋げない
  //   (`pickErConnection` が断る)ので、勧めると**押せない道**へ誘うことになる。
  if (boxes === 1) return '表が 1 つだけなので、繋ぐ相手がいません。';
  const next = connecting ? '' : ' 上の「繋ぐ」を押して列を 2 つ押すと、自分で繋げます。';
  if (dropped > 0) {
    return `繋がりはありますが、1 本も線にできませんでした(理由はこの下に出ています)。${next}`;
  }
  if (declared === 0 && mine === 0) {
    return `この DB は、表どうしの繋がり(外部キー)を 1 つも宣言していません。${next}`;
  }
  // ⚠ ここへは来ない(繋がりが在って落ちてもいないなら、線は引かれている)。
  //   ⚠ **それらしい字を返さない** ── 起きない形に文言を置くと、
  //   後から「この字が出た」と読んだ人が存在しない経路を追う。
  return '';
}
