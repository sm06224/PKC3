/**
 * マニュアル(`docs/manual.md`)の書き方の検査に使う**純粋関数**。
 * 正本の規約は `docs/development/manual-style-2026-09.md`。
 *
 * ⚠ ここの関数はどれも文字列を受けて数えるだけにしてある ── 実物のマニュアルに
 *   当てるだけでは「検査が効いているか」が分からないので、
 *   `tests/manual-style.test.ts` が**自前の小さな原稿(fixture)**でも当てる。
 * ⚠ 囲み(``` / ~~~)の中は見出しでも本文でもない(コード例・書式の見本)ので全部読み飛ばす。
 */

export type MdHeading = { readonly level: number; readonly title: string; readonly line: number };

/** 行の種類。⚠ 囲みの開き・閉じの行そのものも `fence` に数える(本文でも見出しでもない)。 */
type WalkedLine = { readonly line: number; readonly text: string; readonly fence: boolean };

/**
 * 全行を、囲みの内か外かの印つきで返す。⚠ 囲みの判定はここ 1 か所。
 * - 開き: 行頭(字下げ可。リストの中の囲みを含む)の ``` か ~~~ が 3 つ以上
 * - 閉じ: **開きと同じ字で、開き以上の長さ**だけが並ぶ行(4 つの ```` の中の ``` は閉じではない)
 * - ⚠ 見出しは **ATX 形式(`# 題`)だけ**を数える(`===` の下線で書く形は使わない・数えない)
 */
function walk(text: string): WalkedLine[] {
  const out: WalkedLine[] = [];
  let open: { ch: string; len: number } | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (open === null) {
      const m = /^\s*(`{3,}|~{3,})/.exec(l);
      if (m) {
        open = { ch: m[1]![0]!, len: m[1]!.length };
        out.push({ line: i + 1, text: l, fence: true });
        continue;
      }
      out.push({ line: i + 1, text: l, fence: false });
    } else {
      out.push({ line: i + 1, text: l, fence: true });
      const c = /^\s*(`{3,}|~{3,})\s*$/.exec(l);
      if (c && c[1]![0] === open.ch && c[1]!.length >= open.len) open = null;
    }
  }
  return out;
}

