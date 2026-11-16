/**
 * 🔴 **リンクのない言及**(#1966 4-1)── あるノートの題名が、ほかのノートの本文に**ただの字として**出ている所を
 *   見つけ、押すだけで `[題名](entry:<lid>)` のリンクに変える。
 *
 * ## 字として出ている所だけを数える(リンク・コードの中は書き換えない)
 * 本文の次の範囲に**かかる**当たりは数えない・書き換えない(半端に包むと記法が壊れる):
 * - コード(フェンス・行内コード・4 字下げ)── `scanLinks` の `code` と `indentedCodeRanges`(リンクの規則 1 本)
 * - リンク(字も宛先も丸ごと)・参照形式の使う側 `[字][名]` と定義行 `[名]: 宛先`・`[[題名]]`
 * - 自動リンク `<…>`・括弧なしの URL・`entry:` / `asset:` / `pkc://` の語(置換と同じ正規表現 ── `body-replace.ts`)
 * - HTML のタグとコメント・数式 `$…$`・先頭の設定行(前書き)
 * ⚠ 当たりのすぐ前が `[`、すぐ後ろが `]` の物も包まない(`[[題名](entry:…)]` は `[[` の記法と紛れる)。
 *
 * ## 題名の当て方
 * - 大小は区別しない(英字)。⚠ 包むときは**本文の字のまま**をリンクの字にする(書いた字を変えない)
 * - 英数字で始まる / 終わる題名は、前後が英数字でない所だけ(`PKC` が `PKC3` の中に当たらない)
 * - 1 字の題名・数字と記号だけの題名(日付など)は探さない(どこにでも当たり、言及とは読めない)
 *
 * ⚠ pure module。書込は worker の `linkMentions`(走査と書込を 1 tx に閉じ込める)が持つ。
 */
import { AUTOLINK, BARE_URL, REF_WORD } from '../markdown/body-replace';
import { frontmatterLineCount } from '../markdown/frontmatter';
import { formatMarkdownLink } from '../markdown/link-format';
import { indentedCodeRanges, scanLinks } from '../markdown/link-scan';
import { readMathAt } from '../markdown/math-delims';
import { scanTitleLinks } from '../markdown/title-link';

/** 探す題名の最小の字数。 */
export const MENTION_TITLE_MIN = 2;

/** 言及を探してよい題名か(字数・改行・数字と記号だけの題名を外す)。 */
export function isMentionableTitle(title: string): boolean {
  const t = title.trim();
  if ([...t].length < MENTION_TITLE_MIN) return false;
  if (/[\r\n]/.test(t)) return false;
  // 日付・番号だけの題名(`2026-11-16` / `001`)は外す
  return !/^[\d\s\p{P}\p{S}]+$/u.test(t);
}

const HTML_TAG = /<!--[\s\S]*?-->|<\/?[A-Za-z][^<>\n]*>/g;
const REF_USE = /\[[^\]\n]*\]\[[^\]\n]*\]/g;
const WORD = /[A-Za-z0-9_]/;

/** 書き換えの外に置く範囲(昇順・重ならない)。 */
function protectedRanges(body: string): Array<[number, number]> {
  const raw: Array<[number, number]> = [];
  const scan = scanLinks(body);
  for (const r of scan.code) raw.push([r[0], r[1]]);
  for (const r of indentedCodeRanges(body)) raw.push([r[0], r[1]]);
  // リンクは字も宛先も丸ごと(参照形式の定義行 `[名]: 宛先` は `scanLinks` が行の頭から拾う)
  for (const site of scan.sites) raw.push([site.labelStart >= 0 ? site.labelStart : site.start, site.end]);
  for (const t of scanTitleLinks(body)) raw.push([t.start, t.end]);
  for (const re of [AUTOLINK, REF_WORD, BARE_URL, HTML_TAG, REF_USE]) {
    re.lastIndex = 0;
    for (let m = re.exec(body); m; m = re.exec(body)) {
      raw.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) re.lastIndex += 1;
    }
  }
  // 数式(`$…$` / `$$…$$`)── 1 行ずつ、描画と同じ読み方で
  if (body.includes('$')) {
    const memo = {};
    for (let i = body.indexOf('$'); i >= 0 && i < body.length; ) {
      const nl = body.indexOf('\n', i);
      const span = readMathAt(body, i, nl < 0 ? body.length : nl, memo);
      if (span !== null) {
        raw.push([i, span.end]);
        i = body.indexOf('$', span.end);
      } else i = body.indexOf('$', i + 1);
    }
  }
  // 先頭の設定行(前書き)は丸ごと
  const fm = frontmatterLineCount(body);
  if (fm > 0) {
    let pos = 0;
    for (let n = 0; n < fm && pos <= body.length; n++) {
      const nl = body.indexOf('\n', pos);
      pos = nl < 0 ? body.length + 1 : nl + 1;
    }
    raw.push([0, Math.min(pos, body.length)]);
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

function overlaps(ranges: ReadonlyArray<[number, number]>, at: number, len: number): boolean {
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

export interface MentionHit {
  readonly at: number;
  readonly len: number;
}

/** 本文の中で、題名がただの字として出ている所(文書順)。⚠ 本文は原文(CRLF のまま)を渡す。 */
export function findUnlinkedMentions(body: string, title: string): MentionHit[] {
  const needle = title.trim();
  if (!isMentionableTitle(needle) || body === '') return [];
  const lower = body.toLowerCase();
  // ⚠ 小文字にすると長さが変わる字が在る本文は、大小を区別して当てる(添字をずらさない)
  const sameLen = lower.length === body.length;
  const hay = sameLen ? lower : body;
  const key = sameLen ? needle.toLowerCase() : needle;
  if (!hay.includes(key)) return [];
  const ranges = protectedRanges(body);
  const out: MentionHit[] = [];
  const headWord = WORD.test(needle[0]!);
  const tailWord = WORD.test(needle[needle.length - 1]!);
  for (let at = hay.indexOf(key); at >= 0; ) {
    const end = at + key.length;
    const before = body[at - 1] ?? '';
    const after = body[end] ?? '';
    const ok =
      !(headWord && WORD.test(before)) &&
      !(tailWord && WORD.test(after)) &&
      before !== '[' &&
      after !== ']' &&
      !overlaps(ranges, at, key.length);
    if (ok) {
      out.push({ at, len: key.length });
      at = hay.indexOf(key, end);
    } else at = hay.indexOf(key, at + 1);
  }
  return out;
}

/** 言及をすべて `[本文の字](entry:<lid>)` に包む。⚠ 書いた字(大小)はそのまま。 */
export function linkMentions(body: string, title: string, lid: string): { body: string; count: number } {
  const hits = findUnlinkedMentions(body, title);
  if (hits.length === 0) return { body, count: 0 };
  let out = '';
  let cursor = 0;
  for (const h of hits) {
    out += body.slice(cursor, h.at) + formatMarkdownLink(body.slice(h.at, h.at + h.len), `entry:${lid}`);
    cursor = h.at + h.len;
  }
  return { body: out + body.slice(cursor), count: hits.length };
}
