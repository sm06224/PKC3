/**
 * 🔴 **静止している区間を 1 枚に畳む**(#952 A2。画面録画で動かない区間)。
 *
 * 作りは `planPictureOnly` と同じ ── **元のバイトを繋ぐだけ**で、復号も符号化もしない。
 * 畳む = 動いていない区間の差分フレームを落とす。区間の間は直前のフレームがそのまま出続けるので、
 * 長さ・音との同期・キーフレームは変わらない。
 *
 * ⚠ `features/` 層なので browser API を持たない(読み出しは `webm-vp8.ts` の `ByteSource`)。
 */
import { webmWithout, type OutputPart, type VideoBlock, type VideoScan, type VideoTrimRefusal } from './webm-vp8';

/**
 * 静止区間の検出の既定。
 *
 * - `maxBytes` ── 差分フレームの本体がこれ以下なら「ほぼ動いていない」。VP8 の差分フレームは、絵が変わらないと
 *   数バイト〜数十バイトに縮む(スキップブロックだけ)。カーソルの点滅や時計の秒が変わる程度でも百数十バイトに収まる。
 * - `minMs` ── この長さ以上続いたときだけ畳む(ちらつきで切れ切れに畳まない)
 * - `minFrames` ── 落とす枚数がこれ未満なら畳まない(1〜2 枚消しても得が無い)
 *
 * 🔑 モデルも復号も要らない手法(フレームの大きさだけを見る)。画面の録画向きで、カメラの映像のように
 *   雑音で毎フレームの大きさが揺れる映像では、静止と判定される区間が少なくなる(畳めないだけで壊れはしない)。
 */
export const STILL_DEFAULTS = { maxBytes: 160, minMs: 1000, minFrames: 3 } as const;

export interface StillOptions {
  readonly maxBytes?: number;
  readonly minMs?: number;
  readonly minFrames?: number;
}

/** 畳む区間(元の時刻)。`blocks` = 落とす映像の差分フレーム。 */
export interface StillRun {
  /** 直前に残すフレームの時刻 → 次の映像フレーム(または録画の終わり)の時刻。 */
  readonly fromMs: number;
  readonly toMs: number;
  readonly blocks: readonly VideoBlock[];
}

/**
 * 静止区間を見つける。映像のブロックを時刻順に見て、**小さな差分フレームが続く区間**のうち、**次がキーフレームか動画の終わり**の区間だけを返す
 * (参照の連鎖が切れて、残した絵が崩れない場合だけ)。キーフレームは落とさない(区間を区切る)。先頭の 1 枚は必ず残す。
 */
export function findStillRuns(scan: VideoScan, options: StillOptions = {}): StillRun[] {
  const maxBytes = options.maxBytes ?? STILL_DEFAULTS.maxBytes;
  const minMs = options.minMs ?? STILL_DEFAULTS.minMs;
  const minFrames = options.minFrames ?? STILL_DEFAULTS.minFrames;
  const video = scan.blocks.filter((b) => b.track === scan.videoTrack);
  const small = (b: VideoBlock): boolean => !b.key && b.dataEnd - b.dataStart <= maxBytes;
  const runs: StillRun[] = [];
  let i = 1;
  while (i < video.length) {
    if (!small(video[i]!)) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < video.length && small(video[j]!)) j += 1;
    /**
     * 🔴 **落としてよいのは、次の 1 枚がキーフレームのとき、または動画の終わりまで続くときだけ**(着地前レビュー ⚠2)。
     * VP8 の差分フレームは前の絵を参照して積み上がる ── 途中で落とすと、**残した次の差分フレームが違う絵を土台に復号され**、
     * 次のキーフレームまで絵が崩れる。次がキーフレームなら参照の連鎖がそこで切れ、終わりまで落とせば参照する者がいない。
     * 🔑 この条件のとき、区間の中に golden / altref を更新するフレームがあっても**影響しない**(区間は 1 枚残らず落ちる)。
     *   実測(libvpx のリアルタイム符号化): 静止した画面でも 8 枚ほどごとに golden を更新する小さなフレームが出る ──
     *   「更新するフレームは落とさない」とすると、静止区間がほとんどまとまらない。
     */
    const next = j < video.length ? video[j]! : null;
    const closes = next === null || next.key;
    const blocks = video.slice(i, j);
    const fromMs = video[i - 1]!.ms;
    const toMs = next !== null ? next.ms : scan.sourceEndMs;
    if (closes && blocks.length >= minFrames && toMs - fromMs >= minMs) runs.push({ fromMs, toMs, blocks });
    i = j;
  }
  return runs;
}

export interface FoldStillPlan {
  readonly parts: readonly OutputPart[];
  readonly byteLength: number;
  readonly durationMs: number;
  /** 畳んだ区間の数 / 落とした映像フレームの数(観測点)。 */
  readonly runs: number;
  readonly droppedFrames: number;
  /** 畳んだ区間の合計の長さ(ミリ秒)。 */
  readonly foldedMs: number;
}

export type FoldStillResult =
  | { readonly ok: true; readonly plan: FoldStillPlan }
  | { readonly ok: false; readonly reason: VideoTrimRefusal | 'nothing-to-fold' };

/** 畳んだ動画の計画。畳める区間が無ければ `nothing-to-fold`(同じ物を作らない)。⚠ `scan` は終わりまで読んだもの。 */
export function planFoldStill(scan: VideoScan, options: StillOptions = {}): FoldStillResult {
  const runs = findStillRuns(scan, options);
  if (runs.length === 0) return { ok: false, reason: 'nothing-to-fold' };
  const drop = new Set<VideoBlock>();
  let foldedMs = 0;
  for (const r of runs) {
    for (const b of r.blocks) drop.add(b);
    foldedMs += r.toMs - r.fromMs;
  }
  const out = webmWithout(scan, drop);
  return { ok: true, plan: { ...out, runs: runs.length, droppedFrames: drop.size, foldedMs } };
}
