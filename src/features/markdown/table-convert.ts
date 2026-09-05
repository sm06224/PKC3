/**
 * 🔴 **表の形を変える**(#708 段②)── markdown の表 ⇄ csv の囲み。
 *
 * > user の物語(#708): 表を書いたあとで「これは升を押して打ちたい」と思っても、
 * > markdown の `| a | b |` を csv の囲みに書き直す道が無い。逆に、csv の表を
 * > 他所へ持っていくために markdown へ落としたいこともある。
 *
 * ## 🔑 決めたこと
 *
 * - 🔴 **書き換えるのはその表の行範囲だけ**(`csv-shape` と同じ作法)── 本文の他の
 *   行は 1 バイトも動かさない。範囲は**原文から引く**(描画が焼いた
 *   `data-pkc-source-end` を信じない ── disk の本文は別の窓が動かしうる)。
 * - 🔴 **式が在る csv は markdown にしない**(user 裁定 2026-09-04)── markdown の
 *   表に式の概念は無いので、`=B2*C2` は**字になって計算が止まる**。断って理由を出す。
 * - 🔴 **逆向きも黙って壊さない** ── markdown の升に `=B2*C2` と**字として**書いて
 *   いた人がいる。csv にした瞬間それは式になるので、`'` を付けて逃がす
 *   (`csv-formula.ts` の `csvLiteralCell`。画面に出る字は変わらない)。
 * - ⚠ **升の並びを字にするのは `table-copy.ts` の 1 本**(#708 段①)── 持ち出す形と
 *   同じ規則で組む。ここに 2 本目の組み立てを書かない(§7)。
 *
 * ## ⚠ 読み方は「実物の読み手」に合わせてある
 *
 * markdown の表の範囲・升の割り方は **markdown-it の table rule と同じ規則**で書いた
 * (見出しに `|` が要る / 区切りの列数が見出しと一致する / 空行と別の塊で終わる /
 * `\|` の逃がし)。⚠ 書き写しである以上ずれうるので、
 * `tests/features/table-convert.test.ts` が**実際に描いた表**(`renderMarkdown`)と
 * 行範囲・升を突き合わせて守る ── 実装と同じ綴りで期待値を書かない(CLAUDE.md §1)。
 *
 * 🔑 **pure module**。browser API を使わない。
 */
import { csvLiteralCell, displayCell, isFormula } from './csv-formula';
import { DELIMITER, isHeaderDisabled, parseCsv } from './csv-table';
import { frontmatterLineCount } from './frontmatter';
import { parseRenderableFence } from './markdown-render';
import { fenceInfo, scanContainers } from './source-blocks';
import { tableToCsv, tableToMarkdown, type TableCopyRow } from './table-copy';

/** 表の形。⚠ 画面の字(「Markdown の表にする」)は `entry-actions.ts` が持つ。 */
export type TableFormat = 'markdown' | 'csv';

/** 原文の中の 1 つの表。⚠ `rows` は**原文のままの升**(式も `'` も剥がさない)。 */
export interface TableAt {
  /** いまの形。 */
  readonly format: TableFormat;
  /** 原文の行範囲(0 始まり・両端含む)。csv は**囲みの柵ごと**。 */
  readonly start: number;
  readonly end: number;
  readonly rows: readonly TableCopyRow[];
}

/**
 * 区切りの行の 1 列(`---` / `:---` / `---:` / `:---:`)。
 * ⚠ markdown-it は「`-` が 1 個以上、前後に `:` が付いてよい」だけを見る。
 */
const ALIGN_CELL = /^:?-+:?$/;

/**
 * 表の続きを打ち切る行(markdown-it の terminatorRules に相当)。
 * ⚠ 空行・見出し・引用・箇条書き・柵・`:::`・水平線で表は終わる ── ここを緩めると
 *   **表の下の段落まで巻き込んで書き換える**。
 */
const TABLE_BREAK =
  /^ {0,3}(?:$|#{1,6}(?:\s|$)|>|(?:[-*+]|\d+[.)])\s|`{3,}|~{3,}|:::|(?:\*\s*){3,}$|(?:-\s*){3,}$|(?:_\s*){3,}$)/;

/** その行で表が終わるか(空行も含む)。 */
function breaksTable(line: string): boolean {
  return line.trim() === '' || TABLE_BREAK.test(line);
}

/**
 * 1 行を升へ割る。
 *
 * ⚠ **markdown-it の `escapedSplit` と同じ規則**にしてある ── `\|` は升の中の `|` で
 *   あって区切りではない。ここが読み手とずれると、**升が 1 つずれた表**を書き戻す
 *   (いちばん静かなデータ破壊)。一致は parity 検査が守る。
 * ⚠ 前後の `|` は飾り(GFM では省ける)なので、空の端は落とす。
 */
function splitRow(line: string): string[] {
  const src = line.trim();
  const out: string[] = [];
  let cur = '';
  let last = 0;
  let escaped = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '|') {
      if (escaped) {
        // ⚠ 直前の `\` を落として `|` を升の字として残す
        cur += src.slice(last, i - 1);
        last = i;
      } else {
        out.push(cur + src.slice(last, i));
        cur = '';
        last = i + 1;
      }
    }
    escaped = ch === '\\';
  }
  out.push(cur + src.slice(last));
  if (out.length > 0 && out[0] === '') out.shift();
  if (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.map((c) => c.trim());
}

