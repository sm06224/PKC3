/**
 * 🔴 **チャプターを刻む**(#952 A4)── 場面が変わる所(動画)・無音で区切れる所(音)を見つける。
 *
 * どちらも**モデルも復号も要らない**手法で、結果は「経過 + 名前」の行(`0:15 チャプター 2`)。この行は文字起こしと同じ綴りなので、
 * 本文では**押すとその位置から再生**でき(`pkc-seek-link`)、波形の目盛りにも出る。
 *
 * - 動画: VP8 の差分フレームは、絵が変わらないと数バイトに縮み、変わると急に大きくなる。**しばらく動いていない
 *   (小さい差分だけ・または映像が出ない)あとに大きなフレームが来た所**を場面の頭とする
 * - 音: 小さな窓の大きさ(RMS)を測り、**一定以上続いた静けさのあとに声が戻る所**を頭とする
 *
 * ⚠ **pure module**(`features/` 層)。時刻の計算は ms のまま持ち、画面の字は `elapsedText` に通す。
 */
import { elapsedText } from '../elapsed-text';

/** 映像 1 フレームの要約(位置と大きさだけ)。 */
export interface FrameInfo {
  readonly ms: number;
  readonly bytes: number;
  readonly key: boolean;
}

export const SCENE_DEFAULTS = {
  /** この大きさ以下の差分フレームは「動いていない」。`fold-still` の既定と同じ。 */
  quietBytes: 160,
  /** この長さ以上動いていなかったあと、 */
  minQuietMs: 2000,
  /** この大きさ以上のフレームが来たら新しい場面。 */
  changeBytes: 1200,
  /** 直前のチャプターからこれ未満しか離れていない頭は採らない(細かく刻みすぎない)。 */
  minGapMs: 10_000,
} as const;

export interface SceneOptions {
  readonly quietBytes?: number;
  readonly minQuietMs?: number;
  readonly changeBytes?: number;
  readonly minGapMs?: number;
}

/**
 * 場面の頭(ms)の一覧。**0 は必ず先頭に入る**(最初のチャプター)。昇順。
 * 「動いていない」= 小さい差分フレーム、または映像のフレームが出ていない間(画面が止まると映像が出ない録画がある)。
 *
 * 🔴 **周期的なキーフレームは変化に数えない**(実物の fixture で判明)。エンコーダは絵が止まっていても一定の間隔でキーフレームを出す ──
 *   キーフレームを「動いた」と数えると、静止が2 秒続く前に必ず区切られて、**場面が1 つも見つからない**(実測: 1.5 秒ごとのキーフレーム)。
 *   しかも静止画面のキーフレームは中身が同じなので大きさもほぼ同じ。そこで:
 *   - キーフレームは「動いていた」時刻を進めない(静止の途中で出ても静止は続く)
 *   - ただし**直前のキーフレームと大きさが 1.5 倍以上変わった**キーフレーム(= 絵が入れ替わった)は、差分フレームの大きな変化と同じく変わり目に数える
 */
export function sceneStartsFromFrames(frames: readonly FrameInfo[], options: SceneOptions = {}): number[] {
  const quietBytes = options.quietBytes ?? SCENE_DEFAULTS.quietBytes;
  const minQuietMs = options.minQuietMs ?? SCENE_DEFAULTS.minQuietMs;
  const changeBytes = options.changeBytes ?? SCENE_DEFAULTS.changeBytes;
  const minGapMs = options.minGapMs ?? SCENE_DEFAULTS.minGapMs;
  const starts: number[] = [0];
  // 最後に「動いていた」フレームの時刻。先頭は動き始めなので 0 を置く
  let lastActiveMs = frames.length > 0 ? frames[0]!.ms : 0;
  let prevKeyBytes: number | null = frames.length > 0 && frames[0]!.key ? frames[0]!.bytes : null;
  const accept = (ms: number): void => {
    if (ms - lastActiveMs >= minQuietMs && ms - starts[starts.length - 1]! >= minGapMs) starts.push(ms);
  };
  for (let i = 1; i < frames.length; i += 1) {
    const f = frames[i]!;
    if (f.key) {
      const replaced =
        prevKeyBytes !== null && f.bytes >= changeBytes && (f.bytes > prevKeyBytes * 1.5 || f.bytes * 1.5 < prevKeyBytes);
      prevKeyBytes = f.bytes;
      if (replaced) {
        accept(f.ms);
        lastActiveMs = f.ms;
      }
      continue; // 周期的なキーフレームは、静止を中断しない
    }
    if (f.bytes <= quietBytes) continue;
    if (f.bytes >= changeBytes) accept(f.ms);
    lastActiveMs = f.ms;
  }
  return starts;
}

