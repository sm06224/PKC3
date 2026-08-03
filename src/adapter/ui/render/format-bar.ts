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
  return bar;
}
