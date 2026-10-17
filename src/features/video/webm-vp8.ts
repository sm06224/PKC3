/**
 * 🔴 **画面録画(webm = VP8 の映像 + opus の音)の前後を削る**(#683 段②b-1・②b-2。設計 doc
 * `docs/development/video-trim-design-2026-10.md` §3・§4・§5)。
 *
 * ## 🔑 いちばん大事な性質 ── **映像の大半を作り直さない・250MB を丸ごと読まない**
 *
 * VP8 の差分フレームは**前のフレームが無いと絵にならない**ので、始まりは
 * 「押した所より手前の最も近いキーフレーム」へ戻す(= 始まりが少し**早く**なる ── 段②b-1・`planVideoTrim` の既定)。
 * そこから終わりまでは**元のバイトをそのまま繋ぐ**(`Blob.slice` の部品)だけで、
 * 変えるのは `Cluster` の `Timecode`(0 起点に直す)と `Info` の `Duration` だけである。
 *
 * 🔴 **段②b-2(押した所ぴったり)**:WebCodecs が使える環境では、押した所に表示されているフレームから
 * 次のキーフレーム(K1)の手前までだけを**作り直し**(`precisePlanSpec` が範囲を決め、呼び側が復号 → 符号化して
 * `HeadFrame` にする)、K1 から先は同じく元のバイトを繋ぐ(`planVideoTrim` の `head`)。作り直した頭は
 * `SimpleBlock`(1 枚目だけキーフレームの旗)で、1 秒ごとの `Cluster` に詰める。
 *
 * | | |
 * |---|---|
 * | 読む | 8MB 程度の窓を順に(ブロックの**頭だけ**を見て、索引だけを残す) |
 * | 書く | 元の `Blob` の部品 + 新しい見出し(**コピーしない**)。組み直すのは頭と尻の `Cluster` 2 つだけ |
 *
 * ## ⚠ キーフレームの印は 3 つ ── 食い違えば**フレーム本体の印**を正とする
 *
 * 1. `SimpleBlock` のキーフラグ(`0x80`)
 * 2. `BlockGroup` に `ReferenceBlock` が**無い**(**Chrome の映像はこれ**。`SimpleBlock` のフラグは
 *    常に立たない ── 設計 doc §2.1 の実測)
 * 3. 🔑 VP8 の `frame tag`(ブロックの先頭 3 バイト)の bit 0 = 0(RFC 6386 §9.1)
 *
 * ## 音の扱い(設計 doc §4.4 の「外れたら」側を最初から採る)
 *
 * 映像付きの `<video>` が `CodecDelay` による頭の捨てをどう解釈するかは**未測**なので、
 * 札(`CodecDelay` / `DiscardPadding`)は**使わない**。音は始まりの時刻**以降**の最初の
 * packet から採る(最大 1 packet = 約 60ms 遅れる。放送の同期許容の内側)。
 *
 * ⚠ **`features/` 層なので browser API を持たない**(`Blob` も `Worker` も知らない)。
 * 読み出しは `ByteSource`(呼び側が `Blob.slice` で作る)を通す。
 */
import {
  concatBytes,
  asciiBytes,
  element,
  float64Bytes,
  hexBytes,
  readAscii,
  readId,
  readSizeAt,
  readUint,
  readVintLength,
  uintBytes,
  writeSize,
} from '../audio/ebml';

