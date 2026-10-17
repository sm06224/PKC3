/**
 * 一覧の並び順(#183 / 台帳 #180 の A-3)。
 *
 * 🔴 **pure module**。並びの規則はここ 1 か所 ── 面ごとに書くと、一覧・後継選択・
 * ランチャーが**別の答え**を返す(絞り込みで実際に踏んだ型。`title-filter.ts` の
 * 冒頭に記録が在る)。
 *
 * ⚠ **手で並べ替える導線(`move-order-up/down`)を置き換えるものではない。**
 * 既定は手動の順(`entry_order`)で、これはその上に載る「見え方」である。
 */
import type { EntryMeta } from '@core/model/entry-meta';
import { ARCHETYPE_LABELS } from '@features/flavor/archetype-label';
import { compareTitles } from './title-compare';

/** 種類の札の並び(= `ARCHETYPE_LABELS`)。知らない綴りは末尾。 */
const KIND_RANK: ReadonlyMap<string, number> = new Map(ARCHETYPE_LABELS.map(([name], i) => [name, i]));

/**
 * ⚠ **`opened`(最近開いた順)だけは `EntryMeta` から引けない**(#215 残り①)──
 *   開いた時刻は**端末ごとの記録**であって、ノートのデータではない
 *   (`features/history/opened-log.ts`)。だから `sortOrder` は引数でもう 1 本受ける。
 */
export const ENTRY_SORTS = ['manual', 'updated', 'created', 'opened', 'title', 'archetype', 'size'] as const;
export type EntrySort = (typeof ENTRY_SORTS)[number];
export const DEFAULT_ENTRY_SORT: EntrySort = 'manual';

export function isEntrySort(v: string): v is EntrySort {
  return (ENTRY_SORTS as readonly string[]).includes(v);
}

/**
 * 🔴 **その並びの「自然な向き」**(2026-08-19、2 ペインの作り直しで向きを持たせた)。
 *
 * ⚠ 直す前は `sortOrder` の中に `const desc = sort === 'updated'` と**埋まっていた**
 *   ので、向きを外から選べなかった(列見出しを押しても反転できない)。
 * 🔑 ここは「**押したとき最初にどちらへ倒すか**」だけを決める ── 実際の向きは
 *   state が持ち、`sortOrder` は渡された向きに従う(判定を 2 か所に置かない)。
 * ⚠ 新しい並びを足したらここにも足す(`Record` なので tsc が忘れさせない)。
 */
export const NATURAL_DESC: Readonly<Record<EntrySort, boolean>> = {
  manual: false,
  updated: true, // 更新は**新しい順**から見たい
  created: true, // 作成も**新しい順**から見たい(「今日作ったノート」が先頭に集まる。#1635 項 4)
  opened: true, // 最近開いた順 ── 「さっき見ていたあれ」が先頭に来る
  title: false,
  archetype: false,
  size: true, // 大きさは**大きい順**から見たい(整理の面で探すのは大物である)
};

/**
 * 並べ替える。⚠ **元の配列を壊さない**(`order` は state が持つ参照で、
 * reducer の指紋にもなっている ── その場で書き換えると再描画が飛ぶ)。
 *
 * ⚠ **同点は必ず lid で割る**(全モード)。割らないと、同じ題名・同じ時刻の行の
 * 並びが実行のたびに変わり、user から見て「行が勝手に入れ替わる」画面になる。
 *
 * @param metaOf 未知の lid は `undefined` を返してよい(落とさず末尾へ回す ──
 *   一覧から**黙って消える**ほうが害が大きい)
 * @param desc 降順にするか。⚠ **省略可にしない** ── 既定を持たせると
 *   「渡し忘れ = 昇順」が静かに通り、**列見出しの矢印と実際の並びが食い違う**
 *   (CLAUDE.md §7)。呼び側は `NATURAL_DESC` から引くか、state の向きを渡す。
 * @param openedAt その lid を最後に開いた時刻(epoch ミリ秒。無ければ `0`)。
 *   ⚠ **これも省略可にしない** ── 既定を `() => 0` にすると、渡し忘れた面では
 *   「最近開いた順」が**静かに lid 順**になる(選べるのに効かない = 無言の dead click)。
 */
