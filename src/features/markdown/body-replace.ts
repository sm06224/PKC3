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
 * ⚠ **置換語が検索語を含んでいても暴走しない**(1 回走査。
 * `while (s.includes(find))` 型で書くと `a` → `aa` で永久に回る)。
 *
 * 🔴 **見えていない所は置換の外に置く**(#1087 A2)。リンク・画像の宛先(`](…)` の中 / `<…>` の自動リンク /
 *   参照定義 `[x]: …` / HTML の `src`・`href`)、`entry:` / `asset:` / `pkc://` で始まる参照の語、先頭の設定行(前書き)の
 *   項目名は書き換えない ── 当てると URL・ノートの参照・添付の鍵が変わってリンクや画像が切れ、`date` → `day` で日付が外れる。
 *   ⚠ コードブロック・行内コードの中は今どおり置換する(コードは見える字であり、見え方の判断になるので変えない)。
 *   ⚠ 範囲取りは `scanLinks`(リンクの規則 1 本)から引く。新しい文法は書かない。
 *   ⚠ 検索語がこれらの範囲に**かかる**当たりは、丸ごと置換しない(半端に書き換えるとかえって壊れる)。
 */
import { frontmatterLineCount } from './frontmatter';
import { scanLinks } from './link-scan';

export interface ReplaceOptions {
  /** 大小を区別するか。⚠ 既定は**区別しない**(日本語に大小は無く、英語は打ち分けが面倒)。 */
  readonly caseSensitive?: boolean;
}

/** 大小無視で当てるための正規化(比較用の写しだけを作る)。 */
function fold(s: string, caseSensitive: boolean): string {
  return caseSensitive ? s : s.toLowerCase();
}

/** 自動リンク `<scheme:…>` / `<a@b>`。 */
const AUTOLINK = /<(?:[A-Za-z][A-Za-z0-9+.-]*:[^\s<>]*|[^\s<>@]+@[^\s<>]+)>/g;
/** `entry:` / `asset:` / `pkc://` で始まる参照の語。 */
const REF_WORD = /(?<![A-Za-z0-9_])(?:(?:entry|asset):|pkc:\/\/)[^\s)\]>"'<]+/g;

/**
 * 置換の外に置く範囲 `[start, end)`(昇順・重ならない)。⚠ 本文に検索語が当たったときだけ作る。
 */
function protectedRanges(body: string): Array<[number, number]> {
  const raw: Array<[number, number]> = [];
  const scan = scanLinks(body);
  const inCode = (p: number): boolean => scan.code.some(([a, b]) => p >= a && p < b);
  for (const site of scan.sites) raw.push([site.destStart, site.destEnd]);
  for (const re of [AUTOLINK, REF_WORD]) {
    re.lastIndex = 0;
    for (let m = re.exec(body); m; m = re.exec(body)) {
      if (!inCode(m.index)) raw.push([m.index, m.index + m[0].length]);
    }
  }
  // 前書きの項目名(値は置換してよい)と囲みの行。⚠ 物理行で切る(`frontmatterLineCount` と同じ数え方)
  const lines = frontmatterLineCount(body);
  let pos = 0;
  for (let n = 0; n < lines && pos <= body.length; n++) {
    const nl = body.indexOf('\n', pos);
    const end = nl === -1 ? body.length : nl;
    const line = body.slice(pos, end);
    if (/^\uFEFF?---\s*$/.test(line)) raw.push([pos, end]);
    else {
      const km = /^([^\s#:][^:\r\n]*?)(?=\s*:)/.exec(line);
      if (km) raw.push([pos, pos + km[1]!.length]);
    }
    pos = end + 1;
  }
  raw.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const r of raw) {
    if (r[1] <= r[0]) continue;
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** `[at, at+len)` が範囲のどれかにかかるか(二分探索)。 */
function overlaps(ranges: Array<[number, number]>, at: number, len: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid]!;
    if (b <= at) lo = mid + 1;
    else if (a >= at + len) hi = mid - 1;
    else return true;
  }
  return false;
}

/**
 * 🔴 **当たった箇所を、原文の位置と長さで返す**(大小の区別も含めて 1 本。件数と置換は必ずここを通る)。
 * ⚠ 小文字にすると長さが変わる字が在る(`İ` U+0130 は `i` + U+0307 の 2 字になる)── 写しの添字で原文を
 *   切ると、その字より後ろの置換が全部ずれて本文を壊していた(#1087。`İstanbul ve Ankara` の `ankara` →
 *   `İstanbul ve AX`)。長さが変わらない本文は写しで速く探し、変わる本文は原文の位置ごとに比べる。
 * ⚠ 置換の外の範囲(`protectedRanges`)にかかる当たりは数えない・置換しない(1 字ずらして探し直す)。
 */
function findHits(body: string, find: string, caseSensitive: boolean): Array<{ at: number; len: number }> {
  const out: Array<{ at: number; len: number }> = [];
  const hay = fold(body, caseSensitive);
  const needle = fold(find, caseSensitive);
  let ranges: Array<[number, number]> | null = null;
  const blocked = (at: number, len: number): boolean => {
    ranges ??= protectedRanges(body);
    return overlaps(ranges, at, len);
  };
  if (hay.length === body.length) {
    // 写しと原文の添字が 1 対 1(いちばん多い場合)
    let at = 0;
    for (;;) {
      const hit = hay.indexOf(needle, at);
      if (hit < 0) break;
      if (blocked(hit, needle.length)) at = hit + 1;
      else {
        out.push({ at: hit, len: needle.length });
        at = hit + needle.length;
      }
    }
    return out;
  }
  // 長さが変わる字が在る ── 原文の位置ごとに、検索語と同じ長さを切って比べる
  const len = find.length;
  for (let at = 0; at + len <= body.length; ) {
    if (fold(body.slice(at, at + len), caseSensitive) === needle && !blocked(at, len)) {
      out.push({ at, len });
      at += len;
    } else at += 1;
  }
  return out;
}

/**
 * 何件当たるか。⚠ **空の検索語は 0 件**(「全部に当たる」ではない ── 空で押した
 * ときに本文が置換語で埋まる事故を、数える側で先に止める)。
 */
export function countMatches(body: string, find: string, opts: ReplaceOptions = {}): number {
  if (find === '') return 0;
  // ⚠ 数える規則は置換と同じ 1 本(件数と置換が食い違うと「N 件を置き換えました」が嘘になる)
  return findHits(body, find, opts.caseSensitive === true).length;
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
  let out = '';
  let at = 0;
  const hits = findHits(body, find, opts.caseSensitive === true);
  for (const h of hits) {
    out += body.slice(at, h.at) + replace;
    at = h.at + h.len;
  }
  return { body: out + body.slice(at), count: hits.length };
}
