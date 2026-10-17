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

/**
 * 動画の mime の `codecs=` に書かれた名前(小文字)。⚠ 書かれていなければ空。
 * 例: `video/webm;codecs=vp9,opus` → `['vp9', 'opus']`
 */
function codecsOf(mime: string): string[] {
  const m = /codecs\s*=\s*"?([^";]+)"?/i.exec(mime);
  if (m === null) return [];
  return m[1]!.split(',').map((c) => c.trim().toLowerCase());
}

/**
 * 切り出せる形か。⚠ **音の webm と、映像が VP8 の動画の webm**(設計 doc §5 の梯子)。
 *
 * 🔑 動画は mime に `codecs=` が書かれていて **VP8 が入っていなければ**出さない(VP9 / AV1 / H.264 は
 *   キーフレームの印が違うので、この段では切らない)。書かれていないときは中を開くまで分からない
 *   ── そのときは `webm-vp8.ts` の断り文が出る(粗い門と細かい門)。
 */
export function canTrimCapture(item: CaptureItem): boolean {
  if (item.assetKey === null) return false;
  const base = item.mime.split(';')[0]!.trim().toLowerCase();
  if (item.kind === 'audio') return base === 'audio/webm';
  if (base !== 'video/webm') return false;
  const codecs = codecsOf(item.mime);
  return codecs.length === 0 || codecs.includes('vp8');
}

/**
 * 切り出せない理由(押し所の代わりに出す 1 行)。⚠ **切り出せるなら `null`**。
 *
 * ⚠ **何も出さない場合が 1 つ在る** ── **中身の無い行**(聞く口も出ていない)は、
 * 切り出しの話がそもそも画面に出ていないので、断り文だけが浮くのを避ける。
 * 🔑 音と動画で字を分ける(「録音」と書いた字が動画の行に出ない)。
 */
export function trimUnavailableText(item: CaptureItem): string | null {
  if (canTrimCapture(item)) return null;
  if (item.assetKey === null) return null;
  return item.kind === 'video'
    ? 'この形の動画はまだ切り出せません。'
    : 'この形の録音はまだ切り出せません。';
}

/** 動画から取り出す物。`audio` = 音だけ / `picture` = 絵だけ。 */
export type ExtractPart = 'audio' | 'picture';

/**
 * 🔴 **動画から音だけ / 絵だけを取り出せる形か**(#952 A1)。
 *
 * ⚠ 押し所を出す前に呼ぶ(`canTrimCapture` と同じ ── 切れない形にボタンを出さない)。
 * 🔑 mime だけで決める粗い門。中を開いてから断られうる(音が入っていない・読めない)── そのときは
 *   `webm-opus.ts` / `webm-vp8.ts` の断り文が出る。
 * - 音だけ: `video/webm` で、`codecs=` が書かれていれば opus を含むもの(音が無い録画を除く)
 * - 絵だけ: 切り出せる動画(映像が VP8 の webm)
 */
export function canExtractFromVideo(item: CaptureItem, part: ExtractPart): boolean {
  if (item.kind !== 'video' || item.assetKey === null) return false;
  if (part === 'picture') return canTrimCapture(item);
  if (item.mime.split(';')[0]!.trim().toLowerCase() !== 'video/webm') return false;
  const codecs = codecsOf(item.mime);
  return codecs.length === 0 || codecs.includes('opus');
}
