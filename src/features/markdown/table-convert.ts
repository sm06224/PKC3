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
import { csvEscapeField, DELIMITER, isHeaderDisabled, parseCsv } from './csv-table';
import { frontmatterLineCount } from './frontmatter';
import { parseRenderableFence } from './markdown-render';
import {
  allFences,
  containerAtLine,
  fenceInfo,
  quoteLead,
  quotePrefix,
  type FenceSpan,
} from './source-blocks';
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
  /**
   * 🔴 **その表の 1 行目に在った引用の前置き**(引用の外は空文字。#743)。
   *
   * ⚠ 飾りではない ── 書き換える側(`body-rewrite.ts` の `rewriteTableFormat`)は
   *   組んだ字に**これを付け直す**。持たずに差し替えると、引用の中の表を
   *   作り変えた瞬間に `>` が消えて**引用ごと本文へ落ちる**(升の字は 1 文字も
   *   変わらないので、升を数える検査では見えない)。
   * 🔑 **深さ(数)ではなく字を持つ**のは、`> ` と `>` と `>> ` を書き換える側で
   *   組み直さないためである ── user が書いた書き方をそのまま返す。
   *   ⚠ 数を渡すと受け側で `quoteLead` を引き直すことになり、
   *   **段が足りない**という**ここでは起こりえない**場合の分岐が 1 つ増える
   *   (読む側は既にその形を断っている ── 到達しない条件は書かない)。
   */
  readonly quoteLead: string;
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

/**
 * 🔴 **字下げの塊**(4 個の空白 / tab)でも表は終わる(着地前レビューが実測で拾った)。
 *
 * ⚠ 表の行自体は 3 個までしか字下げできないので、4 個目からは**別の塊**である。
 *   これが無いと、表の直後に字下げのコードを書いた人の行が**升へ吸われ、
 *   字下げごと落ちる**(元に戻せない)。
 */
const TABLE_BREAK_INDENT = /^(?: {4}|\t)/;

/**
 * 🔴 **改頁(`+++`)でも表は終わる**(同上)。
 *
 * ⚠ 綴りは `markdown-render.ts` の `processSectionBreaks` と**同じ字**にしてある ──
 *   ずれると、押した瞬間に**改頁が本文から消えて**表に `+++` の升が生える。
 * 🔑 「読み手が終える所で終える」が唯一の正解なので、期待値は実装の綴りではなく
 *   **描いた読み手の `data-pkc-source-end`** と突き合わせて守る(下の SPAN_CASES)。
 */
const TABLE_BREAK_SECTION = /^\s*\+\+\+\s*(?:\{[^}]*\}\s*)?$/;

/**
 * 🔴 **行頭の引用の前置きは `source-blocks.ts` の 1 本**(#749 / #775)。
 *
 * ⚠ 2026-09-07 まで**同じ正規表現がここにも在った** ── そして囲みの走査
 *   (`allFences`)だけがそれを知らなかったので、引用の中の csv は
 *   **押せるのに書けない**形になっていた(#775)。
 * 🔑 規則を 1 本にしたので、走査と読み書きが**同じ答え**を持つ(CLAUDE.md §7)。
 *
 * 🔑 **引用の中でも表の升を押して打てるようにする**ための土台。同じ file が
 *   2026-08-19 に**チェックの印**で同じ穴を塞いでおり(`body-rewrite.ts` の
 *   `TASK_LINE` は `(?:\s*>)*` を受ける)、user から見ると
 *   「同じ引用の中で、チェックは押せるのに表の升は押せない」食い違いだった。
 */

/**
 * その行で表が終わるか(空行も含む)。
 *
 * 🔴 **引用の深さが変わったら切る**(#749)。⚠ 前置きを剥がすだけだと、
 *   引用でない表の下に `> 引用` を書いた行を**表に巻き込んで書き換える**
 *   (この file の冒頭が戒めている「表の下の段落まで巻き込む」)。
 * ⚠ 深さが途中で変わる表(`> | a |` の次が `>> | b |`)も**そこで切る** ──
 *   描き手(markdown-it)が `>>` を**別の引用**として扱うので、切らないと
 *   **画面と原文の切り方が食い違う**(2026-09-06 の実測で決めた)。
 *
 * @param depth その表が居る引用の深さ(引用の外なら 0)
 */
function breaksTable(line: string, depth = 0): boolean {
  const q = quotePrefix(line);
  if (q.depth !== depth) return true;
  const rest = line.slice(q.length);
  return (
    rest.trim() === '' ||
    TABLE_BREAK.test(rest) ||
    TABLE_BREAK_INDENT.test(rest) ||
    TABLE_BREAK_SECTION.test(rest)
  );
}

