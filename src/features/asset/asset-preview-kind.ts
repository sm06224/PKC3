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

/**
 * 🔴 **本文の中に置く再生機の印**(#413 段②)。
 *
 * ⚠ **名前をここに置く**のは、置く側が **2 つ**あるからである ──
 *   アプリの本文(`detail.ts`)と、配る HTML(`export/pkc3-html.ts`)。
 *   綴りが割れると、片方だけを見る検査が**もう片方の壊れを見逃す**(§7)。
 */
export const BODY_MEDIA_FIELD = 'body-media';

/**
 * 🔴 **同じ器の「見た目の名前」**(#413 段②)。
 *
 * ⚠ **印が 2 つ在るのには理由がある** ── 探すのは `data-pkc-field`(規約)、
 *   飾るのは class である。書き出し HTML へ焼く本文 CSS の検品は
 *   `data-pkc-field` を**1 件も通さない**(あれは器の印)ので、
 *   器の名前で飾ると**配った HTML からその規則だけが静かに落ちる**。
 */
export const BODY_MEDIA_CLASS = 'pkc-body-media';

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
  return assetWindowKind(mime) !== null;
}

/** 別窓に出せる種類。⚠ `AssetPreviewKind` の**部分集合**である。 */
export type AssetWindowKind = 'image' | 'pdf';

/**
 * 🔴 **MIME から「別窓での出し方」を決める**(2026-08-15、着地前レビューで判明)。
 *
 * ⚠ 直す前は `main.ts` に `assetPreviewKind(mime) === 'pdf' ? 'pdf' : 'image'` と
 * 書いていた。**知らない種類を黙って image に落とす**形なので、
 * ① `'pdf'` 側へ変える変異が**全 test 緑のまま通り**(`main.ts` は原文を読む test しか
 * 無く、別窓の unit は `kind` を引数で受け、popup の smoke は PDF の 1 本だけ)、
 * 画像の別窓が**空の枠**になる ② 将来 `canOpenAssetWindow` を広げた瞬間に、
 * 増えた種類が黙って image になる。
 * 🔑 **写像を features へ出して、出せないものは `null` を返す**(呼び側が断る)。
 */
export function assetWindowKind(mime: string | null | undefined): AssetWindowKind | null {
  const kind = assetPreviewKind(mime);
  return kind === 'image' || kind === 'pdf' ? kind : null;
}
