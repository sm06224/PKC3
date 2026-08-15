/**
 * 本文の置換(#191 / 台帳 #180 の B-3)。
 *
 * 🔴 **textlog 専用の機構を作らない。** issue の題は「textlog のログ行検索・置換」だが、
 * PKC3 の textlog は**日時見出しの節を持つただの markdown** なので、本文の置換が
 * そのまま答えになる ── ここで textlog 専用の道を作ると、同じ操作が 2 か所に生える
 * (§7「同じ判定が複数の場所にある」を自分から作ることになる)。
 *
 * ⚠ **正規表現ではなく素の文字列**で当てる。user が打つのはたいてい語であって、
 * `.` や `*` を書いた瞬間に意図しない所へ当たるほうが害が大きい。
 * ⚠ **置換語が検索語を含んでいても暴走しない**(`split`/`join` = 1 回走査。
 * `while (s.includes(find))` 型で書くと `a` → `aa` で永久に回る)。
 */
export interface ReplaceOptions {
  /** 大小を区別するか。⚠ 既定は**区別しない**(日本語に大小は無く、英語は打ち分けが面倒)。 */
  readonly caseSensitive?: boolean;
}

/** 大小無視で当てるための正規化(比較用の写しだけを作る)。 */
function fold(s: string, caseSensitive: boolean): string {
  return caseSensitive ? s : s.toLowerCase();
}

/**
 * 何件当たるか。⚠ **空の検索語は 0 件**(「全部に当たる」ではない ── 空で押した
 * ときに本文が置換語で埋まる事故を、数える側で先に止める)。
 */
export function countMatches(body: string, find: string, opts: ReplaceOptions = {}): number {
  if (find === '') return 0;
  const cs = opts.caseSensitive === true;
  return fold(body, cs).split(fold(find, cs)).length - 1;
}

/**
 * 全部置換する。⚠ **当たった件数も返す** ── 呼び側が「0 件でした」と言えないと、
 * 押しても何も起きない dead click になる。
 * ⚠ 大小を区別しない置換でも、**当たった箇所の原文の長さ**で切り出すので
 * 本文の他の部分は 1 文字も変わらない。
 */
export function replaceAll(
  body: string,
  find: string,
  replace: string,
  opts: ReplaceOptions = {},
): { body: string; count: number } {
  if (find === '') return { body, count: 0 };
  const cs = opts.caseSensitive === true;
  if (cs) {
    const parts = body.split(find);
    return { body: parts.join(replace), count: parts.length - 1 };
  }
  // 大小無視: 位置は写しで探し、切り出しは**原文**から行う
  const hay = fold(body, false);
  const needle = fold(find, false);
  let out = '';
  let at = 0;
  let count = 0;
  for (;;) {
    const hit = hay.indexOf(needle, at);
    if (hit < 0) break;
    out += body.slice(at, hit) + replace;
    at = hit + needle.length;
    count += 1;
  }
  return { body: out + body.slice(at), count };
}
