/**
 * 書式パネル(P8 段⑥)。
 *
 * > user 指摘 2026-08-03「**書式設定系のパネルも必要 / 何もかも足りない**」
 *
 * 🔑 中身は `FORMAT_OPS` が正本 ── ここは**並べるだけ**。表とボタンがずれると
 * 「押しても何も起きないボタン」が生まれるので、対応表をここに持たない。
 *
 * ⚠ 図案は付けない。14 個の絵文字が並ぶと読めない ── 高さは CSS(`--row-h`)が
 * 揃えるので、文字だけでもボタンの寸法は乱れない(段④ の規約)。
 * ⚠ **押した瞬間に focus が飛ぶ**のを binder が `mousedown` で抑止している
 * (→ `binder.ts`)。抑止が無いと、押すたびに編集欄が focus を失って画面が
 * ちらつく ── 選択位置そのものは focus を失っても残るので、壊れはしない。
 */
import { BAR_FORMAT_OPS, WRAPS_SELECTION_OPS, type FormatOp } from '@features/markdown/text-ops';
import { FORMAT_BAR_GROUPS, FORMAT_BAR_MORE_GROUPS, type BarItem } from '@features/markdown/format-bar-layout';
import { findCommand } from '@features/keymap';
import { WRAPS_SELECTION_ATTR } from './format-wrap-hint';
import { HINT_BASE, HINT_COMMAND, hintTitle } from './shortcut-hint';

/**
 * 🔴 **選ぶと「囲む」側へ倒れるボタンに印を付ける**(#950 ①)。⚠ **どの op か**は
 *   `WRAPS_SELECTION_OPS`(押したときの振る舞いと同じ集合)が決める ── ここで手で並べない。
 *   説明の切替は `format-wrap-hint.ts` が印を読んで行う(字は変えない ── 帯の高さが動く)。
 */
function markWraps(btn: HTMLElement, op: FormatOp): void {
  if (WRAPS_SELECTION_OPS.has(op)) btn.setAttribute(WRAPS_SELECTION_ATTR, op);
}

/**
 * 🔴 **狭い画面で、1 段に残す書式のボタン**(台帳 #1852、#1163 依頼 237 = A)。
 * 横向きや縦の短いスマホ(`data-pkc-layout='phone'`)で帯が 2〜5 段になり、書く欄が 1 行ぶんしか残らなかった。
 * 残りは「…」(`FORMAT_MORE_FIELD`)で開く。⚠ 狭くない画面は 1 px も変わらない(CSS が phone のときだけ畳む)。
 * 🔑 選んだのは、スマホで続けて押す書式(太字 / 斜体 / 箇条書き / チェック / リンク)。見出しや表などは「…」の中
 *   (開くと直接出す塊が全部と「その他 ▾」が並ぶ。「その他 ▾」の一覧は広い画面と同じ)。
 */
export const COMPACT_BAR_OPS: ReadonlySet<string> = new Set(['bold', 'italic', 'ul', 'task', 'link']);
/** 「…」ボタンの `data-pkc-field`。⚠ `data-pkc-action` は持たない(開閉は帯の中で完結する ── 直接配線)。 */
export const FORMAT_MORE_FIELD = 'format-more';
/** 狭い画面で「…」の中にしまうボタンの印。⚠ CSS が読む(`app.css` のスマホの節)。 */
export const FORMAT_MORE_ITEM_ATTR = 'data-pkc-format-more-item';
/** 「…」を開いている印(帯に付く)。 */
export const FORMAT_MORE_OPEN_ATTR = 'data-pkc-more-open';
const FORMAT_MORE_TITLE = '書式のボタンを、残りも含めてすべて出します / しまいます';

const RENUMBER_TITLE = '番号付きリストの番号を、上から順に振り直します';
const SORT_TASKS_TITLE =
  'カーソルのあるチェックリストで、完了した項目をリストの末尾へ移動して整理します。リストの外にカーソルがあるときは、すべてのリストを整理します';

