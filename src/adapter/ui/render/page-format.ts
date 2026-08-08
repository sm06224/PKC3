/**
 * 紙面フォーマットの保存と適用(2026-08-08。user 裁定)。
 *
 * 意味論(どの形式がどの読み幅・どの紙か)は `features/page-format.ts` に置いてある。
 * ここが持つのは**保存**と**この文書への適用**だけである
 * (`external-images.ts` / `theme.ts` と同じ分け方)。
 *
 * ⚠ **flag ではない**(flag 枠 15 とは別。user 指示 2026-07-30「正規設定と分離」)──
 *   恒久の user 設定で、畳む予定が無い。⚠ **URL パラメータも作らない**
 *   (user 指示 2026-08-07「クエリパラメータを抜け穴にしてはいけない」)。
 * ⚠ **container に入れない** ── ノートのデータではなく**この端末の見方**である。
 *   入れると書出し / 取込 / 同期の意味論に巻き込まれる。
 * ⚠ 読めない環境(プライベートモード等で投げる)でも**落ちない**(既定に落ちる)。
 * ⚠ **戻せる** ── 設定画面の選択肢に既定(A4 縦)が並んでいる。
 */
import {
  DEFAULT_PAGE_FORMAT,
  isPageFormat,
  PAGE_FORMAT_ATTR,
  paperRule,
  type PageFormat,
} from '@features/page-format';

/** ⚠ 1 鍵だけ(`pkc3.theme` / `pkc3.external-images` と同じ作法)。 */
const KEY = 'pkc3.page-format';

/**
 * 紙の指定を載せる `<style>` の印。
 *
 * 🔑 **`@page` はセレクタで絞れない**(文書に 1 つしか無い)ので、属性の切替では
 * 出し分けられない ── 選んだ 1 つだけを載せ替える。⚠ 画面用のフォーマット
 * (フル HD / 4:3)では**器ごと外す** ── 空の規則を残すと、次に紙系へ変えるまで
 * 「前に選んでいた紙」が効いたままになる。
 */
const PAPER_FIELD = 'page-paper';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // 使えない環境でも落ちない
  }
}

/**
 * 最初に使うフォーマット ── **保存されていれば それ、無ければ A4 縦**。
 * ⚠ 配色と違って OS を見る材料が無い(紙の好みは OS に出ていない)。
 */
export function initialPageFormat(): PageFormat {
  try {
    const v = readStorage()?.getItem(KEY);
    return v !== null && v !== undefined && isPageFormat(v) ? v : DEFAULT_PAGE_FORMAT;
  } catch {
    return DEFAULT_PAGE_FORMAT;
  }
}

/**
 * いま当たっているフォーマット(**DOM が正本**)。
 * ⚠ 保存を読み直さない ── 保存できない環境では「この session だけ効いている」値が
 *   正しく、そこで保存を見ると**画面と食い違う**。
 */
export function currentPageFormat(target: HTMLElement): PageFormat {
  const v = target.getAttribute(PAGE_FORMAT_ATTR);
  return v !== null && isPageFormat(v) ? v : DEFAULT_PAGE_FORMAT;
}

/**
 * 当てる。⚠ **保存しない**(`theme.ts` の M-7 と同じ理由 ── 起動時の適用が
 * 「一度も選んでいないのに固定される」を作らないように、保存は `choosePageFormat`
 * だけが持つ)。
 *
 * 🔑 **描き直しは要らない**。読み幅は `--read-w` の値が変わるだけで、HTML は
 * 1 文字も変わらない ── ブラウザが reflow する。⚠ ここで描き直すと、
 * **図が焼き直される**(器の幅から決まるラスタは動いていないのに)。
 */
export function applyPageFormat(target: HTMLElement, fmt: PageFormat): void {
  target.setAttribute(PAGE_FORMAT_ATTR, fmt);
  applyPaper(target.ownerDocument, fmt);
}

/** user が選んだ ── 当てて**保存する**。 */
export function choosePageFormat(target: HTMLElement, fmt: PageFormat): void {
  applyPageFormat(target, fmt);
  try {
    readStorage()?.setItem(KEY, fmt);
  } catch {
    // 保存できないだけ ── この session では効いている
  }
}

function applyPaper(doc: Document, fmt: PageFormat): void {
  const css = paperRule(fmt);
  const found = doc.querySelector<HTMLStyleElement>(`style[data-pkc-field='${PAPER_FIELD}']`);
  if (css === '') {
    found?.remove();
    return;
  }
  const style = found ?? doc.createElement('style');
  if (found === null) {
    style.setAttribute('data-pkc-field', PAPER_FIELD);
    doc.head.append(style);
  }
  if (style.textContent !== css) style.textContent = css;
}
