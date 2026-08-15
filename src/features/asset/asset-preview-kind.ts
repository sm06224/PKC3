/**
 * 添付を**どう見せるか**の判定(2026-08-15、user 報告「PDF ビューアが動作しない」)。
 *
 * 🔴 **判定はここ 1 本**(CLAUDE.md §7「同じ値・同じ判定が複数の場所にある」)。
 * 直す前は `detail.ts` の中に三項の連鎖で埋まっていて、**別の窓で見る**の側は
 * 別の判定(`isImageAssetMime`)を使っていた ── だから
 * **画面には出せるのに別窓には出せない PDF** という食い違いが生まれた。
 *
 * ⚠ **pure module**。browser API を使わない(要素を作るのは adapter)。
 */

/** 添付の見せ方。`null` = 画面には出せない(ダウンロードで開いてもらう)。 */
export type AssetPreviewKind = 'text' | 'image' | 'video' | 'audio' | 'pdf' | null;

/**
 * MIME から見せ方を決める。
 * ⚠ `text/*` と `application/json` は**中身を読んで出す**ので別扱い
 * (呼び側が `blob.slice` で先頭だけ読む)。
 */
export function assetPreviewKind(mime: string | null | undefined): AssetPreviewKind {
  const m = mime ?? '';
  if (m.startsWith('text/') || m === 'application/json') return 'text';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  return null;
}

/**
 * 🔴 **別の窓で見られるか**(画像 / PDF)。
 *
 * ⚠ 動画・音声は**別窓にしない** ── 別窓へ移すと、窓を閉じるまで再生が続く
 * (止める導線が本文の側から消える)。見ながら書くのが目的なのは静止した物である。
 * ⚠ text は本文の面で全部読めるので、窓を増やす理由が無い。
 */
export function canOpenAssetWindow(mime: string | null | undefined): boolean {
  const kind = assetPreviewKind(mime);
  return kind === 'image' || kind === 'pdf';
}