/** 窓で読むための口。⚠ `read` は `[start, end)` を返す。 */
export interface ByteSource {
  readonly size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

/** 切り出せない理由。⚠ どれも「押したのに無言」を作らないためのもの。 */
export type VideoTrimRefusal =
  | 'not-webm'
  | 'not-vp8'
  | 'not-opus'
  | 'lacing'
  | 'no-video'
  | 'empty-range'
  | 'timescale'
  | 'broken';

/** 断り文。⚠ user が読む字なので内部の綴りを出さない。 */
export const VIDEO_TRIM_REFUSAL_TEXT: Record<VideoTrimRefusal, string> = {
  'not-webm': 'この形の動画はまだ切り出せません。',
  'not-vp8': 'この動画は切り出しに対応していない映像の形式です。',
  'not-opus': 'この動画は切り出しに対応していない音の形式です。',
  lacing: 'この動画は切り出しに対応していない詰め方です。',
  'no-video': 'この動画には映像が入っていません。',
  'empty-range': '選んだ範囲に映像が入っていません。',
  timescale: 'この動画は切り出しに対応していない時間の刻み方です。',
  broken: 'この動画は途中までしか読めませんでした。',
};

/** 索引の 1 行(映像か音のブロック)。⚠ **bytes は持たない**(位置だけ)。 */
export interface VideoBlock {
  readonly track: number;
  /** 先頭を 0 とした時刻(ミリ秒)。 */
  readonly ms: number;
  /** 入っている `Cluster` の番号(`VideoScan.clusters` の添字)。 */
  readonly cluster: number;
  /** ブロックを持つ要素(`SimpleBlock` か `BlockGroup`)の頭と尻(file 内の位置)。 */
  readonly elStart: number;
  readonly elEnd: number;
  /** 相対時刻(2 バイト)の位置(file 内)。⚠ 組み直すときに書き換える所。 */
  readonly relPos: number;
  /** 映像のキーフレームか(音は `false`)。 */
  readonly key: boolean;
  /**
   * フレーム本体(トラック番号・相対時刻・旗の後ろ)の頭と尻(file 内の位置)。
   * 🔑 段②b-2:作り直す塊を復号器へ渡すとき、`BlockGroup` の `ReferenceBlock` を含めずに本体だけを読むために持つ。
   */
  readonly dataStart: number;
  readonly dataEnd: number;
}

export interface VideoCluster {
  readonly start: number;
  readonly bodyStart: number;
  /** `Timecode` 要素の頭と尻。 */
  readonly tcStart: number;
  readonly tcEnd: number;
  /** 先頭を 0 とした `Timecode`(ミリ秒)。 */
  readonly tcMs: number;
  /** 次の要素の頭(= この `Cluster` の尻)。 */
  readonly end: number;
}

/**
 * 走査の結果。⚠ **索引だけ**(bytes は持たない)。
 * 大きさは 1 ブロックあたり数十バイトの見積もりで、**未測**(250MB でも数 MB に収まる見込み)。
 */
export interface VideoScan {
  readonly videoTrack: number;
  readonly audioTrack: number | null;
  readonly width: number;
  readonly height: number;
  /** `Tracks` 要素の頭と尻(**元のバイトを写す**)。 */
  readonly tracksStart: number;
  readonly tracksEnd: number;
  readonly clusters: readonly VideoCluster[];
  readonly blocks: readonly VideoBlock[];
  /** 映像のキーフレームの時刻(昇順)。 */
  readonly keyMs: readonly number[];
  /** 映像 1 フレームの長さ(ミリ秒。間隔の中央値)。 */
  readonly frameGapMs: number;
  /**
   * 録画の終わり(ミリ秒)。⚠ 映像の最後のフレームの終わり**と音の最後の packet の終わりの大きいほう**。
   * 🔴 実機の画面録画は画面が止まると**映像のフレームが出ない**(音だけが続く。実測: 3.3 秒の録画で
   *   映像は最初の 0.4 秒に 9 枚だけ)── 映像だけで終わりを決めると、後半を押した所が「録画の外」と断られる。
   */
  readonly sourceEndMs: number;
  /** 窓で読んだ合計(観測点)。 */
  readonly bytesRead: number;
}

export type ScanResult =
  | { readonly ok: true; readonly scan: VideoScan }
  | { readonly ok: false; readonly reason: VideoTrimRefusal };

/** 読む窓の大きさ(設計 doc §4.1)。 */
export const SCAN_WINDOW_BYTES = 8 * 1024 * 1024;

const ID_EBML_HEAD = '1a45dfa3';
const ID_SEGMENT = '18538067';
const ID_INFO = '1549a966';
const ID_TRACKS = '1654ae6b';
const ID_TRACK_ENTRY = 'ae';
const ID_VIDEO = 'e0';
const ID_AUDIO = 'e1';
const ID_CLUSTER = '1f43b675';
const ID_BLOCK_GROUP = 'a0';
const ID_BLOCK = 'a1';
const ID_SIMPLE_BLOCK = 'a3';
const ID_REFERENCE_BLOCK = 'fb';
const ID_TIMESTAMP_SCALE = '2ad7b1';
const ID_TRACK_NUMBER = 'd7';
const ID_TRACK_TYPE = '83';
const ID_CODEC_ID = '86';
const ID_PIXEL_WIDTH = 'b0';
const ID_PIXEL_HEIGHT = 'ba';
const ID_CLUSTER_TIMECODE = 'e7';

/** `Cluster` の外(`Segment` 直下)に居る要素。⚠ これに当たったら `Cluster` は終わり。 */
const SEGMENT_CHILD_IDS: ReadonlySet<string> = new Set([
  ID_CLUSTER,
  '1c53bb6b', // Cues
  '114d9b74', // SeekHead
  ID_INFO,
  ID_TRACKS,
  '1254c367', // Tags
  '1941a469', // Attachments
  '1043a770', // Chapters
]);

/** 入れ物(中へ降りる)。⚠ 大きさを使わない。 */
const DESCEND_IDS: ReadonlySet<string> = new Set([
  ID_SEGMENT,
  ID_INFO,
  ID_TRACKS,
  ID_TRACK_ENTRY,
  ID_VIDEO,
  ID_AUDIO,
]);

/** 読む葉の大きさの上限。 */
const SMALL_LEAF_MAX = 4096;
/** 終わりの後ろへ読み進める余白(ミリ秒)。⚠ 最後の `Cluster` を取りこぼさない。 */
const STOP_MARGIN_MS = 2000;
/** フレーム間隔が測れないときの長さ。 */
const FALLBACK_FRAME_MS = 33;
/** 音の packet の間隔が測れないときの長さ(opus の既定 20ms)。 */
const FALLBACK_AUDIO_MS = 20;
/** `Cluster` の大きさは不明(8 バイトの全 1)で出す ── 元と同じ形。 */
const UNKNOWN_SIZE = Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);

/** 窓。⚠ 窓の外へ出たら、その位置から読み直す。 */
class Win {
  private buf: Uint8Array = new Uint8Array(0);
  private at = 0;
  bytesRead = 0;
  constructor(
    private readonly src: ByteSource,
    private readonly windowBytes: number,
  ) {}

  async view(pos: number, len: number): Promise<Uint8Array> {
    const end = Math.min(this.src.size, pos + len);
    if (pos >= end) return new Uint8Array(0);
    if (pos < this.at || end > this.at + this.buf.length) {
      const to = Math.min(this.src.size, pos + Math.max(len, this.windowBytes));
      this.buf = await this.src.read(pos, to);
      this.at = pos;
      this.bytesRead += this.buf.length;
    }
    return this.buf.subarray(pos - this.at, end - this.at);
  }
}

interface ElementHead {
  readonly id: string;
  readonly size: number | null;
  readonly body: number;
}

async function readHead(w: Win, pos: number): Promise<ElementHead | null> {
  const b = await w.view(pos, 12);
  const id = readId(b, 0);
  if (id === null) return null;
  const size = readSizeAt(b, id.length);
  if (size === null) return null;
  return { id: id.id, size: size.value, body: pos + id.length + size.length };
}

interface TrackDraft {
  number: number;
  type: number;
  codecId: string;
  width: number;
  height: number;
}

/** 1 つのブロックについて、キーフレームの 3 つの印。 */
export interface KeySignals {
  /** VP8 の `frame tag` から読んだ答え(読めなければ `null`)。 */
  readonly tag: boolean | null;
  /** `BlockGroup` の中の `Block` か。 */
  readonly inGroup: boolean;
  /** `SimpleBlock` のキーフラグ。 */
  readonly flagKey: boolean;
  /** `ReferenceBlock` が付いていたか。 */
  readonly ref: boolean;
}

