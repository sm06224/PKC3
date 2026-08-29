/**
 * 本文の中のタグの見せ方の保存と適用(#550 段③)。意味論は `features/tag-badge.ts`。
 *
 * ⚠ 1 鍵だけ(`pkc3.text-scale` / `pkc3.column-rule` と同じ作法)。
 * ⚠ **container に入れない** ── ノートのデータではなく**この端末の見え方**である。
 * 🔑 当て方は `column-rule.ts` と**同じ形**にする(印の属性 1 つ)──
 *   2 本目の作法を作らない(§7)。⚠ こちらは CSS 変数を持たない
 *   (見え方の差が「色」ではなく「箱があるか」なので、規則ごと切り替える)。
 */
import { DEFAULT_TAG_BADGE, isTagBadge, type TagBadge } from '@features/tag-badge';

const KEY = 'pkc3.tag-badge';

/** 当てる先の印。⚠ これが `app.css` の `[data-pkc-tag-badge='…']` と 1 対 1。 */
export const TAG_BADGE_ATTR = 'data-pkc-tag-badge';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** 保存されている値(起動時の初期値)。⚠ 読めなければ既定。 */
export function initialTagBadge(): TagBadge {
  try {
    const v = readStorage()?.getItem(KEY);
    return v !== null && v !== undefined && isTagBadge(v) ? v : DEFAULT_TAG_BADGE;
  } catch {
    return DEFAULT_TAG_BADGE;
  }
}

/**
 * いま当たっている見せ方(**DOM が正本**)。
 * ⚠ 保存を読み直さない ── 保存できない環境では「この session だけ効いている」値が
 *   正しく、そこで保存を見ると**画面と食い違う**。
 */
export function currentTagBadge(target: HTMLElement): TagBadge {
  const v = target.getAttribute(TAG_BADGE_ATTR);
  return v !== null && isTagBadge(v) ? v : DEFAULT_TAG_BADGE;
}

/**
 * 当てる。⚠ **保存しない**(起動時の適用が「一度も選んでいないのに固定される」を
 * 作らないように、保存は `chooseTagBadge` だけが持つ)。
 *
 * 🔑 **描き直しは要らない** ── 箱の見え方が変わるだけで HTML は 1 文字も変わらない
 *   (バッジの骨組みは markdown の側が常に出す)。
 */
export function applyTagBadge(target: HTMLElement, badge: TagBadge): void {
  target.setAttribute(TAG_BADGE_ATTR, badge);
}

/** user が選んだ ── 当てて**保存する**。 */
export function chooseTagBadge(target: HTMLElement, badge: TagBadge): void {
  applyTagBadge(target, badge);
  try {
    readStorage()?.setItem(KEY, badge);
  } catch {
    // 保存できないだけ ── この session では効いている
  }
}
