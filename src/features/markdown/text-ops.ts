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
/**
 * 図の雛形(mermaid = フローチャート)。⚠ **変えない** ── 「図」で「フローチャート」を
 * 選んだとき(#528 案 B)と、雛形の一覧の「図」が入れるのはこれ。
 */
export const MERMAID_BLOCK = template('```mermaid\ngraph TD\n  A-->B\n```\n');

/**
 * 🔴 **UML の雛形**(#528 段①。user 要望 2026-08-28「**うちは UML とかも
 * できるようにしたいね**」)。
 *
 * ⚠ **描き手は前から描けた** ── mermaid は 22 種を受ける(実測。マニュアル
 *   「どんな図が描けるか」に全数)。足りていなかったのは**入れる口**である:
 *   「図」のボタンは `graph TD` しか入れないので、
 *   **1 行目を書き換えられると知っている人しかクラス図を描けなかった**。
 * 🔑 だから作るのは記法ではなく**動線**である(#491 と同じ型 ──
 *   「無い」ではなく「在るのに辿れない」)。
 *
 * ⚠ **帯のボタンも鍵も増やさない。** 帯は既に 14 個で横に長く、
 *   `onBar: false` の 4 つは**既定の鍵を 1 つずつ食う**(`Alt+Shift+…`)。
 *   入口は**既にある「雛形を入れる」の一覧**にする ── そこは
 *   「入れたい塊を選ぶ」用事そのもので、押し所も鍵も 1 つも増えない。
 *   🔑 **段②(#528 案 B。user 裁定 2026-09-04)で入口がもう 1 つ増えた** ──
 *   帯の「図」そのもの(`DIAGRAM_CHOICES`)。ボタンの数は変わらない
 *   (同じボタンが**先に聞く**ようになっただけ)。「図」を押した人が UML に
 *   辿り着けないままだったので、そこに置いた。
 * ⚠ **22 種を全部は並べない。** 一覧は user 自身の雛形を探す場所でもあるので、
 *   組み込みが 26 行になると本業を埋める。user が名指しした **UML の 4 種**に絞り、
 *   残りは**マニュアルの全数表**が受け持つ(そちらは 1 行目の名前で引ける)。
 *   🔑 これが覆る条件:user が「一覧から全部選びたい」と言ったとき、
 *   または一覧が種類で畳める形になったとき。
 *
 * ⚠ 中身は**そのまま描ける最小形**にする(実測で確かめた)── 空の枠を入れると、
 *   user は「書き方が分からないまま赤い理由だけ見る」ことになる。
 */
export interface DiagramTemplate {
  readonly id: string;
  readonly label: string;
  readonly block: TemplateBlock;
}

export const DIAGRAM_TEMPLATES: readonly DiagramTemplate[] = [
  {
    id: 'class',
    label: 'クラス図',
    block: template(
      '```mermaid\nclassDiagram\n  class 帳簿 {\n    +記帳()\n  }\n  帳簿 <|-- 出納帳\n```\n',
    ),
  },
  {
    id: 'sequence',
    label: 'シーケンス図',
    block: template(
      '```mermaid\nsequenceDiagram\n  参加者 A ->> 参加者 B: お願いします\n' +
        '  参加者 B -->> 参加者 A: できました\n```\n',
    ),
  },
  {
    id: 'state',
    label: '状態遷移図',
    block: template(
      '```mermaid\nstateDiagram-v2\n  [*] --> 下書き\n  下書き --> 確認中: 出す\n' +
        '  確認中 --> 完了: 通る\n  確認中 --> 下書き: 差し戻し\n  完了 --> [*]\n```\n',
    ),
  },
  {
    id: 'er',
    label: 'ER 図',
    block: template(
      '```mermaid\nerDiagram\n  顧客 ||--o{ 注文 : "出す"\n' +
        '  注文 ||--|{ 明細 : "含む"\n```\n',
    ),
  },
];