/** 区切りの行なら列数、そうでなければ `null`。 */
function alignCount(line: string): number | null {
  const t = line.trim();
  if (t === '' || !/^[|\-: ]+$/.test(t) || !t.includes('-')) return null;
  const cells = splitRow(line);
  if (cells.length === 0) return null;
  return cells.every((c) => ALIGN_CELL.test(c)) ? cells.length : null;
}

/**
 * `s` 行目から始まる markdown の表。表でなければ `null`。
 *
 * ⚠ 門は markdown-it と同じ 3 つ:①見出しの行に `|` が在る ②次の行が区切りの行
 *   ③区切りの列数が見出しの列数と一致する。1 つでも外れれば表ではない
 *   (外すと**段落の 2 行を表として書き換える**)。
 */
function tableRunFrom(lines: readonly string[], s: number): TableAt | null {
  const header = lines[s];
  const delim = lines[s + 1];
  if (header === undefined || delim === undefined) return null;
  if (breaksTable(header) || !header.includes('|')) return null;
  const head = splitRow(header);
  const cols = alignCount(delim);
  if (cols === null || cols !== head.length || cols === 0) return null;

  let end = s + 1;
  const rows: TableCopyRow[] = [];
  for (let i = s + 2; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (breaksTable(l)) break;
    /**
     * ⚠ **列数は見出しに揃える** ── 読み手(markdown-it)は多い分を捨て、足りない分を
     *   空で埋めて描く。ここで原文どおりの数を持つと、**画面に出ていない升**が
     *   変換後に現れる(押していないのに増える)。
     */
    const cells = splitRow(l);
    rows.push({ cells: Array.from({ length: cols }, (_, c) => cells[c] ?? ''), head: false });
    end = i;
  }

  /**
   * 🔴 **空の見出しは「見出しが無い表」である**(#708 段①の `gfmTable` の作法)。
   *
   * ⚠ 見出しの無い升の並びを markdown の表にすると、`gfmTable` は**空の見出しを
   *   足す**(先頭行を格上げするとデータが 1 行消えるため)。だから戻すときは
   *   その空の行を**落とす**── 落とさないと、往復のたびに空の行が 1 本積む。
   */
  const empty = head.every((c) => c === '');
  return {
    format: 'markdown',
    start: s,
    end,
    rows: empty ? rows : [{ cells: head, head: true }, ...rows],
  };
}

/** csv / tsv / psv の囲み。表として読めなければ `null`。 */
function csvFenceAt(
  lines: readonly string[],
  span: { start: number; end: number; open: boolean; name: string },
): TableAt | null {
  /**
   * ⚠ **閉じていない囲みは触らない** ── 走査は閉じ無しの柵を**末尾まで**飲むので、
   *   そのまま書き換えると**囲みより下の本文が丸ごと消える**。
   *   出さない(押せる口を作らない)のが正しい ── 閉じを足せば出る。
   */
  if (span.open) return null;
  const parsed = parseRenderableFence(span.name);
  if (parsed === null) return null;
  const delimiter = (DELIMITER as Record<string, string | undefined>)[parsed.lang];
  if (delimiter === undefined) return null;
  // ⚠ 見出しの旗(`noheader`)は**開き行の丸ごと**から読む(`name` は 1 語目だけ)
  const info = fenceInfo(lines[span.start] ?? '');
  if (info === null) return null;
  const rows = parseCsv(lines.slice(span.start + 1, span.end).join('\n'), delimiter);
  if (rows === null) return null;
  const withHead = !isHeaderDisabled(info);
  return {
    format: 'csv',
    start: span.start,
    end: span.end,
    rows: rows.map((cells, i) => ({ cells, head: withHead && i === 0 })),
  };
}

/**
 * 🔴 **その行に在る表**(#708 段②)。表でなければ `null`。
 *
 * ⚠ `line` は**原文の行番号**(0 始まり。`csv-cell` / `task` と同じ座標系)。
 *   囲みの柵の行でも、markdown の表のどの行でもよい。
 * ⚠ frontmatter の中は見ない ── 表は本文にしか無い。
 */
