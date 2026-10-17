/**
 * 🔴 **つながりを足す相手を、同じ題名のノートの中から見分けて選ぶ**(Gemini 裁定 = #1163 への依頼 45 の 3、#1657。推薦 A)。
 *
 * 同じ題名のノートが 2 件以上あると、候補の一覧に同じ字が並ぶだけで、どれがどのノートか分からなかった
 * (足すときも「題名を分けてから足してください」で止まった)。
 *
 * 🔑 直し方:**同じ題名が 2 件以上あるノートの候補だけ**、題名の後ろに「入っているフォルダの名前・更新日」を添える
 * (`会議メモ(週次・2026/10/13)`)。選んだ候補は**そのノートの 1 件**に決まる。題名が 1 件しかないノートは今までどおり題名だけ。
 *
 * ⚠ 候補の字(`relationTargetLabel`)と、足すときに字から相手を引く口(`resolveRelationTarget`)は**この file の 1 組**
 *   ── 描く側と引く側で綴りが食い違うと、選んだのに「見つかりません」になる(CLAUDE.md §7)。
 */
import type { EntryMeta, Relation } from '@core/model/entry-meta';
import { formatStoredDate } from '@features/datetime/stored-date';
import { resolveCanonicalParents } from './tree';

/** 入っているフォルダが無い(一番上に在る)ノートに添える字。 */
export const NO_FOLDER_LABEL = 'フォルダなし';

/** 同じ題名のノートを見分ける候補の字。`題名(フォルダの名前・更新日)`。 */
export function relationTargetLabel(
  title: string,
  folderTitle: string | null,
  updatedAt: string | null | undefined,
): string {
  return `${title}(${folderTitle ?? NO_FOLDER_LABEL}・${formatStoredDate(updatedAt)})`;
}

/** 題名 → 件数(自分を除いた、つなぎ先になりうるノートの中で)。 */
export function countTitles(
  metas: ReadonlyMap<string, EntryMeta>,
  exceptLid: string,
): Map<string, number> {
  const n = new Map<string, number>();
  for (const m of metas.values()) {
    if (m.lid === exceptLid) continue;
    n.set(m.title, (n.get(m.title) ?? 0) + 1);
  }
  return n;
}

/** ノート 1 件の候補の字を、同じ題名が他に在るときだけ見分けつきにする。 */
export function candidateText(
  meta: EntryMeta,
  titleCount: number,
  parents: ReadonlyMap<string, string>,
  metas: ReadonlyMap<string, EntryMeta>,
): string {
  if (titleCount < 2) return meta.title;
  const parent = parents.get(meta.lid);
  return relationTargetLabel(meta.title, parent === undefined ? null : (metas.get(parent)?.title ?? null), meta.updatedAt);
}

export type RelationTarget =
  | { readonly kind: 'hit'; readonly lid: string }
  | { readonly kind: 'self' }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous'; readonly count: number };

/**
 * 欄に入っている字から、つなぐ相手のノートを 1 件に決める。
 *
 * | 欄の字 | 結果 |
 * |---|---|
 * | 題名がちょうど 1 件に合う | その 1 件 |
 * | 題名が 2 件以上に合う | `ambiguous`(どれかを勝手に選ばない) |
 * | 候補で選んだ見分けつきの字 | そのノートの 1 件(同じ字が 2 件以上なら `ambiguous`) |
 * | 自分自身の題名だけに合う | `self` |
 * | どれにも合わない | `none` |
 */
export function resolveRelationTarget(
  name: string,
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
  fromLid: string,
): RelationTarget {
  const hits = [...metas.values()].filter((m) => m.title === name && m.lid !== fromLid);
  if (hits.length === 1) return { kind: 'hit', lid: hits[0]!.lid };
  if (hits.length > 1) return { kind: 'ambiguous', count: hits.length };
  // 見分けつきの字(`題名(フォルダ・更新日)`)で選んだ回。⚠ 閉じ括弧で終わらない字は引かない(全件に字を組まない)
  if (name.endsWith(')')) {
    const counts = countTitles(metas, fromLid);
    const parents = resolveCanonicalParents(metas, relations);
    const labelled = [...metas.values()].filter(
      (m) =>
        m.lid !== fromLid &&
        (counts.get(m.title) ?? 0) > 1 &&
        candidateText(m, counts.get(m.title) ?? 0, parents, metas) === name,
    );
    if (labelled.length === 1) return { kind: 'hit', lid: labelled[0]!.lid };
    if (labelled.length > 1) return { kind: 'ambiguous', count: labelled.length };
  }
  if (metas.get(fromLid)?.title === name) return { kind: 'self' };
  return { kind: 'none' };
}