/**
 * 🔴 **キーフレームか**(印は 3 つ。設計 doc §2.1)。
 *
 * ⚠ **食い違えばフレーム本体(`frame tag`)を正とする** ── 容器の印は muxer の流儀で変わるが、
 *   フレームの中身は復号器が実際に見る物である。読めない(ブロックが 3 バイト未満)ときだけ容器の印へ落ちる:
 *   `BlockGroup` なら `ReferenceBlock` が無いこと、`SimpleBlock` ならキーフラグ。
 */
export function isKeyFrame(s: KeySignals): boolean {
  if (s.tag !== null) return s.tag;
  return s.inGroup ? !s.ref : s.flagKey;
}

/**
 * 走査する。⚠ **bytes は覚えない**(ブロックの頭だけ見て位置を残す)。
 *
 * @param endMs これを少し過ぎた `Cluster` に入ったら読むのをやめる(終わりの後ろは読まない)
 */
export async function scanWebmVideo(
  src: ByteSource,
  endMs: number,
  windowBytes: number = SCAN_WINDOW_BYTES,
): Promise<ScanResult> {
  const w = new Win(src, windowBytes);
  const size = src.size;
  const first = await readHead(w, 0);
  if (first === null || first.id !== ID_EBML_HEAD || first.size === null) {
    return { ok: false, reason: 'not-webm' };
  }
  let pos = first.body + first.size;

  let scale = 1_000_000;
  const tracks: TrackDraft[] = [];
  let tracksStart = -1;
  let tracksEnd = -1;
  let videoTrack: TrackDraft | null = null;
  let audioTrack: TrackDraft | null = null;
  let tracksChosen = false;

  interface ClusterDraft {
    start: number;
    bodyStart: number;
    tcStart: number;
    tcEnd: number;
    tc: number | null;
    end: number;
  }
  let cur: ClusterDraft | null = null;
  const clusters: ClusterDraft[] = [];
  let firstTc: number | null = null;

  interface BlockDraft {
    track: number;
    abs: number;
    cluster: number;
    elStart: number;
    elEnd: number;
    relPos: number;
    dataStart: number;
    dataEnd: number;
    sig: { -readonly [K in keyof KeySignals]: KeySignals[K] };
  }
  const blocks: BlockDraft[] = [];
  let group: { start: number; end: number; last: BlockDraft | null } | null = null;

  while (pos < size) {
    if (group !== null && pos >= group.end) group = null;
    const h = await readHead(w, pos);
    if (h === null) return { ok: false, reason: 'broken' };

    if (cur !== null && SEGMENT_CHILD_IDS.has(h.id)) {
      cur.end = pos;
      clusters.push(cur);
      cur = null;
    }

    if (DESCEND_IDS.has(h.id)) {
      if (h.id === ID_TRACKS) {
        if (h.size === null) return { ok: false, reason: 'broken' };
        tracksStart = pos;
        tracksEnd = h.body + h.size;
      }
      if (h.id === ID_TRACK_ENTRY) tracks.push({ number: 0, type: 0, codecId: '', width: 0, height: 0 });
      pos = h.body;
      continue;
    }

    if (h.id === ID_CLUSTER) {
      if (!tracksChosen) {
        tracksChosen = true;
        videoTrack = tracks.find((t) => t.codecId === 'V_VP8') ?? null;
        if (videoTrack === null) {
          return { ok: false, reason: tracks.some((t) => t.type === 1) ? 'not-vp8' : tracks.length === 0 ? 'not-webm' : 'no-video' };
        }
        audioTrack = tracks.find((t) => t.codecId === 'A_OPUS') ?? null;
        if (audioTrack === null && tracks.some((t) => t.type === 2)) return { ok: false, reason: 'not-opus' };
        if (scale !== 1_000_000) return { ok: false, reason: 'timescale' };
        if (tracksStart < 0) return { ok: false, reason: 'broken' };
      }
      cur = { start: pos, bodyStart: h.body, tcStart: -1, tcEnd: -1, tc: null, end: size };
      pos = h.body;
      continue;
    }

    // ここから先は葉(大きさを使って飛ぶ)
    if (h.size === null) return { ok: false, reason: 'broken' };
    const endPos = h.body + h.size;
    if (endPos > size) return { ok: false, reason: 'broken' };

    const small = async (): Promise<Uint8Array | null> =>
      h.size! <= SMALL_LEAF_MAX ? await w.view(h.body, h.size!) : null;

    if (cur === null) {
      const t = tracks[tracks.length - 1];
      switch (h.id) {
        case ID_TIMESTAMP_SCALE: {
          const p = await small();
          const v = p === null ? null : readUint(p);
          if (v !== null && v > 0) scale = v;
          break;
        }
        case ID_TRACK_NUMBER:
        case ID_TRACK_TYPE:
        case ID_PIXEL_WIDTH:
        case ID_PIXEL_HEIGHT: {
          const p = await small();
          const v = p === null ? null : readUint(p);
          if (v !== null && t !== undefined) {
            if (h.id === ID_TRACK_NUMBER) t.number = v;
            else if (h.id === ID_TRACK_TYPE) t.type = v;
            else if (h.id === ID_PIXEL_WIDTH) t.width = v;
            else t.height = v;
          }
          break;
        }
        case ID_CODEC_ID: {
          const p = await small();
          if (p !== null && t !== undefined) t.codecId = readAscii(p);
          break;
        }
        default:
          break;
      }
      pos = endPos;
      continue;
    }

    // Cluster の中
    switch (h.id) {
      case ID_CLUSTER_TIMECODE: {
        const p = await small();
        const v = p === null ? null : readUint(p);
        if (v === null) return { ok: false, reason: 'broken' };
        if (cur.tc === null) {
          cur.tc = v;
          cur.tcStart = pos;
          cur.tcEnd = endPos;
          if (firstTc === null) firstTc = v;
          else if (v - firstTc > endMs + STOP_MARGIN_MS) {
            // 🔑 終わりの後ろの Cluster ── ここで読むのをやめる(前の Cluster の尻 = この頭)
            cur = null;
            pos = size;
            continue;
          }
        }
        break;
      }
      case ID_BLOCK_GROUP:
        // 入れ物だが、大きさ既知の約束で歩く(`DESCEND_IDS` に入れない ── 尻を覚える)
        break;
      case ID_SIMPLE_BLOCK:
      case ID_BLOCK: {
        if (cur.tc === null) return { ok: false, reason: 'broken' };
        const inGroup = h.id === ID_BLOCK;
        if (inGroup && group === null) return { ok: false, reason: 'broken' };
        const hb = await w.view(h.body, Math.min(h.size, 16));
        const tn = readVintLength(hb, 0);
        if (tn === null || hb.length < tn + 3) return { ok: false, reason: 'broken' };
        let track = hb[0]! & (0xff >> tn);
        for (let i = 1; i < tn; i += 1) track = track * 256 + hb[i]!;
        const mine = track === videoTrack!.number || (audioTrack !== null && track === audioTrack.number);
        if (!mine) break;
        const flags = hb[tn + 2]!;
        if (((flags >> 1) & 0x3) !== 0) return { ok: false, reason: 'lacing' };
        const rel = new DataView(hb.buffer, hb.byteOffset + tn, 2).getInt16(0, false);
        const isVideo = track === videoTrack!.number;
        // VP8 の frame tag は 3 バイト。⚠ 3 バイト未満なら読めない(= 容器の印へ落ちる)
        const payloadLen = h.size - (tn + 3);
        const tag = isVideo && payloadLen >= 3 && hb.length >= tn + 4 ? (hb[tn + 3]! & 1) === 0 : null;
        const draft: BlockDraft = {
          track,
          abs: cur.tc + rel,
          cluster: clusters.length,
          elStart: inGroup ? group!.start : pos,
          elEnd: inGroup ? group!.end : endPos,
          relPos: h.body + tn,
          dataStart: h.body + tn + 3,
          dataEnd: endPos,
          sig: { tag, inGroup, flagKey: !inGroup && (flags & 0x80) !== 0, ref: false },
        };
        blocks.push(draft);
        if (inGroup) group!.last = draft;
        break;
      }
      case ID_REFERENCE_BLOCK:
        if (group !== null && group.last !== null) group.last.sig.ref = true;
        break;
      default:
        break;
    }
    if (h.id === ID_BLOCK_GROUP) {
      group = { start: pos, end: endPos, last: null };
      pos = h.body;
    } else {
      pos = endPos;
    }
  }
  if (cur !== null) {
    cur.end = size;
    clusters.push(cur);
  }

  if (videoTrack === null) return { ok: false, reason: 'no-video' };
  const done = clusters.filter((c) => c.tc !== null && c.tcStart >= 0);
  if (done.length !== clusters.length) return { ok: false, reason: 'broken' };
  if (blocks.length === 0) return { ok: false, reason: 'no-video' };

  let origin = Infinity;
  for (const b of blocks) if (b.abs < origin) origin = b.abs;
  const out: VideoBlock[] = blocks.map((b) => ({
    track: b.track,
    ms: b.abs - origin,
    cluster: b.cluster,
    elStart: b.elStart,
    elEnd: b.elEnd,
    relPos: b.relPos,
    dataStart: b.dataStart,
    dataEnd: b.dataEnd,
    key: b.track === videoTrack!.number && isKeyFrame(b.sig),
  }));
  const video = out.filter((b) => b.track === videoTrack!.number);
  if (video.length === 0) return { ok: false, reason: 'no-video' };
  const gaps: number[] = [];
  for (let i = 1; i < video.length; i += 1) {
    const g = video[i]!.ms - video[i - 1]!.ms;
    if (g > 0) gaps.push(g);
  }
  gaps.sort((a, b) => a - b);
  const frameGapMs = gaps.length === 0 ? FALLBACK_FRAME_MS : gaps[gaps.length >> 1]!;
  const audio = out.filter((b) => b.track !== videoTrack!.number);
  const audioGaps: number[] = [];
  for (let i = 1; i < audio.length; i += 1) {
    const g = audio[i]!.ms - audio[i - 1]!.ms;
    if (g > 0) audioGaps.push(g);
  }
  audioGaps.sort((a, b) => a - b);
  const audioGapMs = audioGaps.length === 0 ? FALLBACK_AUDIO_MS : audioGaps[audioGaps.length >> 1]!;
  const sourceEndMs = Math.max(
    video[video.length - 1]!.ms + frameGapMs,
    audio.length === 0 ? 0 : audio[audio.length - 1]!.ms + audioGapMs,
  );

  return {
    ok: true,
    scan: {
      videoTrack: videoTrack.number,
      audioTrack: audioTrack === null ? null : audioTrack.number,
      width: videoTrack.width,
      height: videoTrack.height,
      tracksStart,
      tracksEnd,
      clusters: clusters.map((c) => ({
        start: c.start,
        bodyStart: c.bodyStart,
        tcStart: c.tcStart,
        tcEnd: c.tcEnd,
        tcMs: c.tc! - origin,
        end: c.end,
      })),
      blocks: out,
      keyMs: video.filter((b) => b.key).map((b) => b.ms),
      frameGapMs,
      sourceEndMs,
      bytesRead: w.bytesRead,
    },
  };
}

