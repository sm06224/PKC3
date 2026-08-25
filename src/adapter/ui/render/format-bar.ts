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
import { FORMAT_OPS } from '@features/markdown/text-ops';
import { HINT_BASE, HINT_COMMAND, hintTitle } from './shortcut-hint';

/** 書式パネルを組む。⚠ 押した所は `data-pkc-format` で分かる(binder が読む)。 */
export function buildFormatBar(): HTMLElement {
  const bar = document.createElement('div');
  bar.setAttribute('data-pkc-region', 'format-bar');
  for (const { op, label } of FORMAT_OPS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-pkc-action', 'format-text');
    btn.setAttribute('data-pkc-format', op);
    // ⚠ 文字は `label` span に入れる(段④ の規約 ── 文言の突合がここを読む)
    const text = document.createElement('span');
    text.setAttribute('data-pkc-field', 'label');
    text.textContent = label;
    btn.append(text);
    bar.append(btn);
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
  renumberLabel.textContent = '番号';
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
