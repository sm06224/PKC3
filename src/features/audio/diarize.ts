/**
 * 🔴 **話者分離**(#952 B4・#949)── 声の区間を見つけ、声の特徴でまとめて「誰が話している区間か」を出す。pure。
 *
 * ## 手法(モデルを足さない・端末の中だけ)
 *
 * 1. **声の区間**:RNNoise の声らしさ(`vad`、10ms ごと)から、ヒステリシスで声の塊を作る。300ms 未満の隙間は埋め、300ms 未満の塊は捨て、
 *    6 秒を超える塊は等分する(長く話し続けても途中の話者交代で 1 つの塊にならないように)
 * 2. **特徴**:雑音を引いた声を 16kHz に落とし、25ms 窓・10ms 刻みの MFCC(メルフィルタバンク 24 本・係数 c1〜c12)の平均と、
 *    自己相関で求めた基本周波数(F0)の中央値を塊ごとに 1 つのベクトルにする(**埋め込みの代わりの素朴な特徴**)
 * 3. **まとめ方**:凝集型クラスタリング(重心間の距離)。距離が `MERGE_DISTANCE` を下回る間は併合し、話者は最大 `MAX_SPEAKERS` 人。
 *    合計 `MIN_SPEAKER_MS` に満たない小さな塊は、いちばん近い話者へ吸収する
 *
 * ## ⚠ 限界(画面でも言う)
 * MFCC の平均 + F0 は**学習済みの話者埋め込みではない**。声の高さやこもり方が離れた人どうし(男女など)はよく分かれるが、
 * 似た声の人どうしは 1 人にまとまりうる。重なって話す所は分けられない。だから結果は**あとから直せる**
 * (本文の「## 話者」の行を書き換える / 「話者を直す」で名前の付け替え・統合)。
 *
 * ⚠ `features/` 層なので browser API を持たない。
 */
import { VOICE_FRAME, VOICE_RATE, VAD_WARMUP_FRAMES, type Span } from './voice-lab';

export const MAX_SPEAKERS = 6;
/** 塊の境:声が戻る / 離れる声らしさ。 */
export const VAD_ON = 0.6;
export const VAD_OFF = 0.4;
/** 埋める隙間 / 捨てる短い塊 / 等分する長さ(10ms の枠の数)。 */
export const GAP_FRAMES = 30;
export const MIN_RUN_FRAMES = 30;
export const MAX_PIECE_FRAMES = 600;
/** 併合する距離(特徴量の重み付き距離。合成の声での較正は tests/features/diarize.test.ts)。 */
export const MERGE_DISTANCE = 4.3;
/** 話者として数える最小の合計の長さ(ミリ秒)。これに満たない小さな塊は近い話者に吸収する。 */
export const MIN_SPEAKER_MS = 3000;
/** 同じ話者の隣り合う塊の間がこれ以下なら 1 つの発話にまとめる(ミリ秒)。 */
export const TURN_JOIN_MS = 1500;

export interface SpeakerSegment extends Span {
  readonly speaker: number;
}

export interface SpeakerTurn {
  readonly startMs: number;
  readonly endMs: number;
  /** 0 始まり(出てきた順)。 */
  readonly speaker: number;
}

export interface Diarization {
  readonly segments: readonly SpeakerSegment[];
  readonly turns: readonly SpeakerTurn[];
  readonly speakers: number;
}

// ---------------------------------------------------------------------------------------------
// 声の塊
// ---------------------------------------------------------------------------------------------

/** 声の塊(10ms の枠の番号で `[start, end)`)。 */
export function voicedRuns(vad: Float32Array): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = [];
  let start = -1;
  for (let k = VAD_WARMUP_FRAMES; k <= vad.length; k += 1) {
    const v = k < vad.length ? vad[k]! : 0;
    if (start < 0) {
      if (v >= VAD_ON) start = k;
    } else if (v < VAD_OFF) {
      runs.push({ start, end: k });
      start = -1;
    }
  }
  // 近い塊をつなぐ
  const joined: Array<{ start: number; end: number }> = [];
  for (const r of runs) {
    const last = joined[joined.length - 1];
    if (last !== undefined && r.start - last.end <= GAP_FRAMES) last.end = r.end;
    else joined.push({ ...r });
  }
  return joined.filter((r) => r.end - r.start >= MIN_RUN_FRAMES);
}