export type SnapResult =
  | { readonly ok: true; readonly snappedStartMs: number; readonly snapBackMs: number }
  | { readonly ok: false; readonly reason: VideoTrimRefusal };

/**
 * 🔴 **始まりを、押した所以下の最も近いキーフレームへ戻す**(設計 doc §4.2)。
 *
 * ⚠ 時刻は 1ms 刻みなので、押した時刻を**丸めてから**比べる(`currentTime * 1000` の浮動小数の端数で
 *   ちょうどキーフレームの上を押したのに 1 つ前へ戻らない)。
 * 🔑 戻した長さ(`snapBackMs`)を返す ── 確認の字に後から「約 N 秒早くなります」を足せる。
 */
export function snapVideoStart(scan: VideoScan, startMs: number): SnapResult {
  if (!Number.isFinite(startMs)) return { ok: false, reason: 'empty-range' };
  const s = Math.max(0, Math.round(startMs));
  if (s >= scan.sourceEndMs) return { ok: false, reason: 'empty-range' };
  let k0: number | null = null;
  for (const k of scan.keyMs) {
    if (k <= s) k0 = k;
    else break;
  }
  if (k0 === null) {
    // キーフレームが 1 つも無い録画は切れない
    if (scan.keyMs.length === 0) return { ok: false, reason: 'broken' };
    /**
     * 🔴 **最初のキーフレームより手前を押した**(音が先に始まり、映像の最初の絵が少し後ろにある録画。
     *   0:00 を始まりにした、が典型)。⚠ 断らず、**最初のキーフレームへ進める**。
     *   手前へ戻るのではないので `snapBackMs` は 0(確認も出ない)── 進む幅は最初の 1 枚が出るまでの
     *   ごく短い間で、その前には映像が無い。
     */
    return { ok: true, snappedStartMs: scan.keyMs[0]!, snapBackMs: 0 };
  }
  return { ok: true, snappedStartMs: k0, snapBackMs: s - k0 };
}