/** 「その他 ▾」(帯の最後の直接ボタン)の `data-pkc-action`。押すと binder が隠した元(`FORMAT_MORE_SOURCE_FIELD`)を読んで一覧にする。 */
export const FORMAT_MORE_MENU_ACTION = 'open-format-more';
export const FORMAT_MORE_MENU_LABEL = 'その他 ▾';
const FORMAT_MORE_MENU_HINT = '図・コードブロック・数式・日付・テンプレートなど、ふだん使わない書式や道具の一覧を開きます';
/** 隠した元のボタンを積む器(`hidden`)。⚠ 一覧の項目・並び・塊はここが正本(`exportMenuItemsFrom` が読む)。 */
export const FORMAT_MORE_SOURCE_FIELD = 'format-more-source';
/** 直接出すボタンの塊の器。 */
export const FORMAT_GROUP_FIELD = 'format-group';

/** 道具(書式の表に載らないボタン)の字・説明。⚠ 説明の鍵(`command`)を持つものは `hintTitle` で割当を併記する。 */
interface ToolSpec {
  readonly action: string;
  readonly label: string;
  readonly hint: string;
  /** 鍵の命令 id(`KEY_COMMANDS`)。無ければ素の説明。 */
  readonly command?: string;
  /** 押すと囲む側へ倒れるボタン(#950 ①)の op。 */
  readonly wraps?: FormatOp;
  /** 押す前から持つ `aria-expanded`。 */
  readonly expanded?: boolean;
}

const TOOL_SPECS: readonly ToolSpec[] = [
  /** ⚠ 「先に聞く」道具は `FORMAT_OPS` に入れない(あちらは**その場で字を変える**表)。 */
  {
    action: 'insert-entry-link',
    label: 'ノートリンクを入れる',
    hint: '別のノートを題名で探して、そこへのリンクを打っている場所に入れます',
    command: 'insert-entry-link',
  },
  {
    action: 'insert-attachment',
    label: '添付を入れる',
    hint: '添付を題名で探して、打っている場所に入れます。画像は画像として、ほかのファイルはリンクとして入ります',
  },
  {
    action: 'insert-diagram',
    label: '図を入れる',
    // 🔴 #950 着地前レビュー ④: 選んでいるときは一覧を出さず囲む ── 両方の場合を書く
    hint:
      '選んでいれば、選んだ範囲を ```mermaid で囲みます。' +
      '選んでいなければ、フローチャート / クラス図 / シーケンス図 / 状態遷移図 / ER 図 から選べます',
    // ⚠ 押すと囲む側は `mermaid`(op は別)
    wraps: 'mermaid',
  },
  {
    action: 'insert-callout',
    label: '注意書き',
    hint: '注意書きの種類(メモ / ヒント / 警告など)を選んで、選んだ範囲(無ければ空)をそのブロックにします',
    command: 'insert-callout',
  },
  {
    action: 'insert-date',
    label: '日付を入れる',
    hint: '日付を選んで、打っている場所に入れます',
    command: 'insert-date',
  },
  {
    action: 'insert-snippet',
    label: 'テンプレートを入れる',
    hint: 'テンプレートを一覧から選んで、打っている場所に入れます',
    command: 'insert-snippet',
  },
  {
    action: 'insert-icon',
    label: 'アイコンを入れる',
    hint: 'アイコンを入れます。押すとアイコンの一覧が出て、選ぶと打っている場所に入ります',
  },
  /**
   * 🔴 字は「番号を振り直す」(#717)。⚠ 「番号」(番号付きリストにする)と同じ字を並べない。
   *   押したときだけ全文に効く(ライブエディタは行ごとに欄を出すので、打つたびに全文を書き換えない ── #396)。
   */
  { action: 'renumber-lists', label: '番号を振り直す', hint: RENUMBER_TITLE },
  { action: 'sort-tasks', label: '完了項目を末尾へ', hint: SORT_TASKS_TITLE },
  // 🔴 #766 D-3 ── 押すと本文の欄へ当てる命令(`inline-calc`)をそのまま呼ぶ
  { action: 'calc-line', label: 'この行を計算する', hint: '打っている行の式(2+3= など)を計算して、行の終わりに答えを入れます' },
  // 🔴 読む面の帯の「探す」と同じ口(`find-in-note`)。編集中は 2 ペインのプレビュー / ライブエディタの描かれた本文を探す
  {
    action: 'find-in-note',
    label: 'ノート内を探す',
    hint: 'このノートの本文の中だけを探す小さな欄を開きます',
    command: 'find-in-note',
  },
  // ⚠ 置換が効くのは編集中の本文なので、閲覧中の帯には置かない(押しても効かない導線を作らない)。欄そのものは shell 側
  {
    action: 'toggle-replace',
    label: '置換の欄を開く / 閉じる',
    hint: '編集中のノートの本文で、探す語を全部置き換える欄を開きます / 閉じます',
    command: 'toggle-replace',
    expanded: false,
  },
];