/**
 * 🔴 **帯の「図」を押したときに選べる一覧**(#528 案 B。user 裁定 2026-09-04
 * 「全部推薦で」)。
 *
 * ⚠ 直す前は「図」= `graph TD` の 2 行が**必ず**入る形だった ── UML の 4 種は
 *   `DIAGRAM_TEMPLATES` に在るのに、入口は「雛形」の一覧だけで、
 *   **「図」を押した人はそこに辿り着けなかった**。
 * 🔑 1 手増える(押す → 選ぶ)。それが裁定 B である ── 代わりに、5 種のどれも
 *   **マウスだけで**入る。
 * ⚠ **先頭はこれまでのフローチャート**(`MERMAID_BLOCK` そのもの)── 今までの
 *   user の手触り(「図」→ Enter で `graph TD`)を変えない。
 * ⚠ 字は `DIAGRAM_TEMPLATES` から引く(**表が正本**)── ここで打ち直さない。
 */
export const DIAGRAM_CHOICES: readonly DiagramTemplate[] = [
  { id: 'flowchart', label: 'フローチャート', block: MERMAID_BLOCK },
  ...DIAGRAM_TEMPLATES,
];
/** コードブロックの雛形。カーソルは中。 */
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

/**
 * 🔴 **ルビを入れる**(#425 段②-a)。`[[ruby:漢字|かんじ]]` の形。
 *
 * ⚠ **選んだ字を base にする** ── 「読みを付けたい語を選んでから押す」が自然な順で、
 *   そのとき caret は**読みの側**へ置く(次に打つのは読みだから)。
 * ⚠ 選んでいなければ **base の位置**へ置く(帯の他のボタンと同じ作法)。
 */
