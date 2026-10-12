/**
 * 🔴 **数字の整形(`toLocaleString('ja-JP')`)の初回の読み込みを、操作の外へ出す**(#878)。
 *
 * ## 何が起きていたか
 *
 * 右の列の「N 文字」は `chars.toLocaleString('ja-JP')` で組む。**ページで最初の 1 回だけ**、
 * ブラウザが ICU の日本語の数字の規則を読み込むので **11〜13 ms** かかる(headless_shell で実測、
 * 2 回目以降は 0.1 ms 未満)。起動直後に大きな添付を貼ると、この 1 回が
 * 「添付ができて右の列が初めて描かれる」同じ 1 つの仕事に乗り、メインスレッドの欠測の約 70 ms のうち
 * **約 12 ms** を占めた(CPU profile。残りは新しい面の最初の style / layout)。
 *
 * ## 直し方
 *
 * 起動が済んだ後の**手が空いた時**に、捨てる値で 1 回だけ整形して読み込ませておく。
 * ⚠ 画面には何も出さない。⚠ 読み込みの費用が消えるのではなく、**操作の最中から手が空いた時へ移る**。
 */

export interface IdleHost {
  readonly requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => unknown;
  readonly setTimeout: (cb: () => void, ms: number) => unknown;
}

/** 右の列の文字数(`formatBodyStats`)と同じ言語指定で 1 回整形する。 */
export function warmNumberFormat(): void {
  (0).toLocaleString('ja-JP');
}

/**
 * 手が空いた時に `warmNumberFormat` を 1 回走らせる。
 * ⚠ 呼んだ時点では走らない(起動を遅くしない)。`requestIdleCallback` が無い環境では短い待ちで代える。
 */
export function scheduleNumberFormatWarmup(host: IdleHost): void {
  if (typeof host.requestIdleCallback === 'function') {
    host.requestIdleCallback(warmNumberFormat, { timeout: 3000 });
  } else {
    host.setTimeout(warmNumberFormat, 1000);
  }
}
