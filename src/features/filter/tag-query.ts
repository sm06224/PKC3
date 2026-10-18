/**
 * 🔴 **探す欄の `#タグ` は、そのタグが付いたノートだけを並べる**(台帳 #1852 / 依頼 317)。
 *
 * user の物語: タグの札(「AI」)を押すと、題名や本文に `mail` / `again` を含むだけのノートまで並ぶ。
 * 札を押す人は「そのタグのノート」を見たい。
 *
 * ## 書き方
 *
 * - `#AI` ── 空白を含まず、数字以外を 1 字以上含む名前(本文のタグ行と同じ規則。`#117` のような番号は今までどおり字として探す)
 * - `#"仕事 メモ"` ── 空白を含む名前、または数字だけの名前(札を押したときはこの形で入る)
 *
 * 🔑 **判定はここ 1 か所**(§7)── 札を押す口が欄へ入れる字(`tagQueryText`)と、絞り込み・検索が読む字(`tagQueryOf`)が
 *   別々に書かれると、押した札が「ただの字」として探される(= 今までの不具合)に戻る。
 * ⚠ 比べる側(worker)がタグの突き合わせに使うのは `sameTag` 1 本。ここは名前を取り出すだけで、揃えない。
 */
import { MAX_TAG_CHARS } from '../flavor/tags';

const HAS_NON_DIGIT = /[^\d]/;

/** 欄の字がタグの問い合わせなら、その名前。⚠ 前後の空白は落とす。タグでなければ `null`(ふつうの語として探す)。 */
export function tagQueryOf(query: string): string | null {
  const q = query.trim();
  if (q.length < 2 || (q[0] !== '#' && q[0] !== '＃')) return null;
  const rest = q.slice(1);
  let name: string;
  if (rest.length >= 3 && rest.startsWith('"') && rest.endsWith('"')) {
    name = rest.slice(1, -1);
    if (name.trim() === '' || name.includes('"')) return null;
  } else {
    if (/\s/.test(rest) || rest.startsWith('"') || !HAS_NON_DIGIT.test(rest)) return null;
    name = rest;
  }
  return [...name].length > MAX_TAG_CHARS ? null : name;
}

/** 札を押したとき、欄へ入れる字。⚠ `tagQueryOf(tagQueryText(x)) === x` になる形(空白・数字だけ・引用符を含む名前は引用する)。 */
export function tagQueryText(tag: string): string {
  const bare = !/\s/.test(tag) && HAS_NON_DIGIT.test(tag) && !tag.startsWith('"') && !tag.includes('"');
  return bare ? `#${tag}` : `#"${tag}"`;
}
