/**
 * 🔴 **貼りたいノートを題名で選ぶ**(#427 段②)── 一覧を組む純関数。
 *
 * ## なぜ要るか(段① の残り)
 *
 * 段① の「参照をコピー」は **相手を開きに行ってから戻る**ので、
 * ⚠ **書いている手が止まる**。書きながら「先週の議事録」と打って選べれば止まらない。
 *
 * ## 🔴 打鍵に追随する浮き物は作らない(既存の裁定に揃えた)
 *
 * #427 段② の起票は「`[[` か `@` で小窓を出す」と書いていたが、**採らない**。
 * ⚠ この repo は**同じ判断を 2 度している**:
 * - `insert-date`(2026-08-23)── `@` を退けた。`@[card](…)` と **1 打鍵目で衝突**する
 * - `insert-snippet`(#196 段②-b)── `/` を退けた。散文に普通に出る字なので**誤爆する**
 *
 * 🔑 どちらも理由の芯は同じで、不可侵指示
 * 「**マウスだけで完結し、キーボードは近道**」である ──
 * **打鍵でしか出ない道具は、マウスの人には存在しないのと同じ**。
 * ⚠ そして `[[` は PKC3 では**空いていない**(`[[ruby:…]]` / `[[em:…]]`)ので、
 * ルビを打つたびに小窓が出ることになる。
 *
 * 🔑 だから**書式の帯のボタン**を主の口にし、鍵は近道として添える
 * (`insert-date` / `insert-snippet` とまったく同じ形)。
 * ⚠ **失う動線は無い** ── 「書きながら選ぶ」は帯のボタンでも成立する
 * (caret はそのままで、選んだ物がその場に入る)。
 *
 * ⚠ **pure module**。browser API を持たない。
 */
import type { EntryMeta } from '@core/model/entry-meta';
import { matchesTitle, normalizeQuery } from '@features/filter/title-filter';
import { archetypeLabel } from '@features/flavor/archetype-label';

/**
 * 一覧に出す上限。
 * ⚠ **切ったことは呼び手が画面に出す**(`entryPickNote`)── 黙って切ると、
 *   探している物が出ていないのに「無い」と読まれる。
 */
export const ENTRY_PICK_LIMIT = 50;

export interface EntryPickRow {
  readonly lid: string;
  readonly title: string;
  /** 種類の名前(同じ題名が並んだときの見分け)。 */
  readonly kind: string;
}

/**
 * 題名で絞った候補。
 *
 * 🔴 **自分自身は出さない** ── 開いているノートへのリンクを自分の本文に貼っても
 *   押せば同じ所に戻るだけで、user が欲しかった物ではない(そして
 *   「押しても何も起きない」に見える)。
 *
 * ⚠ **ごみ箱の中は自動的に出ない** ── 捨てた entry は `entryMetas` から外れる
 *   (`trashPanel` は `entryMetas` に**居ないもの**を持つ)。だからここで
 *   除く条件を書かない ── 書くと「2 か所で同じ判定」になる(CLAUDE.md §7)。
 *
 * ⚠ 並びは **`order`(一覧と同じ)** を尊重しつつ、**題名の頭から一致**する物を
 *   先に出す ── 「議事」と打った人が探しているのは、たいてい題名がそれで
 *   始まる物である。
 *
 * @param order 一覧の並び(`state.order`)。⚠ ここに無い lid は出さない
 * @param selfLid いま開いているノート(`null` なら除かない)
 */
export function entryPickRows(
  entryMetas: ReadonlyMap<string, EntryMeta>,
  order: readonly string[],
  query: string,
  selfLid: string | null,
  limit: number = ENTRY_PICK_LIMIT,
): EntryPickRow[] {
  const q = normalizeQuery(query);
  const head: EntryPickRow[] = [];
  const rest: EntryPickRow[] = [];
  for (const lid of order) {
    if (lid === selfLid) continue;
    const meta = entryMetas.get(lid);
    if (meta === undefined) continue;
    if (!matchesTitle(meta.title, q)) continue;
    const row = { lid, title: meta.title, kind: archetypeLabel(meta.archetype) };
    // ⚠ `q === ''` のときは全部が「頭から一致」なので、並びは `order` のまま
    (q !== '' && meta.title.toLowerCase().startsWith(q) ? head : rest).push(row);
  }
  return [...head, ...rest].slice(0, limit);
}

/**
 * 一覧の下に出す 1 行(`''` なら何も出さない)。
 *
 * 🔴 **切ったことを必ず言う。** ⚠ 黙って 50 件で切ると、51 件目を探している
 *   user は「そのノートは無い」と読み、**もう一度作ってしまう**。
 */
export function entryPickNote(shown: number, total: number): string {
  if (total === 0) return 'あてはまるノートがありません(題名で探しています)';
  if (shown < total) return `${total} 件のうち ${shown} 件を出しています ── 題名を打つと絞れます`;
  return '';
}

/**
 * 絞り込む前の総数(`entryPickRows` と**同じ条件**で数える)。
 *
 * ⚠ 呼び手が `order.length` で数えると、**自分自身とごみ箱を含めた数**になり、
 *   「50 件のうち 50 件」と出しながら実は 49 件、という食い違いになる。
 */
export function entryPickTotal(
  entryMetas: ReadonlyMap<string, EntryMeta>,
  order: readonly string[],
  query: string,
  selfLid: string | null,
): number {
  return entryPickRows(entryMetas, order, query, selfLid, Number.MAX_SAFE_INTEGER).length;
}
