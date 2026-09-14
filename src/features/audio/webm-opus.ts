/**
 * 🔴 **録った音の前後を削る**(#683 段②a。user 裁定 2026-09-14)。
 *
 * > 録った音の前後を削ったら、**元と同じ形(opus)で保存する**。
 * > 切り出した結果は**新しい添付として 1 つ増え**、元のものは残る。
 *
 * ## 🔑 いちばん大事な性質 ── **音を作り直さない**
 *
 * 録ったものは **WebM の中の opus** である(`MediaRecorder` の既定)。
 * opus の packet は**それ自体で完結している**ので、要る範囲の packet を
 * **そのまま新しい入れ物へ移す**だけで切り出せる。
 *
 * | | 復号 → 符号化 | 🔑 **packet を移すだけ**(こちら) |
 * |---|---|---|
 * | 音の劣化 | 有る(2 回目の符号化) | **無い**(bit そのまま) |
 * | 記憶 | 30 分で約 345 MB の PCM | **切り出した範囲の圧縮済みバイトだけ** |
 * | ブラウザ | WebCodecs が要る | **要らない** |
 *
 * ⚠ だから「ゼロコピー・生成物のライフサイクル終端での即破棄」(不可侵指示 2026-07-27)と
 * 正面からぶつからない。
 *
 * ## ⚠ 端は packet の境目でしか切れない ── 2 つの札で埋める
 *
 * この箱の `MediaRecorder` は **1 packet = 60ms**(実測 2026-09-14)なので、
 * 素直に切ると**最大 60ms ずれる**。それを消す札が 2 つ在る:
 *
 * | 端 | 札 | 効き方 |
 * |---|---|---|
 * | **始まり** | `TrackEntry` の `CodecDelay`(ナノ秒) | 復号器が頭の N を**捨ててから**出す |
 * | **終わり** | 最後の block の `DiscardPadding`(ナノ秒) | 復号器が尻の余りを**出さない** |
 *
 * ⚠ `DiscardPadding` は `SimpleBlock` に書けない ── **最後の 1 つだけ `BlockGroup`** にする。
 *
 * ## 🔴 test の計器は分ける(実測 2026-09-14)
 *
 * ⚠ **`decodeAudioData` は上の 2 つの札を見ない** ── 同じ file を復号させると
 * packet ぶん丸ごと(1.26 秒)返る。🔑 だから
 * **長さは `<audio>.duration` / 音の有無は復号**、と計器を分ける。
 * ⚠ user に見える所では正しい(アプリが鳴らすのは `<audio>`)。
 */
import {
  asciiBytes,
  concatBytes,
  element,
  float64Bytes,
  int16Bytes,
  intBytes,
  readAscii,
  readId,
  readSizeAt,
  readUint,
  uintBytes,
} from './ebml';

/** 切り出せない理由。⚠ **どれも「押したのに無言」を作らないためのもの**。 */
export type TrimRefusal =
  | 'not-webm'
  | 'not-opus'
  | 'lacing'
  | 'no-audio'
  | 'empty-range'
  | 'broken';

/**
 * 断り文。⚠ **user が読む字**なので、内部の綴りを出さない。
 * 🔑 「何が起きたか」ではなく「**この file はこうだから切り出せない**」と書く。
 */
export const TRIM_REFUSAL_TEXT: Record<TrimRefusal, string> = {
  'not-webm': 'この形の録音はまだ切り出せません。',
  'not-opus': 'この録音は切り出しに対応していない音の形式です。',
  lacing: 'この録音は切り出しに対応していない詰め方です。',
  'no-audio': 'この録音には音が入っていません。',
  'empty-range': '選んだ範囲に音が入っていません。',
  broken: 'この録音は途中までしか読めませんでした。',
};

/** 1 つの opus packet。⚠ `data` は**元のバイトそのまま**(写しは作らない)。 */
export interface OpusPacket {
  /** 録音の先頭からの時刻(ミリ秒)。 */
  readonly ms: number;
  readonly data: Uint8Array;
}

/** ほどいた結果。 */
export interface WebmOpusSource {
  /** 🔑 元の `OpusHead` そのもの ── **写して新しい入れ物へ入れる**。 */
  readonly codecPrivate: Uint8Array;
  readonly channels: number;
  readonly sampleRate: number;
  readonly packets: readonly OpusPacket[];
  /** 実測の 1 packet の長さ(ミリ秒)。⚠ 仕様の値ではなく**この file の値**。 */
  readonly packetMs: number;
  /** 最後の packet の終わりまで(ミリ秒)。 */
  readonly durationMs: number;
}