/**
 * 1 行を升へ割り、**原文の範囲も一緒に返す**(#708 段④)。
 *
 * ⚠ **markdown-it の `escapedSplit` と同じ規則**にしてある ── `\|` は升の中の `|` で
 *   あって区切りではない。ここが読み手とずれると、**升が 1 つずれた表**を書き戻す
 *   (いちばん静かなデータ破壊)。一致は parity 検査が守る。
 */
function splitRowSpans(line: string): { cells: string[]; spans: { start: number; end: number }[] } {
  /**
   * 🔴 **引用の前置きは升ではない**(#749)── `> | a | b |` の `> ` を飲む。
   * ⚠ `lead` は**原文の中での位置**なので、前置きの字数をそのまま足す ──
   *   これで書き換えは升の中だけに当たり、**前置きは 1 文字も動かない**。
   */
  const q = quotePrefix(line);
  const rest = line.slice(q.length);
  const lead = q.length + (rest.length - rest.trimStart().length);
  const src = rest.trim();
  const out: string[] = [];
  /** ⚠ **原文の範囲**(区切りの `|` の間)── 升の字と**同じ添字**で並べる。 */
  const raw: { start: number; end: number }[] = [];
  let cur = '';
  let last = 0;
  let cellStart = 0;
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
        raw.push({ start: cellStart, end: i });
        cur = '';
        last = i + 1;
        cellStart = i + 1;
      }
    }
    escaped = ch === '\\';
  }
  out.push(cur + src.slice(last));
  raw.push({ start: cellStart, end: src.length });
  // ⚠ 前後の縦棒は飾り(GFM では省ける)なので、空の端は**升と範囲を揃えて**落とす
  if (out.length > 0 && out[0] === '') {
    out.shift();
    raw.shift();
  }
  if (out.length > 0 && out[out.length - 1] === '') {
    out.pop();
    raw.pop();
  }
  /**
   * ⚠ **範囲は「字の在る所」まで詰める** ── 前後の空白を含めたまま差し替えると、
   *   `| a | b |` が `|x| b |` になって**升の余白が揃わなくなる**(user が書いた
   *   見た目を、こちらの都合で崩さない)。
   */
  const spans = raw.map((r, i) => {
    const seg = src.slice(r.start, r.end);
    const head = seg.length - seg.trimStart().length;
    const tail = seg.length - seg.trimEnd().length;
    void i;
    const start = lead + r.start + head;
    /**
     * ⚠ **空白だけの升では反転する**(#747-6。実測 `mdCellSpan('|     | 2 |', 0)`
     *   = `{ start: 6, end: 1 }`)── `head + tail` が升の長さを超えるので、
     *   差し替えが**挿入**になり `|     ZZZ     | 2 |` と余白が複製された。
     */
    return { start, end: Math.max(start, lead + r.end - tail) };
  });
  return { cells: out.map((c) => c.trim()), spans };
}

/**
 * 1 行を升へ割る。
 *
 * ⚠ **markdown-it の `escapedSplit` と同じ規則**にしてある ── `\|` は升の中の `|` で
 *   あって区切りではない。ここが読み手とずれると、**升が 1 つずれた表**を書き戻す
 *   (いちばん静かなデータ破壊)。一致は parity 検査が守る。
 * ⚠ 前後の `|` は飾り(GFM では省ける)なので、空の端は落とす。
 * 🔑 **範囲を返す口と同じ 1 本**から作る(§7)── 別々に書くと、升の数だけ合って
 *   位置がずれる形(いちばん見つけにくい)になる。
 */
function splitRow(line: string): string[] {
  return splitRowSpans(line).cells;
}

/**
 * 🔴 **markdown の表の升 1 つを、原文のどこで差し替えればよいか**(#708 段④)。
 *
 * ⚠ `col` は**描いた表の列番号**である ── 読み手(markdown-it)は見出しより多い升を
 *   捨て、足りない分を**原文を持たない空の升**で埋めるので、そこは `null` を返す
 *   (無い物を書き換えない)。
 * ⚠ 区切りの行(`|---|`)は差し替えの対象にしない ── 呼び側が外す。
 *
 * @returns 原文の範囲(両端は字の在る所まで詰めてある)。升が無ければ `null`
 */
export function mdCellSpan(line: string, col: number): { start: number; end: number } | null {
  if (!Number.isInteger(col) || col < 0) return null;
  const { spans } = splitRowSpans(line);
  return spans[col] ?? null;
}