/** 出力の部品。⚠ `slice` は元の file の範囲(**コピーしない**)。 */
export type OutputPart =
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  | { readonly kind: 'slice'; readonly start: number; readonly end: number };

export interface TrimPlan {
  readonly parts: readonly OutputPart[];
  readonly byteLength: number;
  readonly snappedStartMs: number;
  readonly snapBackMs: number;
  /** 書いた `Duration`(ミリ秒)。 */
  readonly durationMs: number;
  readonly keptVideo: number;
  readonly keptAudio: number;
  /** 元のバイトをそのまま繋いだ `Cluster` の数 / 組み直した数。 */
  readonly copiedClusters: number;
  readonly rebuiltClusters: number;
  /** 始まりを押した所ぴったりに切ったか(段②b-2)。 */
  readonly precise: boolean;
  /** 作り直した(または頭として写した)映像フレームの数。 */
  readonly headFrames: number;
}

export type PlanResult =
  | { readonly ok: true; readonly plan: TrimPlan }
  | { readonly ok: false; readonly reason: VideoTrimRefusal };

const CLUSTER_HEAD = concatBytes([hexBytes(ID_CLUSTER), UNKNOWN_SIZE]);

/** block の相対時刻は 16 ビットの符号つき。 */
const REL_MIN = -32768;
const REL_MAX = 32767;
/** 頭の `Cluster` を何ミリ秒ごとに切るか(MediaRecorder の約 1 秒に合わせる)。 */
const HEAD_CLUSTER_MS = 1000;

function timecodeElement(ms: number): Uint8Array {
  return element(ID_CLUSTER_TIMECODE, uintBytes(Math.max(0, Math.round(ms))));
}

/**
 * 🔴 **押した所ぴったりに切るための「作り直す範囲」**(#683 段②b-2。設計 doc §3.1・§4.3)。
 *
 * 押した時刻に**表示されているフレーム**(= 時刻が押した所以下で最後の映像フレーム)から、次のキーフレーム(K1)の
 * 手前までを作り直す。K1 から先は元のバイトのまま繋ぐ。
 *
 * - `decode` ── 復号に渡すブロック(K0 から。**差分は K0 から順に復号しないと絵にならない**)
 * - `emit`   ── そのうち、符号化へ渡す(= 出力の頭になる)ブロック。`decode` の後ろ側
 * - 🔑 押した所に表示されているフレームが**もうキーフレーム**なら作り直しは要らない(`reencode: false`):
 *   そのフレームを頭に写し、次のフレームから先は元のバイトで繋ぐ(WebCodecs が無くても押した所ぴったり)
 */
export interface PreciseSpec {
  /** 押した時刻(ミリ秒に丸めた値)。出力の 0。 */
  readonly startMs: number;
  readonly decode: readonly VideoBlock[];
  readonly emit: readonly VideoBlock[];
  /** 元のバイトのまま繋ぎ始める映像の時刻(元の時刻)。`null` = 繋ぐ所が無い(終わりまで頭に入る)。 */
  readonly tailFromMs: number | null;
  /** 復号して符号化し直す必要があるか。 */
  readonly reencode: boolean;
}

/**
 * @returns `null` = 押した所ぴったりの道は使えない(押した所が最初の映像フレームより手前・録画の外・
 *   キーフレームが無い)── 呼び側は手前のキーフレームから切る道(`snapVideoStart`)へ回す。
 */
export function precisePlanSpec(scan: VideoScan, startMs: number, endMs: number): PreciseSpec | null {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !(endMs > startMs)) return null;
  const s = Math.max(0, Math.round(startMs));
  if (s >= scan.sourceEndMs) return null;
  const video = scan.blocks.filter((b) => b.track === scan.videoTrack);
  let firstIdx = -1;
  for (let i = 0; i < video.length; i += 1) {
    if (video[i]!.ms <= s) firstIdx = i;
    else break;
  }
  if (firstIdx < 0) return null;
  const first = video[firstIdx]!;
  if (first.key) {
    const next = video[firstIdx + 1];
    return {
      startMs: s,
      decode: [],
      emit: [first],
      tailFromMs: next !== undefined && next.ms < endMs ? next.ms : null,
      reencode: false,
    };
  }
  let k0 = -1;
  for (let i = firstIdx; i >= 0; i -= 1) {
    if (video[i]!.key) {
      k0 = i;
      break;
    }
  }
  if (k0 < 0) return null;
  let k1 = -1;
  for (let i = firstIdx + 1; i < video.length; i += 1) {
    if (video[i]!.key) {
      k1 = i;
      break;
    }
  }
  const hasTail = k1 >= 0 && video[k1]!.ms < endMs;
  let last = firstIdx;
  const limit = hasTail ? k1 : video.length;
  for (let i = firstIdx + 1; i < limit; i += 1) {
    if (video[i]!.ms < endMs) last = i;
    else break;
  }
  return {
    startMs: s,
    decode: video.slice(k0, last + 1),
    emit: video.slice(firstIdx, last + 1),
    tailFromMs: hasTail ? video[k1]!.ms : null,
    reencode: true,
  };
}