/** 道具の字(行頭の `/` の一覧も帯と同じ字を引く)。⚠ 登録の無い action は `undefined`。 */
export function formatToolLabel(action: string): string | undefined {
  return TOOL_SPECS.find((t) => t.action === action)?.label;
}

/** 説明(`title`)と、割当の併記に要る属性を付ける。⚠ 鍵を持つものは `HINT_*` を名乗る(割当が変わったら `applyShortcutHints` が書き直す)。 */
function applyHint(btn: HTMLElement, hint: string, command: string | undefined): void {
  if (command !== undefined && findCommand(command) !== null) {
    btn.setAttribute(HINT_BASE, hint);
    btn.setAttribute(HINT_COMMAND, command);
    btn.title = hintTitle(hint, command);
  } else {
    btn.title = hint;
  }
}

function labelSpan(text: string): HTMLSpanElement {
  // ⚠ 文字は `label` span に入れる(段④ の規約 ── 文言の突合がここを読む)
  const span = document.createElement('span');
  span.setAttribute('data-pkc-field', 'label');
  span.textContent = text;
  return span;
}

/** 書式(`FORMAT_OPS` の op)のボタン。説明は表の `hint`、鍵が割り当たる op は割当を併記(#717)。 */
function formatButton(op: FormatOp): HTMLButtonElement {
  const entry = BAR_FORMAT_OPS.find((f) => f.op === op);
  if (entry === undefined) throw new Error(`format-bar: ${op} は書式バーに出す書式ではありません`);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('data-pkc-action', 'format-text');
  btn.setAttribute('data-pkc-format', op);
  markWraps(btn, op);
  applyHint(btn, entry.hint, `format-${op}`);
  btn.append(labelSpan(entry.label));
  return btn;
}

/** 置換の帯の id(`shell.ts` が付ける)。⚠ 「置換の欄を開く / 閉じる」ボタンの `aria-controls` が指す先。 */
export const REPLACE_BAR_ID = 'pkc-replace-bar';

/**
 * 🔴 **「置換の欄を開く / 閉じる」ボタンの `aria-expanded` / `aria-controls` を、置換の帯の見え方に合わせる**(#1982 残り 4)。
 *
 * ⚠ 開閉する唯一の所(`binder.ts` の `toggle-replace`)と、帯を描き直したとき(`toolButton`)の**両方がここを通る** ──
 *   書式の「その他 ▾」・操作を探す・ショートカットキー(Ctrl+H)から開閉しても、帯のボタンの印が食い違わない。
 *   帯が無い(shell 前)ときは畳んでいる扱い。
 */