export function insertRuby(sel: TextSelection): TextSelection {
  const { text, start, end } = sel;
  const base = text.slice(start, end);
  const body = `[[ruby:${base}|]]`;
  const next = text.slice(0, start) + body + text.slice(end);
  // 読みの位置 = `[[ruby:` + base + `|` の直後
  const caret = base === '' ? start + '[[ruby:'.length : start + body.length - 2;
  return { text: next, start: caret, end: caret };
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
  | 'codeblock'
  /**
   * 🔴 **帯に出さない 4 つ**(#425 段②-a)── 描き手は前から持っているのに、
   * **押して入れる口が 1 つも無かった**記法である(`markdown-render.ts:894-896`)。
   * ⚠ 帯は既に 14 個で横に長いので**並びは増やさない** ── 入口は
   *   **鍵**(既定 `Alt+Shift+…`)と、設定のショートカット画面での付け替え。
   */
  | 'highlight'
  | 'ruby'
  | 'emdot'
  | 'strike';

/**
 * 書式パネルの中身(**並び順もここが正本**)。
 * ⚠ 文言は「何になるか」で書く ── 「H1」ではなく「見出し1」。
 * 図案は付けない:14 個も絵文字が並ぶと、かえって読めなくなる(高さは CSS が揃える)。
 * 🔴 `hint` は帯のボタンの説明(`title`)になる(#717)。⚠ 直す前は 14 個とも説明が無く、
 *   「番号」「表」の 1 語で何が起きるか読めなかった ── **起きること**を 1 文で書く
 *   (user 指示 2026-08-21)。鍵が割り当たっている op は描く側(`format-bar.ts`)が
 *   `hintTitle` で鍵を併記する ── ここには鍵の綴りを書かない(割当は user が変えられる)。
 */
export const FORMAT_OPS: readonly {
  op: FormatOp;
  label: string;
  hint: string;
  onBar?: false;
}[] = [
  { op: 'h1', label: '見出し1', hint: 'この行を見出し1にします(もう一度押すと外れます)' },
  { op: 'h2', label: '見出し2', hint: 'この行を見出し2にします(もう一度押すと外れます)' },
  { op: 'h3', label: '見出し3', hint: 'この行を見出し3にします(もう一度押すと外れます)' },
  { op: 'bold', label: '太字', hint: '選んだ範囲を太字にします(もう一度押すと外れます)' },
  { op: 'italic', label: '斜体', hint: '選んだ範囲を斜体にします(もう一度押すと外れます)' },
  { op: 'code', label: 'コード', hint: '選んだ範囲をコードにします(もう一度押すと外れます)' },
  { op: 'ul', label: '箇条書き', hint: 'この行を箇条書きにします(もう一度押すと外れます)' },
  { op: 'ol', label: '番号', hint: 'この行を番号付きリストにします(もう一度押すと外れます)' },
  { op: 'task', label: 'チェック', hint: 'この行をチェック項目にします(もう一度押すと外れます)' },
  { op: 'quote', label: '引用', hint: 'この行を引用にします(もう一度押すと外れます)' },
  { op: 'link', label: 'リンク', hint: 'リンクの形を入れて、URL の所を選んだ状態にします' },
  { op: 'table', label: '表', hint: '2 列の表の雛形を差し込みます' },
  /**
   * 🔴 **「図」は帯に**この表からは**出さない**(#528 案 B。user 裁定 2026-09-04)。
   * ⚠ 帯の「図」は**先に聞く**(5 種の一覧 `DIAGRAM_CHOICES`)ので、
   *   「その場で字を変える」この表の並びには居られない ── 日付 / 雛形と同じ理由。
   *   ボタンそのものは `format-bar.ts` が**同じ場所**(表の隣)に置く。
   * ⚠ `op` は消さない ── 雛形の一覧の「図」(`BUILTIN_SNIPPET_OPS`)と
   *   一覧の先頭(フローチャート)が `MERMAID_BLOCK` を挿す口として使う。
   */
  { op: 'mermaid', label: '図', hint: '図の雛形を差し込みます', onBar: false },
  { op: 'codeblock', label: 'コードブロック', hint: 'コードブロックの雛形を差し込みます' },
  /**
   * 🔴 **帯には出さない**(`onBar: false`)。⚠ **表は 1 つのまま**にしてある ──
   * 「書式の操作は何があるか」と「帯に何を並べるか」を別の表に分けると、
   * 片方だけ増えて食い違う(CLAUDE.md §7)。帯を描く側がこの印で絞る。
   * 🔑 名前はパレットとショートカット画面に出るので、**知る口はある**。
   */
  { op: 'highlight', label: 'ハイライト', hint: '選んだ範囲をハイライトします', onBar: false },
  { op: 'ruby', label: 'ルビ', hint: '選んだ字にルビを付けます', onBar: false },
  { op: 'emdot', label: '圏点', hint: '選んだ字に圏点を打ちます', onBar: false },
  { op: 'strike', label: '打ち消し', hint: '選んだ範囲に打ち消し線を引きます', onBar: false },
] as const;

/** 帯に並べるもの。⚠ **絞るのはここ 1 か所**(描く側が自分で絞らない)。 */
export const BAR_FORMAT_OPS: readonly { op: FormatOp; label: string; hint: string }[] =
  FORMAT_OPS.filter((f) => f.onBar !== false);

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
    /**
     * ⚠ **綴りは描き手から引いた**(`markdown-render.ts:894` / `:1001`)──
     * 圏点は**新形の `^^`** を使う(`[[em:…]]` は同じ意味の古い形で、
     * 描き手は両方読むが、**入れるのは新しいほうだけ**にする)。
     */
    case 'highlight':
      return toggleWrap(sel, '==');
    case 'emdot':
      return toggleWrap(sel, '^^');
    case 'strike':
      return toggleWrap(sel, '~~');
    /**
     * 🔴 **ルビだけは対称ではない**(`[[ruby:base|reading]]`)ので、
     *   囲むのではなく**組み立てて、読みの位置に caret を置く**。
     * ⚠ 選んでいなければ base も空 ── そのときは **base の位置**に置く
     *   (打ち始められる所へ置く、が書式の帯の既定の作法)。
     */
    case 'ruby':
      return insertRuby(sel);
    default:
      return sel;
  }
}

// ── auto pair(2026-08-05。ライブエディタ S5c。user 提案 §5.6 ②)─────────────
//
// > user 提案「**auto pair は開放終端をそもそも作りにくくする機構であり、入力補助な**」
//
// 🔑 **規則はここ 1 か所**(pure)。`row-swap.ts` は結果を挿すだけ ── DOM 側に
// 2 本目の規則を書かない(本 module の冒頭の方針と同じ)。
// ⚠ **返すのは「挿す文字列」**であって新しい本文ではない ── 呼び側が
// `execCommand('insertText')` で挿せる形にしておく(そうしないと **Ctrl+Z で戻せない**)。

/** 行内で対になる記号 → 閉じ。 */
const INLINE_PAIRS: Readonly<Record<string, string>> = {
  '`': '`',
  '[': ']',
  '(': ')',
  '{': '}',
  '「': '」',
  '『': '』',
  '（': '）',
  '【': '】',
  '"': '"',
};