/** 符号化の設定(元の映像に合わせる)。 */
export interface PreciseEncodeParams {
  readonly width: number;
  readonly height: number;
  readonly bitrate: number;
  readonly framerate: number;
}

/**
 * 符号化の設定を、元の映像から決める(設計 doc §4.3 の 6・8)。
 * 🔑 ビットレートは元の映像の**実測**(映像のバイト ÷ 映像の長さ)の 1.2 倍 ── 作り直しは 2 世代目なので少し高めに置く。
 *   ⚠ 画面が止まる録画は実測が極端に低くなる(キーフレーム 1 枚が粗くなる)ので、画素数に比例した下限を置く。
 *   ⚠ **画質が目に見えて違うかは未測**(この数式は仮り置き)。
 */
export function preciseEncodeParams(scan: VideoScan): PreciseEncodeParams {
  const video = scan.blocks.filter((b) => b.track === scan.videoTrack);
  let bytes = 0;
  for (const b of video) bytes += b.dataEnd - b.dataStart;
  const spanMs = video.length === 0 ? 0 : video[video.length - 1]!.ms - video[0]!.ms + scan.frameGapMs;
  const measured = spanMs > 0 ? (bytes * 8 * 1000) / spanMs : 0;
  const floor = Math.max(300_000, Math.round(scan.width * scan.height * 0.8));
  const bitrate = Math.min(20_000_000, Math.max(floor, Math.round(measured * 1.2)));
  const framerate = Math.min(60, Math.max(1, Math.round(1000 / scan.frameGapMs)));
  return { width: scan.width, height: scan.height, bitrate, framerate };
}

/** 頭に入るフレーム(作り直した物、または写した物)。⚠ `ms` は**元の時刻**(出力では押した所を 0 に直す)。 */
export interface HeadFrame {
  readonly ms: number;
  readonly bytes: Uint8Array;
  readonly key: boolean;
}

export interface PreciseHead {
  readonly frames: readonly HeadFrame[];
  readonly tailFromMs: number | null;
}

/** トラック番号の可変長整数(1 バイトか 2 バイト)。 */
function trackVint(n: number): Uint8Array {
  if (n < 0x7f) return Uint8Array.of(0x80 | n);
  return Uint8Array.of(0x40 | (n >> 8), n & 0xff);
}

interface HeadItem {
  readonly ms: number;
  readonly order: number;
  readonly make: (rel: number) => Promise<Uint8Array> | Uint8Array;
}

/**
 * 🔴 **切り出しの部品の並びを組む**(設計 doc §4.5)。
 *
 * - 範囲に丸ごと入る `Cluster` = 見出し(id + 不明の大きさ + **新しい `Timecode`**)だけ新規、
 *   残りは**元のバイトの範囲**
 * - 頭と尻の `Cluster`(範囲をまたぐ物)= ブロック単位で拾い直し、相対時刻を書き換える
 *   (この 2 つだけは bytes をメモリに載せる。約 1 秒ぶん)
 * - 🔑 `head` を渡すと**押した所ぴったり**(段②b-2):頭のフレーム(`SimpleBlock`)と、その間の音を新しい `Cluster`
 *   に詰め、`head.tailFromMs` から先は元のバイトで繋ぐ。渡さないと手前のキーフレームから(段②b-1)
 */
