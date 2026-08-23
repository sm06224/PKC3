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
