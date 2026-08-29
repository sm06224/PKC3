/**
 * 🔴 **1 ノートが持つタグを、1 か所で答える**(#550 段②。裁定 B ── 索引だけ)。
 *
 * > user の言葉(⚠ 要約しない):
 * > 「**frontmatter は本文中に打たれたタグを保存時に重複排除して集約する
 * >  インボディタグ(自動集約)と文書タグ(frontmatter に直接設定)に分け、
 * >  ユーザーがどの見出しや記事でタグがついたのかわかりやすくすべき**」
 *
 * ## 2 種類ある(設計 doc `tag-system-design-2026-08.md` §4)
 *
 * | 種類 | 出どころ | 誰が書くか |
 * |---|---|---|
 * | **文書タグ** | frontmatter の `tags:` | user が直接 |
 * | **インボディタグ** | 本文のタグ行(段①) | **保存時に自動集約**(重複排除) |
 *
 * ## 🔴 frontmatter へは書き戻さない(裁定 B)
 *
 * ⚠ user の本文を機械が書き換える経路は、**この repo が最も事故を起こしてきた場所**
 *   である。集約の目的(探す・集計する・スマートフォルダ)は**索引で全部果たせる**
 *   ので、`tags:` は user のものだけにする。
 *
 * ## 🔑 判定をここ 1 本に寄せる理由(CLAUDE.md §7)
 *
 * 「このノートはタグ X を持つか」に答える口は **3 つ**ある ──
 * ①スマートフォルダの走査(worker)②保存直後の当て直し(`app-state`)
 * ③情報ペインの札。⚠ それぞれが独自に足し算すると、
 * **一覧に出る札と「当たるかどうか」が静かに食い違う**。
 */
import { scanBodyTags, type BodyTag } from './body-tags';
import { MAX_TAGS, MAX_TAG_CHARS, normalizeTag, readTags, sameTag } from './tags';

/** 本文中タグ 1 個の出現。⚠ **重複を残す** ── どの見出しで付いたかを捨てないため。 */
export type BodyTagUse = BodyTag;

export interface EntryTagView {
  /** 文書タグ(frontmatter)。書いた順。 */
  readonly doc: readonly string[];
  /** 本文中タグの**出現**(重複あり・見出しの道筋つき)。 */
  readonly uses: readonly BodyTagUse[];
  /** 本文中タグを**重複排除**した名前(初出の綴りを残す)。 */
  readonly inBody: readonly string[];
  /** 文書タグ + 本文中タグ を重複排除したもの。⚠ **当たり判定はこれで行う**。 */
  readonly all: readonly string[];
}

/**
 * 名前の並びを、`sameTag`(大小無視)で畳む。
 *
 * ⚠ **並べ替えない**(`readTags` / `withTag` と同じ ── 書いた順は user の物)。
 * ⚠ **初出の綴りを残す** ── `#請求` と `#請求` が並んだら先に書いたほうを見せる。
 * ⚠ 上限に当たったら**足さない**(黙って古いほうを落とさない ── `withTag` と同じ作法)。
 */
function foldTags(names: readonly string[], seed: readonly string[] = []): string[] {
  const out: string[] = [...seed];
  for (const raw of names) {
    if (out.length >= MAX_TAGS) break;
    const t = normalizeTag(raw);
    if (t === '' || [...t].length > MAX_TAG_CHARS) continue;
    if (out.some((x) => sameTag(x, t))) continue;
    out.push(t);
  }
  return out;
}

/**
 * 本文中タグだけを、重複排除して返す。
 *
 * 🔑 **索引の列(`entries.body_tags`)へ入れるのはこれ**である ── 走査の側が
 *   本文を丸ごと読まずに当てられるようにするため(それが裁定 B の実体)。
 */
export function bodyTags(body: string): string[] {
  return foldTags(scanBodyTags(body).map((u) => u.name));
}

/**
 * 1 ノートのタグを全部そろえて返す。
 *
 * ⚠ **`all` は文書タグが先**(user が直接書いたほうを先に見せる)。
 */
export function collectEntryTags(body: string): EntryTagView {
  const doc = readTags(body);
  const uses = scanBodyTags(body);
  const inBody = foldTags(uses.map((u) => u.name));
  return { doc, uses, inBody, all: foldTags(inBody, doc) };
}

/**
 * 走査の側が使う形 ── **frontmatter の頭だけ**と、**索引に入っている本文中タグ**から
 * 当たり判定用の並びを作る。
 *
 * 🔴 **本文を丸ごと受け取らない**のが肝である(#421 段④ の `needsFullBody`)──
 *   タグだけの入れ物で全件の本文を heap に載せると、列を足した意味が消える。
 * ⚠ `indexed` が `null` = **まだ集約していない行**(旧ビルドが書いた / 移行前)。
 *   そのときは文書タグだけで当てる ── **壊れではなく遅れ**で、次の起動の
 *   埋め戻しで揃う(`task_total` と同じ作法)。
 */
export function tagsForMatch(head: string, indexed: readonly string[] | null): string[] {
  return foldTags(indexed ?? [], readTags(head));
}
