/**
 * 🔴 **その録音は切り出せるか**(#683 段②a。user 裁定 2026-09-14)。
 *
 * ⚠ **押し所を出す前に呼ぶ** ── 切れない形にボタンを出すと、押しても断り文しか
 * 出ない。この repo の既定は「**押したら断る**」ではなく「**出さない + 理由**」である
 * (設計 doc §6)。
 *
 * 🔑 判定は **mime だけ**で済ませる ── 中身を開くには bytes を読む必要があり、
 * 一覧を描くたびに全部読むわけにいかない(12 時間の録音が何本も並びうる)。
 * ⚠ だから **mime が webm でも、中を開いてから断られうる**(lacing など)──
 * そのときは `webm-opus.ts` の `TRIM_REFUSAL_TEXT` が出る。**二重の門ではなく、
 * 粗い門と細かい門**である。
 *
 * ⚠ **pure module**(`features/` 層)。
 */
import type { CaptureItem } from './capture-item';

/** 切り出せる形か。⚠ いまは**音の webm だけ**(設計 doc §6 の梯子の 1 段目)。 */
export function canTrimCapture(item: CaptureItem): boolean {
  if (item.kind !== 'audio' || item.assetKey === null) return false;
  return item.mime.split(';')[0]!.trim().toLowerCase() === 'audio/webm';
}

/**
 * 切り出せない理由(押し所の代わりに出す 1 行)。⚠ **切り出せるなら `null`**。
 *
 * ⚠ **何も出さない場合が 2 つ在る** ── どちらも「切り出しの話が
 * そもそも画面に出ていない」ので、断り文だけが浮くのを避ける:
 * ①**動画**(いまは音だけが相手)②**中身の無い行**(聞く口も出ていない)。
 */
export function trimUnavailableText(item: CaptureItem): string | null {
  if (canTrimCapture(item)) return null;
  if (item.kind !== 'audio') return null;
  if (item.assetKey === null) return null;
  return 'この形の録音はまだ切り出せません。';
}
