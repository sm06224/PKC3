/**
 * 🔴 **日付の足し算・引き算を 1 か所で決める**(#344 段①)。
 *
 * ⚠ 期間(`@2026-08-25..2026-08-28`)を扱い始めた瞬間に、日付の加算が
 *   **複数の場所で要る**ようになった ── 束ねる側(期間を日へ展開する)と、
 *   落とす側(掴んだ期間をずらす)である。
 * 🔑 CLAUDE.md §7「同じ判定が 2 か所に生えたら規則を 1 つに寄せる」に従い、
 *   ここ 1 つに寄せる。⚠ `agenda.ts` が持っていた私的な `nextDay` も**これに置き換えた**。
 *
 * ## ⚠ `Date` に通してよい場所・いけない場所
 *
 * `stored-date.ts` は「**表示のために切るだけ**なら `Date` に通すな」と書いている
 * (UTC の字を食わせると時差で 1 日ずれる)。ここは向きが違う ── 受けるのは
 * **既に日付として切り出された `YYYY-MM-DD`** で、**暦の繰り上がり**(月末・閏年)を
 * 計算するのが仕事なので、`Date` の暦こそが要る。
 * 🔑 ただし **local time で組んで local time で読む**(`new Date(y, m-1, d)`)──
 *   UTC と混ぜない。
 *
 * ## ⚠ 実在しない日は「弾かない」
 *
 * `schedule-date.ts` の裁定どおり `2026-02-30` は形として通る。ここへ来たら
 * `Date` が **3/2 へ寄せる**ので、`addDays('2026-02-30', 1)` は `2026-03-03` になる。
 * 🔑 これは**わざと**である ── 弾いて `null` を返すと、user が打ち間違えた予定が
 *   束から**黙って消える**。寄った日付は画面に出るので、user が見て直せる。
 *
 * 🔑 **pure module**。時計を読まない(「今日」は呼び側が渡す)。
 */
import { storedDateParts } from './stored-date';
import { pad2 } from './datetime-format';

/**
 * `Date` → **端末の暦日**(`YYYY-MM-DD`。`sep` で区切りを変える ── file 名は `''`)。
 * ⚠ 桁の詰め方は `pad2` 1 か所。
 *
 * 🔴 **書き出す file 名の「今日」もここ 1 つ**(#709)。直す前は 2 系統あり、
 *   設定 / 連絡先の書き出しは `toISOString().slice(0, 10)`(= **UTC の暦日**)、
 *   バックアップ / 持ち歩ける 1 枚は端末の暦日だった ── 日本の 0 時〜9 時に押すと
 *   **同じ日に落とした 2 つの file の日付が食い違う**。⚠ `toISOString` は UTC なので
 *   「今日」には使わない(`tests/features/date-math.test.ts` が変異で確かめてある)。
 */
export function dayStamp(at: Date, sep = '-'): string {
  return `${at.getFullYear()}${sep}${pad2(at.getMonth() + 1)}${sep}${pad2(at.getDate())}`;
}

/**
 * `date` の `days` 日後(負なら前)。読めない字なら `null`。
 * ⚠ 月末・年末・閏年をまたぐので `Date` に任せる(自前で桁を繰り上げない)。
 */
export function addDays(date: string, days: number): string | null {
  const p = storedDateParts(date);
  if (p === null) return null;
  return dayStamp(new Date(Number(p.year), Number(p.month) - 1, Number(p.day) + days));
}

/**
 * `from` から `to` までの日数(`to` が後なら正)。どちらかが読めなければ `null`。
 *
 * ⚠ **夏時間を計算に混ぜない** ── local の 0 時どうしを引くと、夏時間の境目を
 *   またぐ区間は 23 時間 / 25 時間ずれる。だから `Date.UTC` で組む(UTC に夏時間は無い)。
 *
 * 🔑 **ただし「これが無いと壊れる」とは書かない**(2026-08-24 に実測した)──
 *   ずれは**区間の長さに関わらず最大 1 時間**なので、local で組んでも
 *   `Math.round` が吸ってしまい、**答えは現状どちらでも同じ**である
 *   (`TZ=America/New_York` で 3/7→3/9 を測ると local 差は 47 時間 = 丸めて 2 日)。
 * ⚠ 初稿の注記は「長い期間では丸めが積もって 1 日ずれる」と書いていたが、**誤り**
 *   だった ── 積もらない。🔑 UTC にしてあるのは
 *   **丸めに寄りかからずに整数日を出すため**であって、丸めの代わりではない。
 *   test が pin しているのも「**TZ を変えても答えが変わらない**」ほうである。
 */
export function daysBetween(from: string, to: string): number | null {
  const a = storedDateParts(from);
  const b = storedDateParts(to);
  if (a === null || b === null) return null;
  const at = Date.UTC(Number(a.year), Number(a.month) - 1, Number(a.day));
  const bt = Date.UTC(Number(b.year), Number(b.month) - 1, Number(b.day));
  return Math.round((bt - at) / 86400000);
}
