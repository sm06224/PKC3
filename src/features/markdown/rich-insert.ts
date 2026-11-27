/**
 * 🔴 **リッチ編集のブロック挿入の一覧**(v4.0 Phase 1 / PR-06。ビジョン 4-B)。
 *
 * リッチ編集のセルで、空の段落に `/` を打ったとき・セルの端の `+` を押したときに出す一覧の**正本**。
 * 項目・字・絞り込みの語・当てた結果の原文は、すべてここ 1 か所で決める(画面側は並べて押すだけ)。
 *
 * ## 2 つの当て方
 * - **種類を変える**(見出し 1〜3 / 箇条書き / 番号付きリスト / チェックリスト / 引用)── いまのブロックの
 *   中身をそのまま新しい枠に入れ、**リッチ編集を続ける**(`mode: 'rich'`)。
 * - **差し込む**(コードブロック / 表 / 注意書き / 改ページ / 図 / 3D シーン)── 書式の帯と**同じ規則**
 *   (`applyFormat`)でテンプレートを作り、**原文の編集へ移る**(`mode: 'source'`。リッチでは表せない)。
 *   中身が空ならブロックをテンプレートに置き換え、空でなければブロックの後ろに空行を挟んで足す。
 *
 * ⚠ テンプレートの字を 2 本目書かない ── 書式の帯の「その他 ▾」と同じ `applyFormat` の 1 本。
 * ⚠ pure module(DOM も state も知らない)。
 */
import { composeRichBlock, parseRichBlock, type RichBlockMeta } from './rich-block';
import { applyFormat, insertBlock, SCENE_3D_BLOCK, type FormatOp } from './text-ops';

export type RichInsertId =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'ul'
  | 'ol'
  | 'task'
  | 'quote'
  | 'codeblock'
  | 'table'
  | 'callout'
  | 'pagebreak'
  | 'mermaid'
  | 'scene3d';

export interface RichInsertItem {
  readonly id: RichInsertId;
  /** 一覧に出す字。⚠ 標準の日本語 IT 用語(`ui-terms.ts`)。 */
  readonly label: string;
  /** 一覧の説明欄の字。 */
  readonly hint: string;
  /** 絞り込みに当たる語(`/見出し` `/code` など。小文字で比べる)。 */
  readonly keys: readonly string[];
  /** 種類を変える(リッチのまま)か、テンプレートを差し込む(原文の編集へ)か。 */
  readonly kind: 'convert' | 'insert';
}

/** 一覧(この順で出す)。⚠ 字を変えたらマニュアルの「リッチ編集」の節も直す。 */
export const RICH_INSERT_ITEMS: readonly RichInsertItem[] = [
  { id: 'h1', label: '見出し 1', hint: 'このブロックを見出し 1 にします', keys: ['見出し', 'みだし', 'heading', 'h1'], kind: 'convert' },
  { id: 'h2', label: '見出し 2', hint: 'このブロックを見出し 2 にします', keys: ['見出し', 'みだし', 'heading', 'h2'], kind: 'convert' },
  { id: 'h3', label: '見出し 3', hint: 'このブロックを見出し 3 にします', keys: ['見出し', 'みだし', 'heading', 'h3'], kind: 'convert' },
  { id: 'ul', label: '箇条書き', hint: 'このブロックを箇条書きの項目にします', keys: ['箇条書き', 'かじょうがき', 'リスト', 'list', 'bullet', 'ul'], kind: 'convert' },
  { id: 'ol', label: '番号付きリスト', hint: 'このブロックを番号付きリストの項目にします', keys: ['番号', 'ばんごう', 'リスト', 'list', 'number', 'ol'], kind: 'convert' },
  { id: 'task', label: 'チェックリスト', hint: 'このブロックをチェック項目にします', keys: ['チェック', 'ちぇっく', 'タスク', 'todo', 'task', 'check'], kind: 'convert' },
  { id: 'quote', label: '引用', hint: 'このブロックを引用にします', keys: ['引用', 'いんよう', 'quote'], kind: 'convert' },
  { id: 'codeblock', label: 'コードブロック', hint: '空のコードブロックを差し込み、原文で編集します', keys: ['コード', 'こーど', 'code', 'codeblock'], kind: 'insert' },
  { id: 'table', label: '表', hint: '2 列の空の表を差し込み、原文で編集します', keys: ['表', 'ひょう', 'テーブル', 'table'], kind: 'insert' },
  { id: 'callout', label: '注意書き', hint: '注意書きのブロック(:::note)を差し込み、原文で編集します', keys: ['注意', 'ちゅうい', 'メモ', 'note', 'callout'], kind: 'insert' },
  { id: 'pagebreak', label: '改ページ', hint: '改ページ(+++)を差し込みます(印刷・PDF ではここで次のページに移ります)', keys: ['改ページ', 'かいぺーじ', 'ページ', 'page', 'break', 'pagebreak'], kind: 'insert' },
  { id: 'mermaid', label: '図(Mermaid)', hint: '図のテンプレートを差し込み、原文で編集します', keys: ['図', 'ず', 'mermaid', 'diagram', 'chart'], kind: 'insert' },
  { id: 'scene3d', label: '3D シーン', hint: '回して見られる 3D の図の最小形を差し込み、原文で編集します', keys: ['3d', '立体', 'りったい', 'scene', 'model'], kind: 'insert' },
];