export type DemuxResult =
  | { readonly ok: true; readonly source: WebmOpusSource }
  | { readonly ok: false; readonly reason: TrimRefusal };

/** EBML の頭。⚠ ここが合わなければ WebM ですらない。 */
const ID_EBML_HEAD = '1a45dfa3';

/**
 * 中へ降りる入れ物。⚠ **大きさを使わない**(不明のことが在る ── `ebml.ts` の表)。
 * ⚠ ここに載っていない id は**中身**として大きさぶん飛ばす。
 */
const MASTER_IDS: ReadonlySet<string> = new Set([
  '18538067', // Segment
  '1549a966', // Info
  '1654ae6b', // Tracks
  'ae', // TrackEntry
  'e1', // Audio
  '1f43b675', // Cluster
  'a0', // BlockGroup
  '114d9b74', // SeekHead
  '4dbb', // Seek
  '1c53bb6b', // Cues
  'bb', // CuePoint
  'b7', // CueTrackPositions
]);

const ID_TIMESTAMP_SCALE = '2ad7b1';
const ID_CODEC_ID = '86';
const ID_CODEC_PRIVATE = '63a2';
const ID_CHANNELS = '9f';
const ID_SAMPLE_RATE = 'b5';
const ID_CLUSTER_TIMESTAMP = 'e7';
const ID_SIMPLE_BLOCK = 'a3';
const ID_BLOCK = 'a1';

/** opus の既定。⚠ `OpusHead` を読めないときだけ使う。 */
const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_CHANNELS = 1;
/** ⚠ packet が 1 つしか無くて間隔を測れないときの長さ(実測の既定)。 */
const FALLBACK_PACKET_MS = 60;

/**
 * 🔴 **WebM をほどいて opus の packet を取り出す**。
 *
 * ⚠ 読むのは**必要な所だけ** ── `TimestampScale` / `CodecID` / `CodecPrivate` /
 * `Cluster` の時刻 / block。⚠ **lacing(1 つの block に複数 frame)は受けない**:
 * 実測では 0 件だが、**黙って壊れた file を作らない**ために声に出して断る。
 */
export function demuxWebmOpus(bytes: Uint8Array): DemuxResult {
  const head = readId(bytes, 0);
  if (head === null || head.id !== ID_EBML_HEAD) return { ok: false, reason: 'not-webm' };

  let pos = 0;
  let timestampScale = 1000000;
  let clusterMs = 0;
  let codecId: string | null = null;
  let codecPrivate: Uint8Array | null = null;
  let channels = 0;
  let sampleRate = 0;
  const packets: OpusPacket[] = [];

  while (pos < bytes.length) {
    const id = readId(bytes, pos);
    if (id === null) return { ok: false, reason: 'broken' };
    const size = readSizeAt(bytes, pos + id.length);
    if (size === null) return { ok: false, reason: 'broken' };
    const body = pos + id.length + size.length;

    if (MASTER_IDS.has(id.id)) {
      // ⚠ 大きさを見ずに中へ降りる(不明のことが在る)
      pos = body;
      continue;
    }
    if (size.value === null || body + size.value > bytes.length) return { ok: false, reason: 'broken' };
    const payload = bytes.subarray(body, body + size.value);

    switch (id.id) {
      case ID_TIMESTAMP_SCALE: {
        const v = readUint(payload);
        if (v !== null && v > 0) timestampScale = v;
        break;
      }
      case ID_CODEC_ID:
        codecId = readAscii(payload);
        break;
      case ID_CODEC_PRIVATE:
        codecPrivate = payload;
        break;
      case ID_CHANNELS: {
        const v = readUint(payload);
        if (v !== null) channels = v;
        break;
      }
      case ID_SAMPLE_RATE: {
        if (payload.length === 8) sampleRate = new DataView(payload.buffer, payload.byteOffset, 8).getFloat64(0, false);
        else if (payload.length === 4) sampleRate = new DataView(payload.buffer, payload.byteOffset, 4).getFloat32(0, false);
        break;
      }
      case ID_CLUSTER_TIMESTAMP: {
        const v = readUint(payload);
        if (v !== null) clusterMs = (v * timestampScale) / 1e6;
        break;
      }
      case ID_SIMPLE_BLOCK:
      case ID_BLOCK: {
        const block = readBlock(payload);
        if (block === null) return { ok: false, reason: 'broken' };
        if (block.lacing !== 0) return { ok: false, reason: 'lacing' };
        packets.push({ ms: clusterMs + block.relMs, data: block.data });
        break;
      }
      default:
        break;
    }
    pos = body + size.value;
  }

  if (codecId !== 'A_OPUS') return { ok: false, reason: codecId === null ? 'not-webm' : 'not-opus' };
  if (packets.length === 0) return { ok: false, reason: 'no-audio' };

  // 🔑 `OpusHead` から読む(無ければ `Audio` の値 → 既定)
  const headChannels = codecPrivate !== null && codecPrivate.length > 9 ? codecPrivate[9]! : 0;
  const packetMs =
    packets.length > 1 ? Math.max(1, packets[1]!.ms - packets[0]!.ms) : FALLBACK_PACKET_MS;

  return {
    ok: true,
    source: {
      codecPrivate: codecPrivate ?? new Uint8Array(0),
      channels: headChannels || channels || DEFAULT_CHANNELS,
      sampleRate: sampleRate || DEFAULT_SAMPLE_RATE,
      packets,
      packetMs,
      durationMs: packets[packets.length - 1]!.ms + packetMs,
    },
  };
}

