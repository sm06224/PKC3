/**
 * 🔴 **Bookmarklet から 1 件取り込む**(#194 / C-3、2026-08-25)。
 *
 * ## user の物語
 *
 * 1. 記事を読んでいて、ブックマークバーの「PKC に取り込む」を押す
 * 2. **新しいタブで PKC3 が開き**(`…#pkc?capture=1`)、取り込んだノートが
 *    **編集の形で目の前に出る**
 * 3. そのまま保存する。要らなければ捨てる
 * 4. 記事のタブは**そのまま**(退かさない)
 *
 * 🔑 **③が要点である。** 合図で通した相手は**身元を確かめていない**(誰でも
 * `window.open` で PKC3 を開ける)ので、届いた物を**黙って積まない** ──
 * 目の前に出して、user が見て決める。
 *
 * ## ⚠ この file が在る理由
 *
 * `src/main.ts` は**原文を読む test しか無い**(CLAUDE.md §2)。握手の順番
 * (合図を作る → 送る → 待つ)をあそこへ直書きすると、
 * 「**合図を検めずに受ける**」型の取り違えが**全 test 緑のまま**通る。
 *
 * ## ⚠ 既定では何も起きない
 *
 * 断片に `capture` が無ければ**合図を 1 つも作らない**(= 門が開かない)。
 * flag `transport.embed` とは**別の門**である ── あちらは「iframe の親から受ける」、
 * こちらは「**自分を開いた相手から 1 通だけ受ける**」。
 */

import { isCaptureDeepLink } from '@features/link/permalink';
import { mintGrant, type CaptureGrant } from './capture-grant';

export interface CaptureDeps {
  /** いまのアドレスの断片。 */
  hash: string;
  /** この窓を開いた相手(無ければ `null` ── 直接開いたとき)。 */
  opener: Window | null;
  /** 合図の元。⚠ 無い箱では**門を開かない**(弱い乱数で代用しない)。 */
  uuid?: () => string;
  now?: () => number;
}

/**
 * 握手を始める。
 *
 * @returns 門の材料(`message-bridge` の `capture` にそのまま渡せる)。
 *   `null` = **この起動では取り込みを受けない**
 */
export function startCapture(deps: CaptureDeps): {
  isOpener: (source: Window) => boolean;
  grant: () => CaptureGrant | null;
  burn: () => void;
} | null {
  if (!isCaptureDeepLink(deps.hash)) return null;
  const opener = deps.opener;
  // ⚠ **開いた相手が居なければ受けない** ── 断片だけ手で打っても門は開かない
  if (opener === null || typeof opener.postMessage !== 'function') return null;
  const uuid =
    deps.uuid ??
    (typeof crypto === 'object' && typeof crypto.randomUUID === 'function'
      ? () => crypto.randomUUID()
      : null);
  // 🔑 **予測できない値が作れないなら、門を開かない。**
  //    ⚠ 「弱い乱数で代用する」を書かない ── 代用すると**弱いまま動き続ける**。
  if (uuid === null) return null;

  const now = deps.now ?? (() => Date.now());
  let grant: CaptureGrant | null = mintGrant(now(), uuid);

  /**
   * ⚠ **`targetOrigin` は `'*'`** ── 相手の origin は分からない(読んでいる記事は
   * その日によって違う)。🔑 載せているのは**合図だけ**なので、漏れる中身が無い。
   * ⚠ ここに他の物を足さない(足した瞬間、それは任意の頁へ配られる)。
   */
  opener.postMessage({ pkc3: 'capture-ready', grant: grant.nonce }, '*');

  return {
    isOpener: (source) => source === opener,
    grant: () => grant,
    burn: () => {
      grant = null;
    },
  };
}
