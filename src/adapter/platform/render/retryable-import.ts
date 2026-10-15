/**
 * 遅延 import を 1 度だけ読み、**失敗したら覚えない**(#1087)。
 *
 * 🔴 `x ??= import(...)` の形だと、オフライン / 配り直しの後の古い chunk で
 *   一度 reject した Promise が**そのまま残り**、そのタブでは以後ずっと失敗する。
 *   失敗は捨てて、次に要るときにもう一度読みに行く。
 *
 * `onFail` が返した Error に包み直す ── 生の英語の例外(`Failed to fetch dynamic imported module`)を
 * 書き方の間違いの理由として画面に出さないため。
 */
export function retryableImport<T>(
  load: () => Promise<T>,
  onFail: (cause: unknown) => Error,
): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => {
    if (cached === null) {
      const p = load().catch((e: unknown) => {
        if (cached === p) cached = null;
        throw onFail(e);
      });
      cached = p;
    }
    return cached;
  };
}