export function syncReplaceToggle(root: ParentNode): void {
  const bar = (root.ownerDocument ?? (root as Document)).getElementById(REPLACE_BAR_ID);
  const open = bar !== null && !bar.hidden;
  for (const b of root.querySelectorAll<HTMLElement>('[data-pkc-action="toggle-replace"]')) {
    b.setAttribute('aria-controls', REPLACE_BAR_ID);
    // 一覧(`role=menuitem`)の項目は開閉の状態を持たない ── 帯のボタンだけに付ける
    if (b.getAttribute('role') === null) b.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
}

/** 道具のボタン(先に聞く / 全文に効く / 探す)。 */
function toolButton(action: string): HTMLButtonElement {
  const spec = TOOL_SPECS.find((t) => t.action === action);
  if (spec === undefined) throw new Error(`format-bar: ${action} の字と説明が登録されていません`);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('data-pkc-action', action);
  if (spec.wraps !== undefined) markWraps(btn, spec.wraps);
  if (spec.expanded !== undefined) btn.setAttribute('aria-expanded', spec.expanded ? 'true' : 'false');
  // 🔴 置換の欄のボタンは、帯のいまの見え方から印を付ける(描き直しても食い違わない。#1982 残り 4)
  if (action === 'toggle-replace') {
    const bar = document.getElementById(REPLACE_BAR_ID);
    btn.setAttribute('aria-controls', REPLACE_BAR_ID);
    btn.setAttribute('aria-expanded', bar !== null && !bar.hidden ? 'true' : 'false');
  }
  applyHint(btn, spec.hint, spec.command);
  btn.append(labelSpan(spec.label));
  return btn;
}

function buttonFor(item: BarItem): HTMLButtonElement {
  return 'op' in item ? formatButton(item.op) : toolButton(item.action);
}

/**
 * 書式パネルを組む。⚠ 押した所は `data-pkc-format` で分かる(binder が読む)。
 *
 * 🔴 **並びと「その他 ▾」の中身は `format-bar-layout.ts` が正本**(#1982 段 3)。直接出すのは普段使いの 4 塊だけで、
 *   残りは隠した元(`format-more-source`)に**同じボタン**(同じ action / 説明 / 押せない状態)のまま置き、
 *   「その他 ▾」を押すと binder がそれを読んで一覧にする(右の列の「その他 ▾」と同じ作法 ── 判定を 2 本に分けない)。
 */
export function buildFormatBar(): HTMLElement {
  const bar = document.createElement('div');
  bar.setAttribute('data-pkc-region', 'format-bar');
  for (const items of FORMAT_BAR_GROUPS) {
    const group = document.createElement('div');
    group.setAttribute('data-pkc-field', FORMAT_GROUP_FIELD);
    for (const item of items) group.append(buttonFor(item));
    bar.append(group);
  }
  const more = document.createElement('button');
  more.type = 'button';
  more.setAttribute('data-pkc-action', 'open-format-more');
  more.setAttribute('aria-haspopup', 'menu');
  more.title = FORMAT_MORE_MENU_HINT;
  more.append(labelSpan(FORMAT_MORE_MENU_LABEL));
  bar.append(more);
  const source = document.createElement('div');
  source.setAttribute('data-pkc-field', FORMAT_MORE_SOURCE_FIELD);
  source.hidden = true;
  for (const g of FORMAT_BAR_MORE_GROUPS) {
    const box = document.createElement('div');
    box.setAttribute('data-pkc-group', g.group);
    for (const item of g.items) box.append(buttonFor(item));
    source.append(box);
  }
  bar.append(source);
  addMoreToggle(bar);
  return bar;
}

/**
 * 🔴 **狭い画面だけ使う「…」と、しまうボタンの印**(依頼 237 = A)。
 * ⚠ 広い画面では CSS が「…」を出さない(`display: none`)ので、並びも高さも今までどおり。
 * ⚠ 開閉は帯の中で完結する(`aria-expanded` と印 1 つ)── アクションの表に載せる操作ではない。
 *   押しても本文の欄から焦点を奪わない(`mousedown` を止める ── 他の書式ボタンと同じ作法)。
 */
function addMoreToggle(bar: HTMLElement): void {
  // ⚠ 隠した元(`format-more-source`)の中のボタンには付けない(一覧の項目であって、帯に並ばない)
  for (const btn of Array.from(bar.querySelectorAll<HTMLElement>('button'))) {
    if (btn.closest(`[data-pkc-field="${FORMAT_MORE_SOURCE_FIELD}"]`) !== null) continue;
    const op = btn.getAttribute('data-pkc-format');
    if (op !== null && COMPACT_BAR_OPS.has(op)) continue;
    btn.setAttribute(FORMAT_MORE_ITEM_ATTR, '');
  }
  const more = document.createElement('button');
  more.type = 'button';
  more.setAttribute('data-pkc-field', FORMAT_MORE_FIELD);
  more.setAttribute('aria-expanded', 'false');
  more.setAttribute('aria-label', FORMAT_MORE_TITLE);
  more.title = FORMAT_MORE_TITLE;
  // ⚠ ほかのボタンと同じく字は `label` の span に入れる(段④ の規約 ── 文言の突合がここを読む)
  const moreLabel = document.createElement('span');
  moreLabel.setAttribute('data-pkc-field', 'label');
  moreLabel.textContent = '…';
  more.append(moreLabel);
  more.addEventListener('mousedown', (ev) => ev.preventDefault());
  more.addEventListener('click', () => {
    const open = !bar.hasAttribute(FORMAT_MORE_OPEN_ATTR);
    bar.toggleAttribute(FORMAT_MORE_OPEN_ATTR, open);
    more.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  // ⚠ 並びの最後に置く。狭い画面では「しまう」ボタンが消えるので、1 段の末尾に「…」だけが残る
  bar.append(more);
}

/**
 * 🔴 **1 行ずつ打つ編集のあいだ、本文全体に効くボタンを灰色にする**(台帳 #1852 I2 / 依頼 78-4。Gemini 回答 = 推薦 B)。
 *
 * - 対象は「番号を振り直す」(「完了項目を末尾へ」は 87-2 でカーソルのあるリストだけに効くようになり、対象から外した)。1 行ずつ打つ編集の欄は**押した 1 ブロックだけ**を持つので、
 *   本文全体には効かない(押すと「「全文を編集」に切り替えてください」と案内が出るだけだった)。
 * - 押す前に分かるよう、灰色にして、マウスを載せると理由を出す。**ボタンの場所は変えない**。
 * - ⚠ `disabled` にはしない ── 押したときの案内(binder の `RENUMBER_LIVE_NOTE` など)は残す。
 *   灰色は `aria-disabled` + CSS(`button[aria-disabled='true']`)で出す。
 * @param bar 書式の帯
 * @param live 1 行ずつ打つ編集のとき真。偽にすると元の説明と見た目に戻る
 */
export function syncWholeNoteTools(bar: ParentNode, live: boolean): void {
  for (const [action, rest] of WHOLE_NOTE_TOOLS) {
    const btn = bar.querySelector<HTMLElement>(`[data-pkc-action="${action}"]`);
    if (btn === null) continue;
    if (live) {
      btn.setAttribute('aria-disabled', 'true');
      btn.title = WHOLE_NOTE_REASON;
    } else {
      btn.removeAttribute('aria-disabled');
      btn.title = rest;
    }
  }
}

/** 灰色のときに出す理由。⚠ 「全文を編集」は画面のボタンの字(`detail.ts`)と同じ。 */
export const WHOLE_NOTE_REASON = '1 行ずつ打つ編集では使えません。「全文を編集」に切り替えると使えます';

/**
 * 灰色にするボタンと、元の説明。
 * 🔴 「完了項目を末尾へ」は入れない(台帳 #1852 / 依頼 87-2 の残り)── 効く範囲が「カーソルのあるリスト」になったので、
 *   1 ブロックだけの欄でも同じ範囲で効く。本文全体が要るのは「番号を振り直す」だけ。
 */
const WHOLE_NOTE_TOOLS: ReadonlyArray<readonly [string, string]> = [['renumber-lists', RENUMBER_TITLE]];
