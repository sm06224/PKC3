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
import { BAR_FORMAT_OPS } from '@features/markdown/text-ops';
import { findCommand } from '@features/keymap';
import { HINT_BASE, HINT_COMMAND, hintTitle } from './shortcut-hint';

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
    if (op === 'table') bar.append(diagramButton());
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
  insertDate.setAttribute(HINT_BASE, '日付を入れる');
  insertDate.setAttribute(HINT_COMMAND, 'insert-date');
  insertDate.title = hintTitle('日付を入れる', 'insert-date');
  const insertDateLabel = document.createElement('span');
  insertDateLabel.setAttribute('data-pkc-field', 'label');
  insertDateLabel.textContent = '日付';
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
  insertEntryLink.setAttribute(HINT_BASE, 'ノートへのリンク');
  insertEntryLink.setAttribute(HINT_COMMAND, 'insert-entry-link');
  insertEntryLink.title = hintTitle('ノートへのリンク', 'insert-entry-link');
  const insertEntryLinkLabel = document.createElement('span');
  insertEntryLinkLabel.setAttribute('data-pkc-field', 'label');
  insertEntryLinkLabel.textContent = 'ノート';
  insertEntryLink.append(insertEntryLinkLabel);
  bar.append(insertEntryLink);

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
  insertSnippet.setAttribute(HINT_BASE, '雛形を入れる');
  insertSnippet.setAttribute(HINT_COMMAND, 'insert-snippet');
  insertSnippet.title = hintTitle('雛形を入れる', 'insert-snippet');
  const insertSnippetLabel = document.createElement('span');
  insertSnippetLabel.setAttribute('data-pkc-field', 'label');
  insertSnippetLabel.textContent = '雛形';
  insertSnippet.append(insertSnippetLabel);
  bar.append(insertSnippet);

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
  renumber.title = '番号付きリストの番号を、上から順に振り直します';
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

  const toggleReplace = document.createElement('button');
  toggleReplace.type = 'button';
  toggleReplace.setAttribute('data-pkc-action', 'toggle-replace');
  toggleReplace.setAttribute('aria-expanded', 'false');
  toggleReplace.setAttribute(HINT_BASE, '本文の置換');
  toggleReplace.setAttribute(HINT_COMMAND, 'toggle-replace');
  toggleReplace.title = hintTitle('本文の置換', 'toggle-replace');
  const label = document.createElement('span');
  label.setAttribute('data-pkc-field', 'label');
  label.textContent = '置換';
  toggleReplace.append(label);
  bar.append(toggleReplace);
  return bar;
}

/**
 * 🔴 **図を入れる ── 押すと 5 種から選ぶ**(#528 案 B)。
 *
 * ⚠ 鍵は付けない ── 帯の他の道具(日付 / 雛形)は既定の鍵を 1 つずつ食っている。
 *   「図」はこれまで鍵を持っていなかったので、増やさない(15 枠の規律と同じ向き)。
 * ⚠ 文言は**起きること**で書く(user 指示 2026-08-21)。
 */
function diagramButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('data-pkc-action', 'insert-diagram');
  btn.title = '図の雛形を入れます。押すと、フローチャート / クラス図 / シーケンス図 / 状態遷移図 / ER 図 から選べます';
  const text = document.createElement('span');
  text.setAttribute('data-pkc-field', 'label');
  text.textContent = '図';
  btn.append(text);
  return btn;
}
