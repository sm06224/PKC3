/**
 * 端末の localStorage に持つ記録を、持ち歩ける 1 枚(portable)ごとに分ける。
 *
 * 🔴 **`file://` で開いた portable は origin が 1 つに潰れる** ── 別々の HTML を開いても
 *   localStorage は全部共有される。分けないと、B を開いたときの掃除や上書きが
 *   **A の記録を消す**(「最近開いた」`pkc3.opened` / 横に並べた枠 `pkc3.split-lids`)。
 * ⚠ 素の PKC3(`bundleId === null`)は**今までの鍵のまま** ── 経路は変えない。
 * 🔑 鍵の選び方をここ 1 か所に置く(放送路・鍵の名前が `…:${bundle.id}` で切られているのと同じ向き)。
 */

/** 保存の鍵。portable なら `<鍵>:<bundleId>`、素の PKC3 なら `<鍵>` のまま。 */
export function scopedKey(base: string, bundleId: string | null): string {
  return bundleId === null ? base : `${base}:${bundleId}`;
}

/**
 * 読む。⚠ portable で分けた鍵がまだ無いときだけ、**分ける前の鍵を 1 度だけ読む**
 * (今まで貯めた記録を失わない)。書くのは分けた鍵だけ ── 古い鍵は他の portable も読むので触らない。
 */
export function readScoped(
  get: (key: string) => string | null,
  base: string,
  bundleId: string | null,
): string | null {
  const raw = get(scopedKey(base, bundleId));
  if (raw !== null || bundleId === null) return raw;
  return get(base);
}