export async function planVideoTrim(
  src: ByteSource,
  scan: VideoScan,
  startMs: number,
  endMs: number,
  head?: PreciseHead,
): Promise<PlanResult> {
  if (!Number.isFinite(endMs) || !(endMs > startMs)) return { ok: false, reason: 'empty-range' };
  const snap = snapVideoStart(scan, startMs);
  if (!snap.ok) return snap;
  const precise = head !== undefined;
  const t0 = precise ? Math.max(0, Math.round(startMs)) : snap.snappedStartMs;
  // 元のバイトを繋ぎ始める時刻(映像も音も)。⚠ 頭が終わりまで届くなら繋ぐ所は無い(無限大)
  const tailFrom = precise ? (head.tailFromMs ?? Infinity) : t0;

  const byCluster: VideoBlock[][] = scan.clusters.map(() => []);
  for (const b of scan.blocks) byCluster[b.cluster]!.push(b);

  const inTail = (b: VideoBlock): boolean => b.ms >= tailFrom && b.ms < endMs;
  const clusterParts: OutputPart[] = [];
  let keptVideo = 0;
  let keptAudio = 0;
  let copied = 0;
  let rebuilt = 0;
  let lastTc = 0;

  if (precise) {
    const items: HeadItem[] = [];
    const vt = trackVint(scan.videoTrack);
    for (const f of head.frames) {
      keptVideo += 1;
      const outMs = Math.max(0, f.ms - t0);
      items.push({
        ms: outMs,
        order: 0,
        make: (rel) => {
          const body = concatBytes([vt, Uint8Array.of((rel >> 8) & 0xff, rel & 0xff, f.key ? 0x80 : 0x00), f.bytes]);
          return element(ID_SIMPLE_BLOCK, body);
        },
      });
    }
    for (const b of scan.blocks) {
      if (b.track === scan.videoTrack) continue;
      if (!(b.ms >= t0 && b.ms < endMs && b.ms < tailFrom)) continue;
      keptAudio += 1;
      items.push({
        ms: b.ms - t0,
        order: 1,
        make: async (rel) => {
          const copy = new Uint8Array(await src.read(b.elStart, b.elEnd));
          new DataView(copy.buffer, copy.byteOffset, copy.byteLength).setInt16(b.relPos - b.elStart, rel, false);
          return copy;
        },
      });
    }
    items.sort((a, b) => a.ms - b.ms || a.order - b.order);
    let i = 0;
    while (i < items.length) {
      const tc = items[i]!.ms;
      const pieces: Uint8Array[] = [CLUSTER_HEAD, timecodeElement(tc)];
      while (i < items.length && items[i]!.ms - tc < HEAD_CLUSTER_MS) {
        const rel = items[i]!.ms - tc;
        pieces.push(await items[i]!.make(rel));
        i += 1;
      }
      rebuilt += 1;
      lastTc = tc;
      clusterParts.push({ kind: 'bytes', bytes: concatBytes(pieces) });
    }
  }

  for (let ci = 0; ci < scan.clusters.length; ci += 1) {
    const c = scan.clusters[ci]!;
    const all = byCluster[ci]!;
    const kept = all.filter(inTail);
    if (kept.length === 0) continue;
    for (const b of kept) {
      if (b.track === scan.videoTrack) keptVideo += 1;
      else keptAudio += 1;
    }
    const whole = c.tcMs >= tailFrom && kept.length === all.length;
    if (whole) {
      copied += 1;
      lastTc = Math.max(lastTc, c.tcMs - t0);
      clusterParts.push({ kind: 'bytes', bytes: CLUSTER_HEAD });
      if (c.tcStart > c.bodyStart) clusterParts.push({ kind: 'slice', start: c.bodyStart, end: c.tcStart });
      clusterParts.push({ kind: 'bytes', bytes: timecodeElement(c.tcMs - t0) });
      if (c.end > c.tcEnd) clusterParts.push({ kind: 'slice', start: c.tcEnd, end: c.end });
      continue;
    }
    rebuilt += 1;
    // 🔑 Cluster の時刻は戻らない(頭の Cluster より前の時刻を付けない)
    const newTc = Math.max(0, c.tcMs - t0, lastTc);
    lastTc = newTc;
    const pieces: Uint8Array[] = [CLUSTER_HEAD, timecodeElement(newTc)];
    for (const b of kept) {
      const copy = new Uint8Array(await src.read(b.elStart, b.elEnd));
      const rel = b.ms - t0 - newTc;
      /**
       * ⚠ **ここは入力が正しい限り到達しない**(防御として残す)。tc >= t0 なら rel は元の相対時刻と同じ
       *   (元が int16 に収まる)、tc < t0 なら rel = ms - t0 < ms - tc (元の相対時刻)で収まる。
       *   収まらない値を `setInt16` に渡すと黙って丸まるので、万一のときに壊れた動画を作らず断る。
       */
      if (rel < REL_MIN || rel > REL_MAX) return { ok: false, reason: 'broken' };
      new DataView(copy.buffer, copy.byteOffset, copy.byteLength).setInt16(b.relPos - b.elStart, rel, false);
      pieces.push(copy);
    }
    clusterParts.push({ kind: 'bytes', bytes: concatBytes(pieces) });
  }
  if (keptVideo === 0) return { ok: false, reason: 'empty-range' };

  const durationMs = Math.min(endMs, scan.sourceEndMs) - t0;
  const header = element(
    ID_EBML_HEAD,
    concatBytes([
      element('4286', uintBytes(1)), // EBMLVersion
      element('42f7', uintBytes(1)), // EBMLReadVersion
      element('42f2', uintBytes(4)), // EBMLMaxIDLength
      element('42f3', uintBytes(8)), // EBMLMaxSizeLength
      element('4282', asciiBytes('webm')), // DocType
      element('4287', uintBytes(4)), // DocTypeVersion
      element('4285', uintBytes(2)), // DocTypeReadVersion
    ]),
  );
  const info = element(
    ID_INFO,
    concatBytes([
      element(ID_TIMESTAMP_SCALE, uintBytes(1_000_000)),
      element('4d80', asciiBytes('pkc3')), // MuxingApp
      element('5741', asciiBytes('pkc3')), // WritingApp
      element('4489', float64Bytes(durationMs)), // Duration(1ms 刻み)
    ]),
  );
  const body: OutputPart[] = [
    { kind: 'bytes', bytes: info },
    { kind: 'slice', start: scan.tracksStart, end: scan.tracksEnd },
    ...clusterParts,
  ];
  const lengthOf = (p: OutputPart): number => (p.kind === 'bytes' ? p.bytes.length : p.end - p.start);
  let bodyLen = 0;
  for (const p of body) bodyLen += lengthOf(p);
  const segmentHead = concatBytes([hexBytes(ID_SEGMENT), writeSize(bodyLen)]);
  const parts: OutputPart[] = [
    { kind: 'bytes', bytes: concatBytes([header, segmentHead]) },
    ...body,
  ];
  return {
    ok: true,
    plan: {
      parts,
      byteLength: header.length + segmentHead.length + bodyLen,
      snappedStartMs: t0,
      snapBackMs: precise ? 0 : snap.snapBackMs,
      durationMs,
      keptVideo,
      keptAudio,
      copiedClusters: copied,
      rebuiltClusters: rebuilt,
      precise,
      headFrames: precise ? head.frames.length : 0,
    },
  };
}

/** 絵だけにした結果。⚠ `parts` の `slice` は元の file の範囲(**コピーしない**)。 */
export interface PictureOnlyPlan {
  readonly parts: readonly OutputPart[];
  readonly byteLength: number;
  /** 書いた `Duration`(ミリ秒)。⚠ 元の録画と同じ長さ(音の分は無音ではなく、トラックごと無い)。 */
  readonly durationMs: number;
  readonly keptVideo: number;
  /** 落とした音のブロックの数(観測点)。 */
  readonly droppedAudio: number;
}

export type PictureOnlyResult =
  | { readonly ok: true; readonly plan: PictureOnlyPlan }
  | { readonly ok: false; readonly reason: VideoTrimRefusal };