export function tableAt(body: string, line: number): TableAt | null {
  const lines = body.split('\n');
  const fm = frontmatterLineCount(body);
  if (!Number.isInteger(line) || line < fm || line >= lines.length) return null;

  /**
   * ⚠ **囲みの中かどうかを先に見る** ── どんな行も表の行として読めてしまうので、
   *   ` ```js ` の中の `| a | b |` を markdown の表として書き換えかねない
   *   (`csvTableAt` の註記と同じ罠)。
   * ⚠ `scanContainers` は最上位の囲いしか返さない ── `:::note` の中の csv の囲みは
   *   ここに出ないので、セルを押す口(#418)と同じく変換の口も出ない。
   */
  const fence = scanContainers(body).find(
    (c) => c.kind === 'fence' && line >= c.start && line <= c.end,
  );
  if (fence !== undefined) return csvFenceAt(lines, fence);

  /**
   * 🔑 **走の頭まで遡ってから当てる** ── 押した行が中身の行でも見出しから読み直す。
   * ⚠ 遡り先が段落の途中のことがある(表が段落に続いている形)ので、
   *   頭から押した行まで順に当て、**押した行を含む走**が出たところで採る。
   */
  let top = line;
  while (top > fm && !breaksTable(lines[top - 1] ?? '')) top -= 1;
  for (let s = top; s <= line; s += 1) {
    const run = tableRunFrom(lines, s);
    if (run !== null && line >= run.start && line <= run.end) return run;
  }
  return null;
}

/**
 * 🔴 **変えられない理由**(#708 段②)。変えられるなら `null`。
 *
 * ⚠ **黙って断らない**(user 裁定 2026-09-04)── 呼び側はこの字を画面に出す。
 * 🔑 判定はここ 1 か所 ── 画面に出す側(`binder.ts`)と実際に書く側
 *   (`body-rewrite.ts`)が同じ答えを持つ(§7「同じ問いに答える口を 2 つ作らない」)。
 */
export function tableConvertRefusal(at: TableAt, to: TableFormat): string | null {
  if (at.format === to) return 'この表はもうその形です';
  if (to === 'csv') return null;
  for (const row of at.rows) {
    for (const cell of row.cells) {
      /**
       * 🔴 **式が在る csv は markdown にしない**(user 裁定 2026-09-04)。
       * ⚠ markdown の表に式の概念は無いので、`=B2*C2` は**字**になる ── 表は
       *   見た目そのままなのに、**数字が更新されなくなる**(いちばん気づけない)。
       */
      if (isFormula(cell)) {
        return '式(=…)が入っているので Markdown の表にできません(式が字になります)';
      }
      /**
       * ⚠ **升の中の改行も断る** ── markdown の表は 1 行 1 行なので、改行を含む升は
       *   空白へ潰すしかない(段① で「潰すのは潰さないと壊れる形だけ」と決めた)。
       *   潰すと user の字が黙って変わるので、**断って user に決めさせる**。
       */
      if (cell.includes('\n')) {
        return '升の中に改行があるので Markdown の表にできません(改行を消してください)';
      }
    }
  }
  return null;
}

/** 柵の長さ。⚠ 升の字が ``` で始まると囲みが**そこで閉じる**ので、必ず 1 本長くする。 */
function fenceMarkerFor(content: string): string {
  let longest = 0;
  for (const l of content.split('\n')) {
    const m = /^\s*(`+)/.exec(l);
    if (m !== null) longest = Math.max(longest, m[1]!.length);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * 🔴 **その表を別の形の字にする**(#708 段②)。組めなければ `null`。
 *
 * ⚠ **断る形は呼ぶ前に外しておく**(`tableConvertRefusal`)── ここは組むだけである。
 * ⚠ 升の字は**向きごとに逃がし直す**:
 *   - csv → markdown … `'` の逃がしを剥がす(`displayCell`。式はもう無い)
 *   - markdown → csv … `=` / `'` で始まる字に `'` を付ける(`csvLiteralCell`)
 *   🔑 どちらも**画面に出る字は 1 文字も変えない**ための足し引きである。
 */
export function convertTable(at: TableAt, to: TableFormat): string | null {
  if (at.format === to || at.rows.length === 0) return null;
  if (to === 'markdown') {
    const raw = at.rows.map((r) => r.cells);
    return tableToMarkdown(
      at.rows.map((r) => ({ ...r, cells: r.cells.map((c) => displayCell(c, raw).text) })),
    );
  }
  const body = tableToCsv(at.rows.map((r) => ({ ...r, cells: r.cells.map(csvLiteralCell) })));
  const marker = fenceMarkerFor(body);
  // ⚠ 見出しの無い表は `noheader` を宣言する ── 宣言しないと 1 行目が見出しに化ける
  return `${marker}csv${at.rows[0]!.head ? '' : ' noheader'}\n${body}\n${marker}`;
}
