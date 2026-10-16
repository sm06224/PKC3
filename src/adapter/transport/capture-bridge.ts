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
  /**
   * 「このタブで 1 件受けた」を憶える場所(M2)。⚠ 既定は `sessionStorage`(**タブごと**)。
   * 使えない箱(私用ウィンドウなど)では憶えられないだけで、今までどおり動く。
   */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

/** タブごとの「受けた」印の鍵。 */
export const CAPTURE_ACCEPTED_KEY = 'pkc3.capture-accepted';

function tabStorage(deps: CaptureDeps): Pick<Storage, 'getItem' | 'setItem'> | null {
  if (deps.storage !== undefined) return deps.storage;
  try {
    return typeof sessionStorage === 'object' ? sessionStorage : null;
  } catch {
    return null;
  }
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
  /**
   * 🔴 **このタブが 1 件受けたら、再読み込みで新しい合図を出さない**(M2)。
   * ⚠ 開いた相手が何度もこの窓を読み込み直す(`location.reload()` を繰り返す)と、
   *   読み込みのたびに合図が出て**同じ取り込みがノートを増やし続ける**。
   * ⚠ 憶えられない箱では防げない(読めなければ「受けていない」と見なす)。
   */
  const store = tabStorage(deps);
  try {
    if (store?.getItem(CAPTURE_ACCEPTED_KEY) === '1') return null;
  } catch {
    // 読めない ── 受けていない側に倒す(取り込みそのものを止めない)
  }
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
      // 🔑 焼いた = 受けると決めた。この印はタブが閉じるまで残る
      try {
        store?.setItem(CAPTURE_ACCEPTED_KEY, '1');
      } catch {
        // 書けない箱 ── 印が残らないだけ
      }
    },
  };
}
