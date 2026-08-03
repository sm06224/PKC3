/**
 * 本文の**書き換え規則**(P8 段⑥)。
 *
 * > user 指摘 2026-08-03「**書式設定系のパネルも必要 / 何もかも足りない /
 * > ログの追記機構とテキストエントリの追記機構も無い**」
 *
 * 🔑 **pure module**。DOM も textarea も知らない ── 「いまの本文と選択範囲」を
 * もらって「新しい本文と新しい選択範囲」を返すだけ。だから **unit で全部見られる**
 * (実ブラウザでしか確かめられない形にすると、罠が test の外に出る)。
 *
 * 🔑 **規則は 1 つ**(`FORMAT_OPS` / `applyFormat`)。描画側はこの表からボタンを
 * 作り、binder はこの関数を呼ぶ ── 「同じ判定が 2 か所に生える」を最初から作らない。
 *
 * ⚠ **トグルにする** ── 押すたびに付いたり外れたりしないと、書式パネルは
 * 「間違えたら手で消す」道具になる。
 * ⚠ **選択が無いときも効く** ── 何も選ばずに「太字」を押したら、印だけ入れて
 * その間にカーソルを置く(打ち始められる)。
 */

export interface TextSelection {
  text: string;
  start: number;
  end: number;
}

/** 行頭の印(`# ` / `- ` など)を付け外しする種類。 */
export type LinePrefix = 'h1' | 'h2' | 'h3' | 'quote' | 'ul' | 'ol' | 'task';

const LINE_MARKS: Readonly<Record<LinePrefix, string>> = {
  h1: '# ',
  h2: '## ',
  h3: '### ',
  quote: '> ',
  ul: '- ',
  ol: '1. ',
  task: '- [ ] ',
};

/**
 * 「もう付いているか」の判定。⚠ **付ける印と同じ文字列で判定しない**:
 *  - 番号付きは付けた直後に `2. ` `3. ` になるので `1. ` では二度と外せない
 *  - `- ` はチェック `- [ ] ` の頭とも一致するので、除外しないと
 *    チェック行に箇条書きを押した瞬間 `[ ] やること` に化ける
 */
const LINE_DETECT: Readonly<Record<LinePrefix, RegExp>> = {
  h1: /^# /,
  h2: /^## /,
  h3: /^### /,
  quote: /^> /,
  ul: /^- (?!\[[ x]\] )/,
  ol: /^\d+\. /,
  task: /^- \[[ x]\] /,
};

