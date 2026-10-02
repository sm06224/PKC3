/**
 * 🔴 **「見えたとき」を 1 つの口で受ける**(#1223 で `mermaid-hydrate.ts` から取り出した)。
 *
 * 図(mermaid / chart)の「**描くのは見えたとき**」(user 指示 2026-08-03)と、本文に埋め込んだ
 * SQL の答え(` ```sql embed `)の「見えたときに引く」は**同じ作法**である。
 * ⚠ 後者のために別の `IntersectionObserver` の組み方を書くと、「見えたかの判定」が 2 か所に
 *   なる(CLAUDE.md §7)── 段⑪ で観測器が 121 個できたのと同じ失敗の入口でもある。
 * 🔑 だから**ここへ 1 本**に寄せ、呼ぶ側は「見えた要素を 1 度だけ受け取る」だけを知る。
 *   観測器は**呼ぶ側が 1 つ**持つ(`watchVisible` を要素ごとに呼ばない)。
 */
export interface VisibleWatch {
  observe(host: Element): void;
  unobserve(host: Element): void;
  disconnect(): void;
}

/**
 * @param seen 見えた要素ごとに**1 度だけ**呼ぶ(呼ぶ前に観測を外す)。
 *   ⚠ 見えなくなっても呼ばない(`isIntersecting` のときだけ)。
 */
export function watchVisible(seen: (host: HTMLElement) => void): VisibleWatch {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const host = e.target as HTMLElement;
      io.unobserve(host);
      seen(host);
    }
  });
  return {
    observe: (host) => io.observe(host),
    unobserve: (host) => io.unobserve(host),
    disconnect: () => io.disconnect(),
  };
}
