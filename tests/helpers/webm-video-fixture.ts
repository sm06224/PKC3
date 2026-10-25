/**
 * 🔴 **画面収録(VP8 + opus の webm)を手で組む台**(#683 段②b-1)。
 *
 * ⚠ 実装の書き手(`features/audio/ebml.ts`)を使わない ── 大きさは 1・2・4 バイトだけ書ける
 *   **別物**で、バイトは手で数えられる(共有の盲点を作らない。`tests/features/webm-opus.test.ts` と同じ作法)。
 *
 * 組む物は Chrome の `MediaRecorder` が吐く形に寄せてある(設計 doc §2.1):
 *   `Segment` / `Cluster` の大きさは**不明**、`SeekHead` / `Cues` / `Duration` は**無い**、
 *   映像は `BlockGroup` + `Block`(差分にだけ `ReferenceBlock`)、音は `SimpleBlock`(旗 `0x80`)。
 */

export type KeyStyle = 'group' | 'simple';

export interface VideoFixture {
  /** 映像フレームの数。 */
  readonly frames?: number;
  /** フレームの間隔(ミリ秒)。 */
  readonly frameMs?: number;
  /** キーフレームの添字(既定: 0, 10, 20, …)。 */
  readonly keys?: readonly number[];
  /** キーフレームの容器の印の流儀(Chrome は `group`)。 */
  readonly style?: KeyStyle;
  /**
   * フレーム本体(VP8 の frame tag)を**書くか**。`false` なら 2 バイトの中身(tag を読めない短さ)にして、
   * **容器の印だけ**で判定させる。
   */
  readonly tag?: boolean;
  /** フレーム添字 → 容器の印を**わざと逆**にする(`tag` が勝つことを見る)。 */
  readonly lieAbout?: readonly number[];
  /** 音の packet の間隔(ミリ秒)。`0` = 音なし。 */
  readonly audioMs?: number;
  /** `Cluster` を何 ms ごとに切るか。 */
  readonly clusterMs?: number;
  /** `Segment` / `Cluster` の大きさを不明で出すか(Chrome は不明)。 */
  readonly unknownSizes?: boolean;
  /** 映像の CodecID。 */
  readonly videoCodec?: string;
  /** 音の CodecID。 */
  readonly audioCodec?: string;
  /** `TimestampScale`(ナノ秒)。 */
  readonly scaleNs?: number;
  /** 1 フレームの余分な中身の長さ(窓をまたがせる / 大きくする)。 */
  readonly padBytes?: number;
  /** フレーム添字 → 余分な中身の長さ(`padBytes` より優先)。静止区間(小さい差分)を作るのに使う。 */
  readonly padFor?: (index: number) => number;
  /** lacing の旗(0x02 / 0x04 / 0x06)を映像のブロックの flags に立てる(`simple` は SimpleBlock、`group` は Block)。 */
  readonly lacing?: number;
  /** 映像の track 番号(既定 1)。127 を超えると、ブロック先頭の track 番号が 2 バイトになる。 */
  readonly videoTrack?: number;
  /** 映像が始まる時刻(ミリ秒)。音が先に始まり、映像の最初の絵が少し後ろにある録画を作る。 */
  readonly videoOffsetMs?: number;
  /** 末尾の `Cues` / 先頭の `SeekHead` / `Void` を付ける(MediaRecorder 以外の muxer の形)。 */
  readonly cues?: boolean;
  /** 最初の `Cluster` の時刻。 */
  readonly originMs?: number;
  /**
   * 映像の最後のフレームより後ろに続く時間(ミリ秒)。⚠ 実機の画面収録は**画面が止まると映像のフレームが
   * 出ない**(音だけが続く)── 実測: 3.3 秒の録画で映像は最初の 0.4 秒に 9 枚だけだった。
   */
  readonly tailMs?: number;
  /**
   * 2 つ目以降の `Cluster` の `Timecode` を、最初のブロックの時刻より**これだけ手前**に置く
   * (muxer によっては `Cluster` の時刻が最初のブロックより前になる)。ブロックの相対時刻は正になる。
   */
  readonly clusterLeadMs?: number;
}

const hex = (s: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 2) out.push(Number.parseInt(s.slice(i, i + 2), 16));
  return out;
};
const ascii = (s: string): number[] => s.split('').map((c) => c.charCodeAt(0));
const i16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];

