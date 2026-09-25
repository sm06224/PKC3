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
  const range = `(${elapsedText(startMs)}〜${elapsedText(endMs)})`;
  const dot = name.lastIndexOf('.');
  // ⚠ 先頭の `.` は拡張子ではない(`.gitignore` のような名前)
  if (dot <= 0) return `${name} ${range}`;
  return `${name.slice(0, dot)} ${range}${name.slice(dot)}`;
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
