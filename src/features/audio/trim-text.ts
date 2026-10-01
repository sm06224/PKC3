/**
 * 🔴 **切り出したものの名前**(#683 段②a。user 裁定 2026-09-14 の A)。
 *
 * > 切り出したものは**新しい添付**として増え、名前は**元の名前 + 範囲**。
 *
 * 🔑 **聞かない**(小窓を出さない)── 手数が 1 つ少なく、名前を見れば
 * **どこを切ったか**が分かる。⚠ 直したければ、いつもの改名でできる。
 *
 * ⚠ **時刻の形は `elapsedText` の 1 本だけ**が作る ── ここで 2 本目を書くと、
 *   帯は `1:05`・名前は `1 分 5 秒` のように割れて、user は別の量だと思う
 *   (`elapsed-text.ts` の冒頭がまさにそれを戒めている)。
 */
import { elapsedText } from '../elapsed-text';

/**
 * 🔴 **1 秒未満だけを切ったときの名前は小数を出す**(#683 の裁定 B。2026-10-01)。
 *
 * ⚠ いままでは `(0:00〜0:00)` になり、**どこを切ったか見分けられなかった**。
 * 🔑 **小数を出すのは「始まりと終わりが同じ秒に落ちる」ときだけ** ──
 *   `(0:02〜0:05)` のような 1 秒以上の名前は**1 バイトも変えない**
 *   (境目の 0.9〜1.1 は別の秒に落ちるので、今までどおり `0:00〜0:01`)。
 * ⚠ 小数は **0.1 秒きざみで切り捨て**(`elapsedText` が秒を切り捨てるのと同じ向き)。
 * ⚠ 帯の時間表示(`trimMarkText`)とタイマーは**触らない**(別の量ではないが、
 *   小数を出す場面を名前だけに絞るのが裁定)。
 */
function rangeText(startMs: number, endMs: number): string {
  const secOf = (ms: number): number => Math.floor(Math.max(0, ms) / 1000);
  if (secOf(startMs) !== secOf(endMs)) return `${elapsedText(startMs)}〜${elapsedText(endMs)}`;
  const tenth = (ms: number): number => Math.floor((Math.max(0, ms) % 1000) / 100);
  return `${elapsedText(startMs)}.${tenth(startMs)}〜${elapsedText(endMs)}.${tenth(endMs)}`;
}

/**
 * `録音-2026-09-12-143000.webm` + 12〜65 秒 → `録音-2026-09-12-143000 (0:12〜1:05).webm`。
 *
 * ⚠ **拡張子の前に入れる** ── 後ろに付けると `.webm (0:12〜1:05)` になり、
 *   書き出したとき OS が種類を見失う。
 * ⚠ 拡張子が無い名前もそのまま扱える(末尾に足す)。
 * ⚠ **もう一度切ったら括弧が 2 つ並ぶ**(`(0:12〜1:05) (0:03〜0:20)`)。
 *   🔑 これはわざと ── 2 つ目の範囲は**1 つ目を切った後の中**での時刻なので、
 *   古いほうを捨てると「元のどこだったか」が消える。長くなったら改名でよい。
 */
export function trimmedCaptureName(name: string, startMs: number, endMs: number): string {
  const range = `(${rangeText(startMs, endMs)})`;
  const dot = name.lastIndexOf('.');
  // ⚠ 先頭の `.` は拡張子ではない(`.gitignore` のような名前)
  if (dot <= 0) return `${name} ${range}`;
  return `${name.slice(0, dot)} ${range}${name.slice(dot)}`;
}

/**
 * 🔴 **説明文をボタンより前に出すか**(#683 の裁定 C。2026-10-01)。
 *
 * 🔑 **最初に読む物が前、作業が始まったら操作が前**:
 *   目印が 1 つも無いときは**押し方の案内が最初に読む物**なので前へ出し、
 *   1 つでも付けたら(= 作業が始まったら)**ボタンが前**へ戻る。
 * ⚠ **双方向** ── 印を消して 0 に戻れば、また前へ来る(片道にしない)。
 */
export function trimNoteFirst(startMs: number | null, endMs: number | null): boolean {
  return startMs === null && endMs === null;
}

/**
 * 🔴 **印の出方**(#683 段②a)。⚠ **次に何をすればいいか**まで書く ──
 * 印だけ出しても、user は「切り出す」がどこに在るのか分からない。
 *
 * | 印 | 出る字 |
 * |---|---|
 * | 無い | 押し方の案内 |
 * | 片方だけ | その時刻 + **もう片方を押してくれ** |
 * | 両方 | 範囲と、切り出したあとの長さ |
 */
export function trimMarkText(startMs: number | null, endMs: number | null): string {
  if (startMs === null && endMs === null) {
    return '聞きながら「ここを始まりにする」「ここを終わりにする」を押すと、その範囲だけを新しい録音にできます。';
  }
  if (endMs === null)
    return `ここから ${elapsedText(startMs!)} ── 「ここを終わりにする」も押してください`;
  if (startMs === null)
    return `ここまで ${elapsedText(endMs)} ── 「ここを始まりにする」も押してください`;
  return `${elapsedText(startMs)}〜${elapsedText(endMs)}(${elapsedText(endMs - startMs)})`;
}