/** block の頭(track 番号 + 相対時刻 + 旗)を読む。 */
function readBlock(
  payload: Uint8Array,
): { readonly relMs: number; readonly lacing: number; readonly data: Uint8Array } | null {
  if (payload.length < 4) return null;
  const first = payload[0]!;
  if (first === 0) return null;
  let at = 1;
  for (let mask = 0x80; mask > 0 && (first & mask) === 0; mask >>= 1) at += 1;
  if (payload.length < at + 3) return null;
  const relMs = new DataView(payload.buffer, payload.byteOffset + at, 2).getInt16(0, false);
  const flags = payload[at + 2]!;
  return { relMs, lacing: (flags >> 1) & 0x3, data: payload.subarray(at + 3) };
}

/** 切り出した結果。⚠ 数は**報告と test の観測点**なので全部返す。 */
export interface TrimResult {
  readonly bytes: Uint8Array;
  /** 残した packet の数。 */
  readonly keptPackets: number;
  /** 頭で捨てさせるナノ秒(`CodecDelay`)。 */
  readonly codecDelayNs: number;
  /** 尻で捨てさせるナノ秒(`DiscardPadding`)。 */
  readonly discardPaddingNs: number;
  /** 🔑 **鳴らしたときの長さ**(ミリ秒)── 頼んだ範囲と食い違いうる(端で詰まったとき)。 */
  readonly durationMs: number;
}

export type TrimOutcome =
  | { readonly ok: true; readonly result: TrimResult }
  | { readonly ok: false; readonly reason: TrimRefusal };

/**
 * 🔑 復号器の立ち上がりに要る前置き(ミリ秒)。
 * ⚠ いきなり切ると**頭が濁る** ── opus の仕様が 80ms 以上を勧めている。
 */
const PRE_ROLL_MS = 80;

/**
 * ⚠ block の相対時刻は **16 ビットの符号つき**(±32.767 秒)なので、
 * これを超える前に `Cluster` を切り直す。🔑 超えると**書けずに例外**になる
 * (= 1 分を超える切り出しが全部落ちる)。
 */
const CLUSTER_SPAN_MS = 30000;

/**
 * 🔴 **範囲を切り出して、新しい WebM のバイト列を返す**。
 *
 * ⚠ **入れ物も元と同じ WebM にする**(Ogg にすると拡張子と mime が変わり、
 * 書き出しの名前が `.bin` になる罠を踏む ── 設計 doc §4③)。
 */