/** 大きさは 1 / 2 / 4 バイトの 3 通りだけ。 */
function sizeBytes(n: number): number[] {
  if (n < 0x7f) return [0x80 | n];
  if (n < 0x3fff) return [0x40 | (n >> 8), n & 0xff];
  return [0x10 | ((n >> 24) & 0x0f), (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
const el = (id: string, payload: readonly number[]): number[] => [...hex(id), ...sizeBytes(payload.length), ...payload];
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const unknownEl = (id: string, payload: readonly number[]): number[] => [...hex(id), ...UNKNOWN, ...payload];

const opusHead = (): number[] => [
  ...ascii('OpusHead'), 1, 1, 0x00, 0x00, 0x80, 0xbb, 0x00, 0x00, 0x00, 0x00, 0x00,
];

/** 映像フレームの中身の印。⚠ 添字が復元できる(先頭 3 バイトが VP8 の frame tag)。 */
export function framePayload(index: number, key: boolean, tag: boolean, pad: number): number[] {
  // frame tag の bit 0 = 0 がキーフレーム(RFC 6386 §9.1)
  // ⚠ tag を書かないときは**全体で 2 バイト**(3 バイト未満 = frame tag を読めない)
  if (!tag) return [index & 0xff, (index >> 8) & 0xff];
  return [key ? 0x10 : 0x11, 0x00, 0x00, index & 0xff, (index >> 8) & 0xff, ...Array.from({ length: pad }, (_, k) => (index + k) & 0xff)];
}

export interface BuiltFixture {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly frames: number;
  readonly frameMs: number;
  readonly keys: readonly number[];
  /** 映像フレーム i の時刻(ミリ秒)。 */
  readonly frameAt: (i: number) => number;
  readonly clusterCount: number;
}

export function buildVideoWebm(f: VideoFixture = {}): BuiltFixture {
  const frames = f.frames ?? 40;
  const frameMs = f.frameMs ?? 100;
  const keys = f.keys ?? Array.from({ length: Math.ceil(frames / 10) }, (_, i) => i * 10);
  const style = f.style ?? 'group';
  const tag = f.tag ?? true;
  const audioMs = f.audioMs ?? 60;
  const clusterMs = f.clusterMs ?? 1000;
  const unknownSizes = f.unknownSizes ?? true;
  const origin = f.originMs ?? 0;
  const pad = f.padBytes ?? 0;
  const lies = new Set(f.lieAbout ?? []);
  const keySet = new Set(keys);

  const head = el('1a45dfa3', [...el('4282', ascii('webm'))]);
  const scaleNs = f.scaleNs ?? 1_000_000;
  const info = el('1549a966', el('2ad7b1', [(scaleNs >> 16) & 0xff, (scaleNs >> 8) & 0xff, scaleNs & 0xff]));
  const videoEntry = el('ae', [
    ...el('d7', [f.videoTrack ?? 1]),
    ...el('83', [1]),
    ...el('86', ascii(f.videoCodec ?? 'V_VP8')),
    ...el('e0', [...el('b0', i16(640)), ...el('ba', i16(360))]),
  ]);
  const audioEntry =
    audioMs === 0
      ? []
      : el('ae', [
          ...el('d7', [2]),
          ...el('83', [2]),
          ...el('86', ascii(f.audioCodec ?? 'A_OPUS')),
          ...el('63a2', opusHead()),
          ...el('e1', [...el('b5', [0x40, 0xe7, 0x70, 0x00, 0x00, 0x00, 0x00, 0x00]), ...el('9f', [1])]),
        ]);
  const tracks = el('1654ae6b', [...videoEntry, ...audioEntry]);

  const vOffset = f.videoOffsetMs ?? 0;
  const frameAt = (i: number): number => vOffset + i * frameMs;
  const total = vOffset + frames * frameMs + (f.tailMs ?? 0);
  const nClusters = Math.max(1, Math.ceil(total / clusterMs));
  const clusters: number[] = [];
  let audioIdx = 0;
  for (let c = 0; c < nClusters; c += 1) {
    const base = c * clusterMs;
    const tc = c === 0 ? base : base - (f.clusterLeadMs ?? 0);
    const blocks: number[] = [];
    // 映像 + 音を時刻順に混ぜる(Chrome は混在)
    type Ev = { at: number; kind: 'v' | 'a'; i: number };
    const evs: Ev[] = [];
    for (let i = 0; i < frames; i += 1) {
      const at = frameAt(i);
      if (at >= base && at < base + clusterMs) evs.push({ at, kind: 'v', i });
    }
    if (audioMs > 0) {
      for (;;) {
        const at = audioIdx * audioMs;
        if (at >= base + clusterMs || at >= total) break;
        if (at >= base) evs.push({ at, kind: 'a', i: audioIdx });
        audioIdx += 1;
      }
    }
    evs.sort((a, b) => a.at - b.at || (a.kind === 'v' ? -1 : 1));
    for (const e of evs) {
      const rel = e.at - tc;
      if (e.kind === 'a') {
        blocks.push(...el('a3', [0x82, ...i16(rel), 0x80, 0xc0, e.i & 0xff, 0x00, 0x01]));
        continue;
      }
      const isKey = keySet.has(e.i);
      // 容器の印(嘘を混ぜる場合は逆にする)
      const containerKey = lies.has(e.i) ? !isKey : isKey;
      const payload = framePayload(e.i, isKey, tag, f.padFor ? f.padFor(e.i) : pad);
      const vt = f.videoTrack ?? 1;
      const trackVint = vt < 0x7f ? [0x80 | vt] : [0x40 | (vt >> 8), vt & 0xff];
      const lacingBits = f.lacing ?? 0;
      const blockBody = [
        ...trackVint,
        ...i16(rel),
        (style === 'simple' && containerKey ? 0x80 : 0x00) | lacingBits,
        ...payload,
      ];
      if (style === 'simple') blocks.push(...el('a3', blockBody));
      else
        blocks.push(
          ...el('a0', [
            ...el('a1', blockBody),
            ...(containerKey ? [] : el('fb', [0xff])), // ReferenceBlock = -1(差分にだけ付く)
          ]),
        );
    }
    const body = [...el('e7', i16(tc + origin)), ...blocks];
    clusters.push(...(unknownSizes ? unknownEl('1f43b675', body) : el('1f43b675', body)));
  }
  // 🔑 MediaRecorder 以外の muxer の形:先頭に SeekHead と Void、末尾に Void と Cues(`Cluster` の外)
  const seekHead = f.cues === true ? el('114d9b74', el('4dbb', [...el('53ab', [0x1c, 0x53, 0xbb, 0x6b]), ...el('53ac', [0x00])])) : [];
  const voidEl = f.cues === true ? el('ec', [0, 0, 0, 0]) : [];
  const cuesEl = f.cues === true ? el('1c53bb6b', el('bb', [...el('b3', [0x00]), ...el('b7', [...el('f7', [0x01]), ...el('f1', [0x00])])])) : [];
  const segBody = [...seekHead, ...voidEl, ...info, ...tracks, ...clusters, ...voidEl, ...cuesEl];
  const segment = unknownSizes ? unknownEl('18538067', segBody) : el('18538067', segBody);
  return {
    bytes: Uint8Array.from([...head, ...segment]),
    frames,
    frameMs,
    keys,
    frameAt,
    clusterCount: nClusters,
  };
}

/** ByteSource(観測つき)。⚠ `reads` が窓の大きさを超えていないことを test が見る。 */
export function countingSource(bytes: Uint8Array): {
  size: number;
  read(start: number, end: number): Promise<Uint8Array>;
  reads: { start: number; end: number }[];
} {
  const reads: { start: number; end: number }[] = [];
  return {
    size: bytes.length,
    reads,
    async read(start: number, end: number): Promise<Uint8Array> {
      reads.push({ start, end });
      return bytes.slice(start, end);
    },
  };
}

/** 出力の部品を元の bytes から繋いで 1 本にする(実装の `Blob` 組み立ての代わり)。 */
export function assembleParts(
  parts: readonly ({ kind: 'bytes'; bytes: Uint8Array } | { kind: 'slice'; start: number; end: number })[],
  original: Uint8Array,
): Uint8Array {
  const pieces = parts.map((p) => (p.kind === 'bytes' ? p.bytes : original.subarray(p.start, p.end)));
  let n = 0;
  for (const p of pieces) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface ParsedBlock {
  readonly track: number;
  /** 絶対時刻(ミリ秒)= Cluster の Timecode + 相対。 */
  readonly ms: number;
  /** 中身(トラック番号・相対時刻・旗を除いた分)。 */
  readonly payload: number[];
  readonly hasRef: boolean;
  /** ブロックの旗(0x80 = SimpleBlock のキーフレーム)。 */
  readonly flags: number;
  /** 入れ物の種類(SimpleBlock = 'a3' / グループの中の Block = 'a1')。 */
  readonly kind: 'a3' | 'a1';
}

export interface ParsedWebm {
  readonly blocks: ParsedBlock[];
  readonly clusterTimecodes: number[];
  readonly duration: number | null;
  readonly segmentSizeKnown: boolean;
  readonly segmentSize: number | null;
}

/** 出力を**別の書き方**でほどく(実装の走査器を使わない)。 */
export function parseWebm(b: Uint8Array): ParsedWebm {
  const blocks: ParsedBlock[] = [];
  const clusterTimecodes: number[] = [];
  let duration: number | null = null;
  let segmentSize: number | null = null;
  let segmentSizeKnown = false;

  const readVint = (pos: number, keepMarker: boolean): { v: number; len: number; unknown: boolean } => {
    const first = b[pos]!;
    let len = 1;
    while (len <= 8 && (first & (0x80 >> (len - 1))) === 0) len += 1;
    let v = keepMarker ? first : first & (0xff >> len);
    let allOnes = (first & (0xff >> len)) === (0xff >> len);
    for (let i = 1; i < len; i += 1) {
      v = v * 256 + b[pos + i]!;
      if (b[pos + i] !== 0xff) allOnes = false;
    }
    return { v, len, unknown: !keepMarker && allOnes };
  };

  const walk = (start: number, end: number, ctx: { cluster: number | null }): void => {
    let pos = start;
    while (pos < end) {
      const id = readVint(pos, true);
      const idHex = b.slice(pos, pos + id.len).reduce((s, x) => s + x.toString(16).padStart(2, '0'), '');
      const sz = readVint(pos + id.len, false);
      const body = pos + id.len + sz.len;
      const stop = sz.unknown ? end : body + sz.v;
      if (idHex === '18538067') {
        segmentSizeKnown = !sz.unknown;
        segmentSize = sz.unknown ? null : sz.v;
        walk(body, stop, ctx);
      } else if (idHex === '1f43b675') {
        // 大きさ不明の Cluster は次の Cluster の頭まで
        let cEnd = stop;
        if (sz.unknown) {
          let q = body;
          cEnd = end;
          while (q < end) {
            const cid = readVint(q, true);
            const cidHex = b.slice(q, q + cid.len).reduce((s, x) => s + x.toString(16).padStart(2, '0'), '');
            if (cidHex === '1f43b675') {
              cEnd = q;
              break;
            }
            const csz = readVint(q + cid.len, false);
            q = q + cid.len + csz.len + csz.v;
          }
        }
        walk(body, cEnd, { cluster: null });
        pos = cEnd;
        continue;
      } else if (idHex === '1549a966' || idHex === 'a0') {
        walk(body, stop, ctx);
      } else if (idHex === 'e7' && ctx.cluster === null) {
        let tc = 0;
        for (let i = 0; i < sz.v; i += 1) tc = tc * 256 + b[body + i]!;
        clusterTimecodes.push(tc);
        ctx.cluster = tc;
      } else if (idHex === '4489') {
        duration = new DataView(b.buffer, b.byteOffset + body, 8).getFloat64(0, false);
      } else if (idHex === 'a3' || idHex === 'a1') {
        const tv = readVint(body, false);
        const track = tv.v;
        const rel = new DataView(b.buffer, b.byteOffset + body + tv.len, 2).getInt16(0, false);
        blocks.push({
          track,
          ms: (ctx.cluster ?? 0) + rel,
          payload: Array.from(b.subarray(body + tv.len + 3, body + sz.v)),
          hasRef: false,
          flags: b[body + tv.len + 2]!,
          kind: idHex as 'a3' | 'a1',
        });
      } else if (idHex === 'fb') {
        const last = blocks[blocks.length - 1]!;
        blocks[blocks.length - 1] = { ...last, hasRef: true };
      }
      pos = stop;
    }
  };
  // EBML 頭を飛ばして Segment から
  const h = readVint(0, true);
  const hs = readVint(h.len, false);
  walk(h.len + hs.len + hs.v, b.length, { cluster: null });
  return { blocks, clusterTimecodes, duration, segmentSizeKnown, segmentSize };
}
