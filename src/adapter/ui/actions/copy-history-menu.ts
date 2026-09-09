/**
 * 「コピーした物」を出す(#678 の画面)。
 *
 * > user 要望 2026-09-03「**コピーをアプリ内で履歴する機能**」
 *
 * 🔑 **中央の面を奪わない** ── これは「補助的な物」なので、その場に出して、
 *   選んだら消える(user 指示 2026-08-22「補助的な物が、主の作業領域を奪ってはいけない」)。
 *   だから面ではなく**その場のメニュー**である。
 *
 * 🔑 **押すと「もう一度コピーされる」** ── その場へ差し込む形にしない。
 *   ⚠ 差し込むには「いまどこに caret が在るか」が要るが、メニューを開いた時点で
 *   欄から焦点が外れる ── **開いた場所によって結果が変わる**動線になる。
 *   もう一度コピーする形なら、**どこから開いても同じ**で、そのまま貼れる
 *   (user の物語「表が消えたので取り直しになる」は、これで解ける)。
 */
import { copyLabel, type CopiedItem } from '@features/clipboard/history';
import type { MenuItem } from '@adapter/ui/render/context-menu';

/**
 * 空のときに**帯へ**出す字。⚠ **黙って何も出さない**にしない(押した意味が消える)。
 * ⚠ メニューの項目にはしない ── 押しても何も起きない行になる。
 */
export const COPY_HISTORY_EMPTY =
  'まだ何もコピーしていません(PKC の中でコピーすると、この端末に 20 件まで残ります)';

/** 全部消す項目の字。 */
export const COPY_HISTORY_CLEAR = 'コピーした物を消す';

/**
 * 一覧をメニューの項目にする。
 *
 * ⚠ **消す口を必ず置く**(issue #678)── コピーした物が残り続けるのは、
 *   user が消したい情報を持ち続けることである。
 * 🔴 **空のときは 0 件を返す** ── 「まだ何もコピーしていません」を*項目*として
 *   出すと、それは**押しても何も起きない行**になる(無言の dead click)。
 *   ⚠ 呼び側は 0 件のとき**帯で言う**(`COPY_HISTORY_EMPTY`)── 押した意味が消えない。
 */
export function copyHistoryMenu(items: readonly CopiedItem[]): MenuItem[] {
  if (items.length === 0) return [];
  return [
    ...items.map((c, i) => ({
      action: 'use-copied',
      label: copyLabel(c.text),
      hint: 'もう一度コピーします(そのまま貼れます)',
      attrs: { 'data-pkc-copied': String(i) },
    })),
    {
      action: 'clear-copy-history',
      label: COPY_HISTORY_CLEAR,
      hint: 'この端末に残っているコピーの履歴を、全部消します',
    },
  ];
}
