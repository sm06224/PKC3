/**
 * 🔴 **テキスト整形の組み合わせ**(#1233。user 指示 2026-10-26「全部やるのです」)。
 *
 * 貼り付けた文章を、**改行詰め・文字種そろえ・箇条書きの整理・表の変換・正規表現の置換**の
 * 組み合わせで一度に整える。画面は「テキスト整形」の別ウィンドウ(`render/textlab.ts`)。
 *
 * ## 本文の上で字を選んで整える 5 つ(`text-tidy.ts`)との関係
 *
 * 🟣 Gemini 裁定 A で、選んだ字を整える 5 つ(改行を詰める / 全角を半角に / 半角カナを全角に /
 * 空行を減らす / 箇条書きの記号を外す)は本文の「操作を探す」に入った。この file は
 * **その 5 つの純関数を 1 本も書き直さずに呼ぶ**(§7 同じ問いに答える口を増やさない)。
 * ここで足したのは、本文の上では出来なかった残り ──
 * **複数の整えを重ねる・結果を見比べる・表を行き来する・正規表現で置換する**。
 *
 * ## E 束 #251(貼り付け変換)と処理関数を共有する
 *
 * 貼り付けの変換も「文字列 → 文字列」の純関数で足りるので、DOM を持たないこの層に置く。
 * 表の読み書きは `csv-table.ts` / `table-copy.ts` / `table-convert.ts` の既存の 1 本を呼ぶ。
 *
 * ## 決めたこと
 *
 * - **入力は触らない**。結果は別に出す(`runTextLab` は入力を書き換えない・副作用が無い)。
 * - **重ねる順は固定**: 改行詰め → 全角を半角 → 半角カナを全角 → 箇条書きの記号 → 番号の振り直し
 *   → 空行 → 表 → 置換。⚠ 順をユーザーに選ばせない(結果が選んだ順で変わると、同じ組み合わせが
 *   同じ結果にならない)。置換を最後に置くのは、他の整えが済んだ字に当てたいため。
 * - **「改行を詰める」は段落ごと**(空行は段落の境目として残す)。本文の上の操作は選んだ範囲全体を
 *   1 行にするが、貼り付けた文章全体を 1 行にすると段落が消えるので、ここでは段落ごとに結ぶ。
 * - **表は 4 択**(なし / Markdown の表にする / 表を CSV にする / 表を TSV にする)。重ねない。
 * - **置換は JavaScript の正規表現**。`$1` `$&` が使える。オプションは g i m s のみ。空の検索パターンは
 *   「置換しない」。読めない正規表現は結果を出さずに理由を言う(入力をそのまま返す)。
 * - **置換の上限**: 100 万字を超える入力には置換を掛けない(固まらないため)。理由を言う。
 */
import {
  joinLines,
  kanaToFullwidth,
  squeezeBlankLines,
  stripBullets,
  toHalfwidth,
} from './text-tidy';
import { renumberLists } from './list-renumber';
import { parseCsv } from './csv-table';
import { tableToCsv, tableToMarkdown, tableToTsv } from './table-copy';
import { mdCellGate, mdTableAtGate } from './table-convert';
import { pickCsvDelimiter } from './text-ops';

/** 重ねられる整え。⚠ 並びがそのまま適用順(`LAB_OPS` を `runTextLab` が前から掛ける)。 */
export type LabOp =
  | 'join-lines'
  | 'to-halfwidth'
  | 'kana-to-fullwidth'
  | 'strip-bullets'
  | 'renumber-lists'
  | 'squeeze-blank-lines';

