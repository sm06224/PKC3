/**
 * 🔴 **録ったものの一覧**(#683 段①。user 要望 2026-09-03)。
 *
 * > 「**時間を測る・画面録画・録音もストレージとメモ埋め込みを PKC にするだけで、
 * > 組み込みアプリにしたい**」
 *
 * ## 直す前、画面で何が起きていたか
 *
 * 録ったものは**ノートの一覧に紛れる** ── 左の札で「添付」に絞れはするが、
 * 絞りは**種別まで**で中身の種類を見ないので、**画像も PDF も Office も一緒に出る**。
 * ⚠ つまり「先週の録音」を探す仕事は**そのまま user の仕事**だった。
 *
 * ## 🔴 見分けるのは `attachment.mime` である(拡張子ではない)
 *
 * ⚠ `captureFileName` は `.ogg` / `.m4a` / `.mkv` を出しうるので、拡張子で絞ると
 *   **その 3 形式が一覧に出ない**。⚠ そして **0 件は「まだ録っていない」と読める**ので、
 *   user には「**録音が消えた**」に見える(いちばん気づけない壊れ方)。
 * ⚠ `entries` 表に **mime 列は無い**(`schema.ts`)。`assets.mime` は在るが
 *   `attach.ts` が「**信じるな**」と明記している(content-addressed なので
 *   初回に取り込んだ file の mime のまま)── だから **frontmatter を読む**。
 *
 * ⚠ `features/` 層なので **`Date` を作らない / DOM を触らない**。
 */
import { readAttachmentMeta } from '../flavor/attachment-flavor';
import { CAPTURE_LABEL } from '../asset/capture-text';

/** 一覧に並べる 1 件。⚠ **原値を持つ**(丸めるのは描画器の仕事 ── §7)。 */
export interface CaptureItem {
  readonly lid: string;
  /** ノートの題名(= 取り込んだときの file 名)。 */
  readonly title: string;
  /** frontmatter の `attachment.name`。⚠ 空なら題名を使う。 */
  readonly name: string;
  readonly mime: string;
  readonly size: number | null;
  readonly assetKey: string | null;
  /** 音か動画か。⚠ **`audio/` / `video/` のどちらか**しかここへ来ない。 */
  readonly kind: 'audio' | 'video';
}

/** 一覧に入れる元。⚠ `getBodies` の 1 往復で採れる形にしてある。 */
export interface CaptureSource {
  readonly lid: string;
  readonly title: string;
  readonly body: string;
}

/**
 * 🔴 **音か動画か**(`null` = 一覧に入れない)。
 *
 * ⚠ 引数付きの mime(`audio/webm;codecs=opus`)が**そのまま frontmatter に入りうる**
 *   ── `MediaRecorder` が返す綴りがそれである。
 * 🔴 **だからといって `;` で切る必要は無い**(2026-09-09、変異試験 C2 が
 *   SURVIVED で教えた)── 見ているのは**頭**(`startsWith`)なので、
 *   後ろに何が付いていても答えは変わる。⚠ 1 稿目はここに
 *   「`;` の前だけを見る」と**理由まで書いて**いたが、**外しても 1 件も落ちなかった**
 *   = **no-op** である(CLAUDE.md §1「これが無いと壊れるなら、外して壊れるのを見る」)。
 * 🔑 **本当に要るのは `trim` と `toLowerCase`** ── 前に空白が付いた綴り
 *   (` audio/webm`)と、外の道具が付ける大文字(`AUDIO/MP4`)で答えが変わる。
 */
export function captureKindOf(mime: string): 'audio' | 'video' | null {
  const m = mime.trim().toLowerCase();
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  return null;
}

/**
 * 添付ノートの本文から、録ったものだけを拾う。
 * ⚠ **並びは渡された順のまま**(呼び側 = `state.order` が並びの正本)──
 *   ここで並べ替えると、一覧タブと録ったものの面で**別の順**になる。
 */
export function captureItemsFrom(sources: readonly CaptureSource[]): CaptureItem[] {
  const out: CaptureItem[] = [];
  for (const s of sources) {
    const meta = readAttachmentMeta(s.body);
    const kind = captureKindOf(meta.mime);
    if (kind === null) continue;
    out.push({
      lid: s.lid,
      title: s.title,
      name: meta.name === '' ? s.title : meta.name,
      mime: meta.mime,
      size: meta.size,
      assetKey: meta.assetKey,
      kind,
    });
  }
  return out;
}

/**
 * 🔴 **画面に出す呼び名**。
 * ⚠ **録ったものとは限らない** ── 外から取り込んだ音や動画もここへ来る
 *   (`attachment.mime` で拾うので、出所は区別できない)。だから
 *   「録音」「画面収録」と言い切らず、**音 / 動画**と呼ぶ。
 * 🔑 ただし**名前が収録の形なら**、収録の呼び名を使う ── `captureFileName` が
 *   `録音-…` / `画面収録-…` と付けているので、その字で見分けられる。
 */
export function captureItemLabel(item: CaptureItem): string {
  for (const label of Object.values(CAPTURE_LABEL))
    if (item.name.startsWith(`${label}-`)) return label;
  return item.kind === 'audio' ? '音' : '動画';
}

/**
 * 絞り込み。⚠ **一覧タブの絞りと同じ字**を使う(`state.filterQuery`)──
 *   別の欄を作ると、user は「どちらが効いているか」を毎回考えることになる。
 * ⚠ 大文字小文字を無視する(題名の絞りと同じ規則)。
 */
export function visibleCaptures(
  items: readonly CaptureItem[],
  query: string,
): CaptureItem[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...items];
  return items.filter(
    (i) => i.name.toLowerCase().includes(q) || i.title.toLowerCase().includes(q),
  );
}