/** 長い塊を等分する(各片は `MAX_PIECE_FRAMES` 以下)。 */
export function splitLong(runs: ReadonlyArray<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const r of runs) {
    const len = r.end - r.start;
    const n = Math.ceil(len / MAX_PIECE_FRAMES);
    for (let i = 0; i < n; i += 1) {
      out.push({ start: r.start + Math.round((len * i) / n), end: r.start + Math.round((len * (i + 1)) / n) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 特徴(MFCC + F0)
// ---------------------------------------------------------------------------------------------

const FEAT_RATE = 16_000;
const WIN = 400; // 25ms
const HOP = 160; // 10ms
const NFFT = 512;
const N_MEL = 24;
const N_CEP = 12; // c1..c12
const F_LOW = 80;
const F_HIGH = 7600;

/** 基数 2 の FFT(その場)。`re.length` は 2 のべき乗。 */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

const hz2mel = (f: number): number => 2595 * Math.log10(1 + f / 700);
const mel2hz = (m: number): number => 700 * (10 ** (m / 2595) - 1);

/** 三角のメルフィルタバンク(`N_MEL` 本 × `NFFT/2+1` ビン)。 */
const MEL_BANK: Float64Array[] = (() => {
  const bins = NFFT / 2 + 1;
  const mel0 = hz2mel(F_LOW);
  const mel1 = hz2mel(F_HIGH);
  const pts: number[] = [];
  for (let i = 0; i < N_MEL + 2; i += 1) pts.push(Math.floor(((NFFT + 1) * mel2hz(mel0 + ((mel1 - mel0) * i) / (N_MEL + 1))) / FEAT_RATE));
  const bank: Float64Array[] = [];
  for (let m = 1; m <= N_MEL; m += 1) {
    const f = new Float64Array(bins);
    const l = pts[m - 1]!;
    const c = pts[m]!;
    const r = pts[m + 1]!;
    for (let k = l; k < c; k += 1) if (c > l) f[k] = (k - l) / (c - l);
    for (let k = c; k < r; k += 1) if (r > c) f[k] = (r - k) / (r - c);
    bank.push(f);
  }
  return bank;
})();

const HAMMING = Float64Array.from({ length: WIN }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (WIN - 1)));

/** 48kHz → 16kHz(3 つ平均して間引く。粗い低域通過を兼ねる)。 */
export function decimate3(x: Float32Array, from: number, to: number): Float32Array {
  const n = Math.floor((to - from) / 3);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = from + i * 3;
    out[i] = (x[a]! + x[a + 1]! + x[a + 2]!) / 3;
  }
  return out;
}

/** 窓 1 つぶんの基本周波数(Hz)。声でなければ `null`。正規化自己相関の最大(70〜400Hz)。 */
export function f0Of(frame: Float32Array): number | null {
  const lagMin = Math.floor(FEAT_RATE / 400);
  const lagMax = Math.floor(FEAT_RATE / 70);
  let e0 = 0;
  for (let i = 0; i < frame.length; i += 1) e0 += frame[i]! * frame[i]!;
  if (e0 < 1e-9) return null;
  let best = 0;
  let bestLag = 0;
  for (let lag = lagMin; lag <= lagMax; lag += 1) {
    let c = 0;
    let e1 = 0;
    for (let i = 0; i + lag < frame.length; i += 1) {
      c += frame[i]! * frame[i + lag]!;
      e1 += frame[i + lag]! * frame[i + lag]!;
    }
    const r = c / Math.sqrt(e0 * e1 + 1e-12);
    if (r > best) {
      best = r;
      bestLag = lag;
    }
  }
  return best > 0.4 && bestLag > 0 ? FEAT_RATE / bestLag : null;
}

export interface SegmentFeature {
  /** c1〜c12 の平均。 */
  readonly cep: Float64Array;
  /** F0 の中央値の自然対数(取れなかったら `NaN`)。 */
  readonly lnF0: number;
  /** 特徴に使った窓の数。 */
  readonly frames: number;
}

/** 16kHz の信号 `x`(声の塊ひとつぶん)の特徴。窓が少なすぎれば `null`。 */
export function featureOf(x: Float32Array): SegmentFeature | null {
  const nFrames = Math.floor((x.length - WIN) / HOP) + 1;
  if (nFrames < 10) return null;
  // 窓ごとのエネルギー → 小さい窓(息継ぎ・無声)は特徴から外す
  const energies = new Float64Array(nFrames);
  let mean = 0;
  for (let f = 0; f < nFrames; f += 1) {
    let e = 0;
    for (let i = 0; i < WIN; i += 1) e += x[f * HOP + i]! * x[f * HOP + i]!;
    energies[f] = e;
    mean += e / nFrames;
  }
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const cepSum = new Float64Array(N_CEP);
  const f0s: number[] = [];
  let used = 0;
  for (let f = 0; f < nFrames; f += 1) {
    if (energies[f]! < mean * 0.25) continue;
    re.fill(0);
    im.fill(0);
    const base = f * HOP;
    for (let i = 0; i < WIN; i += 1) {
      const prev = i > 0 ? x[base + i - 1]! : 0;
      re[i] = (x[base + i]! - 0.97 * prev) * HAMMING[i]!;
    }
    fft(re, im);
    const logMel = new Float64Array(N_MEL);
    for (let m = 0; m < N_MEL; m += 1) {
      const bank = MEL_BANK[m]!;
      let s = 0;
      for (let k = 0; k <= NFFT / 2; k += 1) if (bank[k]! > 0) s += bank[k]! * (re[k]! * re[k]! + im[k]! * im[k]!);
      logMel[m] = Math.log(s + 1e-10);
    }
    for (let c = 1; c <= N_CEP; c += 1) {
      let s = 0;
      for (let m = 0; m < N_MEL; m += 1) s += logMel[m]! * Math.cos((Math.PI * c * (m + 0.5)) / N_MEL);
      cepSum[c - 1] = cepSum[c - 1]! + s;
    }
    const f0 = f0Of(x.subarray(base, base + WIN));
    if (f0 !== null) f0s.push(f0);
    used += 1;
  }
  if (used < 10) return null;
  const cep = cepSum.map((v) => v / used);
  f0s.sort((a, b) => a - b);
  const lnF0 = f0s.length >= 5 ? Math.log(f0s[Math.floor(f0s.length / 2)]!) : Number.NaN;
  return { cep, lnF0, frames: used };
}

// ---------------------------------------------------------------------------------------------
// クラスタリング
// ---------------------------------------------------------------------------------------------

/** 距離の重み:係数ごとの目安の幅(c1 が大きく、高次ほど小さい)と、F0(自然対数)の目安の幅。 */
const CEP_SCALE = Float64Array.from({ length: N_CEP }, (_, i) => 8 / (1 + i * 0.25));
const F0_SCALE = 0.07;

interface Cluster {
  members: number[];
  cep: Float64Array;
  lnF0: number;
  weight: number;
}

function distance(a: Cluster, b: Cluster): number {
  let d2 = 0;
  for (let k = 0; k < N_CEP; k += 1) {
    const d = (a.cep[k]! - b.cep[k]!) / CEP_SCALE[k]!;
    d2 += d * d;
  }
  if (!Number.isNaN(a.lnF0) && !Number.isNaN(b.lnF0)) {
    const d = (a.lnF0 - b.lnF0) / F0_SCALE;
    d2 += d * d;
  }
  return Math.sqrt(d2);
}

/** 2 つの特徴の距離(重み付き)。 */
export function featureDistance(a: SegmentFeature, b: SegmentFeature): number {
  return distance(
    { members: [], cep: a.cep, lnF0: a.lnF0, weight: 1 },
    { members: [], cep: b.cep, lnF0: b.lnF0, weight: 1 },
  );
}

function mergeClusters(a: Cluster, b: Cluster): Cluster {
  const w = a.weight + b.weight;
  const cep = new Float64Array(N_CEP);
  for (let k = 0; k < N_CEP; k += 1) cep[k] = (a.cep[k]! * a.weight + b.cep[k]! * b.weight) / w;
  let lnF0 = Number.NaN;
  if (!Number.isNaN(a.lnF0) && !Number.isNaN(b.lnF0)) lnF0 = (a.lnF0 * a.weight + b.lnF0 * b.weight) / w;
  else if (!Number.isNaN(a.lnF0)) lnF0 = a.lnF0;
  else if (!Number.isNaN(b.lnF0)) lnF0 = b.lnF0;
  return { members: [...a.members, ...b.members], cep, lnF0, weight: w };
}

export interface ClusterInput {
  readonly feature: SegmentFeature;
  /** 長さ(ミリ秒)。重みと「小さな塊」の判定に使う。 */
  readonly ms: number;
}

/** `clusterSegments` の観測(test が計算量を数える)。 */
export interface ClusterStats {
  /** 距離を計算した回数。 */
  distances: number;
}

/**
 * 塊の特徴を話者にまとめる。戻り値は塊ごとの話者番号(**出てきた順**に 0, 1, …)。
 * 併合は距離 `mergeDistance` 未満の間。話者は最大 `maxSpeakers` 人。合計が `minSpeakerMs` に満たない話者は近い話者へ吸収する。
 *
 * 🔴 **計算量は O(n²)**(着地前レビュー ⚠4)。毎回すべての組の距離を測り直すと O(n³) で、n=1000 で約 4 秒・n=3000 で約 2 分かかった。
 * 各クラスタが**いちばん近い相手(nn)とその距離**を覚え、併合のたびに更新が要る所だけを測り直す:
 *  - 併合で消えたクラスタが nn だった者だけ、全体を測り直す(O(n))
 *  - それ以外は、新しいクラスタとの距離 1 つだけを比べる
 * 最初の表づくりだけが n²/2 回で、あとは併合ごとに O(n) ── 実測は `tests/features/diarize.test.ts`。
 */
export function clusterSegments(
  inputs: readonly ClusterInput[],
  options: {
    readonly mergeDistance?: number;
    readonly maxSpeakers?: number;
    readonly minSpeakerMs?: number;
    readonly stats?: ClusterStats;
  } = {},
): number[] {
  const tau = options.mergeDistance ?? MERGE_DISTANCE;
  const maxSp = options.maxSpeakers ?? MAX_SPEAKERS;
  const minMs = options.minSpeakerMs ?? MIN_SPEAKER_MS;
  const stats = options.stats;
  const dist = (a: Cluster, b: Cluster): number => {
    if (stats !== undefined) stats.distances += 1;
    return distance(a, b);
  };
  const n = inputs.length;
  const slots: Array<Cluster | null> = inputs.map((p, i) => ({ members: [i], cep: p.feature.cep, lnF0: p.feature.lnF0, weight: p.ms }));
  const nnIdx = new Int32Array(n).fill(-1);
  const nnDist = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  let alive = n;

  /** `i` のいちばん近い相手を全体から測り直す。 */
  const recompute = (i: number): void => {
    nnIdx[i] = -1;
    nnDist[i] = Number.POSITIVE_INFINITY;
    const ci = slots[i]!;
    for (let k = 0; k < n; k += 1) {
      const ck = slots[k];
      if (k === i || ck === null || ck === undefined) continue;
      const d = dist(ci, ck);
      if (d < nnDist[i]!) {
        nnDist[i] = d;
        nnIdx[i] = k;
      }
    }
  };

  // 最初の表:組ごとに 1 回だけ測り、両方の「いちばん近い相手」を更新する
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const d = dist(slots[i]!, slots[j]!);
      if (d < nnDist[i]!) {
        nnDist[i] = d;
        nnIdx[i] = j;
      }
      if (d < nnDist[j]!) {
        nnDist[j] = d;
        nnIdx[j] = i;
      }
    }
  }

  while (alive > 1) {
    // いま最も近い組(nn の表を 1 周するだけ)
    let bi = -1;
    for (let i = 0; i < n; i += 1) if (slots[i] !== null && nnIdx[i]! >= 0 && (bi < 0 || nnDist[i]! < nnDist[bi]!)) bi = i;
    if (bi < 0) break;
    const bj = nnIdx[bi]!;
    if (nnDist[bi]! >= tau && alive <= maxSp) break;
    slots[bi] = mergeClusters(slots[bi]!, slots[bj]!);
    slots[bj] = null;
    alive -= 1;
    if (alive <= 1) break;
    recompute(bi);
    for (let k = 0; k < n; k += 1) {
      const ck = slots[k];
      if (k === bi || ck === null || ck === undefined) continue;
      if (nnIdx[k] === bi || nnIdx[k] === bj) {
        recompute(k); // いちばん近かった相手が動いた(併合で消えた / 重心が動いた)
      } else {
        const d = dist(ck, slots[bi]!);
        if (d < nnDist[k]!) {
          nnDist[k] = d;
          nnIdx[k] = bi;
        }
      }
    }
  }

  // ここから先は話者の数(最大 maxSpeakers)だけが相手 ── 小さな話者を近い話者へ吸収する(大きな話者が 1 つは残る)
  let clusters: Cluster[] = slots.filter((c): c is Cluster => c !== null);
  for (;;) {
    if (clusters.length <= 1) break;
    const small = clusters.findIndex((c) => c.weight < minMs);
    if (small < 0) break;
    // 全員が小さい(短い録音)── 吸収せず、距離で分かれたままにする
    if (clusters.every((c) => c.weight < minMs)) break;
    let nearest = -1;
    let nd = Number.POSITIVE_INFINITY;
    for (let k = 0; k < clusters.length; k += 1) {
      if (k === small || clusters[k]!.weight < minMs) continue;
      const d = dist(clusters[small]!, clusters[k]!);
      if (d < nd) {
        nd = d;
        nearest = k;
      }
    }
    const merged = mergeClusters(clusters[small]!, clusters[nearest]!);
    clusters = clusters.filter((_, k) => k !== small && k !== nearest);
    clusters.push(merged);
  }
  // 出てきた順に番号を振る
  const labelOf = new Array<number>(n).fill(-1);
  for (let c = 0; c < clusters.length; c += 1) for (const m of clusters[c]!.members) labelOf[m] = c;
  const order = new Map<number, number>();
  return labelOf.map((l) => {
    if (!order.has(l)) order.set(l, order.size);
    return order.get(l)!;
  });
}

