/**
 * 🔴 **選んだ字を整える 5 つ**(#1233。Gemini 裁定 A ── 別アプリは作らず、本文で字を選んで
 * 「操作を探す」から呼ぶ)。
 *
 * ## user がやりたいこと
 *
 * 貼り付けた文章の**折り返しの改行**を詰めたい / 全角で打った英数字を半角へそろえたい /
 * 半角カナを全角へそろえたい / 空行が続くのを 1 つにしたい / 箇条書きの記号をまとめて外したい。
 * 別の窓は出さず、**選んだ範囲だけ**が変わり、`Ctrl+Z` で戻る。
 *
 * ## 決めたこと
 *
 * - **選んでいなければ何もしない**(`no-selection`)── 本文全体へ勝手に効かせない。
 * - **すでに整っていれば 1 byte も変えない**(`unchanged`)── 書き込みを起こさない
 *   (取り消しの履歴に「何も変わらない 1 手」を積まない)。
 * - **字の操作 2 つ**(全角→半角 / 半角カナ→全角)は**選んだ範囲そのもの**だけを変える。
 *   **行の操作 3 つ**(改行を詰める / 空行を減らす / 箇条書きの記号を外す)は
 *   **触れた行を行頭から行末まで**使う(行の途中から選んでも、行の半分だけ詰めない)。
 *   下の行の頭まで選んだとき、その行は巻き込まない(`line-swap.ts` と同じ)。
 * - 戻りの選択は**書き換えた範囲の全体**(続けて別の整えを押せる)。
 *
 * ⚠ 全角→半角に **NFKC は使わない** ── ㈱ や ① まで変わり、カナの濁点も合成される。
 *   自前の対応表(下)を 1 か所に持つ。
 * ⚠ 正規表現による置換は**別件**(ここには入れない)。
 *
 * 🔑 **pure module**。DOM も textarea も知らない ── 書き込みは呼び側が `insertText`
 * (取り消しの履歴を切らない)で `from`〜`to` を `insert` へ置き換える(`line-swap.ts` と同じ作法)。
 */
import { lineStart } from './line-start';
import { THEMATIC_BREAK } from './list-renumber';
import type { TextSelection } from './text-ops';

/** 整える 5 つ。⚠ `keymap.ts` の命令 id と 1:1(`TIDY_COMMANDS`)。 */
export type TidyOp =
  | 'join-lines'
  | 'to-halfwidth'
  | 'kana-to-fullwidth'
  | 'squeeze-blank-lines'
  | 'strip-bullets';

/** 結果。⚠ `TextSelection`(新しい本文と選択)に、置き換える範囲を足したもの。 */
export interface TidyEdit extends TextSelection {
  /** 古い本文の中で置き換える範囲。 */
  readonly from: number;
  readonly to: number;
  /** その範囲へ入れる字。 */
  readonly insert: string;
}

export type TidyResult =
  | { readonly kind: 'edit'; readonly edit: TidyEdit }
  | { readonly kind: 'none'; readonly reason: 'no-selection' | 'unchanged' };

/** 何も変わらなかった理由を、画面の下の 1 行で言う字。 */
export const TIDY_NOTES: Readonly<Record<'no-selection' | 'unchanged', string>> = {
  'no-selection': '整えたい範囲を選んでから実行してください',
  unchanged: '整える所がありません',
};

// ── 全角 → 半角 ─────────────────────────────────────────────────────

/**
 * 全角の記号(半角へそろえるもの)。全角英数 `０-９Ａ-Ｚａ-ｚ` は範囲で持つ。
 * ⚠ 書くのは**この 29 字だけ** ── `＂ ＄ ＇ ＼` は含めない(引用符・`$`・`\` は
 *   本文の記法の字なので、勝手に半角にしない。#1233 の指定の一覧に無い)。
 * ⚠ 全角ではない字(カナ・漢字・`ー`・`〜`)は 1 つも入れない。
 */
const FULLWIDTH_SYMBOLS =
  '\uFF01\uFF03\uFF05\uFF06\uFF08\uFF09\uFF0A\uFF0B\uFF0C\uFF0D\uFF0E\uFF0F' +
  '\uFF1A\uFF1B\uFF1C\uFF1D\uFF1E\uFF1F\uFF20\uFF3B\uFF3D\uFF3E\uFF3F\uFF40' +
  '\uFF5B\uFF5C\uFF5D\uFF5E';

/** 全角 → 半角のずれ(`Ａ` U+FF21 → `A` U+0041 など、この範囲は一定)。 */
const FULLWIDTH_OFFSET = 0xfee0;

function isFullwidthAlnum(c: number): boolean {
  return (
    (c >= 0xff10 && c <= 0xff19) || (c >= 0xff21 && c <= 0xff3a) || (c >= 0xff41 && c <= 0xff5a)
  );
}

