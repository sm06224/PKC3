/**
 * DB に入っている時刻(`YYYY-MM-DD HH:MM:SS` ── sqlite の `datetime('now')`)を
 * **表示用**に整える。P9 段①。
 *
 * 🔑 **`Date` に通さない**。UTC の文字列を `new Date()` に食わせると端末の時差で
 * 日付が 1 日ずれる(日本なら +9 時間で、深夜の書込が翌日になる)。
 * 見せたいのは「DB に書かれている日」なので、**文字列のまま切る**。
 *
 * ⚠ 規則はここ 1 つに寄せる(CLAUDE.md「同じ判定が 2 か所に生えたら規則を 1 つに寄せる」)
 * ── 情報列と一覧の行が別々に parse していると、片方だけ直す事故が起きる。
 */

/** `YYYY-MM-DD…` の先頭を切る。読めなければ null。 */
export function storedDateParts(
  value: string | null | undefined,
): { year: string; month: string; day: string } | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? { year: m[1]!, month: m[2]!, day: m[3]! } : null;
}

/**
 * 情報列などの**そのまま読む**場所向け(`YYYY/MM/DD`)。
 * 読めない値は `fallback`(既定 `—`)。⚠ 形が違う値は捨てずにそのまま出す ──
 * 「読めなかった」ことが見えるほうが、無かったことにするより良い。
 */
export function formatStoredDate(value: string | null | undefined, fallback = '—'): string {
  if (!value) return fallback;
  const p = storedDateParts(value);
  return p ? `${p.year}/${p.month}/${p.day}` : value;
}

/**
 * 一覧の行向け(**幅を食わない**形)。
 * 今年のものは `MM/DD`、それ以外は `YYYY/MM/DD`。
 *
 * ⚠ 「今年」は引数で渡す ── 内部で `new Date()` を読むと test が年を跨いだ日に落ちる。
 */
export function formatListDate(
  value: string | null | undefined,
  thisYear: number,
  fallback = '',
): string {
  const p = storedDateParts(value);
  if (!p) return value ? value : fallback;
  return Number(p.year) === thisYear ? `${p.month}/${p.day}` : `${p.year}/${p.month}/${p.day}`;
}
