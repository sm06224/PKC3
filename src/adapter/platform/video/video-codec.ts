/**
 * 🔴 **動画の切り出しの「中身」**(#683 段②b-1・②b-2。設計 doc §4.3・§4.6・§4.7)。
 *
 * 🔑 **ワーカーの配線とは別の file に置く**(`audio-codec.ts` / `asset-codec.ts` と同じ作法)。
 *
 * ⚠ **音の `trimAudio` と違い、元を `arrayBuffer()` で丸ごと読まない** ── 動画は 1 本 250MB まで
 *   ありうるので、**窓(8MB)で順に読み、索引だけを持つ**。出力も `Blob.slice` の部品を
 *   並べた `Blob` で返す(コピーしない。不可侵指示 2026-07-27「ゼロコピー」)。
 *
 * 口は 3 つ:
 * - `scanVideo` ── 走査して、始まりをどこへ戻すか・**押した所ぴったりに切れるか**を返す(確認の前に呼ぶ)
 * - `cutVideo`  ── 走査の結果を使って、新しい動画の `Blob` を組む
 * - `reencodeHead` ── 🔴 段②b-2:押した所からの数秒を**復号 → 符号化し直す**(WebCodecs)
 *
 * ## 🔴 押した所ぴったり(段②b-2)の作り
 *
 * 押した所に表示されているフレームから、次のキーフレームの手前までを `VideoDecoder` → `VideoEncoder` で作り直し
 * (1 枚目だけキーフレーム)、そこから先は元のバイトのまま繋ぐ(`planVideoTrim` の `head`)。
 * - ⚠ **`VideoFrame` は同時に 10 枚前後まで**(`MAX_LIVE_FRAMES`)。受け取ったら符号化器へ渡してすぐ `close()` する
 *   (GOP 全体を貯めない ── 1080p で 1 枚 約 3MB)
 * - ⚠ **使えるかは「実際に 1 枚通す」で決める**(`detectPrecise`)── `isConfigSupported` が true でも、
 *   環境によっては `configure` や出力で落ちる。結果は**環境ごとに 1 回だけ**測る
 * - ⚠ 途中で 1 枚でも落ちたら**ファイルを作らず** `preciseFailed` で返す(部分的な file を出さない)。
 *   呼び側は手前のキーフレームから切る道へ回し、**確認を出す**
 * - 🔴 **落ちたのが「その録画だけ」か「環境そのもの」かは、小さい 1 枚をもう一度通して決める**(`recheckAfterFailure`)。
 *   通れば環境は使える(次の録画は押した所ぴったりで切る)── 1 本の失敗で、このページを開いている間ずっと
 *   確認つきの道へ倒さない。通らなければ環境の失敗として「使えない」に倒す
 */
import {
  planVideoTrim,
  precisePlanSpec,
  preciseEncodeParams,
  scanWebmVideo,
  snapVideoStart,
  type ByteSource,
  type HeadFrame,
  type PreciseSpec,
  type VideoScan,
  type VideoTrimRefusal,
} from '@features/video/webm-vp8';

/** 同時に生きている `VideoFrame` の上限(設計 doc §4.3 の 4)。 */
export const MAX_LIVE_FRAMES = 10;
/** 符号化器の待ち行列の上限。 */
const MAX_ENCODE_QUEUE = 8;
/** 検出の打ち切り(ミリ秒)。⚠ 出力が返らない符号化器で固まらない。 */
export const DETECT_TIMEOUT_MS = 8000;
/** 作り直しの途中で、出力が 1 つも来ないまま経つ時間の上限(ミリ秒)。⚠ 固まった符号化器で永久に待たない。 */
export const STALL_MS = 30_000;