/** 画面に並べる字と、載せたときの説明。⚠ 字はここ 1 か所(画面は並べるだけ)。 */
export const LAB_OPS: readonly { readonly id: LabOp; readonly label: string; readonly hint: string }[] = [
  { id: 'join-lines', label: '改行を詰める', hint: '段落(空行で区切られた、ひとまとまり)の途中の改行を結びます。空行は残します' },
  { id: 'to-halfwidth', label: '全角を半角にそろえる', hint: '全角の英数字・記号・空白を半角にします。カナと漢字は変えません' },
  { id: 'kana-to-fullwidth', label: '半角カナを全角にそろえる', hint: '半角カナを全角にします(濁点・半濁点も結びます)' },
  { id: 'strip-bullets', label: '箇条書きの記号を外す', hint: '行頭の - * + を外します。チェック項目と区切り線は変えません' },
  { id: 'renumber-lists', label: '番号を振り直す', hint: '番号付きの箇条書きを 1 から順に振り直します' },
  { id: 'squeeze-blank-lines', label: '空行を減らす', hint: '続く空行を 1 つにまとめます' },
];

/** 表の変換。⚠ 4 択(重ねない)。 */
export type LabTableMode = 'none' | 'to-markdown' | 'to-csv' | 'to-tsv';

export const LAB_TABLE_MODES: readonly {
  readonly id: LabTableMode;
  readonly label: string;
  readonly hint: string;
}[] = [
  { id: 'none', label: '表は変えない', hint: '表の変換をしません' },
  {
    id: 'to-markdown',
    label: '表にする',
    hint: 'カンマ区切り・タブ区切りの行を Markdown の表にします(1 行目が見出しになります)',
  },
  { id: 'to-csv', label: '表を CSV にする', hint: 'Markdown の表を CSV(カンマ区切り)の行にします' },
  { id: 'to-tsv', label: '表を TSV にする', hint: 'Markdown の表を TSV(タブ区切り)の行にします' },
];

import { applyLabRegex, type LabRegex } from './lab-regex';
export { applyLabRegex, badRegexFlags, expandLabReplacement, LAB_REGEX_FLAGS, LAB_REGEX_MAX_CHARS } from './lab-regex';
export type { LabRegex, LabRegexResult } from './lab-regex';

export interface LabRecipe {
  readonly ops: ReadonlySet<LabOp> | readonly LabOp[];
  readonly table: LabTableMode;
  readonly regex: LabRegex | null;
}

export interface LabOutput {
  /** 整えた結果。置換が読めなかったときは、置換の手前までの結果。 */
  readonly text: string;
  /** 置換を掛けなかった理由(読めない正規表現・大きすぎる入力)。無ければ `null`。 */
  readonly regexNote: string | null;
  /** 置換で当たった数(オプションに g が無ければ最大 1)。置換していなければ 0。 */
  readonly regexHits: number;
  /** 表の変換を頼まれたが、変換できる表が見つからなかった(結果は表の手前のまま)。 */
  readonly tableFound: boolean;
}

const BLANK = /^[ \t\u3000\r]*$/;

/** 段落ごとに改行を結ぶ。空行(空白だけの行も)は段落の境目としてそのまま残す。 */
export function joinParagraphLines(text: string): string {
  const out: string[] = [];
  let group: string[] = [];
  const flush = (): void => {
    if (group.length === 0) return;
    out.push(joinLines(group.join('\n')));
    group = [];
  };
  for (const line of text.split('\n')) {
    if (BLANK.test(line)) {
      flush();
      out.push(line);
    } else {
      group.push(line);
    }
  }
  flush();
  return out.join('\n');
}

/** CSV / TSV の行を Markdown の表にする。表にできなければ `null`(空・読めない)。 */
export function textToMarkdownTable(text: string): string | null {
  if (text.trim() === '') return null;
  const rows = parseCsv(text, pickCsvDelimiter(text));
  if (rows === null) return null;
  return tableToMarkdown(rows.map((cells, i) => ({ cells, head: i === 0 })));
}

/**
 * Markdown の表(全部)を CSV / TSV の行にする。表が 1 つも見つからなければ `null`。
 * ⚠ 表と表の間の字はそのまま残す。表のブロックだけを置き換える。
 */