// ---------------------------------------------------------------------------------------------
// 全体
// ---------------------------------------------------------------------------------------------

const frameToMs = (k: number): number => k * 10;

/**
 * 話者分離。`clean` は雑音を引いた PCM(48kHz)、`vad` はその 10ms ごとの声らしさ。
 * 声が無ければ `speakers: 0`・`turns: []`。
 */
export function diarize(clean: Float32Array, vad: Float32Array): Diarization {
  const pieces = splitLong(voicedRuns(vad));
  const featured: Array<{ run: { start: number; end: number }; input: ClusterInput }> = [];
  const dropped: Array<{ start: number; end: number }> = [];
  for (const run of pieces) {
    const from = run.start * VOICE_FRAME;
    const to = Math.min(clean.length, run.end * VOICE_FRAME);
    const x = decimate3(clean, from, to);
    const feature = featureOf(x);
    if (feature === null) dropped.push(run);
    else featured.push({ run, input: { feature, ms: frameToMs(run.end - run.start) } });
  }
  if (featured.length === 0) return { segments: [], turns: [], speakers: 0 };
  const labels = clusterSegments(featured.map((f) => f.input));
  const segments: SpeakerSegment[] = featured.map((f, i) => ({
    start: f.run.start * VOICE_FRAME,
    end: Math.min(clean.length, f.run.end * VOICE_FRAME),
    speaker: labels[i]!,
  }));
  // 発話(同じ話者の近い塊をつなぐ)
  const turns: SpeakerTurn[] = [];
  for (const s of segments) {
    const startMs = Math.round((s.start * 1e3) / VOICE_RATE);
    const endMs = Math.round((s.end * 1e3) / VOICE_RATE);
    const last = turns[turns.length - 1];
    if (last !== undefined && last.speaker === s.speaker && startMs - last.endMs <= TURN_JOIN_MS) {
      turns[turns.length - 1] = { ...last, endMs };
    } else {
      turns.push({ startMs, endMs, speaker: s.speaker });
    }
  }
  return { segments, turns, speakers: Math.max(...labels) + 1 };
}
