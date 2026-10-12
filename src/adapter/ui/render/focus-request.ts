/**
 * 🔴 **「今日」を押したあと、カーソルをどこへ置くか**の一回限りの頼み(#1087 流れ 29)。
 *
 * ## 物語
 *
 * 「今日」を押す user は、その日のことを**書きたい**。
 * - 今日のノートが**まだ無い** → 作って、**本文**にカーソルを置く(題名は日付のまま。
 *   他の作り方 = 「ノートを作る」は今までどおり題名へ)
 * - 既に在る → 選んで、本文の下の**追記欄**にカーソルを置く(開いたノートを壊さず足せる)
 *
 * 🔑 置き場は**頼んだ側(`binder`)と叶える側(`detail` / `append-box`)の間の 1 回限りの札**。
 * 新しい state を足さない(作成直後の印 `freshLid` を読む側が、札を 1 度だけ引き取る)。
 * ⚠ **期限を付ける** ── 叶える相手(編集欄 / 追記欄)が出ない場面(別のノートを編集中など)で
 *   札が残ると、何分も後に別の操作の焦点を奪う。
 */

/** 札の寿命(ms)。⚠ 本文の到着待ちを含む ── 数秒で十分で、長いほど奪い返しの害が大きい。 */
export const FOCUS_REQUEST_TTL_MS = 4000;

type Req = { lid: string; at: number };

let bodyReq: Req | null = null;
let appendReq: Req | null = null;

function take(req: Req | null, lid: string, now: number): boolean {
  return req !== null && req.lid === lid && now - req.at <= FOCUS_REQUEST_TTL_MS;
}

/** 作った直後のノートの**本文**へカーソルを置く頼み。 */
export function requestBodyFocus(lid: string, now: number = Date.now()): void {
  bodyReq = { lid, at: now };
  appendReq = null;
}

/** 選んだノートの**追記欄**へカーソルを置く頼み。 */
export function requestAppendFocus(lid: string, now: number = Date.now()): void {
  appendReq = { lid, at: now };
  bodyReq = null;
}

/** 本文の頼みを引き取る(`lid` が合い、期限内なら true。引き取ったら忘れる)。 */
export function takeBodyFocus(lid: string, now: number = Date.now()): boolean {
  const ok = take(bodyReq, lid, now);
  if (ok || (bodyReq !== null && bodyReq.lid === lid)) bodyReq = null;
  return ok;
}

/** 追記欄の頼みを引き取る(同上)。 */
export function takeAppendFocus(lid: string, now: number = Date.now()): boolean {
  const ok = take(appendReq, lid, now);
  if (ok || (appendReq !== null && appendReq.lid === lid)) appendReq = null;
  return ok;
}

/** test 用:札を全部捨てる。 */
export function resetFocusRequests(): void {
  bodyReq = null;
  appendReq = null;
}
