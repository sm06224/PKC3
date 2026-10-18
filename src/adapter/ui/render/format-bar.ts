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
 * 🔑 選んだのは、スマホで続けて押す書式(太字 / 斜体 / 箇条書き / チェック / リンク)。見出しや表などは「…」の中。
 */
export const COMPACT_BAR_OPS: ReadonlySet<string> = new Set(['bold', 'italic', 'ul', 'task', 'link']);
/** 「…」ボタンの `data-pkc-field`。⚠ `data-pkc-action` は持たない(開閉は帯の中で完結する ── 直接配線)。 */
export const FORMAT_MORE_FIELD = 'format-more';
/** 狭い画面で「…」の中にしまうボタンの印。⚠ CSS が読む(`app.css` のスマホの節)。 */
export const FORMAT_MORE_ITEM_ATTR = 'data-pkc-format-more-item';
/** 「…」を開いている印(帯に付く)。 */
export const FORMAT_MORE_OPEN_ATTR = 'data-pkc-more-open';
const FORMAT_MORE_TITLE = '書式のボタンを、残りも含めてすべて出します / しまいます';

/** 書式パネルを組む。⚠ 押した所は `data-pkc-format` で分かる(binder が読む)。 */
export function buildFormatBar(): HTMLElement {
  const bar = document.createElement('div');
  bar.setAttribute('data-pkc-region', 'format-bar');
  /**
   * ⚠ **帯に出すものだけ**(#425 段②-a)── 絞る規則は `BAR_FORMAT_OPS` が持つ。
   *   ここで `filter` を書くと、表と描き手の 2 か所に規則が生える(§7)。
   */
  for (const { op, label, hint } of BAR_FORMAT_OPS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-pkc-action', 'format-text');
    btn.setAttribute('data-pkc-format', op);
    markWraps(btn, op);
    /**
     * 🔴 **説明(`title`)を付ける**(#717)。⚠ 直す前は 14 個とも無く、「表」「番号」の
     *   1 語で何が起きるか読めなかった。字は表(`FORMAT_OPS.hint`)から引く。
     * 🔑 鍵が割り当たっている op(`format-<op>` が `KEY_COMMANDS` に在る ── 太字 / 斜体 /
     *   リンク)は `hintTitle` で**いまの割当**を併記し、`HINT_*` を名乗って
     *   割当が変わったら `applyShortcutHints` が書き直す(下の「置換」と同じ作法)。
     *   無い op は素の説明だけ ── 空の `()` を出さない。
     */
    const command = `format-${op}`;
    if (findCommand(command) !== null) {
      btn.setAttribute(HINT_BASE, hint);
      btn.setAttribute(HINT_COMMAND, command);
      btn.title = hintTitle(hint, command);
    } else {
      btn.title = hint;
    }
    // ⚠ 文字は `label` span に入れる(段④ の規約 ── 文言の突合がここを読む)
    const text = document.createElement('span');
    text.setAttribute('data-pkc-field', 'label');
    text.textContent = label;
    btn.append(text);
    bar.append(btn);
    /**
     * 🔴 **「図」は表の隣 ── これまでと同じ場所**(#528 案 B。user 裁定 2026-09-04)。
     *
     * ⚠ `FORMAT_OPS` の帯からは外した(`onBar: false`)── 押すと**先に聞く**
     *   (フローチャート / クラス図 / シーケンス図 / 状態遷移図 / ER 図 の一覧)ので、
     *   「その場で字を変える」表の並びには居られない(日付 / 雛形と同じ理由)。
     * ⚠ ただし**置き場は変えない** ── 下の道具の列(日付 …)へ移すと、
     *   表とコードブロックの間に在ったボタンが 1 つ右へ飛ぶ(業務画面の作法
     *   「同じものが常に同じ場所にある」)。だから表の直後に差す。
     */
    if (op === 'table') {
      const diagram = diagramButton();
      // ⚠ 「図」の押すと囲む側は `mermaid`(表の隣に差すだけで、op は別)
      markWraps(diagram, 'mermaid');
      bar.append(diagram);
    }
  }
  /**
   * 🔴 **置換の切替はここ**(2026-08-15、user 指示「中央の上を潰しすぎ /
   * ボタンがボタンすぎる」)。⚠ 置換が効くのは**編集中の本文**なので、
   * 閲覧中の帯に置くと「押しても効かない導線」になる ── 効く場所にだけ置く。
   * ⚠ 欄そのもの(`replace-bar`)は shell 側に在る ── ここは切替だけ。
   *   打鍵のたびに描き直される面へ欄を入れると、打ちかけの語が消える。
   */
  /**
   * 🔴 **日付を入れる道具**(user 指示 2026-08-23)。
   *
   * > 「**日付の記法としては入力がめんどくさいから、日付と時刻を簡単に入力できるし、
   * > ついてくるツールとか用意されてもいいかも**」
   *
   * ⚠ ここに置く理由は 2 つ ── ① **本文を打っている場所**に在る(道具を探しに
   *   行かせない)② **押せる形**なので、マウスだけで完結する(不可侵指示
   *   「マウスだけで完結し、キーボードは近道」)。
   * ⚠ `FORMAT_OPS` には入れない ── あちらは**その場で字を変える**純関数の表で、
   *   こちらは**先に聞く**(ダイアログが挟まる)。同じ表に混ぜると
   *   「押したら何が起きるか」が表から読めなくなる。
   */
  const insertDate = document.createElement('button');
  insertDate.type = 'button';
  insertDate.setAttribute('data-pkc-action', 'insert-date');
  insertDate.setAttribute(HINT_BASE, '日付を選んで、打っている場所に入れます');
  insertDate.setAttribute(HINT_COMMAND, 'insert-date');
  insertDate.title = hintTitle('日付を選んで、打っている場所に入れます', 'insert-date');
  const insertDateLabel = document.createElement('span');
  insertDateLabel.setAttribute('data-pkc-field', 'label');
  insertDateLabel.textContent = '日付を入れる';
  insertDate.append(insertDateLabel);
  bar.append(insertDate);

  /**
   * 🔴 **ノートへのリンクを入れる**(#427 段②)。
   *
   * ⚠ 段① の「参照をコピー」は**相手を開きに行ってから戻る**ので、書いている手が
   *   止まる。ここに在れば、打っている場所から題名で選べる。
   * ⚠ `[[` で出す形は採らない ── 理由は `features/entry-ref/entry-pick.ts` の冒頭
   *   (`insert-date` が `@` を、`insert-snippet` が `/` を退けたのと同じ芯)。
   * ⚠ `FORMAT_OPS` には入れない ── こちらは**先に聞く**(日付・雛形と同じ理由)。
   */
  const insertEntryLink = document.createElement('button');
  insertEntryLink.type = 'button';
  insertEntryLink.setAttribute('data-pkc-action', 'insert-entry-link');
  insertEntryLink.setAttribute(HINT_BASE, '別のノートを題名で探して、そこへのリンクを打っている場所に入れます');
  insertEntryLink.setAttribute(HINT_COMMAND, 'insert-entry-link');
  insertEntryLink.title = hintTitle('別のノートを題名で探して、そこへのリンクを打っている場所に入れます', 'insert-entry-link');
  const insertEntryLinkLabel = document.createElement('span');
  insertEntryLinkLabel.setAttribute('data-pkc-field', 'label');
  insertEntryLinkLabel.textContent = 'ノートリンクを入れる';
  insertEntryLink.append(insertEntryLinkLabel);
  bar.append(insertEntryLink);

  /**
   * 🔴 **添付を本文に入れる**(#1640 ④。🟣 Gemini 依頼 37 の答え「A」)。
   *
   * ⚠ 直す前は、別のノートで使い直すのに「添付の画面を開く → 参照をコピー → 戻って貼る」が要り、
   *   「ノートリンクを入れる」で添付を選ぶと入るのは**リンク**で画像にならなかった。
   * 🔑 題名で探して選ぶと、画像は画像の行・ほかはリンクの行が打っている場所に入る(組み立ては「参照をコピー」と同じ 1 本)。
   * ⚠ `FORMAT_OPS` には入れない ── こちらは**先に聞く**(日付・ノートリンクと同じ理由)。鍵は付けない。
   */
  const insertAttachment = document.createElement('button');
  insertAttachment.type = 'button';
  insertAttachment.setAttribute('data-pkc-action', 'insert-attachment');
  insertAttachment.title =
    '添付を題名で探して、打っている場所に入れます。画像は画像として、ほかのファイルはリンクとして入ります';
  const insertAttachmentLabel = document.createElement('span');
  insertAttachmentLabel.setAttribute('data-pkc-field', 'label');
  insertAttachmentLabel.textContent = '添付を入れる';
  insertAttachment.append(insertAttachmentLabel);
  bar.append(insertAttachment);

  /**
   * 🔴 **雛形を一覧から入れる**(#196 / B-2 段②-b)。
   *
   * ⚠ 短縮語 + `Tab` は**覚えている人の近道**であって、入口ではない ── 覚えて
   *   いない人には、これが無いと**自分で作った雛形を呼ぶ道が 1 つも無い**。
   * ⚠ 日付と同じくここに置く(本文を打っている場所に在る / 押せる形)。
   *   ⚠ `FORMAT_OPS` には入れない ── あちらは**その場で字を変える**表で、
   *     こちらは**先に聞く**(日付ボタンと同じ理由)。
   */
  const insertSnippet = document.createElement('button');
  insertSnippet.type = 'button';
  insertSnippet.setAttribute('data-pkc-action', 'insert-snippet');
  insertSnippet.setAttribute(HINT_BASE, 'テンプレートを一覧から選んで、打っている場所に入れます');
  insertSnippet.setAttribute(HINT_COMMAND, 'insert-snippet');
  insertSnippet.title = hintTitle('テンプレートを一覧から選んで、打っている場所に入れます', 'insert-snippet');
  const insertSnippetLabel = document.createElement('span');
  insertSnippetLabel.setAttribute('data-pkc-field', 'label');
  insertSnippetLabel.textContent = 'テンプレートを入れる';
  insertSnippet.append(insertSnippetLabel);
  bar.append(insertSnippet);

  /**
   * 🔴 **図案を本文に入れる**(#853 段①、2026-09-13)。
   *
   * > user 指示 2026-09-12:「**マテリアルデザインのアイコンはユーザーのメモ内でも
   * > 使用できるように動線を追加して欲しい**」
   *
   * ⚠ 直す前、図案が使えるのは **PKC が描く所**(ボタン / タブ / 一覧の行の頭 /
   *   アプリのタイル)だけで、**本文に置く道が 1 つも無かった**。
   * 🔑 ここに置く理由は日付・雛形と同じ ── ①**本文を打っている場所**に在る
   *   ②**押せる形**なので、打つ字を覚えなくてもマウスだけで完結する。
   * ⚠ `FORMAT_OPS` には入れない ── あちらは**その場で字を変える**表で、
   *   こちらは**先に聞く**(日付・ノート・雛形と同じ)。
   * ⚠ 鍵は付けない ── 「図」と同じく、これまで鍵を持っていなかったので増やさない。
   */
  const insertIcon = document.createElement('button');
  insertIcon.type = 'button';
  insertIcon.setAttribute('data-pkc-action', 'insert-icon');
  // ⚠ 文言は**起きること**で書く(user 指示 2026-08-21)
  insertIcon.title = 'アイコンを入れます。押すとアイコンの一覧が出て、選ぶと打っている場所に入ります';
  const insertIconLabel = document.createElement('span');
  insertIconLabel.setAttribute('data-pkc-field', 'label');
  insertIconLabel.textContent = 'アイコンを入れる';
  insertIcon.append(insertIconLabel);
  bar.append(insertIcon);

  /**
   * 🔴 **番号を振り直す**(#396)。
   *
   * ⚠ PKC2 は frontmatter で**常時かかる設定**にしていたが、PKC3 は
   *   **押したときだけ**にする ── ライブエディタは行ごとに欄を出すので、
   *   1 行打つたびに全文の番号を書き換えると**触っていない行が勝手に変わる**
   *   (しかも別の窓が書いていたら、それを踏む)。
   */
  const renumber = document.createElement('button');
  renumber.type = 'button';
  renumber.setAttribute('data-pkc-action', 'renumber-lists');
  // ⚠ 文言は**起きること**で書く(user 指示 2026-08-21)
  renumber.title = RENUMBER_TITLE;
  const renumberLabel = document.createElement('span');
  renumberLabel.setAttribute('data-pkc-field', 'label');
  /**
   * 🔴 字は「番号を振り直す」(#717)。⚠ 直す前は「番号」で、同じ帯の左に在る
   *   「番号」(番号付きリストにする)と**同じ字が 2 つ並んでいた** ── どちらを押すと
   *   何が起きるか、押すまで分からない。⚠ 「番号」の側は変えない(表の記法の名前)。
   */
  renumberLabel.textContent = '番号を振り直す';
  renumber.append(renumberLabel);
  bar.append(renumber);

  /**
   * 🔴 **完了項目を末尾へ**(#1108)。
   *
   * チェックリストの完了した項目（- [x]）を各リストブロックの末尾へ移動し、
   * 未完了タスクを見やすく整理する。
   */
  const sortTasks = document.createElement('button');
  sortTasks.type = 'button';
  sortTasks.setAttribute('data-pkc-action', 'sort-tasks');
  // ⚠ 文言は起きることで書く(user 指示 2026-08-21)
  sortTasks.title = SORT_TASKS_TITLE;
  const sortTasksLabel = document.createElement('span');
  sortTasksLabel.setAttribute('data-pkc-field', 'label');
  sortTasksLabel.textContent = '完了項目を末尾へ';
  sortTasks.append(sortTasksLabel);
  bar.append(sortTasks);

  const toggleReplace = document.createElement('button');
  toggleReplace.type = 'button';
  toggleReplace.setAttribute('data-pkc-action', 'toggle-replace');
  toggleReplace.setAttribute('aria-expanded', 'false');
  toggleReplace.setAttribute(HINT_BASE, '編集中のノートの本文で、探す語を全部置き換える欄を開きます / 閉じます');
  toggleReplace.setAttribute(HINT_COMMAND, 'toggle-replace');
  toggleReplace.title = hintTitle('編集中のノートの本文で、探す語を全部置き換える欄を開きます / 閉じます', 'toggle-replace');
  const label = document.createElement('span');
  label.setAttribute('data-pkc-field', 'label');
  label.textContent = '置換の欄を開く / 閉じる';
  toggleReplace.append(label);
  bar.append(toggleReplace);
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
  for (const btn of Array.from(bar.querySelectorAll<HTMLElement>('button'))) {
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
 * 🔴 **図を入れる ── 押すと 5 種から選ぶ**(#528 案 B)。
 *
 * ⚠ 鍵は付けない ── 帯の他の道具(日付 / 雛形)は既定の鍵を 1 つずつ食っている。
 *   「図」はこれまで鍵を持っていなかったので、増やさない(15 枠の規律と同じ向き)。
 * ⚠ 文言は**起きること**で書く(user 指示 2026-08-21)。
 * 🔴 **#950 着地前レビュー ④**: 「選んでいれば一覧を出さず直接 ```mermaid で
 *   囲む」(binder.ts の `insert-diagram`)に直したのに、この字は「押すと
 *   一覧が出て雛形を差し込みます」のまま残っていた ── 選んでいるときは
 *   一覧が出ないので、字が事実と食い違っていた。両方の場合を書く。
 */
function diagramButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('data-pkc-action', 'insert-diagram');
  btn.title =
    '選んでいれば、選んだ範囲を ```mermaid で囲みます。' +
    '選んでいなければ、フローチャート / クラス図 / シーケンス図 / 状態遷移図 / ER 図 から選べます';
  const text = document.createElement('span');
  text.setAttribute('data-pkc-field', 'label');
  text.textContent = '図を入れる';
  btn.append(text);
  return btn;
}

/**
 * 🔴 **1 行ずつ打つ編集のあいだ、本文全体に効く 2 つのボタンを灰色にする**(台帳 #1852 I2 / 依頼 78-4。Gemini 回答 = 推薦 B)。
 *
 * - 対象は「番号を振り直す」と「完了項目を末尾へ」。1 行ずつ打つ編集の欄は**押した 1 ブロックだけ**を持つので、
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

const RENUMBER_TITLE = '番号付きリストの番号を、上から順に振り直します';
const SORT_TASKS_TITLE =
  'カーソルのあるチェックリストで、完了した項目をリストの末尾へ移動して整理します。リストの外にカーソルがあるときは、すべてのリストを整理します';

/** 灰色にするボタンと、元の説明。 */
const WHOLE_NOTE_TOOLS: ReadonlyArray<readonly [string, string]> = [
  ['renumber-lists', RENUMBER_TITLE],
  ['sort-tasks', SORT_TASKS_TITLE],
];
