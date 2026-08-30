/**
 * 🔴 **「幅が足りないので畳んだ」を言う口は 1 つだけ**(#606。2026-08-30)。
 *
 * ## なぜ 1 つに寄せたか
 *
 * 直す前は**同じ種類の知らせに口が 2 つ**あった:
 *
 * | 何を畳んだか | 口 | 状態 |
 * |---|---|---|
 * | 本文の段組み | `read-columns.ts` の module 変数 | 🟢 `main.ts:873` で配線されていた |
 * | 横に並べた枠 | `SplitView` の**コンストラクタ引数** | 🔴 **`main.ts` が渡していなかった** |
 *
 * ⚠ 後者は**文言も受け口も在った**のに、`main.ts` が `CenterRouter` を 5 引数で
 * 作っていたので既定の `() => {}` に落ち、**製品では 1 度も出ていなかった**。
 * ⚠ しかも `tests/adapter/split-view.test.ts` は**自分で口を渡していた**ので緑のまま
 * (CLAUDE.md §7「両端が相手を模した stub と話している」)。
 *
 * 🔑 **口が 2 つある限り、片方を配線し忘れても誰も気づかない。**
 *   1 つにすれば、落としたとき**段組みの帯も同時に消える**ので、既に在る
 *   `tests/smoke/read-columns.smoke.spec.ts`(畳んだ帯の文言を見る唯一の spec)が鳴る。
 *   ── 型で止められないなら、**落としたときに既に在る検査が鳴る形**にする。
 *
 * ## ⚠ なぜ引数ではなく module 変数か
 *
 * `showStatus` は `main.ts:859` で、`CenterRouter` は `:721` で作られる ──
 * **帯の口はまだ存在しない**。`read-columns` が setter 形なのは元々この理由で、
 * `main.ts:864-866` にそう書いてある。
 */
let notify: ((text: string) => void) | null = null;

/** 帯へ出す口を配る(`main.ts` が起動時に 1 度だけ呼ぶ)。 */
export function setFoldNotify(fn: ((text: string) => void) | null): void {
  notify = fn;
}

/**
 * 「幅が足りないので畳んだ」を言う。
 * ⚠ 口が配られていなければ**黙る**(test や別窓は帯を持たない)。
 */
export function sayFolded(text: string): void {
  if (notify !== null) notify(text);
}
