/**
 * 🔴 **長い録音を、区切りながら文字にする**(台帳 #1852 O1 / 依頼 149。Gemini 回答 = 推薦どおり ③)。
 *
 * ## 何が起きていたか
 *
 * 録音を文字にするとき、録音全体を 1 本の PCM にして認識のワーカーへ一度に渡していた。数時間の録音では、端末によってはタブが落ちる可能性がある
 * (実機ではまだ測っていない)。上限は設けていなかった。
 * 🔑 ここでは**一定の長さを超える録音だけ**を、約 10 分ごとに区切って 1 つずつ渡す(ワーカーが一度に持つ PCM が 10 分ぶんで済む)。
 *   短い録音(20 分まで)は今までどおり 1 本で渡す ── 境で語が割れる可能性を、必要な録音にだけ持たせる。
 * ⚠ 区切りは**いちばん静かな所**に寄せる(目標の位置の前後 5 秒のうち、音の小さい 0.1 秒)── 語の途中で切らないため。
 * ⚠ **pure module**(browser API を触らない)。
 */

/** 認識が受ける PCM の標本化周波数(`asr-pcm.ts` の 16kHz)。 */
export const ASR_SAMPLE_RATE = 16_000;
/** これより長い録音だけを区切る(秒)。 */
export const ASR_CHUNK_AFTER_SEC = 20 * 60;
/** 区切る長さの目標(秒)。 */
export const ASR_CHUNK_SEC = 10 * 60;
/** 区切りの位置を探す幅(目標の前後。秒)。 */
const CUT_SEARCH_SEC = 5;
/** 静かさを測る窓(秒)。 */
const CUT_WINDOW_SEC = 0.1;
/** 最後の 1 本がこれより短くなるときは、前の 1 本に合わせる(秒)。 */
const MIN_TAIL_SEC = 30;

export interface AsrChunk {
  /** 標本の添字(含む)。 */
  readonly start: number;
  /** 標本の添字(含まない)。 */
  readonly end: number;
}

/** `[from, to)` の中で、いちばん音の小さい窓の先頭の標本。 */
function quietestAt(pcm: Float32Array, from: number, to: number): number {
  const win = Math.max(1, Math.floor(ASR_SAMPLE_RATE * CUT_WINDOW_SEC));
  let best = from;
  let bestEnergy = Number.POSITIVE_INFINITY;
  for (let s = from; s + win <= to; s += win) {
    let e = 0;
    for (let i = s; i < s + win; i++) {
      const v = pcm[i]!;
      e += v * v;
    }
    if (e < bestEnergy) {
      bestEnergy = e;
      best = s;
    }
  }
  return best;
}

/** 区切りの条件(秒)。省略 = 既定(20 分を超えたら約 10 分ずつ)。⚠ test が小さい値を渡して「区切れること」を見る。 */
export interface AsrChunkOptions {
  readonly afterSec?: number;
  readonly chunkSec?: number;
  /** 最後の 1 本の最小の長さ(秒)。 */
  readonly minTailSec?: number;
  /** 区切りの位置を探す幅(目標の前後。秒)。 */
  readonly searchSec?: number;
}

/**
 * 録音(PCM)を区切る計画。20 分までなら 1 本(`[{start: 0, end: 長さ}]`)、それより長ければ約 10 分ずつ。
 * ⚠ 空の PCM は空の配列。区切りは隣り合う本が**隙間も重なりも無く**つながる(全部を足すと元の長さ)。
 */
export function planAsrChunks(pcm: Float32Array, opts: AsrChunkOptions = {}): AsrChunk[] {
  const total = pcm.length;
  if (total === 0) return [];
  const afterSec = opts.afterSec ?? ASR_CHUNK_AFTER_SEC;
  if (total <= afterSec * ASR_SAMPLE_RATE) return [{ start: 0, end: total }];
  const step = Math.max(1, Math.floor((opts.chunkSec ?? ASR_CHUNK_SEC) * ASR_SAMPLE_RATE));
  const reach = Math.floor((opts.searchSec ?? CUT_SEARCH_SEC) * ASR_SAMPLE_RATE);
  const minTail = Math.floor((opts.minTailSec ?? MIN_TAIL_SEC) * ASR_SAMPLE_RATE);
  const cuts: number[] = [];
  for (let at = step; at < total; at += step) {
    // 残りが短すぎる最後の 1 本は作らない(前の本に含める)
    if (total - at < minTail) break;
    const from = Math.max((cuts[cuts.length - 1] ?? 0) + 1, at - reach);
    const to = Math.min(total, at + reach);
    cuts.push(quietestAt(pcm, from, to));
  }
  const out: AsrChunk[] = [];
  let start = 0;
  for (const c of cuts) {
    out.push({ start, end: c });
    start = c;
  }
  out.push({ start, end: total });
  return out;
}

/** 区切りごとの結果の時刻(始まりと、あれば終わり)に、その区切りの先頭の位置(ms)を足す。 */
export function shiftSegments<T extends { readonly startMs: number; readonly endMs?: number | null }>(
  segments: readonly T[],
  offsetMs: number,
): T[] {
  return segments.map((s) => ({
    ...s,
    startMs: s.startMs + offsetMs,
    ...(typeof s.endMs === 'number' ? { endMs: s.endMs + offsetMs } : {}),
  }));
}

/** 区切りの先頭の位置(ms)。 */
export const chunkOffsetMs = (chunk: AsrChunk): number =>
  Math.round((chunk.start / ASR_SAMPLE_RATE) * 1000);
