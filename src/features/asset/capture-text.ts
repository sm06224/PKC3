/**
 * **収録の名前と、収録中の帯に出す 1 行**(#413)。
 *
 * ⚠ `features/` 層なので **`Date` を作らない / DOM を触らない**(呼び側が渡す)──
 *   ここを純関数にしておかないと、「経過が 60 秒で 1:00 になるか」のような
 *   当たり前の性質を**実ブラウザでしか確かめられない**形になる。
 */
import { assetStamp } from './pasted-image-name';

/** 何を録ったか。⚠ `media-capture.ts` の `CaptureKind` と同じ綴り(値は 2 つ)。 */
export type CaptureTextKind = 'audio' | 'screen';

/**
 * 収録の MIME → 拡張子。
 * ⚠ **`;codecs=opus` のような引数が付いて来る** ── 呼び側が落としてから渡す。
 * ⚠ 知らない型は `webm` に倒す(ブラウザ既定がほぼ webm。拡張子が無いと
 *   書き出しで種類を失う ── `pasted-image-name.ts` が `png` に倒すのと同じ理由)。
 */
const EXT: Readonly<Record<string, string>> = {
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
 * `録音-2026-08-27-030102.webm` の形。
 * ⚠ 日時の形は**貼り付けた画像と同じ**(`assetStamp`)── 一覧に並んだとき、
 *   同じ規則で並ぶ物は同じ形をしているべきである。
 */
export function captureFileName(kind: CaptureTextKind, at: Date, mime: string): string {
  const ext = EXT[mime.split(';')[0]!.trim().toLowerCase()] ?? 'webm';
  return `${CAPTURE_LABEL[kind]}-${assetStamp(at)}.${ext}`;
}

/** 2 桁に揃える。 */
const two = (n: number): string => String(n).padStart(2, '0');

/**
 * 経過(`0:07` / `12:34` / `1:02:03`)。
 * ⚠ 1 時間を超えたら**時を出す** ── 出さないと「62:03」になって読めない。
 */
export function captureElapsed(ms: number): string {
  const all = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(all / 3600);
  const m = Math.floor((all % 3600) / 60);
  const s = all % 60;
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/**
 * 帯の 1 行(`録音中 0:07(約 12KB)`)。
 *
 * ⚠ **「約」と書く** ── ここに出るのは**届いた断片の合計**であって、
 *   まだ切られていない分は入っていない。丸めた数を断定で書かない。
 */
export function captureBarLine(kind: CaptureTextKind, elapsedMs: number, bytes: string): string {
  return `${CAPTURE_LABEL[kind]}中 ${captureElapsed(elapsedMs)}(約 ${bytes})`;
}
