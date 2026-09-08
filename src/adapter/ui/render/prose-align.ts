/**
 * 本文の置き場所の保存と適用(#722、2026-09-08)。
 *
 * 意味論(どの置き方がどのトークンか)は `features/prose-align.ts` に置いてある。
 * ここが持つのは**保存**と**この文書への適用**だけである
 * (`page-format.ts` / `theme.ts` と同じ分け方)。
 *
 * ⚠ **flag ではない**(flag 枠 15 とは別。user 指示 2026-07-30「正規設定と分離」)──
 *   恒久の user 設定で、畳む予定が無い。⚠ **URL パラメータも作らない**
 *   (user 指示 2026-08-07「クエリパラメータを抜け穴にしてはいけない」)。
 * ⚠ **container に入れない** ── ノートのデータではなく**この端末の見方**である。
 * ⚠ 読めない環境(プライベートモード等で投げる)でも**落ちない**(既定に落ちる)。
 * ⚠ **戻せる** ── 設定画面の選択肢に既定(中央)が並んでいる。
 */
import {
  DEFAULT_PROSE_ALIGN,
  isProseAlign,
  PROSE_ALIGN_ATTR,
  type ProseAlign,
} from '@features/prose-align';

/** ⚠ 1 鍵だけ(`pkc3.page-format` と同じ作法)。 */
const KEY = 'pkc3.prose-align';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // 使えない環境でも落ちない
  }
}

/**
 * 最初に使う置き場所 ── **保存されていれば それ、無ければ中央**。
 * ⚠ 配色と違って OS を見る材料が無い(読む位置の好みは OS に出ていない)。
 */
export function initialProseAlign(): ProseAlign {
  try {
    const v = readStorage()?.getItem(KEY);
    return v !== null && v !== undefined && isProseAlign(v) ? v : DEFAULT_PROSE_ALIGN;
  } catch {
    return DEFAULT_PROSE_ALIGN;
  }
}

/**
 * いま当たっている置き場所(**DOM が正本**)。
 * ⚠ 保存を読み直さない ── 保存できない環境では「この session だけ効いている」値が
 *   正しく、そこで保存を見ると**画面と食い違う**(`page-format.ts` と同じ理由)。
 */
export function currentProseAlign(target: HTMLElement): ProseAlign {
  const v = target.getAttribute(PROSE_ALIGN_ATTR);
  return v !== null && isProseAlign(v) ? v : DEFAULT_PROSE_ALIGN;
}

/**
 * 当てる。⚠ **保存しない**(起動時の適用が「一度も選んでいないのに固定される」を
 * 作らないように、保存は `chooseProseAlign` だけが持つ ── `theme.ts` の M-7 と同じ)。
 *
 * 🔑 **描き直しは要らない** ── 変わるのはトークン 2 つの値だけで、HTML は 1 文字も
 *   変わらない(ブラウザが reflow する)。⚠ ここで描き直すと**図が一度消えてから戻る**。
 * ⚠ **図のラスタは焼き直される** ── 塊の左の余白が変わるので焼き幅が変わる。
 *   それは `mermaid-hydrate.ts` の `ResizeObserver` が拾うので、ここでやることは変わらない
 *   (紙面を変えたときと同じ道である)。
 */
export function applyProseAlign(target: HTMLElement, align: ProseAlign): void {
  target.setAttribute(PROSE_ALIGN_ATTR, align);
}

/** user が選んだ ── 当てて**保存する**。 */
export function chooseProseAlign(target: HTMLElement, align: ProseAlign): void {
  applyProseAlign(target, align);
  try {
    readStorage()?.setItem(KEY, align);
  } catch {
    // 保存できないだけ ── この session では効いている
  }
}