/** 区切りの行なら列数、そうでなければ `null`。 */
function alignCount(line: string): number | null {
  // ⚠ **引用の前置きは骨格ではない**(#749)── 剥がしてから見ないと
  //    `> |---|---|` の `>` が `[|\-: ]` に当たらず、区切りの行に見えない
  const t = line.slice(quotePrefix(line).length).trim();
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
  /**
   * 🔴 **深さは見出しの行が決める**(#749)── 以降の行はこの深さで読み、
   *   違う深さの行が来たら `breaksTable` がそこで切る。
   * ⚠ 区切りの行だけは `alignCount` が前置きを剥がして読んでしまうので、
   *   ここで**深さを明示して**検める(`> | a |` の次が `>> |---|` を表にしない)。
   */
  const depth = quotePrefix(header).depth;
  if (breaksTable(header, depth)) return null;
  // ⚠ `|` は**前置きの外**で探す(`>` は升の区切りではない)
  if (!header.slice(quotePrefix(header).length).includes('|')) return null;
  // ⚠ 区切りの行の深さも検める ── `alignCount` は前置きを剥がして読むので、
  //    ここで見ないと `> | a |` の次の `>> |---|` を同じ表として飲む
  if (quotePrefix(delim).depth !== depth) return null;
  const head = splitRow(header);
  const cols = alignCount(delim);
  // ⚠ `cols === 0` は書かない ── `alignCount` が升 0 個で既に `null` を返すので
  //    **到達しない条件**である(変異試験 S-5 が SURVIVED で教えた)。
  if (cols === null || cols !== head.length) return null;

  let end = s + 1;
  const rows: TableCopyRow[] = [];
  for (let i = s + 2; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (breaksTable(l, depth)) break;
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
    // 🔑 前置きは**見出しの行**の実物から採る(`depth` はこの行から数えた数である)
    quoteLead: header.slice(0, quotePrefix(header).length),
  };
}

/**
 * csv / tsv / psv の囲み。表として読めなければ `null`。
 *
 * 🔴 **引用(`>`)の中の囲みも読む**(#743)── `span.quote` の段数ぶん前置きを
 *   剥がしてから見出しも中身も読む。⚠ 剥がさないと ① 見出しの `FENCE_OPEN` が
 *   `> ``` ` に当たらず**囲みと読めない** ② 中身の 1 列目が `> a` になり、
 *   Markdown へ戻したとき**引用の印が升の字になる**。
 * ⚠ **段が足りない行は「この囲みの中身ではない」ので断る**(`quoteLead` が `null`。
 *   `body-rewrite.ts` の升を打つ側と同じ規則 ── §7)。
 */
