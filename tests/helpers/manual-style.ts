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

/** 見出し(段, 題名, 行)を拾う。囲みの中の `#` は見出しではない。⚠ マニュアルの見出し走査はここ 1 か所。 */
export function scanHeadings(text: string): MdHeading[] {
  const out: MdHeading[] = [];
  let fence = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = /^(#{1,6}) (.*)$/.exec(line);
    if (m) out.push({ level: m[1]!.length, title: m[2]!, line: i + 1 });
  }
  return out;
}

/** 囲みの外の行(行番号つき)。本文の言い回しを検査するときの入口。 */
export function proseLines(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let fence = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (/^\s*(```|~~~)/.test(l)) {
      fence = !fence;
      continue;
    }
    if (!fence) out.push({ line: i + 1, text: l });
  }
  return out;
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

/** 条 3 ── 見出しの終わりに置かない言い回し(「〜を知る」「〜を確かめる」と「〜のとき」型の断片)。 */
export const BANNED_HEADING_ENDINGS: RegExp = /(を知る|を確かめる|のとき)$/;

export function bannedEndingHeadings(text: string): string[] {
  return scanHeadings(text)
    .filter((h) => BANNED_HEADING_ENDINGS.test(h.title.trim()))
    .map((h) => `${h.line}: ${h.title}`);
}

/** 本文に日付の印を入れない(更新の履歴はお知らせ / CHANGELOG に在る)。`(2026-09-08)` `(2026-09-08 〜)` `(2026 年 9 月)` 等。 */
export const DATE_STAMP: RegExp =
  /[(（]\s*20\d\d\s*(?:-\d{1,2}|\/\d{1,2}|年)[^)）\n]*[)）]/;

/** 本文に経緯の言い回しを書かない(いまの動きだけを書く)。 */
export const HISTORY_WORDS: RegExp =
  /以前は|以前の|従来|旧版|旧バージョン|かつて|になりました|に変わりました|に変更されました|を廃止しました|へ移しました|を追加しました/;

/** いまの画面の位置と合わない言い方(下のバーは廃止済み。位置は「左のバー」「メッセージ」ボタンで書く)。 */
export const STALE_UI_PHRASES: RegExp = /画面の下に|ステータスバー|状態バー|上のタブ/;

function matchedProse(text: string, re: RegExp): string[] {
  return proseLines(text)
    .filter((l) => re.test(l.text))
    .map((l) => `${l.line}: ${l.text.trim().slice(0, 60)}`);
}

export const dateStampLines = (text: string): string[] => matchedProse(text, DATE_STAMP);
export const historyWordLines = (text: string): string[] => matchedProse(text, HISTORY_WORDS);
export const staleUiLines = (text: string): string[] => matchedProse(text, STALE_UI_PHRASES);

export function totalLines(text: string): number {
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

export function h3Count(text: string): number {
  return scanHeadings(text).filter((h) => h.level === 3).length;
}

function rangeOfHeading(lines: string[], heads: MdHeading[], at: number): string {
  const h = heads[at]!;
  let end = lines.length;
  for (let j = at + 1; j < heads.length; j += 1) {
    if (heads[j]!.level <= h.level) {
      end = heads[j]!.line - 1;
      break;
    }
  }
  return lines.slice(h.line - 1, end).join('\n');
}

/**
 * 題名にキーワードを含む見出し(**どの段でもよい**)の節を返す。節 = その見出しの行から、
 * 同じかより浅い段の次の見出しの手前まで(下位の見出しは含む)。
 * 候補が複数あるときは「題名が一致 > 題名がキーワードで始まる > 題名に含む」の順で、先に出てくるものを取る。
 * ⚠ 見出しの**正確な字**に依存しない ── 章立てを組み替えて段や周りの語が変わっても、
 *   キーワードが題名に残っていれば同じ節を拾える。当たらなければ null(呼び側が空振りを検知する)。
 */
export function sectionByTitle(text: string, keyword: string): string | null {
  const lines = text.split('\n');
  const heads = scanHeadings(text);
  let at = heads.findIndex((h) => h.title.trim() === keyword);
  if (at < 0) at = heads.findIndex((h) => h.title.startsWith(keyword));
  if (at < 0) at = heads.findIndex((h) => h.title.includes(keyword));
  return at < 0 ? null : rangeOfHeading(lines, heads, at);
}

/**
 * 題名が `re` に当たる見出しの節を**全部つないで**返す(別の節の中に入っているものは重ねない)。
 * 1 つの話題が複数の節に分かれているとき(「窓」の説明が 3 節に割れている等)に、分け方に依らず 1 組として読む。
 * 当たらなければ null。
 */
export function sectionsByTitle(text: string, re: RegExp): string | null {
  const lines = text.split('\n');
  const heads = scanHeadings(text);
  const parts: string[] = [];
  let coveredUntil = 0;
  for (let k = 0; k < heads.length; k += 1) {
    const h = heads[k]!;
    if (!re.test(h.title) || h.line <= coveredUntil) continue;
    parts.push(rangeOfHeading(lines, heads, k));
    let end = lines.length;
    for (let j = k + 1; j < heads.length; j += 1) {
      if (heads[j]!.level <= h.level) {
        end = heads[j]!.line - 1;
        break;
      }
    }
    coveredUntil = end;
  }
  return parts.length === 0 ? null : parts.join('\n');
}

/**
 * 「その字を**本文に**含む最初の行」が属する節(いちばん近い見出しの節)を返す。見出しの名前に頼らず、
 * 内容で節を探したいとき用。囲みの中の行は数えない。当たらなければ null。
 */
export function sectionContaining(text: string, phrase: string): string | null {
  const hit = proseLines(text).find((l) => !/^#{1,6} /.test(l.text) && l.text.includes(phrase));
  if (hit === undefined) return null;
  const lines = text.split('\n');
  const heads = scanHeadings(text);
  let at = -1;
  for (let k = 0; k < heads.length; k += 1) if (heads[k]!.line <= hit.line) at = k;
  return at < 0 ? null : rangeOfHeading(lines, heads, at);
}

/** 「その字を含む行(見出しでなくてもよい)」を起点に、次の見出しの手前までの範囲。ラベル(`**…**`)の周りを読むとき用。 */
export function paragraphAround(text: string, phrase: string, before = 0, after = 12): string | null {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.includes(phrase));
  if (i < 0) return null;
  return lines.slice(Math.max(0, i - before), i + after + 1).join('\n');
}
