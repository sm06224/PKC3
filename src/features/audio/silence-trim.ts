/**
 * 🔴 **録音の前後の無音を、切り出しの範囲として見つける**(#1232。user 指示 2026-10-26「全部やるのです」)。
 *
 * > 「前後の無音部分をカットする」── 録り始めと録り終わりの、何も話していない所を一手で除きたい。
 *
 * ## 既存の切り出しに統合する(別の編集画面を作らない)
 *
 * 見つけるのは**範囲だけ**。押すと既存の切り出しの印(`SET_CAPTURE_TRIM_MARK` の始まりと終わり)に入り、
 * 切るのは既存の「この範囲で切り出す」(元は残り、新しい添付が増える)が行う。つまり user は
 * **見つかった範囲を波形で確かめ、必要なら端をドラッグで直してから切り出せる**。
 *
 * ## 無音の決め方
 *
 * 波形の山(`computePeaks` の出力。0..1)を見て、**いちばん大きい山の `RELATIVE` 倍**と `FLOOR` の大きいほうより
 * 小さい山を無音とする。絶対値だけにしないのは、小さく録れた録音で声まで無音と読まないため。
 * 先頭と末尾から、最初に無音でなくなる山までを無音として除き、**声の前後に `PAD_MS` の余白を残す**
 * (語頭・語尾の弱い音を削らない)。
 *
 * ⚠ 山は帯の幅で粗い(1 時間の録音で 1 つ 3.6 秒)── 余白がその粗さを吸う。
 * 🔑 **pure module**。DOM も store も知らない。
 */

/** 無音とみなす山の高さの下限(0..1)。これより小さい山は、どんなに録音が小さくても無音。 */
export const SILENCE_FLOOR = 0.01;
/** 無音のしきい値の、いちばん大きい山に対する割合。 */
export const SILENCE_RELATIVE = 0.05;
/** 声の前後に残す余白(ms)。 */
export const SILENCE_PAD_MS = 300;
/** 前後それぞれで、これ以下の無音は「除く物が無い」とみなす(ms)。 */
export const SILENCE_MIN_EDGE_MS = 500;

export type SilenceTrim =
  /** 前後に除ける無音が在る。`startMs` / `endMs` は残す範囲。 */
  | { readonly kind: 'range'; readonly startMs: number; readonly endMs: number }
  /** 前後とも、除くほどの無音が無い。 */
  | { readonly kind: 'nothing' }
  /** 全体がほぼ無音(声が見つからない)。 */
  | { readonly kind: 'silent' };

/**
 * @param peaks `computePeaks` の山(0..1)
 * @param durationMs 録音の長さ
 */
export function silenceTrimRange(peaks: ArrayLike<number>, durationMs: number): SilenceTrim {
  const n = peaks.length;
  if (n === 0 || !(durationMs > 0)) return { kind: 'silent' };
  let max = 0;
  for (let i = 0; i < n; i++) if (peaks[i]! > max) max = peaks[i]!;
  const threshold = Math.max(SILENCE_FLOOR, max * SILENCE_RELATIVE);
  if (max < SILENCE_FLOOR) return { kind: 'silent' };
  let first = 0;
  while (first < n && peaks[first]! < threshold) first++;
  let last = n - 1;
  while (last > first && peaks[last]! < threshold) last--;
  if (first >= n) return { kind: 'silent' };
  // 山 i は [i/n, (i+1)/n) の区間 ── 声は first の頭から last の終わりまで
  const voiceStart = (first / n) * durationMs;
  const voiceEnd = ((last + 1) / n) * durationMs;
  const startMs = Math.max(0, Math.round(voiceStart - SILENCE_PAD_MS));
  const endMs = Math.min(Math.round(durationMs), Math.round(voiceEnd + SILENCE_PAD_MS));
  const head = startMs;
  const tail = Math.round(durationMs) - endMs;
  if (head <= SILENCE_MIN_EDGE_MS && tail <= SILENCE_MIN_EDGE_MS) return { kind: 'nothing' };
  // 片側だけ除けるときも、除かない側は端のまま(0 と全長)
  return {
    kind: 'range',
    startMs: head <= SILENCE_MIN_EDGE_MS ? 0 : startMs,
    endMs: tail <= SILENCE_MIN_EDGE_MS ? Math.round(durationMs) : endMs,
  };
}
