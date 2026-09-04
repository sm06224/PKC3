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

/**
 * 🔑 **export している**のは、焼いたマニュアル(`features/help/manual-page.ts` の
 *   inline script)が**同じ鍵**を読むため(`theme.ts` の `THEME_STORAGE_KEY` と同じ理由)。
 */
export const TEXT_SCALE_STORAGE_KEY = 'pkc3.text-scale';

/**
 * 🔴 **当てる先の印**。⚠ `data-` 属性も置く ── CSS 変数だけだと
 *   「いま何が当たっているか」を DOM から読めず、smoke と設定画面が
 *   **別々に保存を読む**ことになる(`page-format.ts` と同じ理由)。
 */
export const TEXT_SCALE_ATTR = 'data-pkc-text-scale';
/** `app.css` の `body { font-size: var(--pkc-text-size, 13px) }` と 1 対 1。 */
export const TEXT_SIZE_VAR = '--pkc-text-size';

function readStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * 🔴 **user が選んで保存した大きさ。選んでいなければ `null`**(2026-09-02 hotfix、#648)。
 *
 * ⚠ 「いま効いている値」ではない ── アプリは選んでいなくても既定(13px)を当てているが、
 *   焼いたマニュアル(`features/help/manual-page.ts` の boot script)は**選んでいなければ
 *   触らない**(CSS の既定のまま)。I6 で揃えるまで窓の既定は 14px だったので、
 *   マニュアルの窓へ当て直す側が「効いている 13px」を渡すと、**何も変えずにもう一度
 *   押しただけで字が縮んだ**(着地前レビューが拾った ── `main.ts` の `currentAppearance`)。
 *   ⚠ 既定が揃った今も「選んだか」で読む ── 「効いている値」を渡すと、設定を「標準」へ
 *   戻した人の窓が `--pkc-text-size` を持ち続け、CSS の既定を変えた日に追従しなくなる。
 * 🔑 boot script と**同じ門**(保存が在り、知っている id)で読む ── 2 つの読み手が
 *   同じ答えを出すことが、当て直しを冪等にする条件である。
 */
export function chosenTextScale(): TextScale | null {
  try {
    const v = readStorage()?.getItem(TEXT_SCALE_STORAGE_KEY);
    return v !== null && v !== undefined && isTextScale(v) ? v : null;
  } catch {
    return null;
  }
}

/** 保存されている値(起動時の初期値)。⚠ 読めなければ既定。 */
export function initialTextScale(): TextScale {
  return chosenTextScale() ?? DEFAULT_TEXT_SCALE;
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

/**
 * user が選んだ ── 当てて**保存する**。
 *
 * 🔴 **「標準」を選ぶ = 選んでいない状態へ戻す**(2026-09-04、#656 ①)。
 * ⚠ 直す前は `'standard'` も `setItem` していた ── すると `chosenTextScale()` が
 *   「選んだ」と読み、マニュアルの窓へ「標準の大きさ」を当て続ける。**鍵を消す道が
 *   repo に 1 つも無かった**ので、一度「大」を試した人は二度と「選んでいない」に戻れなかった
 *   (マニュアル §4-2 の「標準を選べば元に戻せます」が、窓については嘘だった)。
 * 🔑 既定を選んだら鍵ごと消す ── `initialTextScale()` は鍵が無ければ既定へ落ちるので、
 *   次の起動の見え方は 1px も変わらない。変わるのは「選んだか」の答えだけである。
 */
export function chooseTextScale(target: HTMLElement, scale: TextScale): void {
  applyTextScale(target, scale);
  try {
    if (scale === DEFAULT_TEXT_SCALE) readStorage()?.removeItem(TEXT_SCALE_STORAGE_KEY);
    else readStorage()?.setItem(TEXT_SCALE_STORAGE_KEY, scale);
  } catch {
    // 保存できないだけ ── この session では効いている
  }
}