/**
 * 🔴 **行頭に 3 つ並べるとブロックになる記号** → その閉じ。
 *
 * ここが auto pair の本題である ── 行内の対(`**` など)が閉じていなくても
 * 描画は原文どおりに見えるだけだが、**ブロックは閉じないと後続を飲み込む**。
 */
const BLOCK_MARKERS: Readonly<Record<string, string>> = {
  '`': '```',
  ':': ':::',
};

export interface AutoPair {
  /**
   * 🔴 **何をするか**(2026-08-21)。
   * - `'insert'` … `insert` を挿して caret を `start`/`end` へ
   * - `'skip'` … **何も挿さず**、caret を `start`/`end` へ動かすだけ
   *   (= すぐ右に在る閉じを**通り抜ける**)
   *
   * ⚠ 通り抜けを `insert: ''` で表さない ── 呼び側は `execCommand('insertText')`
   *   で挿すので、空文字を撃つと **undo の粒度が変わる**(この file 冒頭の戒め)。
   */
  kind: 'insert' | 'skip';
  /** いまの選択範囲を置き換えて挿す文字列(`kind: 'skip'` では空)。 */
  insert: string;
  /** 挿した後の選択(caret)。 */
  start: number;
  end: number;
}

/**
 * 閉じ記号の集合(`INLINE_PAIRS` の値)。
 *
 * ⚠ **同字対**(バッククォート / 二重引用符)は開きと閉じが同じなので、ここにも入る
 *   ── だから**通り抜けを先に判定する**。後回しにすると新しい対を開いてしまい、
 *   被害が 1 文字増える(実測で確認した)。
 */
const CLOSERS: ReadonlySet<string> = new Set(Object.values(INLINE_PAIRS));

/**
 * その打鍵で補うものを返す。補わないなら `null`(= ブラウザにそのまま打たせる)。
 *
 * ⚠ **行頭では行内の対を作らない** ── `` ``` `` を組み立てている途中に
 * `` ` `` を対にすると `` `````` `` になって、狙いと逆に壊れる。
 * ⚠ ブロックの閉じは**次の行**に置く(markdown の閉じ記号は行頭でなければ効かない)。
 * ⚠ 変換中に呼ばないのは**呼び側の責任**(`ke.isComposing` を 1 か所で見る)。
 */
export function autoPairFor(sel: TextSelection, key: string): AutoPair | null {
  const { text, start, end } = sel;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const prefix = text.slice(lineStart, start);
  const nl = text.indexOf('\n', end);
  const rest = text.slice(end, nl === -1 ? text.length : nl);
  const block = BLOCK_MARKERS[key];
  // 行頭からその記号だけが並んでいて、後ろに何も無い = ブロック記号を組んでいる
  if (
    block !== undefined &&
    start === end &&
    rest.trim() === '' &&
    prefix === key.repeat(prefix.length)
  ) {
    // 3 つ目で閉じを次の行に置く。caret は**開き記号の直後**(言語 / 名前を打つ所)
    if (prefix.length === 2) {
      return { kind: 'insert', insert: key + '\n' + block, start: start + 1, end: start + 1 };
    }
    return null;
  }
  /**
   * 🔴 **閉じを打ったら、すぐ右に在る同じ閉じを通り抜ける**(2026-08-21)。
   *
   * ⚠ **これが無いと、対になる 9 記法すべてで閉じが二重になる**(実測 9/9)──
   *   `tags: [あ, い]` と打つと `tags: [あ, い]]` になり、しかも frontmatter は
   *   それを **警告 0 件で `{tags:["あ","い]"]}` と読む**(= タグが無言で別物になる)。
   * ⚠ **開きの判定より先に置く** ── 同字対は開きでもあるので、後回しにすると
   *   通り抜けではなく**新しい対を開く**。
   * ⚠ 選択があるときは通り抜けない(選んだ文字を閉じで囲む方が自然)。
   */
  if (start === end && CLOSERS.has(key) && text[start] === key) {
    return { kind: 'skip', insert: '', start: start + 1, end: start + 1 };
  }
  const close = INLINE_PAIRS[key];
  if (close === undefined) return null;
  // 選択があるときは**囲む**(選んだ文字を消さない)
  if (start !== end) {
    const inner = text.slice(start, end);
    return {
      kind: 'insert',
      insert: key + inner + close,
      start: start + 1,
      end: start + 1 + inner.length,
    };
  }
  return { kind: 'insert', insert: key + close, start: start + 1, end: start + 1 };
}