export function markdownTablesToText(text: string, to: 'csv' | 'tsv'): string | null {
  const lines = text.split('\n');
  const out: string[] = [];
  const gate = mdCellGate(lines);
  let found = false;
  let i = 0;
  while (i < lines.length) {
    const at = lines[i]!.includes('|') ? mdTableAtGate(gate, i) : null;
    // ⚠ 引用の中の表などは `quoteLead` を持つ。ここは平文の整形なので、前置きを付け直して残す
    if (at !== null && at.start === i) {
      found = true;
      const body = to === 'csv' ? tableToCsv(at.rows) : tableToTsv(at.rows);
      for (const l of body.split('\n')) out.push(at.quoteLead + l);
      i = at.end + 1;
      continue;
    }
    out.push(lines[i]!);
    i += 1;
  }
  return found ? out.join('\n') : null;
}

/** 整えの手前まで(正規表現の置換を除く)。⚠ 同期で終わる軽い段。 */
export function runTextLabPre(
  input: string,
  recipe: LabRecipe,
): { text: string; tableFound: boolean } {
  const ops = new Set<LabOp>(recipe.ops);
  let text = input.replace(/\r\n?/g, '\n');
  if (ops.has('join-lines')) text = joinParagraphLines(text);
  if (ops.has('to-halfwidth')) text = toHalfwidth(text);
  if (ops.has('kana-to-fullwidth')) text = kanaToFullwidth(text);
  if (ops.has('strip-bullets')) text = stripBullets(text);
  if (ops.has('renumber-lists')) text = renumberLists(text);
  if (ops.has('squeeze-blank-lines')) text = squeezeBlankLines(text);
  let tableFound = true;
  if (recipe.table === 'to-markdown') {
    const md = textToMarkdownTable(text);
    if (md === null) tableFound = false;
    else text = md;
  } else if (recipe.table === 'to-csv' || recipe.table === 'to-tsv') {
    const converted = markdownTablesToText(text, recipe.table === 'to-csv' ? 'csv' : 'tsv');
    if (converted === null) tableFound = false;
    else text = converted;
  }
  return { text, tableFound };
}

/** 整えを重ねる(置換まで)。⚠ 入力を書き換えず、副作用も無い。画面は `runTextLabPre` + ワーカーの置換で組む。 */
export function runTextLab(input: string, recipe: LabRecipe): LabOutput {
  const pre = runTextLabPre(input, recipe);
  if (recipe.regex === null) return { text: pre.text, regexNote: null, regexHits: 0, tableFound: pre.tableFound };
  const r = applyLabRegex(pre.text, recipe.regex);
  return { text: r.text, regexNote: r.note, regexHits: r.hits, tableFound: pre.tableFound };
}

/** 結果の上の 1 行(何が起きたか)。⚠ 画面の字はここ 1 か所。 */
export function labSummary(input: string, out: LabOutput, recipe: LabRecipe): string {
  if (input === '') return '左に文章を貼ると、右に整えた結果が出ます';
  const parts: string[] = [];
  if (!out.tableFound) {
    parts.push(
      recipe.table === 'to-markdown'
        ? '表にできる行が見つかりません'
        : 'Markdown の表が見つかりません',
    );
  }
  if (out.regexNote !== null) parts.push(out.regexNote);
  else if (recipe.regex !== null && recipe.regex.pattern !== '') {
    parts.push(out.regexHits === 0 ? '置換: 一致はありませんでした' : `置換: ${out.regexHits} か所`);
  }
  if (parts.length === 0) {
    if (out.text === input) parts.push('変わる所はありません');
    // 🔴 改行コードだけが違うとき(CRLF → LF)は「変わらない」と言わない ── コピーすると中身は変わっている
    else if (out.text === input.replace(/\r\n?/g, '\n')) parts.push('改行コードを LF にそろえました');
    else parts.push(`${input.length} 字 → ${out.text.length} 字`);
  }
  return parts.join(' / ');
}

/** 新しいノートの題名。結果の最初の空でない行(40 字まで)。無ければ日時入り。 */
export function labNoteTitle(text: string, now: Date): string {
  const first = text.split('\n').find((l) => l.trim() !== '');
  if (first !== undefined) {
    const t = first.replace(/^[#>\-*+\s|]+/, '').trim();
    if (t !== '') return t.length > 40 ? `${t.slice(0, 40)}…` : t;
  }
  const p = (n: number): string => String(n).padStart(2, '0');
  return `整形したテキスト ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
}
