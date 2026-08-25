/**
 * 🔴 **その起動 1 回だけ効く「取り込みの合図」**(#194 / C-3)。
 *
 * ## なぜ許可リストでは通らないか
 *
 * C-4(#189)の受け口は **origin の許可リスト**で守っている ── PKC3 を iframe に
 * 入れる相手は**決まっている**からである。ところが Bookmarklet は**読んでいる頁の上**で
 * 走るので、相手の origin は**その日読んでいる記事**であって、事前に列挙できない。
 * ⚠ 「読む頁を全部許可リストに足す」は、許可リストを**意味の無いもの**にする。
 *
 * ## 代わりに置くもの ── **1 回きりの合図**
 *
 * 1. Bookmarklet が PKC3 を **`#pkc?capture` で開く**(⚠ 中身は運ばない。
 *    クエリを抜け穴にしないのは不可侵指示 2026-08-07。断片はディープリンクの器である)
 * 2. PKC3 が **合図(nonce)を作り**、`window.opener` へ渡す
 *    (⚠ 中身は合図だけなので、`targetOrigin: '*'` で漏れるものが無い)
 * 3. Bookmarklet が**その合図を添えて** `pkc.createEntry` を送る
 * 4. PKC3 は **1 回だけ**受け、合図を焼き捨てる
 *
 * 🔑 **許可リストより狭い。** 許可リストは「その origin から、いつでも、何度でも」だが、
 * これは「**この起動の、この 1 通だけ**」である。しかも**始めたのは user**である
 * (ブックマークを押した)。
 *
 * ## ⚠ それでも「誰でも 1 通は送れる」
 *
 * 悪意ある頁も `window.open` で PKC3 を `#pkc?capture` で開ける ── そのとき
 * **ノートが 1 件届く**。だから受け取ったものは**保存して終わりにせず、
 * 編集の形で user の目の前に出す**(呼び側の役)── 見て、要らなければ捨てられる。
 * ⚠ そして**返事に中身を載せない**(`lid` も返さない)── 読み出しの口にしない。
 *
 * ⚠ **pure module**(時計も窓も持たない ── `now` を受け取る)。
 */

/** 合図が効く時間。⚠ 押してから開いて送るまでの間しか要らない。 */
export const GRANT_TTL_MS = 60_000;

/** この合図で通してよい method。🔴 **1 つだけ**(読み出しには使わせない)。 */
export const GRANTED_METHOD = 'pkc.createEntry';

export interface CaptureGrant {
  readonly nonce: string;
  readonly issuedAt: number;
}

/**
 * まだ効いているか。⚠ **`null` は「合図を出していない」** ── 期限切れと同じ扱いで
 * よいが、呼び側が見分けたいことがあるので型で分けてある。
 */
export function isLive(grant: CaptureGrant | null, now: number): boolean {
  if (grant === null) return false;
  // ⚠ **未来に発行された合図は効かせない** ── 時計が巻き戻った環境で、
  //    期限が実質無限になるのを防ぐ(`now - issuedAt` が負になる形)。
  const age = now - grant.issuedAt;
  return age >= 0 && age < GRANT_TTL_MS;
}

/**
 * 🔴 **この 1 通を受けてよいか。**
 *
 * ⚠ 3 つ**すべて**を見る ── ①合図が生きている ②method が 1 つだけのもの
 * ③添えられた合図が**一致する**。
 * 🔑 ③が無いと「開いた頁なら誰でも通る」になり、①②だけでは**合図の意味が無い**。
 */
export function accepts(
  grant: CaptureGrant | null,
  now: number,
  method: string,
  params: unknown,
): boolean {
  if (!isLive(grant, now)) return false;
  if (method !== GRANTED_METHOD) return false;
  const given = (params as { grant?: unknown } | null | undefined)?.grant;
  return typeof given === 'string' && given === grant!.nonce;
}

/**
 * 合図を作る。⚠ **予測できない値**でなければ意味が無い ── `crypto.randomUUID` が
 * 無い環境(古い箱)では**合図を出さない**(`null`)。
 * 🔑 「弱い乱数で代用する」を書かない ── 代用すると、**弱いまま動き続ける**。
 */
export function mintGrant(now: number, uuid: () => string): CaptureGrant {
  return { nonce: uuid(), issuedAt: now };
}
