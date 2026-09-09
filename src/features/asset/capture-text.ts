/**
 * **収録の名前と、収録中の帯に出す 1 行**(#413)。
 *
 * ⚠ `features/` 層なので **`Date` を作らない / DOM を触らない**(呼び側が渡す)──
 *   ここを純関数にしておかないと、「経過が 60 秒で 1:00 になるか」のような
 *   当たり前の性質を**実ブラウザでしか確かめられない**形になる。
 */
import { assetStamp } from './pasted-image-name';
import { elapsedText } from '../elapsed-text';

/** 何を録ったか。⚠ `media-capture.ts` の `CaptureKind` と同じ綴り(値は 2 つ)。 */
export type CaptureTextKind = 'audio' | 'screen';

/**
 * 収録の MIME → 拡張子。
 * ⚠ **`;codecs=opus` のような引数が付いて来る** ── 呼び側が落としてから渡す。
 * ⚠ 知らない型は `webm` に倒す(ブラウザ既定がほぼ webm。拡張子が無いと
 *   書き出しで種類を失う ── `pasted-image-name.ts` が `png` に倒すのと同じ理由)。
 */
export const CAPTURE_MIME_EXT: Readonly<Record<string, string>> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
  'video/x-matroska': 'mkv',
};

/** 画面に出す呼び名。⚠ **1 か所**(名前・帯・断り文で綴りを分けない)。 */
export const CAPTURE_LABEL: Readonly<Record<CaptureTextKind, string>> = {
  audio: '録音',
  screen: '画面収録',
};

/**
 * `録音-2026-08-27-030102.webm` の形。分かれた回は `…-030102-2.webm`(#771)。
 *
 * ⚠ 日時の形は**貼り付けた画像と同じ**(`assetStamp`)── 一覧に並んだとき、
 *   同じ規則で並ぶ物は同じ形をしているべきである。
 * 🔴 **日時は「始めた時刻」を渡す**(呼び側の約束)── 分かれた 3 本が
 *   3 つの時刻を持つと、一覧で**バラバラの場所に並ぶ**。同じ時刻 + 連番なら
 *   必ず隣どうしになる。
 * 🔴 **`part` は「分かれたときだけ」番号を付ける**(`null` = 1 本で収まった)。
 *   ⚠ 常に `-1` を付けると、**分かれていない大多数の名前まで変わる** ──
 *   分かれるかどうかは、切った瞬間に分かる(切ったから 2 本目が在る)。
 */
export function captureFileName(
  kind: CaptureTextKind,
  at: Date,
  mime: string,
  part: number | null,
): string {
  const ext = CAPTURE_MIME_EXT[mime.split(';')[0]!.trim().toLowerCase()] ?? 'webm';
  const nth = part === null ? '' : `-${part}`;
  return `${CAPTURE_LABEL[kind]}-${assetStamp(at)}${nth}.${ext}`;
}

/**
 * ⚠ ここに在った `captureElapsed` は **`features/elapsed-text.ts` へ出した**(#279)──
 *   タイマーが同じ形を 2 本目に書くところだった(#454 と同じ型)。
 */

/**
 * 帯の 1 行(`録音中 0:07(約 12KB・残り 11:59:53)`)。
 *
 * ⚠ **「約」と書く** ── ここに出るのは**届いた断片の合計**であって、
 *   まだ切られていない分は入っていない。丸めた数を断定で書かない。
 * 🔴 **残りを出す**(#771)── 上限が 12 時間になったので、user が
 *   「あとどれくらい録れるのか」を**押す前に**読めないと意味が無い。
 * 🔴 **`partNo` は「いま録っている本が何本目か」**(1 始まり)。⚠ 1 本目は
 *   出さない ── 分かれていない回に「1 本目」と出すと、**分かれたのかと思わせる**。
 * ⚠ 引数は**どれも省略できない** ── 省略できるようにすると、呼び側が渡し忘れた日に
 *   帯から静かに消える(CLAUDE.md §7「optional にすると門ごと消える」)。
 */
export function captureBarLine(
  kind: CaptureTextKind,
  elapsedMs: number,
  bytes: string,
  remainingMs: number,
  partNo: number,
): string {
  const nth = partNo > 1 ? `・${partNo} 本目` : '';
  return `${CAPTURE_LABEL[kind]}中 ${elapsedText(elapsedMs)}(約 ${bytes}${nth}・残り ${elapsedText(remainingMs)})`;
}