/** 依頼。⚠ `Blob` で渡す(構造化複製で参照として渡り、bytes は写されない)。 */
export type VideoJob =
  | {
      readonly op: 'scan';
      readonly blob: Blob;
      readonly startMs: number;
      readonly endMs: number;
    }
  | {
      readonly op: 'cut';
      readonly blob: Blob;
      readonly scan: VideoScan;
      readonly startMs: number;
      readonly endMs: number;
      /** `precise` = 押した所ぴったり / `snap` = 手前のキーフレームから。 */
      readonly mode: 'precise' | 'snap';
      /** 作り直しを呼び側(メインスレッド)で済ませたとき、その結果。 */
      readonly head?: readonly HeadFrame[];
    };

/**
 * 押した所ぴったりに切れるか。
 * - `ready` ── ここで切れる(作り直しが要らない / ここの WebCodecs が通った)
 * - `needs-codec` ── 作り直しが要るが、ここの WebCodecs は使えない(呼び側が別の場所で作り直せる)
 * - `none` ── 使えない(押した所が最初の映像フレームより手前など)
 */
export type PreciseState = 'ready' | 'needs-codec' | 'none';

export type VideoScanResult =
  | {
      readonly ok: true;
      readonly scan: VideoScan;
      readonly snappedStartMs: number;
      /** 始まりが手前へ戻る長さ(ミリ秒)。0 = 押した所がちょうどキーフレーム。⚠ 押した所ぴったりの道では使わない。 */
      readonly snapBackMs: number;
      readonly precise: PreciseState;
    }
  | { readonly ok: false; readonly reason: VideoTrimRefusal };

export type VideoCutResult =
  | {
      readonly ok: true;
      /** ⚠ **元の `Blob` の部品を指す**(コピーしていない)。 */
      readonly blob: Blob;
      readonly durationMs: number;
      readonly snappedStartMs: number;
      /** 始まりが押した所より手前へ戻った長さ(ミリ秒)。押した所ぴったりなら 0。 */
      readonly snapBackMs: number;
      readonly keptVideo: number;
      readonly keptAudio: number;
      /** 作り直したフレームの数(押した所ぴったりの道だけ)。 */
      readonly reencoded: number;
      readonly precise: boolean;
    }
  | { readonly ok: false; readonly reason: VideoTrimRefusal }
  /** 🔴 押した所ぴったりの道が途中で落ちた。**何も作っていない**。呼び側は手前のキーフレームから切る道へ回す。 */
  | {
      readonly ok: false;
      readonly preciseFailed: true;
      /** 落ちたのが環境そのものか(再検出も通らなかった)。`false` = その録画だけ。 */
      readonly environmentBroken: boolean;
    };

export type VideoJobResult = VideoScanResult | VideoCutResult;

/** `Blob` を窓で読む口。 */
export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
  };
}

// ---------------------------------------------------------------------------------------------
// WebCodecs の口(差し替えられる形にして、unit が本物の意味論を真似た偽物で通せるようにする)
// ---------------------------------------------------------------------------------------------

export interface FrameLike {
  readonly timestamp: number;
  close(): void;
}

export interface EncodedOut {
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
  readonly data: Uint8Array;
}

export interface EncoderLike {
  readonly encodeQueueSize: number;
  /** 待ち行列が減ったときの合図(`dequeue`)。⚠ 背景のタブでは `setTimeout` が約 1 秒に間引かれるので、待ちは合図で起こす。 */
  onDequeue(listener: () => void): void;
  configure(config: { codec: 'vp8'; width: number; height: number; bitrate: number; framerate: number }): void;
  encode(frame: FrameLike, options?: { keyFrame?: boolean }): void;
  flush(): Promise<void>;
  close(): void;
}

export interface DecoderLike {
  readonly decodeQueueSize: number;
  onDequeue(listener: () => void): void;
  configure(config: { codec: 'vp8'; codedWidth: number; codedHeight: number }): void;
  decode(chunk: { type: 'key' | 'delta'; timestamp: number; data: Uint8Array }): void;
  flush(): Promise<void>;
  close(): void;
}