export const SILENCE_DEFAULTS = {
  windowMs: 50,
  /** この長さ以上続いた静けさのあとに声が戻る所を頭とする。 */
  minSilenceMs: 2000,
  minGapMs: 15_000,
  /** 静けさの基準 = 声のある所の大きさ(90 パーセンタイル)のこの倍率。 */
  relative: 0.08,
  /** これ未満は絶対に静けさ(完全な無音の録音でも基準が 0 にならない)。 */
  floorRms: 1e-3,
} as const;

export interface SilenceOptions {
  readonly windowMs?: number;
  readonly minSilenceMs?: number;
  readonly minGapMs?: number;
  readonly relative?: number;
  readonly floorRms?: number;
}

/** ms → 標本数(`ms * rate * 1e-3`)。⚠ 経過の割り算は `elapsed-text.ts` だけが持つ決まりなので、掛け算で書く。 */
export function msToSamples(ms: number, rate: number): number {
  return Math.round(ms * rate * 1e-3);
}

/** 標本数 → ms。 */
export function samplesToMs(samples: number, rate: number): number {
  return Math.round((samples * 1e3) / rate);
}

/** 窓ごとの RMS。 */
export function windowRms(pcm: Float32Array, rate: number, windowMs: number): Float32Array {
  const size = Math.max(1, msToSamples(windowMs, rate));
  const n = Math.floor(pcm.length / size);
  const out = new Float32Array(n);
  for (let w = 0; w < n; w += 1) {
    let sum = 0;
    const base = w * size;
    for (let i = 0; i < size; i += 1) {
      const v = pcm[base + i]!;
      sum += v * v;
    }
    out[w] = Math.sqrt(sum / size);
  }
  return out;
}

/** 窓の大きさの 90 パーセンタイル(声のある所の目安)。空なら 0。 */
export function percentile90(values: Float32Array): number {
  if (values.length === 0) return 0;
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!;
}

/**
 * 無音で区切れる所の頭(ms)。**0 は必ず先頭に入る**。昇順。
 * 全体が無音(基準が床以下)なら 0 だけを返す。
 */
export function silenceChapterStarts(pcm: Float32Array, rate: number, options: SilenceOptions = {}): number[] {
  const windowMs = options.windowMs ?? SILENCE_DEFAULTS.windowMs;
  const minSilenceMs = options.minSilenceMs ?? SILENCE_DEFAULTS.minSilenceMs;
  const minGapMs = options.minGapMs ?? SILENCE_DEFAULTS.minGapMs;
  const relative = options.relative ?? SILENCE_DEFAULTS.relative;
  const floorRms = options.floorRms ?? SILENCE_DEFAULTS.floorRms;
  const rms = windowRms(pcm, rate, windowMs);
  const ref = percentile90(rms);
  const starts: number[] = [0];
  if (ref <= floorRms) return starts;
  const threshold = Math.max(floorRms, ref * relative);
  const minSilentWindows = Math.max(1, Math.round(minSilenceMs / windowMs));
  let quietRun = 0;
  for (let w = 0; w < rms.length; w += 1) {
    if (rms[w]! < threshold) {
      quietRun += 1;
      continue;
    }
    if (quietRun >= minSilentWindows) {
      const ms = w * windowMs;
      if (ms - starts[starts.length - 1]! >= minGapMs) starts.push(ms);
    }
    quietRun = 0;
  }
  return starts;
}

/** 「## チャプター」の節の見出しか(`## チャプター` 単独、または `## チャプター 日時`)。⚠ 判定はここ 1 か所。 */
export const isChaptersHeading = (line: string): boolean => /^## チャプター(?:\s.*)?$/.test(line.trimEnd());

/** `## チャプター 2026-10-25 10:30`(文字起こしの見出しと同じ作り)。 */
export function chaptersHeading(at: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return `## チャプター ${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

/** 本文に足す行(`0:00 チャプター 1`)。⚠ 行頭の経過は文字起こしと同じ綴り(押すとその位置から再生する)。 */
export function chaptersText(startsMs: readonly number[]): string {
  return startsMs.map((ms, i) => `${elapsedText(ms)} チャプター ${String(i + 1)}`).join('\n');
}
