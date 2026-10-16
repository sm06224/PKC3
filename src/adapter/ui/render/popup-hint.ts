/**
 * 🔴 **外部リンクを初めて押したとき、1 度だけ「開かないときは」を言う**
 * (Gemini 裁定、#1163 の依頼 69-B2)。
 *
 * ## 何が起きていたか
 *
 * 本文の外部リンクは新しいタブで開く。ブラウザがポップアップを止めていると、押しても
 * **何も起きない**(理由はどこにも出ない)。アドレスバーの右端に出る許可の表示に気づけない人は、
 * リンクが壊れていると読む。
 *
 * ## 作り
 *
 * - 言うのは**端末ごとに 1 度だけ**(`pkc3.popup-hint-shown`)。毎回言うと、開く人には雑音になる。
 * - リンクは止めない(`preventDefault` しない)── 開く人の動線を変えない。
 * - 保存が使えない環境でも、その session の間は 1 度だけに保つ(`fallback`)。
 * - その端末で見せた事実なので、設定ファイルでは運ばない(`SKIPPED_KEYS`)。
 */

import { POPUP_ALLOW_STEP } from '@adapter/platform/view-window';

/** 言う字。⚠ 画面の字なので `ui-terms` の使わない語を避ける。 */
export const POPUP_HINT_TEXT = `開かないときは、${POPUP_ALLOW_STEP}`;

const KEY = 'pkc3.popup-hint-shown';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class PopupHintStore {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback = false;

  /** 🔴 直近の書き込みが失敗したか(容量不足など)。真の間は読みも控えを返す。 */
  private saveFailed = false;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /** もう言ったか。⚠ 読むたびに保存を見る(別のタブが先に言ったかもしれない)。 */
  shown(): boolean {
    // 🔴 保存が無い環境では控えを読む(`?.` では `catch` に入らない)
    if (this.storage === null || this.saveFailed) return this.fallback;
    try {
      return this.storage.getItem(KEY) === '1' || this.fallback;
    } catch {
      return this.fallback;
    }
  }

  setShown(on: boolean): void {
    this.fallback = on;
    this.saveFailed = false;
    try {
      this.storage?.setItem(KEY, on ? '1' : '0');
    } catch {
      // 🔴 書けなかった ── 次に書けるまで、読みは控え(書いた値)を返す(戻らない)
      this.saveFailed = true;
      // 保存できないだけ ── この session では効いている(控えが持つ)
    }
  }
}

/** アプリ共有の 1 個。 */
export const appPopupHint = new PopupHintStore();

/**
 * 押した物が「新しいタブで開く外部リンク」か(`http` / `https` の `<a target="_blank">`)。
 * ⚠ 判定はここ 1 か所 ── 本文の焼き側(`markdown-render.ts`)が `target="_blank"` を立てるものと揃える。
 */
export function isExternalNewTabLink(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  const a = el?.closest?.<HTMLAnchorElement>('a[href]') ?? null;
  if (a === null || a.getAttribute('target') !== '_blank') return false;
  return /^https?:\/\//i.test(a.getAttribute('href') ?? '');
}