/** 差し込みの項目 → 書式の帯の op(テンプレートの正本)。 */
const INSERT_OP: Readonly<Partial<Record<RichInsertId, FormatOp>>> = {
  codeblock: 'codeblock',
  table: 'table',
  callout: 'callout-note',
  pagebreak: 'pagebreak',
  mermaid: 'mermaid',
};

/** 種類を変える項目 → 新しい枠。 */
function metaFor(id: RichInsertId): RichBlockMeta | null {
  switch (id) {
    case 'h1':
    case 'h2':
    case 'h3':
      return { kind: 'heading', level: Number(id.slice(1)), indent: '', marker: '', checked: null };
    case 'ul':
      return { kind: 'list-item', level: 0, indent: '', marker: '-', checked: null };
    case 'ol':
      return { kind: 'list-item', level: 0, indent: '', marker: '1.', checked: null };
    case 'task':
      return { kind: 'list-item', level: 0, indent: '', marker: '-', checked: ' ' };
    case 'quote':
      return { kind: 'quote', level: 0, indent: '', marker: '', checked: null };
    default:
      return null;
  }
}

/** 正規化(全角の英数字は半角へ・小文字へ)── `/ｃｏｄｅ` でも当たるように。 */
function norm(s: string): string {
  return s.normalize('NFKC').toLowerCase().trim();
}

/**
 * 絞り込み(`/` の後ろに打った字)。空なら全部。字・語のどれかの頭に当たるか、字の中に含めば残す。
 */
export function filterRichInsert(query: string): readonly RichInsertItem[] {
  const q = norm(query);
  if (q === '') return RICH_INSERT_ITEMS;
  return RICH_INSERT_ITEMS.filter((it) => norm(it.label).includes(q) || it.keys.some((k) => norm(k).startsWith(q)));
}

/**
 * スラッシュの絞り込みの字か(ブロックの中身が `/` か `／` で始まり、空白・改行を含まない)。
 * @returns 絞り込みの語(`/` の後ろ)。当たらなければ `null`
 */
export function slashQueryOf(content: string): string | null {
  const m = /^[/／]([^\s]*)$/.exec(content);
  return m === null ? null : m[1]!;
}

/** 当てた結果。`text` はブロックの原文、`start`/`end` はその中の選択。 */
export interface RichInsertResult {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** リッチのまま続ける(種類を変えた)/ 原文の編集へ移る(テンプレートを差し込んだ)。 */
  readonly mode: 'rich' | 'source';
}

/**
 * 🔴 **項目を当てる**。
 * @param source いまのブロックの原文(LF)
 * @param stripSlash `/` で開いた一覧なら真(中身の `/…` を消してから当てる)
 */
export function applyRichInsert(id: RichInsertId, source: string, stripSlash: boolean): RichInsertResult {
  const parsed = parseRichBlock(source);
  let content = parsed?.content ?? source;
  if (stripSlash && slashQueryOf(content) !== null) content = '';
  const meta = metaFor(id);
  if (meta !== null) {
    // ⚠ 原文が単純ブロックで読めないときは中身をそのまま段落の字として扱う(壊さない)
    const text = composeRichBlock(meta, content);
    return { text, start: text.length, end: text.length, mode: 'rich' };
  }
  // ⚠ 3D シーンは書式バーの op を持たない ── 「テンプレートを挿入」と同じ雛形(`SCENE_3D_BLOCK`)を使う
  const empty = { text: '', start: 0, end: 0 };
  const tpl = id === 'scene3d' ? insertBlock(empty, SCENE_3D_BLOCK) : applyFormat(empty, INSERT_OP[id]!);
  // 末尾の改行はブロックの区切り(行の範囲の書き戻しが空行を足す)── 落とす
  const body = tpl.text.replace(/\n+$/, '');
  const caret = Math.min(tpl.start, body.length);
  if (content === '') return { text: body, start: caret, end: caret, mode: 'source' };
  // 中身が在れば、いまのブロックを保ったまま後ろに足す(空行で区切る)
  const head = parsed === null ? source : composeRichBlock(parsed.meta, content);
  const off = head.length + 2;
  return { text: `${head}\n\n${body}`, start: off + caret, end: off + caret, mode: 'source' };
}