/** 全角の英数字と記号と空白を半角へ。それ以外の字は 1 つも変えない。 */
export function toHalfwidth(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (isFullwidthAlnum(c) || FULLWIDTH_SYMBOLS.includes(ch)) {
      out += String.fromCharCode(c - FULLWIDTH_OFFSET);
    } else if (c === 0x3000) {
      out += ' ';
    } else {
      out += ch;
    }
  }
  return out;
}

// ── 半角カナ → 全角 ─────────────────────────────────────────────────

/**
 * 半角カナ(U+FF61〜U+FF9D)→ 全角。⚠ **対応表はこの 1 か所**。
 * 並びは Unicode の半角カナの区画の順(`｡｢｣､･ｦｧ…ｯｰｱ…ﾝ`)。
 */
const KANA_FROM =
  '\uFF61\uFF62\uFF63\uFF64\uFF65\uFF66\uFF67\uFF68\uFF69\uFF6A\uFF6B\uFF6C\uFF6D\uFF6E\uFF6F\uFF70' +
  '\uFF71\uFF72\uFF73\uFF74\uFF75\uFF76\uFF77\uFF78\uFF79\uFF7A\uFF7B\uFF7C\uFF7D\uFF7E\uFF7F' +
  '\uFF80\uFF81\uFF82\uFF83\uFF84\uFF85\uFF86\uFF87\uFF88\uFF89\uFF8A\uFF8B\uFF8C\uFF8D\uFF8E\uFF8F' +
  '\uFF90\uFF91\uFF92\uFF93\uFF94\uFF95\uFF96\uFF97\uFF98\uFF99\uFF9A\uFF9B\uFF9C\uFF9D';
const KANA_TO =
  '\u3002\u300C\u300D\u3001\u30FB\u30F2\u30A1\u30A3\u30A5\u30A7\u30A9\u30E3\u30E5\u30E7\u30C3\u30FC' +
  '\u30A2\u30A4\u30A6\u30A8\u30AA\u30AB\u30AD\u30AF\u30B1\u30B3\u30B5\u30B7\u30B9\u30BB\u30BD' +
  '\u30BF\u30C1\u30C4\u30C6\u30C8\u30CA\u30CB\u30CC\u30CD\u30CE\u30CF\u30D2\u30D5\u30D8\u30DB\u30DE' +
  '\u30DF\u30E0\u30E1\u30E2\u30E4\u30E6\u30E8\u30E9\u30EA\u30EB\u30EC\u30ED\u30EF\u30F3';

const HALF_VOICED = '\uFF9E';
const HALF_SEMI = '\uFF9F';

/**
 * 濁点 `ﾞ` / 半濁点 `ﾟ` が付いたときの 1 字(基の字 → 結合後)。
 * ⚠ 付けられない字(`ｱﾞ` など)はここに無い ── 基の字と濁点を別々に全角にする。
 */
const KANA_VOICED: Readonly<Record<string, string>> = {
  '\uFF73': '\u30F4', // ｳ → ヴ
  '\uFF76': '\u30AC', '\uFF77': '\u30AE', '\uFF78': '\u30B0', '\uFF79': '\u30B2', '\uFF7A': '\u30B4',
  '\uFF7B': '\u30B6', '\uFF7C': '\u30B8', '\uFF7D': '\u30BA', '\uFF7E': '\u30BC', '\uFF7F': '\u30BE',
  '\uFF80': '\u30C0', '\uFF81': '\u30C2', '\uFF82': '\u30C5', '\uFF83': '\u30C7', '\uFF84': '\u30C9',
  '\uFF8A': '\u30D0', '\uFF8B': '\u30D3', '\uFF8C': '\u30D6', '\uFF8D': '\u30D9', '\uFF8E': '\u30DC',
};
const KANA_SEMI: Readonly<Record<string, string>> = {
  '\uFF8A': '\u30D1', '\uFF8B': '\u30D4', '\uFF8C': '\u30D7', '\uFF8D': '\u30DA', '\uFF8E': '\u30DD',
};

const KANA_BASE: ReadonlyMap<string, string> = new Map(
  [...KANA_FROM].map((c, i) => [c, KANA_TO[i]!] as const),
);

/**
 * 半角カナを全角へ。濁点・半濁点は**前の字と結合**する(`ｶﾞ` → `ガ`)。
 * 結合できない濁点(行頭の `ﾞ` / `ｱﾞ`)は全角の濁点 `゛` `゜` にして残す(字を落とさない)。
 */