export function sortOrder(
  order: readonly string[],
  metaOf: (lid: string) => EntryMeta | undefined,
  sort: EntrySort,
  desc: boolean,
  openedAt: (lid: string) => number,
): string[] {
  if (sort === 'manual') return [...order];
  /**
   * 🔴 **種類順**(依頼 193 / 275。Gemini 裁定 = 275 の A)。
   * 種類の**札の並び**(ノート → ログ → 表 → フォルダ …)で並べ、**同じ種類の中は
   * 「自分で並べた順」**(= 渡された `order` の順)のまま。知らない綴りは末尾で綴り順。
   * ⚠ 同点を lid で割らない ── 割ると手で並べた順が壊れる。向き(`desc`)は種類の並びだけを
   *   逆にし、種類の中は手で並べた順のまま(行が lid 順に化けない)。
   */
  if (sort === 'archetype') {
    const rank = (lid: string): readonly [number, string] => {
      const a = metaOf(lid)?.archetype;
      return a === undefined ? [KIND_RANK.size + 1, ''] : [KIND_RANK.get(a) ?? KIND_RANK.size, a];
    };
    const pos = new Map(order.map((lid, i) => [lid, i]));
    return [...order].sort((a, b) => {
      const [ra, sa] = rank(a);
      const [rb, sb] = rank(b);
      if (ra !== rb) return desc ? rb - ra : ra - rb;
      if (sa !== sb) return desc ? sb.localeCompare(sa) : sa.localeCompare(sb);
      return (pos.get(a) ?? 0) - (pos.get(b) ?? 0);
    });
  }
  /**
   * ⚠ **鍵の型は並びごとに 1 つ**(文字か数のどちらか)── 混ぜると比較が
   *   実行のたびに違う答えを返す。`size` だけが数で、他は全部文字である。
   */
  const key = (lid: string): string | number => {
    const m = metaOf(lid);
    /**
     * ⚠ **`opened` は `metaOf` より先に見る** ── 一度も開いていないノートも
     *   (`0` で)並びに残す。⚠ ここで `m` を要求すると、記録の無いノートが
     *   「未知」として末尾の文字キーへ落ち、**数と文字が混ざる**(上の注記)。
     */
    if (sort === 'opened') return openedAt(lid);
    if (sort === 'size') {
      // ⚠ 未知 / 未計算は**いちばん小さい**扱い(末尾でも先頭でもなく、0 と同列)
      return m?.bodyChars ?? -1;
    }
    if (!m) return '￿'; // 未知は末尾
    if (sort === 'title') return m.title;
    // created: 作った時刻(ISO / sqlite の字 ── どちらも辞書順 = 時刻順)。無いノートは最後へ回す
    if (sort === 'created') return m.createdAt ?? '';
    return m.updatedAt ?? ''; // updated: 時刻文字列(ISO なので辞書順 = 時刻順)
  };
  return [...order].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    // ⚠ 題名だけは照合順(数は数として・かなの種類は問わない)── 他は字の順 / 数の順
    if (sort === 'title' && typeof ka === 'string' && typeof kb === 'string') {
      const c = ka === '\uFFFF' || kb === '\uFFFF' ? (ka === kb ? 0 : ka === '\uFFFF' ? 1 : -1) : compareTitles(ka, kb);
      if (c !== 0) return desc ? -c : c;
    } else if (ka !== kb) return desc ? (ka < kb ? 1 : -1) : ka < kb ? -1 : 1;
    return a.localeCompare(b); // 同点は lid で割る(並びを決定的にする)
  });
}