/** WebCodecs の道具一式。⚠ 本物は `nativeCodecApi()`、test は偽物を渡す。 */
export interface CodecApi {
  createEncoder(init: { output: (chunk: EncodedOut) => void; error: (e: unknown) => void }): EncoderLike;
  createDecoder(init: { output: (frame: FrameLike) => void; error: (e: unknown) => void }): DecoderLike;
  /** 検出用の 1 枚(単色でない絵)。⚠ 呼び側が `close()` する。 */
  makeProbeFrame(width: number, height: number): FrameLike;
}

let nativeApi: CodecApi | null | undefined;

/** この場所(ワーカー / メイン)で WebCodecs の VP8 を回す道具。無ければ `null`。 */
export function nativeCodecApi(): CodecApi | null {
  if (nativeApi !== undefined) return nativeApi;
  const g = globalThis as unknown as Record<string, unknown>;
  if (
    typeof g['VideoEncoder'] !== 'function' ||
    typeof g['VideoDecoder'] !== 'function' ||
    typeof g['EncodedVideoChunk'] !== 'function' ||
    typeof g['VideoFrame'] !== 'function'
  ) {
    nativeApi = null;
    return null;
  }
  nativeApi = {
    createEncoder: (init) => {
      const enc = new VideoEncoder({
        output: (chunk) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          init.output({ type: chunk.type, timestamp: chunk.timestamp, data });
        },
        error: init.error,
      });
      return {
        get encodeQueueSize(): number {
          return enc.encodeQueueSize;
        },
        onDequeue: (listener) => enc.addEventListener('dequeue', listener),
        configure: (config) => enc.configure({ ...config, bitrateMode: 'variable' }),
        encode: (frame, options) => enc.encode(frame as VideoFrame, options),
        flush: () => enc.flush(),
        close: () => {
          if (enc.state !== 'closed') enc.close();
        },
      };
    },
    createDecoder: (init) => {
      const dec = new VideoDecoder({ output: init.output as (f: VideoFrame) => void, error: init.error });
      return {
        get decodeQueueSize(): number {
          return dec.decodeQueueSize;
        },
        onDequeue: (listener) => dec.addEventListener('dequeue', listener),
        configure: (config) => dec.configure(config),
        decode: (chunk) => dec.decode(new EncodedVideoChunk(chunk)),
        flush: () => dec.flush(),
        close: () => {
          if (dec.state !== 'closed') dec.close();
        },
      };
    },
    makeProbeFrame: (width, height) => {
      const rgba = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const i = (y * width + x) * 4;
          rgba[i] = (x * 255) / width;
          rgba[i + 1] = (y * 255) / height;
          rgba[i + 2] = 128;
          rgba[i + 3] = 255;
        }
      }
      return new VideoFrame(rgba, { format: 'RGBA', codedWidth: width, codedHeight: height, timestamp: 0 });
    },
  };
  return nativeApi;
}

// ---------------------------------------------------------------------------------------------
// 検出:実際に 1 枚通す
// ---------------------------------------------------------------------------------------------

const detectCache = new WeakMap<CodecApi, Promise<boolean>>();

/**
 * 🔴 **押した所ぴったりに切れる環境か**(設計 doc §5 の 225 行)。
 *
 * ⚠ `VideoEncoder.isConfigSupported` が true でも、環境によって `configure` で落ちる。
 *   だから**小さい絵を 1 枚、符号化 → 復号**まで通し、1 枚戻ったときだけ true にする。
 * 🔑 結果は**環境ごと(`CodecApi` ごと)に 1 回だけ**測る ── 続けて切り出すたびに測り直さない。
 */
export function detectPrecise(api: CodecApi | null = nativeCodecApi()): Promise<boolean> {
  if (api === null) return Promise.resolve(false);
  const hit = detectCache.get(api);
  if (hit !== undefined) return hit;
  const p = probeOnce(api).catch(() => false);
  detectCache.set(api, p);
  return p;
}

