/**
 * 🔴 **本文の中のタグの見せ方**(#550 段③。user 要望 2026-08-29)。
 *
 * > 「**そして、タグはバッジ化して表示が必要**」
 *
 * ## 🔑 なぜ「1 つ選んで配る」ではなく「選べるようにする」か
 *
 * user 指示 2026-08-28(不可侵):
 * > 「**正直変更はユーザーに委ねて欲しい**」
 * > 🔑 **user が選べる形にできるなら、そちらを先に出す** ── 「私が決めた見え方」を
 * >    配るより「**user が変えられる設定**」を作るほうが、この裁定に沿う(#504)
 *
 * ⚠ **既定は `chip`** ── user が「バッジ化して表示が必要」と言っているので、
 *   既定を「文字のまま」にすると**頼まれたことをやっていない**。
 *   ⚠ ただし**その場で `plain` に戻せる** ── 決めるのは user である。
 *   4 案を画面で見せたうえで `chip` を推薦し、その形で出している(#550 のコメント)。
 *
 * ## ⚠ 色は使わない
 *
 * user 指示 2026-08-03「**地は無彩色、色は情報にだけ使う**」── バッジは
 * **薄い灰色の下地**だけで作る(タグごとに色を振る案は、その裁定を覆す提案になる
 * ので出していない)。
 *
 * 🔑 **pure module**。browser API を使わない(保存と DOM は adapter 側)。
 */

export type TagBadge = 'chip' | 'outline' | 'plain';

export interface TagBadgeSpec {
  readonly id: TagBadge;
  /** 設定画面に出す字。⚠ **見え方で書く**(内部の語彙で書かない)。 */
  readonly label: string;
}

export const TAG_BADGES: readonly TagBadgeSpec[] = [
  { id: 'chip', label: '札(既定・薄い灰色の下地)' },
  { id: 'outline', label: '枠の札(下地なし・細い枠)' },
  { id: 'plain', label: '文字のまま(いままでと同じ)' },
] as const;

export const DEFAULT_TAG_BADGE: TagBadge = 'chip';

export function isTagBadge(v: unknown): v is TagBadge {
  return typeof v === 'string' && TAG_BADGES.some((s) => s.id === v);
}

/** 表から 1 つ引く。⚠ 知らない id は既定へ落ちる(呼び側で分岐させない)。 */
export function tagBadgeSpec(id: TagBadge): TagBadgeSpec {
  return TAG_BADGES.find((s) => s.id === id) ?? TAG_BADGES[0]!;
}
