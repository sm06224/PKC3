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
  if (cs) return body.split(find).length - 1;
  // ⚠ 数える規則は置換と同じ 1 本(件数と置換が食い違うと「N 件を置き換えました」が嘘になる)
  return foldedHits(body, find).length;
}

/**
 * 🔴 **大小無視で当たった箇所を、原文の位置と長さで返す**(#1087、本文の書換の見直し)。
 * ⚠ 小文字にすると長さが変わる字が在る(`İ` U+0130 は `i` + U+0307 の 2 字になる)── 写しの添字で原文を
 *   切ると、その字より後ろの置換が全部ずれて本文を壊していた(`İstanbul ve Ankara` の `ankara` →
 *   `İstanbul ve AX`)。長さが変わらない本文は写しで速く探し、変わる本文は原文の位置ごとに比べる。
 */
function foldedHits(body: string, find: string): Array<{ at: number; len: number }> {
  const hay = fold(body, false);
  const needle = fold(find, false);
  const out: Array<{ at: number; len: number }> = [];
  if (hay.length === body.length) {
    // 写しと原文の添字が 1 対 1(いちばん多い場合)
    let at = 0;
    for (;;) {
      const hit = hay.indexOf(needle, at);
      if (hit < 0) break;
      out.push({ at: hit, len: needle.length });
      at = hit + needle.length;
    }
    return out;
  }
  // 長さが変わる字が在る ── 原文の位置ごとに、検索語と同じ長さを切って比べる
  const len = find.length;
  for (let at = 0; at + len <= body.length; ) {
    if (fold(body.slice(at, at + len), false) === needle) {
      out.push({ at, len });
      at += len;
    } else at += 1;
  }
  return out;
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
  // 大小無視: 当たった箇所は**原文の位置と長さ**で受け取り、原文から切り出す(`foldedHits`)
  let out = '';
  let at = 0;
  const hits = foldedHits(body, find);
  for (const h of hits) {
    out += body.slice(at, h.at) + replace;
    at = h.at + h.len;
  }
  return { body: out + body.slice(at), count: hits.length };
}
