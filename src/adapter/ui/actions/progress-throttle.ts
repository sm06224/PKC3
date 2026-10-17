/**
 * 進み具合(N / M)を画面の一時の知らせへ出すときの間引き。
 *
 * 添付が数百件あるバックアップの書き出し・取り込みは、最初の 1 行(「書き出しています…」)が
 * 最後まで残り、止まっているのか進んでいるのか分からなかった。1 件ごとに知らせると
 * 画面の更新が処理を邪魔するので、**20 件ごと、または前の知らせから 250ms 以上たったとき**だけ出す。
 * 最後の 1 件は出さない(直後に「完了」の知らせが出る)。
 */
export const PROGRESS_EVERY_ITEMS = 20;
export const PROGRESS_EVERY_MS = 250;

export function createProgressThrottle(
  emit: (done: number, total: number) => void,
  now: () => number = () => Date.now(),
): (done: number, total: number) => void {
  let lastDone = 0;
  let lastAt = now();
  return (done, total) => {
    if (done >= total) return;
    const t = now();
    if (done - lastDone >= PROGRESS_EVERY_ITEMS || t - lastAt >= PROGRESS_EVERY_MS) {
      lastDone = done;
      lastAt = t;
      emit(done, total);
    }
  };
}