export function trimWebmOpus(bytes: Uint8Array, startMs: number, endMs: number): TrimOutcome {
  const demuxed = demuxWebmOpus(bytes);
  if (!demuxed.ok) return demuxed;
  const src = demuxed.source;

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return { ok: false, reason: 'empty-range' };
  }
  const packets = src.packets;
  const packetMs = src.packetMs;

  // ── 範囲の始まり「以前」でいちばん近い境目
  const first = packets.findIndex((p) => p.ms + packetMs > startMs);
  if (first < 0) return { ok: false, reason: 'empty-range' };
  // 🔑 前置きを packet の数へ直す(実測 60ms なら 2 つ前から)
  const pre = Math.ceil(PRE_ROLL_MS / packetMs);
  const from = Math.max(0, first - pre);

  let last = packets.findIndex((p) => p.ms >= endMs);
  if (last < 0) last = packets.length;
  const kept = packets.slice(from, Math.max(last, from + 1));
  if (kept.length === 0) return { ok: false, reason: 'empty-range' };

  const base = kept[0]!.ms;
  const tailMs = kept[kept.length - 1]!.ms + packetMs;
  const codecDelayNs = Math.max(0, Math.round((startMs - base) * 1e6));
  const discardPaddingNs = Math.max(0, Math.round((tailMs - endMs) * 1e6));
  const durationMs = tailMs - base - codecDelayNs / 1e6 - discardPaddingNs / 1e6;

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
    '1549a966',
    concatBytes([
      element(ID_TIMESTAMP_SCALE, uintBytes(1000000)),
      element('4d80', asciiBytes('pkc3')), // MuxingApp
      element('5741', asciiBytes('pkc3')), // WritingApp
      element('4489', float64Bytes(durationMs)), // Duration(1ms 刻み)
    ]),
  );
  const tracks = element(
    '1654ae6b',
    element(
      'ae',
      concatBytes([
        element('d7', uintBytes(1)), // TrackNumber
        element('73c5', uintBytes(1)), // TrackUID
        element('83', uintBytes(2)), // TrackType = audio
        element(ID_CODEC_ID, asciiBytes('A_OPUS')),
        element(ID_CODEC_PRIVATE, src.codecPrivate),
        element('56aa', uintBytes(codecDelayNs)), // CodecDelay
        element('56bb', uintBytes(80000000)), // SeekPreRoll(opus は 80ms 固定)
        element(
          'e1',
          concatBytes([
            element(ID_SAMPLE_RATE, float64Bytes(src.sampleRate)),
            element(ID_CHANNELS, uintBytes(src.channels)),
          ]),
        ),
      ]),
    ),
  );

  const clusters = buildClusters(kept, base, discardPaddingNs);
  const segment = element('18538067', concatBytes([info, tracks, ...clusters]));

  return {
    ok: true,
    result: {
      bytes: concatBytes([header, segment]),
      keptPackets: kept.length,
      codecDelayNs,
      discardPaddingNs,
      durationMs,
    },
  };
}

/**
 * packet を `Cluster` に詰める。
 * ⚠ **相対時刻が 16 ビットに収まる範囲で切り直す**(`CLUSTER_SPAN_MS`)──
 * 1 つの `Cluster` に詰め続けると、**33 秒を超える切り出しが書けなくなる**。
 */
function buildClusters(
  kept: readonly OpusPacket[],
  base: number,
  discardPaddingNs: number,
): Uint8Array[] {
  const clusters: Uint8Array[] = [];
  let blocks: Uint8Array[] = [];
  let clusterMs = 0;

  const flush = (): void => {
    if (blocks.length === 0) return;
    clusters.push(element('1f43b675', concatBytes([element(ID_CLUSTER_TIMESTAMP, uintBytes(clusterMs)), ...blocks])));
    blocks = [];
  };

  for (let i = 0; i < kept.length; i += 1) {
    const p = kept[i]!;
    const ms = Math.round(p.ms - base);
    if (blocks.length === 0) clusterMs = ms;
    else if (ms - clusterMs > CLUSTER_SPAN_MS) {
      flush();
      clusterMs = ms;
    }
    const isLast = i === kept.length - 1;
    // ⚠ 旗の `0x80` = keyframe。opus は全部 keyframe だが、
    //   `BlockGroup` の中の `Block` には旗を立てない(そちらは `ReferenceBlock` が無いことで示す)
    const body = concatBytes([
      Uint8Array.of(0x81), // TrackNumber 1(vint)
      int16Bytes(ms - clusterMs),
      Uint8Array.of(isLast && discardPaddingNs > 0 ? 0x00 : 0x80),
      p.data,
    ]);
    blocks.push(
      isLast && discardPaddingNs > 0
        ? element('a0', concatBytes([element(ID_BLOCK, body), element('75a2', intBytes(discardPaddingNs))]))
        : element(ID_SIMPLE_BLOCK, body),
    );
  }
  flush();
  return clusters;
}
