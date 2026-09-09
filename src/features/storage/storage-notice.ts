/**
 * 🔴 **保存先が取れなかったときに、user へ出す言い方**(#811。user 報告 2026-09-09)。
 *
 * ## 直す前に何が起きていたか
 *
 * iPhone の画面の下に、こう出ていた:
 *
 * > ⚠ InvalidStateError: The object is in an invalid state.
 *
 * これは `main.ts` が `init.fallbackReason`(= **ブラウザの例外の綴りそのまま**)を
 * `⚠ ` を付けて出していたものである。⚠ user には
 * **何が起きたか / 何を失うか / どうすればよいか**が 1 文字も出ていない。
 *
 * 🔴 **中身は「閉じると消える」である。** `storage-worker.ts` は
 * `installOpfsSAHPoolVfs` が投げると `vfs = 'memory'` へ退避する ── 同 file の注記が
 * その意味を書いている:「**書いたものが OPFS へ 1 バイトも届かない。症状は
 * 『保存したのに次の起動で消えている』で、当日は絶対に気づけない**」。
 *
 * ## ⚠ もっとまともな字が、同じ file の 60 行上に既に在った
 *
 * 起動を止める側(`main.ts` の再試行が尽きたとき)は
 * 「ストレージを確保できませんでした(別タブが保持中の可能性)」と言っていた ──
 * **同じ事実に説明が 2 通り**あって、user に届くのは**悪いほう**だった(CLAUDE.md §7)。
 * 🔑 だから**言い方をこの 1 か所に寄せる**。
 *
 * ## ⚠ 判断をここに置く理由
 *
 * `main.ts` は**どの test からも実行されない**(CLAUDE.md §2「どの test からも
 * 実行されない file に、判断を書かない」)。だから字と条件はこの pure module が持ち、
 * `main.ts` は**呼ぶだけ**にする。
 */

/**
 * 🔴 **画面の下に出し続ける 1 行**(退避した回だけ)。
 *
 * ⚠ **「何を失うか」を最初に言う** ── 原因(例外の綴り)は user には直せないが、
 *   「閉じると消える」は user が**いま行動できる**事実である。
 * ⚠ 例外の綴りはここに入れない ── 診断が要る人のために、帯の `title`
 *   (ツールチップ)へ回す。
 */
export const STORAGE_FALLBACK_LINE =
  '保存先が使えません ── このタブで書いたものは、閉じると消えます(ほかのタブを閉じて、読み込み直してください)';

/**
 * 帯に出す字。⚠ **退避した回だけ**出す。
 *
 * ⚠ 判定を `vfs === 'memory'` にしてはいけない ── 持ち歩ける 1 枚の HTML は
 *   **選んで** `memory` で動くので、そちらを事故として告げることになる
 *   (`storage-worker.ts` の注記と同じ向き)。`fallbackReason` が立つのは
 *   **落ちた回だけ**である。
 */
export function storageStatusLine(fallbackReason: string | undefined): string {
  return fallbackReason === undefined || fallbackReason === ''
    ? ''
    : `⚠ ${STORAGE_FALLBACK_LINE}`;
}

/**
 * 起動を止めるときの字(再試行が尽きた回)。
 * ⚠ こちらは**開けない**ので、原因も添える ── 読むのは「起動に失敗しました」の
 *   画面で、user はそれを報告に写す。
 */
export function storageFallbackError(fallbackReason: string | undefined): string {
  return `${STORAGE_FALLBACK_LINE}(原因: ${fallbackReason ?? 'unknown'})`;
}

/**
 * 帯のツールチップに添える診断。⚠ **画面の字には混ぜない**(上の理由)。
 * @param base 版と保存先(`versionText() — vfs`)
 */
export function storageStatusTitle(base: string, fallbackReason: string | undefined): string {
  return fallbackReason === undefined || fallbackReason === '' ? base : `${base} — ${fallbackReason}`;
}