export function kanaToFullwidth(s: string): string {
  let out = '';
  const chars = [...s];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const base = KANA_BASE.get(ch);
    if (base !== undefined) {
      const next = chars[i + 1];
      const voiced = next === HALF_VOICED ? KANA_VOICED[ch] : undefined;
      const semi = next === HALF_SEMI ? KANA_SEMI[ch] : undefined;
      if (voiced !== undefined || semi !== undefined) {
        out += (voiced ?? semi)!;
        i++;
      } else {
        out += base;
      }
    } else if (ch === HALF_VOICED) {
      out += '\u309B';
    } else if (ch === HALF_SEMI) {
      out += '\u309C';
    } else {
      out += ch;
    }
  }
  return out;
}

// ── 行の操作 ──────────────────────────────────────────────────────────

/** 行末(と、つなぐ側の行頭)で落とす空白。半角の空白・tab・全角の空白・`\r`。 */
const EDGE_BLANK = /^[ \t\u3000\r]+|[ \t\u3000\r]+$/g;

/** 日本語の側か(かな・漢字・全角の形・半角カナ)。 */
const WIDE = /[\u3000-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

/**
 * 行を 1 行へ結ぶ。つなぎ目は **日本語が一方でも在れば空白なし**、
 * **どちらも英数字・半角の記号なら半角空白 1 つ**(`hello,` + `world` を `hello,world` にしない)。
 * 空の行は捨てる(1 行になる)。行末の空白は落とす。⚠ **先頭の行の字下げは残す**。
 * 改行が 1 つも無い(結ぶ相手が無い)ときは**何も変えない**。
 */
export function joinLines(block: string): string {
  const lines = block.split('\n');
  if (lines.length < 2) return block;
  let out = '';
  let first = true;
  for (const raw of lines) {
    const piece = first ? raw.replace(/[ \t\u3000\r]+$/, '') : raw.replace(EDGE_BLANK, '');
    if (piece === '') continue;
    if (first) {
      out = piece;
      first = false;
      continue;
    }
    const space = !WIDE.test(out[out.length - 1]!) && !WIDE.test(piece[0]!);
    out += (space ? ' ' : '') + piece;
  }
  return out;
}

const BLANK_LINE = /^[ \t\u3000\r]*$/;

/** 連続する空行(空白だけの行を含む)を 1 つにする。⚠ 残すのは**最初の 1 行そのまま**。 */
export function squeezeBlankLines(block: string): string {
  const out: string[] = [];
  let prevBlank = false;
  for (const line of block.split('\n')) {
    const blank = BLANK_LINE.test(line);
    if (blank && prevBlank) continue;
    out.push(line);
    prevBlank = blank;
  }
  return out.join('\n');
}

/** 箇条書きの記号(`-` `*` `+` と空白)。チェック項目(`- [ ] `)と区切り線(`---` `* * *`)は対象外。 */
const BULLET = /^[ \t]*[-*+][ \t]+(?!\[[ xX]\][ \t])/;

/**
 * 箇条書きの記号を**全部の行から**外す(一部の行にだけ付いていても外す側)。
 * 記号の手前の字下げも外す(字下げだけ残すと 4 つ以上で**コード**として読まれる)。
 */
export function stripBullets(block: string): string {
  return block
    .split('\n')
    .map((line) => (THEMATIC_BREAK.test(line) ? line : line.replace(BULLET, '')))
    .join('\n');
}

/** 選択が触れている行の範囲(行頭〜行末)。下の行の頭まで選んだときは、その行を巻き込まない。 */
function touchedLines(sel: TextSelection): { from: number; to: number } {
  const { text, start, end } = sel;
  const last = text[end - 1] === '\n' ? end - 1 : end;
  const nl = text.indexOf('\n', last);
  return { from: lineStart(text, start), to: nl === -1 ? text.length : nl };
}

const LINE_OPS: Readonly<Record<string, (block: string) => string>> = {
  'join-lines': joinLines,
  'squeeze-blank-lines': squeezeBlankLines,
  'strip-bullets': stripBullets,
};

const CHAR_OPS: Readonly<Record<string, (s: string) => string>> = {
  'to-halfwidth': toHalfwidth,
  'kana-to-fullwidth': kanaToFullwidth,
};

/**
 * 選んだ範囲を整える。⚠ **規則はここ 1 か所**(`binder.ts` は結果を挿すだけ)。
 */
export function tidySelection(sel: TextSelection, op: TidyOp): TidyResult {
  if (sel.start >= sel.end) return { kind: 'none', reason: 'no-selection' };
  const lineOp = LINE_OPS[op];
  const { from, to } = lineOp !== undefined ? touchedLines(sel) : { from: sel.start, to: sel.end };
  const before = sel.text.slice(from, to);
  const insert = (lineOp ?? CHAR_OPS[op]!)(before);
  if (insert === before) return { kind: 'none', reason: 'unchanged' };
  return {
    kind: 'edit',
    edit: {
      text: sel.text.slice(0, from) + insert + sel.text.slice(to),
      start: from,
      end: from + insert.length,
      from,
      to,
      insert,
    },
  };
}