function csvFenceAt(lines: readonly string[], span: FenceSpan): TableAt | null {
  /**
   * ⚠ **閉じていない囲みは触らない** ── 走査は閉じ無しの柵を**末尾まで**飲むので、
   *   そのまま書き換えると**囲みより下の本文が丸ごと消える**。
   *   出さない(押せる口を作らない)のが正しい ── 閉じを足せば出る。
   */
  if (span.open) return null;
  /** 前置きを `span.quote` 段ちょうど剥がす。足りなければ `null`。 */
  const unquote = (l: string): string | null => {
    const lead = quoteLead(l, span.quote);
    return lead === null ? null : l.slice(lead);
  };
  const open = lines[span.start] ?? '';
  const openLead = quoteLead(open, span.quote);
  if (openLead === null) return null;
  const openLine = open.slice(openLead);
  const parsed = parseRenderableFence(span.name);
  if (parsed === null) return null;
  /**
   * 🔴 **`-norender` の囲みは触らない**(着地前レビュー・動線 ⑥)。
   *
   * ⚠ user は「**表にするな**」と明示して書いている ── その明示を消す口を出さない。
   *   出すと、markdown にした後で戻したとき `csv`(= 表)になり、
   *   **二度とコード表示へ戻せない**(片道の操作を作らない、user 指示 2026-08-23)。
   */
  if (parsed.mode === 'norender') return null;
  const delimiter = (DELIMITER as Record<string, string | undefined>)[parsed.lang];
  if (delimiter === undefined) return null;
  // ⚠ 見出しの旗(`noheader`)は**開き行の丸ごと**から読む(`name` は 1 語目だけ)
  const info = fenceInfo(openLine);
  if (info === null) return null;
  /**
   * 🔴 **読み手と同じく、囲みの字下げを剥がしてから読む**(着地前レビューが実測で拾った)。
   *
   * ⚠ 剥がさないと**先頭の升にだけ**空白が残り、`isFormula`(`=` で始まるか)が
   *   **false** になる ── 式の在る csv を markdown にしない門(user 裁定 2026-09-04)が
   *   字下げ 1 つで開き、画面の `2` が `=1+1` に変わって**計算が止まる**。
   * ⚠ 剥がすのは**柵と同じ数まで**(CommonMark と同じ規則)── 多く剥がすと
   *   升の中の意図した字下げが消える。
   */
  const indent = /^[ \t]*/.exec(openLine)![0]!.length;
  const strip = (l: string): string => {
    let n = 0;
    while (n < indent && (l[n] === ' ' || l[n] === '\t')) n += 1;
    return l.slice(n);
  };
  const content: string[] = [];
  for (const l of lines.slice(span.start + 1, span.end)) {
    const bare = unquote(l);
    if (bare === null) return null;
    content.push(strip(bare));
  }
  const rows = parseCsv(content.join('\n'), delimiter);
  if (rows === null) return null;
  const withHead = !isHeaderDisabled(info);
  return {
    format: 'csv',
    start: span.start,
    end: span.end,
    rows: rows.map((cells, i) => ({ cells, head: withHead && i === 0 })),
    // 🔑 開き行から実際に剥がした分をそのまま返す
    quoteLead: open.slice(0, openLead),
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
   * 🔑 **地図は 1 回だけ組む**(§7)── 囲みの走査を升を打つ側と共有する。
   *   別々に組むと、同じ本文に**別の答えを持つ口が 2 つ**になる。
   */
  const gate = mdCellGate(lines);
  gate.body = body;
  gate.fm = fm;

  /**
   * 🔴 **囲み(```)は入れ子と引用まで降りて引く**(#743。user 裁定 2026-09-07
   * 「**出す**」)。
   *
   * ⚠ **囲みの中かどうかを先に見る** ── どんな行も表の行として読めてしまうので、
   *   ` ```js ` の中の `| a | b |` を markdown の表として書き換えかねない。
   * ⚠ **ここで答えを閉じている**(csv でなければ `null`)が、**この門は単独では
   *   効いていない** ── 素通しさせる変異を当てても、表まわりの unit
   *   (`table-convert` / `md-table-cell` / `csv-cell` の 3 file・219 件)は
   *   **1 件も落ちなかった**(2026-09-07 実測)。
   *   🔑 下の {@link mdTableRun} が**同じ囲みの地図でもう一度**外すからである。
   *   ⚠ だから「これが無いと ` ```js ` の字を書き換える」とは書けない ──
   *   ここは**読み方を 1 本に見せるための形**であって、守っているのは向こうである。
   *
   * ## ⚠ 直す前は「引用の中」と「`:::` の板の中」で出していなかった
   *
   * 理由は「**戻す口が出ない片道になるから**」だった ── 当時は走査
   * (`scanContainers`)が**最上位しか返さず**、作り変えた先の ` ```csv ` を
   * 二度と囲みと読めなかった。🔑 **その理由は #747 / #775 で消えた**
   * (走査が板の中へも引用の中へも降りる)。⚠ 残っていたのは
   * 「**右クリックの項目が 1 つ増える = 見え方が変わる**」ことだけなので、
   * 画面の言葉でお伺いして裁定をいただいた(2026-09-07)。
   */
  const fence = containerAtLine(gateFences(gate), line);
  if (fence !== null) return csvFenceAt(lines, fence);

  /**
   * 🔑 **markdown の表は、升を打つ側と同じ 1 本を通す**(§7)。
   *
   * ⚠ 直す前はここに**同じ走査をもう 1 つ**書いていた(引用の深さを見ない版)。
   *   引用の中を外していたので当時は等価だったが、**外すのをやめた瞬間に
   *   「押した行の深さで遡る」を落とした 2 本目**になる ── だから寄せた。
   * 🔑 `mdTableRun` は `:::` の板を外さない ── 板の中の表も、升が打てるのと
   *   同じように**形も作り変えられる**(裁定 2026-09-07)。
   */
  return mdTableRun(gate, line);
}

/**
 * 🔴 **その行は markdown の表の行か**(#708 段④)。違えば `null`。
 *
 * ⚠ **`tableAt` と門は同じである**(#743、2026-09-07 に揃えた)。あちらは
 *   「**この表の形を作り変えられるか**」で、かつては `:::` の板の中と引用の中を
 *   外していたが、**外していた理由(片道になる)は #747 / #775 で消えた**ので、
 *   いまはどちらも {@link mdTableRun} という同じ 1 本を通る(§7)。
 * 🔑 だから門は 2 つだけ ── ①frontmatter の中は見ない ②**囲み(``` )の中は見ない**
 *   (コードとして描かれるので押せる印も焼かれないが、別の窓から古い依頼が来た日に
 *   囲みの中身を書き換えない)。⚠ ②は**入れ子の深さを問わない**(#747-5)。
 * ⚠ **区切りの行(`|---|`)は呼び側が外す** ── ここは走の範囲を返すだけである。
 */
export function mdTableAt(body: string, line: number): TableAt | null {
  return mdTableRun(mdCellGate(body.split('\n')), line);
}

/**
 * 🔴 **升を打つときの門を 1 本にまとめた入れ物**(#747)。
 *
 * ⚠ 焼く側(描画)と書く側(`body-rewrite`)が**別々に門を数えていた**ため、
 *   引用の中・箇条書きの中の表は**押せるのに書けなかった**(打った字が消え、
 *   「本文が変わっている」という起きていない理由が出る)。
 * 🔑 だから両方が {@link mdCellSpanAt} だけを呼ぶ。**門を足すならここに足す。**
 *
 * ⚠ `runs` は**同じ表の行を何度も引き直さない**ための控えである(表 1 つにつき
 *   `mdTableAt` は 1 回)── 無くても答えは同じ。
 */
export interface MdCellGate {
  readonly lines: readonly string[];
  readonly runs: Map<number, TableAt | null>;
  /**
   * ⚠ **1 回きり。**{@link mdCellSpanAt} が要るときに 1 度だけ組む ──
   *   呼び側が `lines` を書き換えたら、gate を**作り直す**こと
   *   (`rewriteMdCell` は答えを受け取った**後で** `lines` を書き換える)。
   */
  body?: string;
  fm?: number;
  fences?: readonly FenceSpan[];
  /**
   * 🔴 **引用の前置きを「全段」剥がした写しの囲み**(#749)。
   *
   * ⚠ **足した当時の理由は #775 で消えた。** 当時は囲みの走査(`allFences`)が
   *   引用の中の柵を 1 本も見なかったので、`> ``` ` の中の表が
   *   **押せる側に化ける**のをここで止めていた ── いまは走査が引用へ降りるので、
   *   そろった形(`> ``` ` の中身も `> `)は {@link gateFences} だけで外れる。
   *
   * 🔴 **いまこの門だけが効くのは「深さが食い違う形」である**(2026-09-07 実測):
   *   `>> ``` ` の中身が `> | a |` / `> ``` ` の中身が前置き無しの `| a |`。
   *   ⚠ そこは読み手が**表として描く**(コードではない)ので、外せば
   *   **押せて書ける**(実測:印 4 / 書けた 4 ── 不変量は壊れない)。
   * 🔑 つまり残っているのは**壊れるかどうかではなく、見え方の 1 問**である
   *   ── 崩れた入れ子の引用で升を押させるか。**裁定は #786**(切り出した)。
   * ⚠ かつてここは「**#743 とまとめて仰ぐ**」と書いていたが、**#743 の裁定
   *   (2026-09-07「出す」)はこの件を含んでいない** ── あちらは
   *   「引用や `:::` の中の表に『CSV の表にする』を出すか」である。
   *   🔑 註記だけが待ち続けるのを避けるため、issue へ出した
   *   (CLAUDE.md「裁定を待っているものも起票する」)。
   * ⚠ **外すと黙って見え方が変わる**ので、いまの答え(押させない)を
   *   `tests/features/md-table-cell.test.ts` が名指しで pin する
   *   ── 直す前はここを消しても**全 8,180 件が緑のまま**だった。
   */
  quotedFences?: readonly FenceSpan[];
}

/** {@link mdCellSpanAt} に渡す入れ物を作る。 */
export function mdCellGate(lines: readonly string[]): MdCellGate {
  return { lines, runs: new Map() };
}

/**
 * 🔴 **囲みの地図を、gate に 1 回だけ組む**(#747 の着地前レビュー)。
 *
 * ⚠ 直す前は表 1 つにつき `fenceAt` を呼び、その中で**本文を丸ごと走査**していた ──
 *   実測で **表 160 個・3680 行の描画が 62ms → 262ms**(二次)になっていた。
 * 🔴 **走査は frontmatter の下から始める。** ⚠ frontmatter の中の ` ``` ` は
 *   YAML の字であって囲みの柵ではない ── 数えると、**閉じていない柵が 1 本在るだけで
 *   本文の升が全部「押せるのに書けない」**になる(実測 96 形中 24 形)。
 *   🔑 描く側は frontmatter を落とした本文を渡してくるので、ここで揃えないと
 *   **同じ 1 本の門でも、見ている本文が違う**(§7)。
 */
function gateFences(gate: MdCellGate): readonly FenceSpan[] {
  gate.fences ??= fencesBelowFrontmatter(gate.body ?? gate.lines.join('\n'));
  return gate.fences;
}

/**
 * 引用の前置きを**空にした写し**(#749)。
 * ⚠ 行数も行番号も変わらない ── 囲みの範囲は行で返るので、そのまま突き合わせられる。
 */
function withoutQuotePrefix(body: string): string {
  return body
    .split('\n')
    .map((l) => l.slice(quotePrefix(l).length))
    .join('\n');
}

/** 引用を剥がした写しの囲み(gate に 1 回だけ組む)。 */
function gateQuotedFences(gate: MdCellGate): readonly FenceSpan[] {
  gate.quotedFences ??= fencesBelowFrontmatter(
    withoutQuotePrefix(gate.body ?? gate.lines.join('\n')),
  );
  return gate.quotedFences;
}

/**
 * 🔴 **囲みは frontmatter の下から数える**(#747 の着地前レビュー)。
 * 🔑 起点を決めるのはここ 1 か所 ── 升を打つ側(`mdCellSpanAt`)と
 *   csv の側(`body-rewrite.ts` の `csvTableAt`)が同じ答えを持つ(§7)。
 */
export function fencesBelowFrontmatter(body: string): readonly FenceSpan[] {
  const fm = frontmatterLineCount(body);
  const below = fm === 0 ? body : body.split('\n').slice(fm).join('\n');
  const found = allFences(below);
  return fm === 0 ? found : found.map((f) => ({ ...f, start: f.start + fm, end: f.end + fm }));
}

function gateFm(gate: MdCellGate): number {
  gate.body ??= gate.lines.join('\n');
  gate.fm ??= frontmatterLineCount(gate.body);
  return gate.fm;
}

/**
 * 🔴 **その行は markdown の表の行か**(gate 版)。{@link mdTableAt} の中身である。
 * 🔑 門を足すならここ 1 か所 ── 焼く側も書く側もここを通る。
 */
function mdTableRun(gate: MdCellGate, line: number): TableAt | null {
  const fm = gateFm(gate);
  const lines = gate.lines;
  if (!Number.isInteger(line) || line < fm || line >= lines.length) return null;
  if (containerAtLine(gateFences(gate), line) !== null) return null;
  /**
   * 🔴 **引用の中の囲みも外す**(#749)── `> ``` ` の中の `| a | b |` は
   *   コードであって表ではない。
   * ⚠ そろった形は 1 つ上の `gateFences` が外す(#775 で走査が引用へ降りた)。
   *   ここが効くのは**深さが食い違う形**だけ ── 詳しくは `quotedFences` の註記。
   */
  if (containerAtLine(gateQuotedFences(gate), line) !== null) return null;
  /**
   * 🔴 **遡りは「押した行の深さ」で行う**(#749)── 引用の中の表なら、
   *   その引用の中だけを遡る。深さが違う行に当たったら `breaksTable` が切る。
   */
  const depth = quotePrefix(lines[line] ?? '').depth;
  let top = line;
  while (top > fm && !breaksTable(lines[top - 1] ?? '', depth)) top -= 1;
  for (let s = top; s <= line; s += 1) {
    const run = tableRunFrom(lines, s);
    if (run !== null && line >= run.start && line <= run.end) return run;
  }
  return null;
}

/**
 * 🔴 **その升は打てるか。打てるなら原文のどこを差し替えるか**(#747)。
 *
 * 門は 3 つ ── ①その行が markdown の表の行か({@link mdTableAt}:frontmatter の中と
 * 囲みの中を外す)②区切りの行(`|---|`)ではないか ③その列の升が**原文に在るか**
 * ({@link mdCellSpan}:読み手が見出しの列数ぶん作る**空の升**は原文を持たない)。
 *
 * @param line **原文の**行番号(描画の行番号ではない ── 前処理が行を挿入する)
 */
export function mdCellSpanAt(
  gate: MdCellGate,
  line: number,
  col: number,
): { start: number; end: number } | null {
  let at = gate.runs.get(line);
  if (at === undefined) {
    at = mdTableRun(gate, line);
    gate.runs.set(line, at);
    // 🔑 同じ走の行はまとめて控える(表 1 つにつき 1 回だけ数える)
    // ⚠ **走の外へはみ出す変異は、いまの呼び側では観測できない**(実測:`end + 1` に
    //    しても全 spec 緑)── td の印は必ず表の行に付くので、控えが 1 行多くても
    //    誰も引かない。ここは**正しさのため**であって、鳴る検査は無い
    if (at !== null) for (let i = at.start; i <= at.end; i += 1) gate.runs.set(i, at);
  }
  if (at === null) return null;
  // ⚠ 区切りの行は表の骨格である(押せる印も焼かない)
  if (line === at.start + 1) return null;
  const src = gate.lines[line];
  if (src === undefined) return null;
  return mdCellSpan(src, col);
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
  /**
   * 🔴 **どの升かを言う**(着地前レビュー・動線 ⑤)。
   *
   * ⚠ 「式を消してください」だけでは**直す場所が画面に出ていない** ── 式は描くとき
   *   評価されて**ただの数字に見え**、升の中の改行は**空白 1 個に見える**ので、
   *   user は升を 1 つずつ押して探すことになる。
   * 🔑 判定はここで升を 1 つずつ見ているのだから、**そのとき行と列を持っている**。
   * ⚠ 数え方は**画面に出ている表のまま**(見出しの行も 1 行目に数える)。
   */
  const where = (r: number, c: number): string => `${r + 1} 行目の ${c + 1} 列目`;
  /**
   * ⚠ 断るときは**代わりにできること**も言う ── 持ち出したいだけの人が居る。
   * ⚠ **「もう一度開いて」まで書く**(#708 裁定②の着地前レビュー・改善 I4)──
   *   ▾ の小窓から来た人は、行を押した時点で**その小窓が閉じている**ので、
   *   「▾ →」だけだと**いま閉じたばかりのもの**を指しているように読める。
   *   🔑 右クリックから来た人にも同じ字で通る(▾ はどちらの端末にも出る)。
   */
  const instead =
    '(表の右上の ▾ をもう一度開いて「Markdown の表」を選べば、本文はそのままコピーできます)';
  for (const [r, row] of at.rows.entries()) {
    for (const [c, cell] of row.cells.entries()) {
      /**
       * 🔴 **式が在る csv は markdown にしない**(user 裁定 2026-09-04)。
       * ⚠ markdown の表に式の概念は無いので、`=B2*C2` は**字**になる ── 表は
       *   見た目そのままなのに、**数字が更新されなくなる**(いちばん気づけない)。
       */
      if (isFormula(cell)) {
        return `${where(r, c)}に式(${cell})が入っているので Markdown の表にできません${instead}`;
      }
      /**
       * ⚠ **升の中の改行も断る** ── markdown の表は 1 行 1 行なので、改行を含む升は
       *   空白へ潰すしかない(段① で「潰すのは潰さないと壊れる形だけ」と決めた)。
       *   潰すと user の字が黙って変わるので、**断って user に決めさせる**。
       */
      if (cell.includes('\n')) {
        return `${where(r, c)}の升に改行があるので Markdown の表にできません${instead}`;
      }
    }
  }
  return null;
}

/** 柵の長さ。⚠ 升の字が ``` で始まると囲みが**そこで閉じる**ので、必ず 1 本長くする。 */
export function fenceMarkerFor(content: string): string {
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

/**
 * markdown の塊の書き出し(見出し / 箇条書き / 引用 / 表)。
 * ⚠ 1 行でも当たったら、その平文は**表ではなく markdown の原文**として扱う。
 *
 * ⚠ **柵(``` / ~~~)はここに入れない。** 入れると「柵で始まる行は組まない」に
 *   なるので、囲みの柵を伸ばす門(`fenceMarkerFor`)が**到達しなくなる** ──
 *   no-op の規則を残すことになる(CLAUDE.md §1「外して壊れるのを見る」)。
 * 🔑 役割が違う:ここは**書いた人の意図**(markdown の原文か)を見る門、
 *   `fenceMarkerFor` は**囲みが途中で閉じない**ことを保つ門である。
 */
const BLOCK_MARK = /^ {0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/;

/**
 * 🔴 **タブ区切りの平文を、表の囲みにする**(#708 段③)。
 *
 * > user の物語(#708): 表を「いろんなところで楽」に行き来させたい。
 *
 * ## ⚠ 「Excel から貼ると表にならない」は**誤りだった**(2026-09-05 の検算)
 *
 * Excel / Google スプレッドシートは `text/html` に `<table>` を載せるので、
 * 既定の設定なら**いまでも markdown の表になる**(`convertPastedHtml` →
 * `gfmTable`)。残っていた穴は**タブ区切りの平文しか届かないとき**である ──
 * 端末・`.tsv` の中身・チャットのコードブロックからのコピーがそれに当たる。
 *
 * ## 🔑 表と決めてよい条件は 3 つ全部そろったときだけ
 *
 * ⚠ ここは**貼ったものを勝手に組み替える**側なので、迷ったら**組まない**
 *   (誤って組むと user の字が囲みの中へ入り、消したように見える)。
 *
 * | 条件 | なぜ |
 * |---|---|
 * | **2 行以上** | 1 行だけの「a\tb」は表ではなく、字下げや飾りのことがある |
 * | **どの行もタブの数が同じ** | 表なら列数は揃う ── 揃わないなら、ただタブが混ざった文である |
 * | **タブが 1 つ以上** | 0 個は普通の文章 |
 *
 * ⚠ **末尾の空行は数えない**(コピーの最後に改行が付くのは普通である)。
 * ⚠ 中の空行は**数える** ── 空行が混ざる時点で「どの行も同じ列数」が崩れるので、
 *   自然に組まない側へ倒れる。
 *
 * @returns 囲みの字。表と決められなければ `null`
 */
export function tsvFenceFromPlain(plain: string): string | null {
  const lines = plain.replace(/\r\n?/g, '\n').split('\n');
  // ⚠ 末尾の空行だけ落とす(先頭・途中の空行は残して判定に効かせる)
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length < 2) return null;
  const tabs = (l: string): number => l.split('\t').length - 1;
  const n = tabs(lines[0]!);
  if (n < 1) return null;
  if (!lines.every((l) => tabs(l) === n)) return null;
  /**
   * 🔴 **行頭がタブなら、それは字下げであって列ではない**(着地前レビュー ⚠3)。
   *
   * ⚠ 「タブの数が同じ」だけだと、**タブで字下げしたコード**(Makefile のレシピ /
   *   Go / C)が「1 列目が空の表」になる。⚠ 原文は `‹/›` で戻せるので消えては
   *   いないが、「貼ったら知らない表になった」は user の物語として不合格である。
   * 🔑 **1 列目が全部空**が、字下げと本物の TSV を分ける唯一の合図。
   */
  if (lines.every((l) => l.startsWith('\t'))) return null;
  /**
   * 🔴 **markdown の原文は、原文のまま入れる**(着地前レビュー ⚠4)。
   *
   * ⚠ `convertPastedHtml` は「平文が markdown に見えるなら**わざと降りる**」
   *   (`plainLooksLikeMarkdown`)── マニュアルの「コピー元が markdown 原文を
   *   渡してきたときは原文をそのまま入れます」がそれである。
   * ⚠ ところが `choosePaste` から見ると、その `null` は「変換しても得るものが
   *   無かった」と**見分けが付かない**ので、最後の手が拾ってしまう。
   * 🔑 だから**こちらで断る** ── 判定を `choosePaste` に足すと「経路ごとに挙動が
   *   違う」形になる(§7)。⚠ 表の升に `#` や `- ` が来る形は失うが、
   *   この module の既定(**迷ったら組まない**)に沿う。
   */
  if (lines.some((l) => BLOCK_MARK.test(l))) return null;
  /**
   * 🔴 **升の字を逃がす**(着地前レビュー 🔴1。**貼った行が画面から消えていた**)。
   *
   * ⚠ 読み手(`parseCsv`)は RFC4180 の引用符を解釈し、描く側は `'` を剥がして
   *   `=` で始まる升を**式として評価する**。逃がさないと実測でこうなった:
   *
   *   | 貼った字 | 画面に出た升 |
   *   |---|---|
   *   | `太郎⇥5" ディスク` + 次の行 | 🔴 **次の行ごと 1 升に飲まれて消える** |
   *   | `太郎⇥say "hi"` | `say hi`(引用符が消える) |
   *   | `=1+1⇥x` | 🔴 **`2`**(式として計算される) |
   *   | `'quoted⇥x` | `quoted`(先頭の `'` が消える) |
   *
   * 🔑 逃がす規則は**兄弟と同じ 2 本**(`csvLiteralCell` → `csvEscapeField`)──
   *   `convertTable` が既に通している道であり、ここに 3 本目を書かない(§7)。
   * ⚠ 代償:Excel が `text/plain` に載せる TSV は**既に引用されている**ので、
   *   この道を通ると二重に逃がされる。⚠ ただし Excel は `text/html` が先に勝つ
   *   ので、ここへ来るのは**逃がしを知らない出し手**(端末 / `.tsv` / チャット)
   *   である ── そちらへ寄せるのが正しい。
   */
  const body = lines
    .map((l) =>
      l
        .split('\t')
        .map((c) => csvEscapeField(csvLiteralCell(c), '\t'))
        .join('\t'),
    )
    .join('\n');
  const marker = fenceMarkerFor(body);
  return `${marker}tsv\n${body}\n${marker}`;
}