/** `Tracks` の中の `TrackEntry` のうち、映像のトラック番号を持つ 1 つの bytes(見出しごと)。無ければ `null`。 */
function videoTrackEntry(tracks: Uint8Array, videoTrack: number): Uint8Array | null {
  const head = readId(tracks, 0);
  if (head === null || head.id !== ID_TRACKS) return null;
  const size = readSizeAt(tracks, head.length);
  if (size === null) return null;
  let pos = head.length + size.length;
  while (pos < tracks.length) {
    const id = readId(tracks, pos);
    if (id === null) return null;
    const sz = readSizeAt(tracks, pos + id.length);
    if (sz === null || sz.value === null) return null;
    const body = pos + id.length + sz.length;
    const end = body + sz.value;
    if (end > tracks.length) return null;
    if (id.id === ID_TRACK_ENTRY) {
      let q = body;
      while (q < end) {
        const cid = readId(tracks, q);
        if (cid === null) return null;
        const csz = readSizeAt(tracks, q + cid.length);
        if (csz === null || csz.value === null) return null;
        const cbody = q + cid.length + csz.length;
        if (cid.id === ID_TRACK_NUMBER && readUint(tracks.subarray(cbody, cbody + csz.value)) === videoTrack) {
          return tracks.subarray(pos, end);
        }
        q = cbody + csz.value;
      }
    }
    pos = end;
  }
  return null;
}

/**
 * 🔴 **音のトラックを落として、映像だけの WebM にする**(#952 A1「動画から絵だけ取り出す」)。
 *
 * 範囲を切る道(`planVideoTrim`)と違い、**全区間をそのまま**残す ── 映像のブロックの時刻は 1 つも変えない
 * (`Cluster` の `Timecode` は走査が 0 起点に直した値を書き、ブロックの相対時刻は元のまま)。
 * - `Tracks` は**映像の `TrackEntry` だけ**で組み直す(音の宣言が残ると、再生器が「音のトラックがある」と読む)
 * - 各 `Cluster` は見出し + `Timecode` を新しく書き、中の**映像のブロックだけ**を元のバイトの範囲で繋ぐ
 *   (隣り合う映像のブロックは 1 つの `slice` にまとめる ── 音が間に挟まる所だけ切れる)
 * - 🔑 音のブロックだけの `Cluster` は出さない
 *
 * ⚠ `scan` は**終わりまで読んだもの**(`scanWebmVideo(src, Infinity)`)でなければならない。
 */
export async function planPictureOnly(src: ByteSource, scan: VideoScan): Promise<PictureOnlyResult> {
  const trackBytes = await src.read(scan.tracksStart, scan.tracksEnd);
  const entry = videoTrackEntry(trackBytes, scan.videoTrack);
  if (entry === null) return { ok: false, reason: 'broken' };
  const tracks = element(ID_TRACKS, entry);

  const byCluster: VideoBlock[][] = scan.clusters.map(() => []);
  for (const b of scan.blocks) byCluster[b.cluster]!.push(b);

  const clusterParts: OutputPart[] = [];
  let keptVideo = 0;
  let droppedAudio = 0;
  for (let ci = 0; ci < scan.clusters.length; ci += 1) {
    const c = scan.clusters[ci]!;
    const video = byCluster[ci]!.filter((b) => b.track === scan.videoTrack);
    droppedAudio += byCluster[ci]!.length - video.length;
    if (video.length === 0) continue;
    keptVideo += video.length;
    clusterParts.push({ kind: 'bytes', bytes: CLUSTER_HEAD });
    clusterParts.push({ kind: 'bytes', bytes: timecodeElement(c.tcMs) });
    let runStart = video[0]!.elStart;
    let runEnd = video[0]!.elEnd;
    for (let i = 1; i < video.length; i += 1) {
      const b = video[i]!;
      if (b.elStart === runEnd) {
        runEnd = b.elEnd;
        continue;
      }
      clusterParts.push({ kind: 'slice', start: runStart, end: runEnd });
      runStart = b.elStart;
      runEnd = b.elEnd;
    }
    clusterParts.push({ kind: 'slice', start: runStart, end: runEnd });
  }
  if (keptVideo === 0) return { ok: false, reason: 'no-video' };

  const durationMs = scan.sourceEndMs;
  const header = element(
    ID_EBML_HEAD,
    concatBytes([
      element('4286', uintBytes(1)), // EBMLVersion
      element('42f7', uintBytes(1)), // EBMLReadVersion
      element('42f2', uintBytes(4)), // EBMLMaxIDLength
      element('42f3', uintBytes(8)), // EBMLMaxSizeLength
      element('4282', asciiBytes('webm')), // DocType
      element('4287', uintBytes(4)), // DocTypeVersion
      element('4285', uintBytes(2)), // DocTypeReadVersion
    ]),
  );
  const info = element(
    ID_INFO,
    concatBytes([
      element(ID_TIMESTAMP_SCALE, uintBytes(1_000_000)),
      element('4d80', asciiBytes('pkc3')), // MuxingApp
      element('5741', asciiBytes('pkc3')), // WritingApp
      element('4489', float64Bytes(durationMs)), // Duration(1ms 刻み)
    ]),
  );
  const body: OutputPart[] = [{ kind: 'bytes', bytes: info }, { kind: 'bytes', bytes: tracks }, ...clusterParts];
  const lengthOf = (p: OutputPart): number => (p.kind === 'bytes' ? p.bytes.length : p.end - p.start);
  let bodyLen = 0;
  for (const p of body) bodyLen += lengthOf(p);
  const segmentHead = concatBytes([hexBytes(ID_SEGMENT), writeSize(bodyLen)]);
  return {
    ok: true,
    plan: {
      parts: [{ kind: 'bytes', bytes: concatBytes([header, segmentHead]) }, ...body],
      byteLength: header.length + segmentHead.length + bodyLen,
      durationMs,
      keptVideo,
      droppedAudio,
    },
  };
}
