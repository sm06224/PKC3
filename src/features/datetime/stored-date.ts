/**
 * DB に入っている時刻(`YYYY-MM-DD HH:MM:SS` ── sqlite の `datetime('now')`)を
 * **表示用**に整える。P9 段①。
 *
 * ## 🔴 時刻を持つ値は **UTC の瞬間**として読み、**端末の暦日**を出す(#709 案 A)
 *
 * `datetime('now')` は UTC で刻まれる。直す前は「文字列の先頭 10 字を切る」だけ
 * だったので、出ていたのは **UTC の暦日**である ── 日本(+9 時間)では 0 時〜9 時に
 * 書いたノートの作成日・更新日が**前日**で出ていた(cowork 実測 2026-09-05 07:00 JST:
 * 題名は `2026-09-05 ノート 1`、作成 / 更新欄は `2026/09/04`)。
 * ⚠ 旧 docstring の理由「`Date` に通すと時差で 1 日ずれる」は**誤り**だった ──
 *   `Z` 無しの字を V8 は端末時刻として読むのでずれない。正しい変換は
 *   **`Z` を付けて UTC として読み、端末の暦日を取る**こと。それをここでやる。
 *
 * ## ⚠ 時刻を持たない値(`YYYY-MM-DD`)は**ずらさない**
 *
 * 予定の `@2026-08-25` や frontmatter の `date:` は**暦日**であって瞬間ではない
 * (`date-math.ts` / `alarm-due.ts` / `agenda.ts` / `repeat.ts` がここを通す)。
 * 暦日に時差は無いので、そのまま切る。🔑 見分けは「時刻が付いているか」1 つ。
 *
 * ⚠ 規則はここ 1 つに寄せる(CLAUDE.md「同じ判定が 2 か所に生えたら規則を 1 つに寄せる」)
 * ── 情報列と一覧の行が別々に parse していると、片方だけ直す事故が起きる。
 */
import { pad2 } from './datetime-format';

/** `YYYY-MM-DD[ T]HH:MM…` の形か(= 瞬間を表す値か)。 */
const WITH_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;
/** 末尾に時差の印(`Z` / `+09:00` / `+0900`)を持つか。無ければ UTC と読む。 */
const WITH_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * 時刻を持つ値を **瞬間**(`Date`)にする。時刻が無い / 読めない値は `null`。
 * 🔑 時差の印が無い値は sqlite の `datetime('now')` = **UTC** なので `Z` を付けて読む。
 */
function storedInstant(value: string): Date | null {
  if (!WITH_TIME.test(value)) return null;
  const iso = value.replace(' ', 'T');
  const d = new Date(WITH_ZONE.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 年・月・日を取る。読めなければ null。
 * - 時刻を持つ値 … UTC の瞬間として読んだ**端末の暦日**
 * - 日付だけの値 … その字のまま(暦日はずらさない)
 * - 時刻はあるが `Date` が読めない値 … 先頭 10 字を切る(今までどおり素通し)
 */
export function storedDateParts(
  value: string | null | undefined,
): { year: string; month: string; day: string } | null {
  if (!value) return null;
  const at = storedInstant(value);
  if (at !== null) {
    return {
      year: String(at.getFullYear()),
      month: pad2(at.getMonth() + 1),
      day: pad2(at.getDate()),
    };
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? { year: m[1]!, month: m[2]!, day: m[3]! } : null;
}

/**
 * 機械可読な瞬間(`<time datetime>` 向け。ISO 8601、`Z` 付き)。
 * 時刻を持たない / 読めない値は `null`(属性を付けない)。
 */
export function storedInstantIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = storedInstant(value);
  return at === null ? null : at.toISOString();
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
 * 🔑 年の比較も `storedDateParts` が出した**端末の暦日**の年で行う(UTC の年ではない)。
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
