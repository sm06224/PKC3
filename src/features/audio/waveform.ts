/**
 * 🔴 **録音の波形**(#1232、Gemini 裁定 = #1163 依頼 10 D)。⚠ **pure**(browser API を触らない)。
 *
 * 一覧の音の行に **細い波形を 1 本**出し、その上のドラッグで切り出しの始まり・終わりを決める。
 * 決めた範囲は、既存の「ここを始まりにする」「ここを終わりにする」と**同じ印**(`SET_CAPTURE_TRIM_MARK`)に入る。
 *
 * ## 持つのは「山の高さの配列」だけ
 *
 * ⚠ PCM は heap に残さない(不可侵指示 2026-07-27)。デコードの結果はワーカーへ**転送**し、
 *   ワーカーが `computePeaks` で畳んだ**山の配列(最大 `WAVE_MAX_POINTS` 個)**だけが戻る。
 */

/** 山の個数の上限。⚠ 帯の幅は数百 px なので、1000 あれば 2px に 1 つ以上取れる。 */
export const WAVE_MAX_POINTS = 1000;
/** 山の個数の下限。⚠ 0 にしない(畳む先が無くなる)。 */
export const WAVE_MIN_POINTS = 16;

/**
 * 帯の幅(CSS px)から山の個数を決める。**約 2px に 1 つ**、`WAVE_MIN_POINTS`〜`WAVE_MAX_POINTS`。
 * ⚠ 幅が測れない(0 / 非数)ときも下限を返す ── 空の配列を作らない。
 */
export function peakCountFor(widthPx: number): number {
  if (!Number.isFinite(widthPx) || widthPx <= 0) return WAVE_MIN_POINTS;
  return Math.min(WAVE_MAX_POINTS, Math.max(WAVE_MIN_POINTS, Math.ceil(widthPx / 2)));
}

/**
 * 複数チャンネルの PCM を `points` 個の山(絶対値の最大、`0..1`)に畳む。
 *
 * - 各山は**そのぶんの区間の全チャンネルの最大**(平均しない ── 短い音の山が潰れる)。
 * - 区間は `[floor(i*n/points), floor((i+1)*n/points))`。⚠ 標本が `points` より少ないときは
 *   区間が空になる山が出る ── その山は **0**(無音)にし、`NaN` を作らない。
 * - 長さの違うチャンネルは短いほうに合わせる(`mixToMono` と同じ向き)。
 * - 1 を超える値(クリップ)は 1 に丸める。
 */
export function computePeaks(channels: readonly Float32Array[], points: number): Float32Array {
  const k = Math.min(WAVE_MAX_POINTS, Math.max(1, Math.floor(points)));
  const out = new Float32Array(k);
  if (channels.length === 0) return out;
  const n = Math.min(...channels.map((c) => c.length));
  if (n === 0) return out;
  for (let i = 0; i < k; i++) {
    const from = Math.floor((i * n) / k);
    const to = Math.floor(((i + 1) * n) / k);
    let peak = 0;
    for (const c of channels) {
      for (let j = from; j < to; j++) {
        const v = c[j]!;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
    }
    out[i] = peak > 1 ? 1 : peak;
  }
  return out;
}

/**
 * ポインタの x(画面座標)を録音の位置(ms)へ。
 *
 * 🔑 **CSS で伸縮した幅は `rect.width` で受ける**(`getBoundingClientRect` の幅 ── 山の個数や
 *   canvas の画素幅ではない)。⚠ 画像が `width: 100%` で伸び縮みしても位置は帯全体の割合で決まる。
 * ⚠ 帯の外へはみ出したら端に張り付く(0〜`durationMs`)。幅 0 / 長さ不明は 0 を返す。
 */
export function waveXToMs(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
  durationMs: number,
): number {
  if (!(rectWidth > 0) || !(durationMs > 0)) return 0;
  const f = (clientX - rectLeft) / rectWidth;
  const c = f < 0 ? 0 : f > 1 ? 1 : f;
  return Math.round(c * durationMs);
}

/** 位置(ms)を帯の中の割合(`0..1`)へ。⚠ 重ね描き(範囲・目盛り)の位置はこの 1 本から出す。 */
export function msToFrac(ms: number, durationMs: number): number {
  if (!(durationMs > 0) || !Number.isFinite(ms)) return 0;
  const f = ms / durationMs;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** ドラッグと見なす最小の動き(CSS px)。これ未満は「押しただけ」= その位置へ移る。 */
export const WAVE_DRAG_MIN_PX = 4;

/** 押した位置と離した位置(ms)を、小さいほうが始まりになる範囲へ。 */
export function dragRange(aMs: number, bMs: number): { readonly startMs: number; readonly endMs: number } {
  return aMs <= bMs ? { startMs: aMs, endMs: bMs } : { startMs: bMs, endMs: aMs };
}

/**
 * 文字起こしの本文から、各行の時刻(ms)を拾う。⚠ 読み方は本文の時刻リンクと**同じ 1 本**
 * (`ELAPSED_LINE_HEAD` + `parseElapsed`)── 別に書くと「押せるのに目盛りが出ない」行が生まれる。
 * 引数は注入する(features 同士の依存を増やさない)。
 */
export function transcriptTimesMs(
  body: string,
  head: RegExp,
  parse: (text: string) => number | null,
): number[] {
  const out: number[] = [];
  for (const line of body.split('\n')) {
    const m = head.exec(line.trimEnd());
    if (m === null) continue;
    const ms = parse(m[1]!);
    if (ms !== null) out.push(ms);
  }
  return out;
}