/** 行頭の印を落とす(どの種類でも)。⚠ 番号付きは `12. ` のような形もある。 */
function stripMark(line: string): string {
  return line.replace(/^(?:#{1,6} |> |- \[[ x]\] |[-*+] |\d+\. )/, '');
}

/** 選択が触れている行の範囲(行頭・行末まで広げる)。 */
function lineRange(text: string, start: number, end: number): [number, number] {
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const nl = text.indexOf('\n', end);
  return [from, nl === -1 ? text.length : nl];
}

/**
 * 行頭の印をトグルする。
 * ⚠ **全部の行に既に付いていたら外す**(一部だけ付いている状態からは「揃える」)
 * ── 半端な状態で押したときに「外れて驚く」のを避ける。
 */
export function toggleLinePrefix(sel: TextSelection, kind: LinePrefix): TextSelection {
  const mark = LINE_MARKS[kind];
  const detect = LINE_DETECT[kind];
  const [from, to] = lineRange(sel.text, sel.start, sel.end);
  const block = sel.text.slice(from, to);
  const lines = block.split('\n');
  const allMarked = lines.every((l) => detect.test(l));
  const next = lines
    .map((l, i) => {
      if (allMarked) return l.replace(detect, '');
      const bare = stripMark(l);
      // 番号付きは行ごとに数える(全部 `1.` だと読みにくい)
      return kind === 'ol' ? `${i + 1}. ${bare}` : `${mark}${bare}`;
    })
    .join('\n');
  const text = sel.text.slice(0, from) + next + sel.text.slice(to);
  return { text, start: from, end: from + next.length };
}

/** 位置 `i` から `dir` 方向へ、同じ文字が何個続くか。 */
function markRun(text: string, i: number, ch: string, dir: -1 | 1): number {
  let n = 0;
  for (;;) {
    const j = dir < 0 ? i - n - 1 : i + n;
    if (j < 0 || j >= text.length || text[j] !== ch) return n;
    n += 1;
  }
}

/**
 * その印が「いま自分のものとして付いている」か。
 *
 * 🔴 **`*` の個数を数える**。ここを「先頭が印か」で済ませると、`**太字**` の内側で
 * 斜体を押したときに **太字の印を 1 個ずつ剥がして `*太字*` にしてしまう**
 * (押した人は斜体を付けたつもりなのに、太字が消える)。markdown の意味論は
 * 「`*` の連なりの本数」なので、そのまま数える:
 *  - 太字(2 文字)は **2 本以上あれば自分のもの**
 *  - 斜体・コード(1 文字)は **奇数のときだけ自分のもの**
 *
 * これで `**太字**` + 斜体 → `***太字***`、そこで斜体 → `**太字**` と戻る。
 */
function wrapped(before: number, after: number, len: number): boolean {
  if (before < len || after < len) return false;
  return len > 1 || (before % 2 === 1 && after % 2 === 1);
}

/**
 * 前後を囲む印(`**` / `` ` `` など)をトグルする。
 * ⚠ 選択が無いときは印だけ入れて**間にカーソルを置く**(すぐ打ち始められる)。
 * ⚠ 印は**同じ文字の繰り返し**であること(`**` / `*` / `` ` ``)を前提にしている。
 */
export function toggleWrap(sel: TextSelection, mark: string): TextSelection {
  const { text, start, end } = sel;
  const ch = mark[0]!;
  const len = mark.length;
  const inner = text.slice(start, end);
  // ① 選択が印ごと囲んでいる(`**太字**` を丸ごと選んで押した)
  if (
    inner.length >= len * 2 &&
    wrapped(markRun(inner, 0, ch, 1), markRun(inner, inner.length, ch, -1), len)
  ) {
    const bare = inner.slice(len, inner.length - len);
    return { text: text.slice(0, start) + bare + text.slice(end), start, end: start + bare.length };
  }
  // ② 選択の外側に印がある(`**太字**` の `太字` だけ選んで押した)
  if (wrapped(markRun(text, start, ch, -1), markRun(text, end, ch, 1), len)) {
    return {
      text: text.slice(0, start - len) + inner + text.slice(end + len),
      start: start - len,
      end: end - len + inner.length,
    };
  }
  // ③ 付ける
  const out = `${mark}${inner}${mark}`;
  return {
    text: text.slice(0, start) + out + text.slice(end),
    start: start + len,
    end: start + len + inner.length,
  };
}

/** カーソルを置きたい所の目印(雛形の定義にだけ現れ、挿入時に取り除かれる)。 */
const CARET = '\u0001';

/** 雛形 = 文字列 + 「打ち始めてほしい位置」。⚠ 位置を数字で書かない(数え間違える)。 */
export interface TemplateBlock {
  text: string;
  caret: number;
}

function template(withCaret: string): TemplateBlock {
  const caret = withCaret.indexOf(CARET);
  return { text: withCaret.replace(CARET, ''), caret };
}

/** 表の雛形(2 列)。カーソルは最初のセル。 */
export const TABLE_BLOCK = template(`| 項目 | 値 |\n|---|---|\n| ${CARET} |  |\n`);
/** 図の雛形(mermaid)。 */
export const MERMAID_BLOCK = template('```mermaid\ngraph TD\n  A-->B\n```\n');
/** コード塊の雛形。カーソルは中。 */
export const CODE_BLOCK = template(`\`\`\`\n${CARET}\n\`\`\`\n`);

/**
 * 選択(または カーソル位置)に塊を差し込む。
 * ⚠ **行の途中なら改行してから**入れる ── 表や fence が段落の途中に生えると
 * markdown として壊れる。
 */
export function insertBlock(sel: TextSelection, block: TemplateBlock): TextSelection {
  const { text, start, end } = sel;
  const atLineStart = start === 0 || text[start - 1] === '\n';
  const lead = atLineStart ? '' : '\n';
  const tailNeedsBreak = end < text.length && text[end] !== '\n';
  const body = `${lead}${block.text}${tailNeedsBreak ? '\n' : ''}`;
  const next = text.slice(0, start) + body + text.slice(end);
  const caret = block.caret < 0 ? start + body.length : start + lead.length + block.caret;
  return { text: next, start: caret, end: caret };
}

/** リンク。選択があればそれを文字列に、無ければ雛形。 */
export function insertLink(sel: TextSelection): TextSelection {
  const label = sel.text.slice(sel.start, sel.end) || 'リンク';
  const out = `[${label}](url)`;
  const text = sel.text.slice(0, sel.start) + out + sel.text.slice(sel.end);
  // url を選択状態にする(すぐ貼り付けられる)
  const at = sel.start + label.length + 3;
  return { text, start: at, end: at + 3 };
}

/**
 * 末尾に**追記の場所を作る**。
 *
 * > user 指摘 2026-08-03「**ログの追記機構とテキストエントリの追記機構も無い**」
 *
 * `heading` を渡すと日時の節を足す(ログ)、渡さなければ空行だけ空ける(ノート)。
 * ⚠ **末尾の空白は畳んでから**足す ── 押すたびに空行が増えていくと、
 * 書き出した markdown が空行だらけになる。
 * ⚠ 返す選択は**折り返し位置**(text の末尾)── 呼ぶ側はここへスクロールする。
 */
export function appendAt(text: string, heading: string | null): TextSelection {
  const base = text.replace(/\s+$/, '');
  const head = heading === null ? '' : `${heading}\n\n`;
  const next = base === '' ? head : `${base}\n\n${head}`;
  return { text: next, start: next.length, end: next.length };
}

/**
 * 末尾に**一塊を追記する**(P8 段⑧)。
 *
 * > user 指示 2026-08-03「**追記型は今すぐ実装して、今のままだと、なんの意味もない**」
 *
 * 🔑 `appendAt` が「場所を作る」だけなのに対し、こちらは**中身まで足して閉じる**
 * ── 追記欄は編集画面を開かないので、本文が完成した形で返る必要がある。
 * ⚠ **空の追記は作らない**(base をそのまま返す)── 押し間違いで日時見出しだけの
 * 空節が積もると、ログが読めなくなる。
 */
export function appendBlock(base: string, heading: string | null, text: string): string {
  const body = text.replace(/\s+$/, '');
  if (body === '') return base;
  return `${appendAt(base, heading).text}${body}\n`;
}

/** 書式パネルが持つ操作。⚠ ここに足す = ボタンが増える(表が正本)。 */
export type FormatOp =
  | LinePrefix
  | 'bold'
  | 'italic'
  | 'code'
  | 'link'
  | 'table'
  | 'mermaid'
  | 'codeblock';

/**
 * 書式パネルの中身(**並び順もここが正本**)。
 * ⚠ 文言は「何になるか」で書く ── 「H1」ではなく「見出し1」。
 * 図案は付けない:14 個も絵文字が並ぶと、かえって読めなくなる(高さは CSS が揃える)。
 */
export const FORMAT_OPS: readonly { op: FormatOp; label: string }[] = [
  { op: 'h1', label: '見出し1' },
  { op: 'h2', label: '見出し2' },
  { op: 'h3', label: '見出し3' },
  { op: 'bold', label: '太字' },
  { op: 'italic', label: '斜体' },
  { op: 'code', label: 'コード' },
  { op: 'ul', label: '箇条書き' },
  { op: 'ol', label: '番号' },
  { op: 'task', label: 'チェック' },
  { op: 'quote', label: '引用' },
  { op: 'link', label: 'リンク' },
  { op: 'table', label: '表' },
  { op: 'mermaid', label: '図' },
  { op: 'codeblock', label: 'コード塊' },
] as const;

const LINE_OPS: ReadonlySet<string> = new Set(Object.keys(LINE_MARKS));

/** 1 つの入口。⚠ 分岐をここに閉じ込める(呼ぶ側に op ごとの知識を漏らさない)。 */
export function applyFormat(sel: TextSelection, op: FormatOp): TextSelection {
  if (LINE_OPS.has(op)) return toggleLinePrefix(sel, op as LinePrefix);
  switch (op) {
    case 'bold':
      return toggleWrap(sel, '**');
    case 'italic':
      return toggleWrap(sel, '*');
    case 'code':
      return toggleWrap(sel, '`');
    case 'link':
      return insertLink(sel);
    case 'table':
      return insertBlock(sel, TABLE_BLOCK);
    case 'mermaid':
      return insertBlock(sel, MERMAID_BLOCK);
    case 'codeblock':
      return insertBlock(sel, CODE_BLOCK);
    default:
      return sel;
  }
}