/**
 * 🔴 **作り直しが落ちた後に、環境がまだ使えるかを測り直す**(小さい 1 枚をもう一度通す)。
 *
 * ⚠ 1 本の録画の失敗(枚数の食い違い・その録画の復号の error)で、このページを開いている間ずっと
 *   押した所ぴったりの道を閉じない。通れば覚えを「使える」に戻す。通らなければ環境の失敗として倒す。
 * @returns 環境が使えなくなったか
 */
export async function recheckAfterFailure(api: CodecApi): Promise<boolean> {
  const ok = await probeOnce(api).catch(() => false);
  detectCache.set(api, Promise.resolve(ok));
  return !ok;
}

async function probeOnce(api: CodecApi): Promise<boolean> {
  const W = 128;
  const H = 96;
  let enc: EncoderLike | null = null;
  let dec: DecoderLike | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = async (): Promise<boolean> => {
      const chunks: EncodedOut[] = [];
      let failed = false;
      enc = api.createEncoder({ output: (c) => chunks.push(c), error: () => (failed = true) });
      enc.configure({ codec: 'vp8', width: W, height: H, bitrate: 500_000, framerate: 30 });
      const frame = api.makeProbeFrame(W, H);
      try {
        enc.encode(frame, { keyFrame: true });
      } finally {
        frame.close();
      }
      await enc.flush();
      if (failed || chunks.length !== 1 || chunks[0]!.type !== 'key') return false;
      let got = 0;
      dec = api.createDecoder({
        output: (f) => {
          got += 1;
          f.close();
        },
        error: () => (failed = true),
      });
      dec.configure({ codec: 'vp8', codedWidth: W, codedHeight: H });
      dec.decode({ type: 'key', timestamp: 0, data: chunks[0]!.data });
      await dec.flush();
      return !failed && got === 1;
    };
    const timeout = new Promise<boolean>((res) => {
      timer = setTimeout(() => res(false), DETECT_TIMEOUT_MS);
    });
    return await Promise.race([run(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      (enc as EncoderLike | null)?.close();
    } catch {
      /* 閉じられないなら諦める */
    }
    try {
      (dec as DecoderLike | null)?.close();
    } catch {
      /* 同上 */
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 作り直し
// ---------------------------------------------------------------------------------------------

export interface ReencodeStats {
  /** 同時に生きていた `VideoFrame` の最大数(観測点)。 */
  readonly maxLive: number;
  /** 終わった時点で閉じられていない `VideoFrame` の数(0 であるべき)。 */
  readonly leaked: number;
}

export async function reencodeHead(
  src: ByteSource,
  scan: VideoScan,
  spec: PreciseSpec,
  api: CodecApi,
): Promise<{ frames: HeadFrame[]; stats: ReencodeStats }> {
  const params = preciseEncodeParams(scan);
  const firstUs = spec.emit[0]!.ms * 1000;
  const out: HeadFrame[] = [];
  const queue: FrameLike[] = [];
  let live = 0;
  let maxLive = 0;
  let encoded = 0;
  let pumping = false;
  let error: unknown = null;
  let lastProgress = Date.now();
  /**
   * 🔑 待ちは**合図で起こす**(`dequeue` / 数が変わったとき)。⚠ 1 ミリ秒ごとの `setTimeout` の見張りは、
   *   背景のタブで約 1 秒に間引かれ、1 枚ごとに 1 秒待つ。合図を取りこぼしても進めるよう、250ms の保険の時計も置く。
   */
  const waiters = new Set<() => void>();
  const wake = (): void => {
    const all = [...waiters];
    waiters.clear();
    for (const w of all) w();
  };
  const waitUntil = async (cond: () => boolean): Promise<void> => {
    while (!cond()) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(wake, 250);
        waiters.add(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  };
  const fail = (e: unknown): void => {
    if (error === null) error = e instanceof Error ? e : new Error(String(e));
    wake();
  };

  const enc = api.createEncoder({
    output: (c) => {
      lastProgress = Date.now();
      out.push({ ms: Math.round(c.timestamp / 1000), bytes: c.data, key: c.type === 'key' });
      wake();
    },
    error: fail,
  });
  const dec = api.createDecoder({
    output: (f) => {
      lastProgress = Date.now();
      live += 1;
      if (live > maxLive) maxLive = live;
      // 作り直さない側(押した所より前のフレーム)は**すぐ捨てる**
      if (error !== null || f.timestamp < firstUs) {
        f.close();
        live -= 1;
        wake();
        return;
      }
      queue.push(f);
      if (!pumping) void pump();
    },
    error: fail,
  });

  /** 復号されたフレームを符号化器へ 1 枚ずつ渡す(渡したらすぐ `close()`)。 */
  async function pump(): Promise<void> {
    pumping = true;
    try {
      while (queue.length > 0) {
        await waitUntil(() => enc.encodeQueueSize < MAX_ENCODE_QUEUE || error !== null);
        const f = queue.shift();
        if (f === undefined) break; // 待っている間に後始末(諦め)で空にされた
        try {
          if (error === null) {
            enc.encode(f, encoded === 0 ? { keyFrame: true } : undefined);
            encoded += 1;
          }
        } catch (e) {
          fail(e);
        } finally {
          f.close();
          live -= 1;
          wake();
        }
      }
    } finally {
      pumping = false;
      wake();
    }
  }
  enc.onDequeue(wake);
  dec.onDequeue(wake);

  const run = async (): Promise<{ frames: HeadFrame[]; stats: ReencodeStats }> => {
    enc.configure({ codec: 'vp8', ...params });
    dec.configure({ codec: 'vp8', codedWidth: scan.width, codedHeight: scan.height });
    for (const b of spec.decode) {
      await waitUntil(() => error !== null || live + dec.decodeQueueSize < MAX_LIVE_FRAMES);
      if (error !== null) break;
      const data = await src.read(b.dataStart, b.dataEnd);
      // 🔴 読んでいる間に止められた(stall)なら、閉じた復号器へ渡さない
      if (error !== null) break;
      dec.decode({ type: b.key ? 'key' : 'delta', timestamp: b.ms * 1000, data });
    }
    if (error === null) await dec.flush();
    await waitUntil(() => (queue.length === 0 && !pumping) || error !== null);
    if (error === null) await enc.flush();
    if (error !== null) throw error;
    // 🔴 落ちたフレームも重なったフレームも無い ── 渡した数と戻った数が一致し、1 枚目はキーフレーム
    if (encoded !== spec.emit.length) throw new Error(`作り直すフレームの数が合わない(復号 ${encoded} / 期待 ${spec.emit.length})`);
    if (out.length !== encoded) throw new Error(`符号化の出力の数が合わない(${out.length} / ${encoded})`);
    if (!out[0]!.key) throw new Error('作り直した 1 枚目がキーフレームでない');
    return { frames: out, stats: { maxLive, leaked: live } };
  };
  let watchdog: ReturnType<typeof setInterval> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    watchdog = setInterval(() => {
      if (Date.now() - lastProgress > STALL_MS) {
        const e = new Error('作り直しが止まった');
        fail(e); // 🔑 負けた run() が、閉じた後の復号器 / 元の Blob に触らないよう、先に止める印を立てる
        reject(e);
      }
    }, 1000);
  });
  const running = run();
  running.catch(() => {}); // 先に stall で抜けても、後から落ちた分が未処理の拒否にならない
  try {
    return await Promise.race([running, stalled]);
  } finally {
    if (watchdog !== undefined) clearInterval(watchdog);
    fail(new Error('終了')); // 後から動く run() があっても、ここで止まる
    // 失敗でも成功でも、残っている `VideoFrame` を全部閉じる
    for (const f of queue.splice(0)) {
      f.close();
      live -= 1;
    }
    try {
      dec.close();
    } catch {
      /* 閉じられないなら諦める */
    }
    try {
      enc.close();
    } catch {
      /* 同上 */
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 口
// ---------------------------------------------------------------------------------------------

export async function scanVideo(
  job: { blob: Blob; startMs: number; endMs: number },
  api: CodecApi | null = nativeCodecApi(),
): Promise<VideoScanResult> {
  const scanned = await scanWebmVideo(blobSource(job.blob), job.endMs);
  if (!scanned.ok) return scanned;
  const snap = snapVideoStart(scanned.scan, job.startMs);
  if (!snap.ok) return snap;
  const spec = precisePlanSpec(scanned.scan, job.startMs, job.endMs);
  let precise: PreciseState = 'none';
  if (spec !== null) {
    // 🔑 押した所に表示されているフレームがキーフレームなら、作り直しも WebCodecs も要らない
    if (!spec.reencode) precise = 'ready';
    else precise = (await detectPrecise(api)) ? 'ready' : 'needs-codec';
  }
  return {
    ok: true,
    scan: scanned.scan,
    snappedStartMs: snap.snappedStartMs,
    snapBackMs: snap.snapBackMs,
    precise,
  };
}

export async function cutVideo(
  job: {
    blob: Blob;
    scan: VideoScan;
    startMs: number;
    endMs: number;
    mode?: 'precise' | 'snap';
    head?: readonly HeadFrame[];
  },
  api: CodecApi | null = nativeCodecApi(),
): Promise<VideoCutResult> {
  const src = blobSource(job.blob);
  let reencoded = 0;
  let planned;
  if (job.mode === 'precise') {
    const spec = precisePlanSpec(job.scan, job.startMs, job.endMs);
    if (spec === null) return { ok: false, preciseFailed: true, environmentBroken: false };
    let frames: readonly HeadFrame[];
    if (job.head !== undefined) {
      frames = job.head;
    } else if (!spec.reencode) {
      const f = spec.emit[0]!;
      frames = [{ ms: f.ms, bytes: await src.read(f.dataStart, f.dataEnd), key: true }];
    } else {
      if (api === null) return { ok: false, preciseFailed: true, environmentBroken: true };
      try {
        frames = (await reencodeHead(src, job.scan, spec, api)).frames;
        reencoded = frames.length;
      } catch {
        // 🔴 途中で落ちた:何も作らずに返す。環境が壊れたのか、この録画だけかは測り直して決める
        return { ok: false, preciseFailed: true, environmentBroken: await recheckAfterFailure(api) };
      }
    }
    if (job.head !== undefined) reencoded = job.head.length;
    planned = await planVideoTrim(src, job.scan, job.startMs, job.endMs, { frames, tailFromMs: spec.tailFromMs });
  } else {
    planned = await planVideoTrim(src, job.scan, job.startMs, job.endMs);
  }
  if (!planned.ok) return planned;
  const p = planned.plan;
  const blob = new Blob(
    p.parts.map((part) =>
      part.kind === 'bytes' ? (part.bytes as Uint8Array<ArrayBuffer>) : job.blob.slice(part.start, part.end),
    ),
    { type: 'video/webm' },
  );
  return {
    ok: true,
    blob,
    durationMs: p.durationMs,
    snappedStartMs: p.snappedStartMs,
    snapBackMs: p.snapBackMs,
    keptVideo: p.keptVideo,
    keptAudio: p.keptAudio,
    reencoded,
    precise: p.precise,
  };
}

/** ワーカー / その場の両方が通る 1 本の入口。 */
export function runVideoJob(job: VideoJob, api?: CodecApi | null): Promise<VideoJobResult> {
  return job.op === 'scan' ? scanVideo(job, api) : cutVideo(job, api);
}