/** 見出し(段, 題名, 行)を拾う。囲みの中の `#` は見出しではない。⚠ マニュアルの見出し走査はここ 1 か所。 */
export function scanHeadings(text: string): MdHeading[] {
  const out: MdHeading[] = [];
  for (const w of walk(text)) {
    if (w.fence) continue;
    const m = /^(#{1,6}) (.*)$/.exec(w.text);
    if (m) out.push({ level: m[1]!.length, title: m[2]!, line: w.line });
  }
  return out;
}

/** 囲みの外の行(行番号つき)。本文の言い回しを検査するときの入口。 */
export function proseLines(text: string): Array<{ line: number; text: string }> {
  return walk(text)
    .filter((w) => !w.fence)
    .map((w) => ({ line: w.line, text: w.text }));
}

/**
 * 画面に出る字の**逐語の引用**を落とす(日付・経緯・古い位置の検査は、ここを通した行に当てる)。
 * 落とすもの: 「…」/『…』/ インラインコード `…` / **太字の画面の字**(1 文の太字は落とさない = 「。」を含まない太字だけ)。
 * ⚠ 画面の字そのもの(例:「n 件をゴミ箱へ移しました」)は、マニュアルが書き換えてよいものではない。
 */
export function stripQuoted(line: string): string {
  return line
    .replace(/`[^`]*`/g, '')
    .replace(/「[^」]*」/g, '')
    .replace(/『[^』]*』/g, '')
    .replace(/\*\*[^*。]+\*\*/g, '');
}

/** 見出しの長さ(コードポイント数)。 */
export function headingLength(title: string): number {
  return [...title].length;
}

/** 条 3 ── 見出しの文字数の上限(最終値)。目標は 20 字以内。 */
export const HEADING_MAX_CHARS = 30;

export function longHeadings(text: string, max = HEADING_MAX_CHARS): string[] {
  return scanHeadings(text)
    .filter((h) => headingLength(h.title) > max)
    .map((h) => `${h.line}: ${h.title}`);
}

/** 条 3 ── 見出しに読点「、」を入れない(名詞か標準の操作名で言い切る)。 */
export function commaHeadings(text: string): string[] {
  return scanHeadings(text)
    .filter((h) => h.title.includes('、'))
    .map((h) => `${h.line}: ${h.title}`);
}

/** 条 3 ── 見出しの終わりに置かない言い回し(「〜を知る」「〜を確かめる」と「〜のとき」「〜たとき」型の断片)。 */
export const BANNED_HEADING_ENDINGS: RegExp = /(を知る|を確かめる|のとき|たとき)$/;

/** 末尾のかっこの補足(`(…)` / `(…)`)を除いた題名。 */
export function headingCore(title: string): string {
  return title.trim().replace(/\s*[(（][^()（）]*[)）]\s*$/, '').trim();
}

export function bannedEndingHeadings(text: string): string[] {
  return scanHeadings(text)
    .filter((h) => BANNED_HEADING_ENDINGS.test(headingCore(h.title)))
    .map((h) => `${h.line}: ${h.title}`);
}

/** 本文に日付の印を入れない。1) 括弧つき `(2026-09-08)` `(2026 年 9 月)` など */
export const DATE_STAMP: RegExp = /[(（]\s*20\d\d\s*(?:-\d{1,2}|\/\d{1,2}|年)[^)）\n]*[)）]/;

/** 2) 括弧なしの日付 + 経緯の助詞・語(`2026-08-28 に…変えました` `2026-09-04 まで` など) */
export const DATE_HISTORY: RegExp =
  /20\d\d-\d{2}-\d{2}\s*(?:に|から|より|まで|以降|以前|現在|追加|直し|足し|変え|入れ|廃止|移し|揃え)/;

/** 本文に経緯の言い回しを書かない(いまの動きだけを書く)。⚠ 「旧版 PKC の zip」は機能の名前なので語から外した。 */
export const HISTORY_WORDS: RegExp =
  /以前は|以前の|従来|旧バージョン|かつて|になりました|に変わりました|に変更されました|を廃止しました|へ移しました|を追加しました/;

/** いまの画面の位置と合わない言い方(下のバーは廃止済み。位置は「左のバー」「メッセージ」ボタンで書く)。「上のタブ」は左ペイン・スマホの正しい呼び名なので対象外。 */
export const STALE_UI_PHRASES: RegExp = /画面の下に|ステータスバー|状態バー/;

/** 「画面の下に…ありません」のような**打ち消し**は、古い位置を案内していないので落とす。 */
function dropNegatedBottom(s: string): string {
  return s.replace(/画面の下に[^。)）\n]*ありません/g, '');
}

function matchedProse(text: string, test: (stripped: string) => boolean): string[] {
  return proseLines(text)
    .filter((l) => test(stripQuoted(l.text)))
    .map((l) => `${l.line}: ${l.text.trim().slice(0, 60)}`);
}

export const dateStampLines = (text: string): string[] =>
  matchedProse(text, (s) => DATE_STAMP.test(s) || DATE_HISTORY.test(s));
export const historyWordLines = (text: string): string[] => matchedProse(text, (s) => HISTORY_WORDS.test(s));
export const staleUiLines = (text: string): string[] =>
  matchedProse(text, (s) => STALE_UI_PHRASES.test(dropNegatedBottom(s)));

export function totalLines(text: string): number {
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

export function h3Count(text: string): number {
  return scanHeadings(text).filter((h) => h.level === 3).length;
}

/** 節の取り方。`ownBodyOnly` = その見出しの**自分の本文だけ**(どの段でも、次の見出しの手前まで。小節を含まない)。 */
export type SectionOptions = { readonly ownBodyOnly?: boolean };

function rangeOfHeading(lines: string[], heads: MdHeading[], at: number, opt: SectionOptions = {}): string {
  const h = heads[at]!;
  let end = lines.length;
  for (let j = at + 1; j < heads.length; j += 1) {
    if (opt.ownBodyOnly === true || heads[j]!.level <= h.level) {
      end = heads[j]!.line - 1;
      break;
    }
  }
  return lines.slice(h.line - 1, end).join('\n');
}

/**
 * 題名で見出し(**どの段でもよい**)を探し、その節を返す。節 = その見出しの行から、
 * 同じかより浅い段の次の見出しの手前まで(下位の見出しは含む。`ownBodyOnly` なら自分の本文だけ)。
 * 探し方は「題名が一致」→「題名がキーワードで始まる」の順。**各段で当たりが 2 つ以上なら例外**
 * (どれを指すか分からないまま緑にしない)。「題名に含む」までは広げない。当たらなければ null。
 * ⚠ 見出しの**正確な字**でなく、**題名の頭**に依存する ── 段や章立てが変わっても、題名が残っていれば拾える。
 */
export function sectionByTitle(text: string, keyword: string, opt: SectionOptions = {}): string | null {
  const lines = text.split('\n');
  const heads = scanHeadings(text);
  const tiers: Array<(h: MdHeading) => boolean> = [
    (h) => h.title.trim() === keyword,
    (h) => h.title.startsWith(keyword),
  ];
  for (const pick of tiers) {
    const hits = heads.map((h, k) => (pick(h) ? k : -1)).filter((k) => k >= 0);
    if (hits.length > 1) {
      throw new Error(`見出し「${keyword}」に当たる節が ${hits.length} 個ある: ${hits.map((k) => heads[k]!.title).join(' / ')}`);
    }
    if (hits.length === 1) return rangeOfHeading(lines, heads, hits[0]!, opt);
  }
  return null;
}

/**
 * 「その字を**本文に**含む最初の行」が属する節(いちばん近い見出しの節)を返す。見出しの名前に頼らず、
 * 内容で節を探したいとき用。囲みの中の行は数えない。当たらなければ null。
 * ⚠ **字がマニュアルにちょうど 1 回だけ在る**ことは呼び側が別に見る(最初の行を取るので、2 回目以降は見ない)。
 */
export function sectionContaining(text: string, phrase: string, opt: SectionOptions = {}): string | null {
  const hit = proseLines(text).find((l) => !/^#{1,6} /.test(l.text) && l.text.includes(phrase));
  if (hit === undefined) return null;
  const lines = text.split('\n');
  const heads = scanHeadings(text);
  let at = -1;
  for (let k = 0; k < heads.length; k += 1) if (heads[k]!.line <= hit.line) at = k;
  return at < 0 ? null : rangeOfHeading(lines, heads, at, opt);
}

/** 囲みの外の本文に、その字が何回出るか(行の数でなく出現数)。 */
export function occurrences(text: string, phrase: string): number {
  return proseLines(text).reduce((n, l) => n + (l.text.split(phrase).length - 1), 0);
}

/** 「その字を含む行(見出しでなくてもよい)」を起点に、次の見出しの手前までの範囲。ラベル(`**…**`)の周りを読むとき用。 */
export function paragraphAround(text: string, phrase: string, before = 0, after = 12): string | null {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.includes(phrase));
  if (i < 0) return null;
  return lines.slice(Math.max(0, i - before), i + after + 1).join('\n');
}
