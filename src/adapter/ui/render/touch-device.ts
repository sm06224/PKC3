/**
 * 🔴 **指で触るだけの端末かどうかを、1 か所で答える**(#722 P2-12)。
 *
 * > cowork の評価:追記の欄に `(Ctrl + Enter)` と出るが、スマホには Ctrl も
 * > Enter も無い ── **押せない鍵の名前が、欄の説明を半分埋めている**。
 *
 * ⚠ **鍵そのものは殺さない。** 外付けキーボードを繋いだタブレットでは効いてほしい ──
 *   ここが決めるのは**字を出すかどうか**だけである。
 *
 * ## なぜ `(hover: none) and (pointer: coarse)` の両方を見るか
 *
 * `app.css` の「打つ欄の字だけ 16px」と**同じ綴り**にしてある(grep で並ぶ)。
 * ⚠ 片方だけで切る所も在る(`@media (hover: none)` = 乗せたときだけ出る物を常に出す)が、
 *   あちらは**足す**向きなので広く当てて安全である。
 * 🔑 こちらは**消す**向きなので狭く当てる ── マウスを繋いだタブレットのように
 *   片方だけ真の端末で、押せる鍵の名前まで消してはいけない
 *   (CLAUDE.md「誤差の向きを決めて、両側に使い回さない」)。
 *
 * ⚠ `matchMedia` を持たない器(unit / 古い箱)では **false** を返す ──
 *   分からないときは**これまでどおり**にする(字が出るだけで、害は無い)。
 */

/** ⚠ 綴りは `app.css` の `@media (hover: none) and (pointer: coarse)` と揃える。 */
export const TOUCH_ONLY_QUERY = '(hover: none) and (pointer: coarse)';

type MediaLike = { readonly matches: boolean };

/**
 * 指で触るだけの端末か。
 * @param mm 差し替え口(unit / 別の窓)。既定は window の `matchMedia`。
 */
export function isTouchOnly(mm?: (q: string) => MediaLike | undefined): boolean {
  const ask =
    mm ??
    ((q: string) =>
      (globalThis as { matchMedia?: (q: string) => MediaLike }).matchMedia?.(q));
  try {
    return ask(TOUCH_ONLY_QUERY)?.matches === true;
  } catch {
    // ⚠ sandbox の frame では `matchMedia` が投げることがある ── 出す側へ倒す
    return false;
  }
}
