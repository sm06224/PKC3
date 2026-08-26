/**
 * 🔴 **種類で絞るための札**(#411。PKC2 の「サイドバーの種別フィルタ」)。
 *
 * ## user の物語
 *
 * ノートが 300 件あって、**添付だけ**を見たい。いままでの PKC3 は絞り込み欄が
 * 題名と本文にしか効かないので、「添付」と打つと**題名に「添付」と書いてある
 * ノート**が出るだけだった(並べ替えに種類は在るが、⚠ **並べ替えは絞り込みでは
 * ない** ── 300 件が 300 件のまま順番が変わるだけである)。
 *
 * ## 🔑 出す札は「いま数えて 1 件以上ある種類」だけ
 *
 * ⚠ 名前を持つ種別は 9 つある(`ARCHETYPE_LABELS`)。全部を常に並べると:
 * - 帯が長くなって、**絞り込み欄より目立つ**(補助が主を押しのける)
 * - **押しても 0 件になる札**が並ぶ ── user は「壊れている」と読む
 *
 * 🔑 だから**その場に居るものだけ**を数えて出す。件数も添えるので、
 *   押す前に何件になるかが分かる(押してから驚かない)。
 *
 * ## ⚠ 数える母集団は「種類で絞る**前**、語で絞った**後**」
 *
 * 🔴 これを取り違えると、**押すと 0 件になる札**か、**押しても減らない札**の
 *   どちらかができる:
 * - 種類でも絞った後を数えると → 選んだ札**だけ**が残り、他の札が消えるので
 *   **戻れなくなる**(解除の口が画面から無くなる)
 * - 語で絞る前を数えると → 「りんご」で 3 件しか無いのに札が「添付 61」と言い、
 *   押すと **0 件**になる
 *
 * ⚠ **pure module**。browser API を持たない。
 */
import { ARCHETYPE_LABELS, archetypeLabel } from '@features/flavor/archetype-label';
import type { FilterTarget } from './title-filter';

/** 札 1 枚。 */
export interface KindCount {
  readonly archetype: string;
  /** user に見せる名前(内部語は出さない)。 */
  readonly label: string;
  readonly count: number;
}

/** `ARCHETYPE_LABELS` の並び(= user に見せる順)。知らない綴りは末尾。 */
const ORDER: ReadonlyMap<string, number> = new Map(
  ARCHETYPE_LABELS.map(([name], i) => [name, i]),
);

/**
 * その場に居る種類を数える。
 *
 * ⚠ **知らない綴りも落とさない**(`generic` / 取り込みが作った独自の語)──
 *   落とすと、そのノートは**どの札でも絞れない**のに札の合計にも入らないので、
 *   「合計が合わない」という説明できない画面になる。名前が無いものは
 *   `archetypeLabel` が**綴りをそのまま返す**ので、札としては成立する。
 *
 * @param targets 種類で絞る**前**・語で絞った**後**の行(上の ⚠ を読むこと)
 */
export function kindCounts(targets: Iterable<FilterTarget>): KindCount[] {
  const tally = new Map<string, number>();
  for (const t of targets) tally.set(t.archetype, (tally.get(t.archetype) ?? 0) + 1);
  return [...tally]
    .map(([archetype, count]) => ({ archetype, label: archetypeLabel(archetype), count }))
    .sort((a, b) => {
      const ai = ORDER.get(a.archetype) ?? ORDER.size;
      const bi = ORDER.get(b.archetype) ?? ORDER.size;
      // ⚠ 知らない綴りどうしは**綴り順**で並べる ── 数の順にすると、
      //   1 件足すたびに札が飛び回って押し間違える
      return ai !== bi ? ai - bi : a.archetype.localeCompare(b.archetype);
    });
}

/**
 * 札を押した後の選択。
 *
 * 🔴 **もう一度押すと外れる**(PKC2 と同じ)。⚠ 外した結果が空になったら
 *   それは「絞らない」であって「0 件」ではない ── `matchesEntry` が空集合を
 *   「全部出す」と読む(そちらに規則が在る。ここでは持たない)。
 */
export function toggleKind(kinds: ReadonlySet<string>, archetype: string): ReadonlySet<string> {
  const next = new Set(kinds);
  if (!next.delete(archetype)) next.add(archetype);
  return next;
}
