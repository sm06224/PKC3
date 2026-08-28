/**
 * 文字の大きさの保存と適用(#504)。意味論は `features/text-scale.ts`。
 *
 * ⚠ 1 鍵だけ(`pkc3.theme` / `pkc3.page-format` / `pkc3.editor-mode` と同じ作法)。
 * ⚠ **container に入れない** ── ノートのデータではなく**この端末の見え方**である。
 * ⚠ 読めない環境(プライベートモード等)でも落ちない ── 既定(標準)に落ちる。
 *
 * 🔑 当て方は `page-format.ts` と**同じ形**にする(属性 1 つ + CSS 変数)──
 *   2 本目の作法を作らない(§7)。
 */
import {
  DEFAULT_TEXT_SCALE,
  isTextScale,
  textScaleSpec,
  type TextScale,
} from '@features/text-scale';

const KEY = 'pkc3.text-scale';

/**
 * 🔴 **当てる先の印**。⚠ `data-` 属性も置く ── CSS 変数だけだと
 *   「いま何が当たっているか」を DOM から読めず、smoke と設定画面が
 *   **別々に保存を読む**ことになる(`page-format.ts` と同じ理由)。
 */
export const TEXT_SCALE_ATTR = 'data-pkc-text-scale';
/** `app.css` の `body { font-size: var(--pkc-text-size, 13px) }` と 1 対 1。 */
export const TEXT_SIZE_VAR = '--pkc-text-size';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** 保存されている値(起動時の初期値)。⚠ 読めなければ既定。 */
export function initialTextScale(): TextScale {
  try {
    const v = readStorage()?.getItem(KEY);
    return v !== null && v !== undefined && isTextScale(v) ? v : DEFAULT_TEXT_SCALE;
  } catch {
    return DEFAULT_TEXT_SCALE;
  }
}

/**
 * いま当たっている大きさ(**DOM が正本**)。
 * ⚠ 保存を読み直さない ── 保存できない環境では「この session だけ効いている」値が
 *   正しく、そこで保存を見ると**画面と食い違う**(`page-format.ts` と同じ)。
 */
export function currentTextScale(target: HTMLElement): TextScale {
  const v = target.getAttribute(TEXT_SCALE_ATTR);
  return v !== null && isTextScale(v) ? v : DEFAULT_TEXT_SCALE;
}

/**
 * 当てる。⚠ **保存しない**(起動時の適用が「一度も選んでいないのに固定される」を
 * 作らないように、保存は `chooseTextScale` だけが持つ)。
 *
 * 🔑 **描き直しは要らない** ── `font-size` が変わるだけで HTML は 1 文字も
 *   変わらない。⚠ ここで描き直すと**図が焼き直される**(読み幅は `rem` なので
 *   器の幅は 1px も動いていないのに)。
 */
export function applyTextScale(target: HTMLElement, scale: TextScale): void {
  target.setAttribute(TEXT_SCALE_ATTR, scale);
  target.style.setProperty(TEXT_SIZE_VAR, textScaleSpec(scale).size);
}

/** user が選んだ ── 当てて**保存する**。 */
export function chooseTextScale(target: HTMLElement, scale: TextScale): void {
  applyTextScale(target, scale);
  try {
    readStorage()?.setItem(KEY, scale);
  } catch {
    // 保存できないだけ ── この session では効いている
  }
}
