/**
 * 🔴 **押した所ぴったりに切る ── 作り直しの駆動**(#683 段②b-2。設計 doc §4.3・§5)。
 *
 * ⚠ 本物の `VideoEncoder` / `VideoDecoder` は unit に居ない。`tests/helpers/fake-webcodecs.ts` の偽物は
 *   本物の意味論を写す(最初の chunk がキーでなければ error / `keyFrame: true` を頼まないと差分 /
 *   出力は非同期 / `VideoFrame` は `close()` まで生きている)。本物は `media-capture.smoke.spec.ts` が通す。
 *
 * 見るのは user の受け取りに効く 5 つ:
 *   ①**始まりが押した所ぴったり**(頭が作り直され、継ぎ目で欠けも重なりも無い)
 *   ②**1 枚目はキーフレーム**(頼み忘れると、再生できない file ができる)
 *   ③**`VideoFrame` は同時に 10 枚まで・全部 `close()`**(長い塊でもメモリが伸びない)
 *   ④**途中で落ちたら何も作らない**(`preciseFailed`)── 呼び側が手前の区切りへ回して確認を出す
 *   ⑤**使えるかは「実際に 1 枚通す」で決め、環境ごとに 1 回だけ測る**
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CodecApi,
  cutVideo,
  DETECT_TIMEOUT_MS,
  detectPrecise,
  MAX_LIVE_FRAMES,
  STALL_MS,
  reencodeHead,
  scanVideo,
  blobSource,
} from '../../src/adapter/platform/video/video-codec';
import { VideoClient } from '../../src/adapter/platform/video/video-client';
import { JobMonitor } from '../../src/adapter/platform/job-monitor';
import { precisePlanSpec, scanWebmVideo, type VideoScan } from '../../src/features/video/webm-vp8';
import { buildVideoWebm, countingSource, parseWebm, type VideoFixture } from '../helpers/webm-video-fixture';
import { fakeCodecApi, type FakeOptions } from '../helpers/fake-webcodecs';

async function prepare(f: VideoFixture = { frames: 40, frameMs: 100 }) {
  const built = buildVideoWebm(f);
  const blob = new Blob([built.bytes], { type: 'video/webm' });
  const scanned = await scanWebmVideo(countingSource(built.bytes), 1e9);
  if (!scanned.ok) throw new Error('走査できなかった');
  return { built, blob, scan: scanned.scan as VideoScan };
}

const video = (bytes: Uint8Array) => parseWebm(bytes).blocks.filter((b) => b.track === 1);
const idx = (b: { payload: number[] }): number => b.payload[3]!;

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe('押した所ぴったりに切る(cutVideo の precise)', () => {
  it('🔴 頭が作り直され、継ぎ目で欠けも重なりも無い ── 復号は K0 から、符号化は押した所に表示されていた 1 枚から', async () => {
    const { blob, scan } = await prepare();
    const { api, stats } = fakeCodecApi();
    const r = await cutVideo({ blob, scan, startMs: 1550, endMs: 3050, mode: 'precise' }, api);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.precise).toBe(true);
    expect(r.snapBackMs, '押した所ぴったりなので戻らない').toBe(0);
    expect(r.snappedStartMs).toBe(1550);
    expect(r.reencoded).toBe(5);
    // 🔑 復号に渡したのは K0(添字 10)から K1 の手前(19)まで ── 差分は K0 から順に
    expect(stats.decodeCalls.map((c) => c.index)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(stats.decodeCalls[0]!.type).toBe('key');
    expect(stats.decodeCalls.slice(1).every((c) => c.type === 'delta')).toBe(true);
    // 符号化に渡したのは表示されていた 15 から(14 以前は捨てる)── 重ならず欠けない
    expect(stats.encodeCalls.map((c) => c.index)).toEqual([15, 16, 17, 18, 19]);
    const out = video(await bytesOf(r.blob));
    expect(out.map(idx)).toEqual(Array.from({ length: 16 }, (_, i) => 15 + i));
    expect(out.map((b) => b.ms)).toEqual([0, 50, 150, 250, 350, 450, 550, 650, 750, 850, 950, 1050, 1150, 1250, 1350, 1450]);
    expect(r.keptVideo).toBe(16);
  });

  it('🔴 符号化の 1 枚目だけ keyFrame:true を頼む ── 頼み忘れると再生できない file になる(出力のキー判定も見る)', async () => {
    const { blob, scan } = await prepare();
    const { api, stats } = fakeCodecApi();
    const r = await cutVideo({ blob, scan, startMs: 1550, endMs: 3050, mode: 'precise' }, api);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(stats.encodeCalls.map((c) => c.keyFrame === true)).toEqual([true, false, false, false, false]);
    const out = video(await bytesOf(r.blob));
    expect(out[0]!.flags & 0x80, '1 枚目に旗が立っていない').toBe(0x80);
    expect(out[0]!.payload[0]).toBe(0x10);
    expect(out.slice(1, 5).every((b) => (b.flags & 0x80) === 0)).toBe(true);
  });

  it('🔴 VideoFrame は全部 close される(復号した数 = 閉じた数)・長い塊でも同時に 10 枚まで', async () => {
    // 区切りが 100 フレーム(10 秒)おき、押した所は塊の途中(2.55 秒)── K0 から 99 枚を復号する
    const { blob, scan } = await prepare({ frames: 150, frameMs: 100, keys: [0, 100] });
    // 出力を遅らせて、背圧が無ければフレームが溜まる形にする
    const { api, stats } = fakeCodecApi({ encodeDelayMs: 2, decodeDelayMs: 0 });
    const r = await cutVideo({ blob, scan, startMs: 2550, endMs: 14_000, mode: 'precise' }, api);
    expect(r.ok).toBe(true);
    expect(stats.decodeCalls, '空振り防止:10 枚を大きく超える数を復号している').toHaveLength(100);
    expect(stats.created, '復号した数').toBe(100);
    expect(stats.closed, '閉じていない VideoFrame が残っている').toBe(stats.created);
    expect(stats.live).toBe(0);
    expect(stats.maxLive, '同時に生きている VideoFrame が上限を超えた').toBeLessThanOrEqual(MAX_LIVE_FRAMES);
    expect(stats.maxLive, '空振り防止:背圧が働くほど溜まる形になっていない').toBeGreaterThan(2);
    expect(stats.encoderClosed).toBe(1);
    expect(stats.decoderClosed).toBe(1);
  });

  it('🔴 押した所がキーフレームの上なら WebCodecs は要らない(api が無くても押した所ぴったり)', async () => {
    const { blob, scan } = await prepare();
    const r = await cutVideo({ blob, scan, startMs: 2040, endMs: 3050, mode: 'precise' }, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.precise).toBe(true);
    expect(r.reencoded).toBe(0);
    const out = video(await bytesOf(r.blob));
    expect(out.map(idx)).toEqual(Array.from({ length: 11 }, (_, i) => 20 + i));
    expect(out[0]!.ms).toBe(0);
  });

  it('🔴 WebCodecs が無く作り直しが要るなら、何も作らず preciseFailed(手前の区切りへ回す)', async () => {
    const { blob, scan } = await prepare();
    const r = await cutVideo({ blob, scan, startMs: 1550, endMs: 3050, mode: 'precise' }, null);
    expect(r).toEqual({ ok: false, preciseFailed: true, environmentBroken: true });
  });
});

describe('途中で落ちたら何も作らない(preciseFailed)── この録画だけの失敗は、環境を閉じない', () => {
  const cases: [string, FakeOptions][] = [
    ['符号化が非同期の error を返す', { errorAtEncode: 2 }],
    ['encode が例外を投げる', { throwAtEncode: 3 }],
    ['復号が非同期の error を返す', { errorAtDecode: 4 }],
    ['符号化の出力が 1 枚落ちる(渡した数と戻った数が合わない)', { dropAtEncode: 2 }],
  ];
  for (const [name, opts] of cases) {
    it(`🔴 ${name} → ファイルを作らず、VideoFrame を全部閉じる。環境は使えるままで、次の録画は押した所ぴったりで切れる`, async () => {
      const { blob, scan } = await prepare();
      const { api, stats } = fakeCodecApi(opts);
      const r = await cutVideo({ blob, scan, startMs: 1550, endMs: 3050, mode: 'precise' }, api);
      expect(r, '落ちたのに file ができている / 環境の失敗と読んでいる').toEqual({
        ok: false,
        preciseFailed: true,
        environmentBroken: false,
      });
      expect(stats.closed, '落ちたときに閉じ漏れた VideoFrame').toBe(stats.created);
      expect(stats.encoderClosed).toBeGreaterThanOrEqual(1);
      expect(stats.decoderClosed).toBeGreaterThanOrEqual(1);
      // 🔴 再検出(小さい 1 枚)は通る ── このページを開いている間ずっと確認つきの道へ倒さない
      expect(await detectPrecise(api), '1 本の失敗で環境ごと閉じている').toBe(true);
      const again = await cutVideo({ blob, scan, startMs: 1550, endMs: 3050, mode: 'precise' }, api);
      expect(again.ok && again.precise, '次の録画が押した所ぴったりで切れない').toBe(true);
      const sc = await scanVideo({ blob, startMs: 1550, endMs: 3050 }, api);
      expect(sc.ok && sc.precise).toBe('ready');
    });
  }

  it('🔴 環境そのものが壊れた(再検出の 1 枚も通らない)→ preciseFailed + environmentBroken。以後は「使えない」で、走査は needs-codec', async () => {
    const { blob, scan } = await prepare();
    const { api, stats } = fakeCodecApi({ brokenFromEncode: 2 });
    const r = await cutVideo({ blob, scan, startMs: 1550, endMs: 3050, mode: 'precise' }, api);
    expect(r).toEqual({ ok: false, preciseFailed: true, environmentBroken: true });
    expect(stats.closed).toBe(stats.created);
    // 再検出で通した 1 枚が実際に走った(= 本当に測り直している)
    expect(stats.probeFrames, '再検出が走っていない').toBe(1);
    expect(await detectPrecise(api)).toBe(false);
    const sc = await scanVideo({ blob, startMs: 1550, endMs: 3050 }, api);
    expect(sc.ok && sc.precise).toBe('needs-codec');
  });

  it('対照群:同じ台で何も落ちなければ成功する(落ちる回の assert が台のせいでないこと)', async () => {
    const { blob, scan } = await prepare();
    const { api } = fakeCodecApi({});
    expect((await cutVideo({ blob, scan, startMs: 1550, endMs: 3050, mode: 'precise' }, api)).ok).toBe(true);
  });

  it('🔴 手前の区切りで切る道(snap)は WebCodecs に触らない・押した所より早く始まる(2 つの道は別物)', async () => {
    const { blob, scan } = await prepare();
    const { api, stats } = fakeCodecApi();
    const r = await cutVideo({ blob, scan, startMs: 1550, endMs: 3050, mode: 'snap' }, api);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.precise).toBe(false);
    expect(r.snapBackMs).toBe(550);
    expect(r.snappedStartMs).toBe(1000);
    expect(stats.encoders + stats.decoders).toBe(0);
  });
});

describe('作り直しそのもの(reencodeHead)', () => {
  it('🔴 1 枚目の出力がキーでなければ断る(頼み忘れた file を作らない)', async () => {
    const { blob, scan } = await prepare();
    const spec = precisePlanSpec(scan, 1550, 3050)!;
    const { api } = fakeCodecApi();
    // 符号化器の最初の encode を差分にする偽物(keyFrame を握りつぶす)
    const orig = api.createEncoder.bind(api);
    api.createEncoder = (init) => {
      const e = orig(init);
      return { ...e, encode: (f) => e.encode(f), get encodeQueueSize() { return e.encodeQueueSize; } } as typeof e;
    };
    await expect(reencodeHead(blobSource(blob), scan, spec, api)).rejects.toThrow(/キーフレーム/);
  });

  it('作り直した物の時刻は元の時刻のまま(符号化器に任せて振り直さない)', async () => {
    const { blob, scan } = await prepare();
    const spec = precisePlanSpec(scan, 1550, 3050)!;
    const { api } = fakeCodecApi();
    const { frames, stats } = await reencodeHead(blobSource(blob), scan, spec, api);
    expect(frames.map((f) => f.ms)).toEqual([1500, 1600, 1700, 1800, 1900]);
    expect(frames.map((f) => f.key)).toEqual([true, false, false, false, false]);
    expect(stats.leaked).toBe(0);
  });
});

describe('固まった符号化器で永久に待たない(STALL_MS / DETECT_TIMEOUT_MS)', () => {
  afterEach(() => vi.useRealTimers());

  it('🔴 作り直しは、出力が STALL_MS 来なければ諦める。諦めた後は元の Blob も復号器にも触らず、VideoFrame は全部閉じる', async () => {
    const { blob, scan } = await prepare({ frames: 150, frameMs: 100, keys: [0, 100] });
    const spec = precisePlanSpec(scan, 2550, 14_000)!;
    const reads = { n: 0 };
    const inner = blobSource(blob);
    const src = {
      size: inner.size,
      read: async (a: number, b: number) => {
        reads.n += 1;
        return inner.read(a, b);
      },
    };
    const { api, stats } = fakeCodecApi({ hangEncoder: true });
    vi.useFakeTimers();
    const p = reencodeHead(src, scan, spec, api);
    const settled = expect(p).rejects.toThrow(/止まった/);
    // 前提:STALL_MS の手前ではまだ待っている(早く諦めていない)
    await vi.advanceTimersByTimeAsync(STALL_MS - 2000);
    let early = false;
    void p.catch(() => (early = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(early, 'STALL_MS より早く諦めている').toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    await settled;
    const readsAt = reads.n;
    const decodesAt = stats.decodeCalls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads.n, '諦めた後に元の Blob を読んでいる').toBe(readsAt);
    expect(stats.decodeCalls.length, '諦めた後に閉じた復号器へ渡している').toBe(decodesAt);
    expect(stats.closed, '閉じ漏れた VideoFrame').toBe(stats.created);
    expect(stats.encoderClosed).toBe(1);
    expect(stats.decoderClosed).toBe(1);
  });

  it('🔴 元の Blob の読み出し中に諦めても、読み出しが後から返ったとき閉じた復号器へ渡さない', async () => {
    const { blob, scan } = await prepare({ frames: 150, frameMs: 100, keys: [0, 100] });
    const spec = precisePlanSpec(scan, 2550, 14_000)!;
    const inner = blobSource(blob);
    let release: (() => void) | null = null;
    let calls = 0;
    const src = {
      size: inner.size,
      // 3 回目の読み出しだけ、test が解くまで返らない(= 諦める瞬間に、読み出しの途中にいる)
      read: async (a: number, b: number) => {
        calls += 1;
        if (calls === 3) await new Promise<void>((r) => (release = r));
        return inner.read(a, b);
      },
    };
    const { api, stats } = fakeCodecApi();
    vi.useFakeTimers();
    const p = reencodeHead(src, scan, spec, api);
    const settled = expect(p).rejects.toThrow(/止まった/);
    await vi.advanceTimersByTimeAsync(STALL_MS + 2000);
    await settled;
    expect(release, '前提:諦めた時点で読み出しの途中にいる').not.toBeNull();
    const decodesAt = stats.decodeCalls.length;
    release!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(stats.decodeCalls.length, '諦めた後に返った読み出しを、閉じた復号器へ渡している').toBe(decodesAt);
    expect(stats.closed).toBe(stats.created);
  });

  it('🔴 検出は、符号化が返らなければ DETECT_TIMEOUT_MS で false にする(道具は閉じる)', async () => {
    const { api, stats } = fakeCodecApi({ hangEncoder: true });
    vi.useFakeTimers();
    const p = detectPrecise(api);
    await vi.advanceTimersByTimeAsync(DETECT_TIMEOUT_MS - 1000);
    let done = false;
    void p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done, 'DETECT_TIMEOUT_MS より早く false にしている').toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toBe(false);
    expect(stats.encoderClosed).toBe(1);
    expect(stats.closed).toBe(stats.created);
  });
});

describe('待ちは合図(dequeue)で起こす ── 背景のタブで時計が止まっても進む', () => {
  afterEach(() => vi.useRealTimers());

  it('🔴 時計(setTimeout)が一切進まなくても、作り直しが終わる(1 枚ごとに時計を待たない)', async () => {
    // ⚠ 元の bytes は**メモリから直に**返す(Blob.slice は実時間の待ちを挟む ── 待ちが時計だけに見える形にする)
    const built = buildVideoWebm({ frames: 150, frameMs: 100, keys: [0, 100] });
    const scanned = await scanWebmVideo(countingSource(built.bytes), 1e9);
    if (!scanned.ok) throw new Error('走査できなかった');
    const scan = scanned.scan;
    const spec = precisePlanSpec(scan, 2550, 14_000)!;
    const src = {
      size: built.bytes.length,
      read: async (a: number, b: number) => built.bytes.slice(a, b),
    };
    // 出力を 50 回ぶんの微小な順番待ちだけ遅らせる(時計は使わない)── 背圧の待ちが必ず起きる形
    const { api, stats } = fakeCodecApi({ lagMicrotasks: 50 });
    vi.useFakeTimers(); // 以後、時計は 1 ミリも進めない
    const r = await reencodeHead(src, scan, spec, api);
    expect(r.frames).toHaveLength(75);
    expect(stats.maxLive).toBeLessThanOrEqual(MAX_LIVE_FRAMES);
    // 空振り防止:10 枚を超えて復号している(= 背圧の待ちが実際に起きた)
    expect(stats.decodeCalls.length).toBeGreaterThan(MAX_LIVE_FRAMES * 5);
    expect(stats.closed).toBe(stats.created);
    // 合図の受け口:符号化器と復号器の両方の `dequeue` に聞き耳を立てている(待ちを起こす本命の道)
    expect(stats.encoderDequeueListeners, '符号化器の dequeue を聞いていない').toBeGreaterThanOrEqual(1);
    expect(stats.decoderDequeueListeners, '復号器の dequeue を聞いていない').toBeGreaterThanOrEqual(1);
  });
});

describe('使えるかの検出(detectPrecise)── 実際に 1 枚通す', () => {
  it('🔴 符号化 → 復号が 1 枚戻れば true。通したのは 1 枚だけ(符号化 1 回・復号 1 回)', async () => {
    const { api, stats } = fakeCodecApi();
    expect(await detectPrecise(api)).toBe(true);
    expect(stats.probeFrames).toBe(1);
    expect(stats.encodeCalls).toHaveLength(1);
    expect(stats.encodeCalls[0]!.keyFrame).toBe(true);
    expect(stats.decodeCalls).toHaveLength(1);
    expect(stats.closed, '検出に使った VideoFrame の閉じ漏れ').toBe(stats.created);
    expect(stats.encoderClosed + stats.decoderClosed, '検出が使った道具を閉じていない').toBe(2);
  });

  it('🔴 結果は環境ごとに 1 回だけ測る(続けて呼んでも道具を作り直さない)', async () => {
    const { api, stats } = fakeCodecApi();
    const [a, b] = await Promise.all([detectPrecise(api), detectPrecise(api)]);
    expect(await detectPrecise(api)).toBe(true);
    expect([a, b]).toEqual([true, true]);
    expect(stats.encoders, '呼ぶたびに測り直している').toBe(1);
    expect(stats.decoders).toBe(1);
    // 別の環境(別の道具)は別に測る
    const other = fakeCodecApi({ encoderBroken: true });
    expect(await detectPrecise(other.api)).toBe(false);
    expect(await detectPrecise(api), '別の環境の結果が混ざった').toBe(true);
  });

  it('🔴 動かない環境は false:符号化が error / 復号が 0 枚 / 道具が無い', async () => {
    expect(await detectPrecise(fakeCodecApi({ encoderBroken: true }).api)).toBe(false);
    expect(await detectPrecise(fakeCodecApi({ decoderSilent: true }).api)).toBe(false);
    expect(await detectPrecise(null)).toBe(false);
  });

  it('🔴 false の環境は走査が「作り直しが要るが使えない」(needs-codec)を返す。true なら ready。キーフレームの上なら要らない', async () => {
    const { blob } = await prepare();
    const bad = fakeCodecApi({ encoderBroken: true }).api;
    const good = fakeCodecApi().api;
    const mid = { blob, startMs: 1550, endMs: 3050 };
    const a = await scanVideo(mid, bad);
    const b = await scanVideo(mid, good);
    expect(a.ok && a.precise).toBe('needs-codec');
    expect(b.ok && b.precise).toBe('ready');
    // 押した所がキーフレームの上 ── WebCodecs が無い環境でも押した所ぴったり
    const onKey = await scanVideo({ blob, startMs: 2000, endMs: 3050 }, null);
    expect(onKey.ok && onKey.precise).toBe('ready');
    // 録画の外 / 最初の映像フレームより手前 ── 使えない
    const out = await scanVideo({ blob, startMs: 99_999, endMs: 100_000 }, good);
    expect(out.ok).toBe(false);
  });

  it('測った結果は覚えている ── 続けて走査しても、検出の道具を作り直さない', async () => {
    const { blob } = await prepare();
    const { api, stats } = fakeCodecApi();
    const a = await scanVideo({ blob, startMs: 1550, endMs: 3050 }, api);
    const b = await scanVideo({ blob, startMs: 1550, endMs: 3050 }, api);
    expect(a.ok && a.precise).toBe('ready');
    expect(b.ok && b.precise).toBe('ready');
    expect(stats.encoders, '走査のたびに測り直している').toBe(1);
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('VideoClient ── ワーカーで使えないとき、作り直しだけメインスレッドで', () => {
  const noWorker = (mainApi: CodecApi | null): VideoClient => {
    vi.stubGlobal('Worker', undefined);
    return new VideoClient({ monitor: new JobMonitor(), mainApi });
  };

  it('🔴 メインで使えるなら ready になり、切り出しはメインで作り直した頭を使う(押した所ぴったり)', async () => {
    const { blob, built } = await prepare();
    const { api, stats } = fakeCodecApi();
    const c = noWorker(api);
    const s = await c.scan(blob, 1550, 3050);
    expect(s.ok && s.precise).toBe('ready');
    if (!s.ok) return;
    expect(stats.probeFrames, '走査でメインの検出が走った').toBe(1);
    const r = await c.cut(blob, s.scan, 1550, 3050, 'precise');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.precise).toBe(true);
    expect(r.reencoded).toBe(5);
    expect(video(await bytesOf(r.blob)).map(idx)).toEqual(Array.from({ length: 16 }, (_, i) => 15 + i));
    expect(stats.closed).toBe(stats.created);
    void built;
  });

  it('🔴 メインでも使えないなら needs-codec のまま(呼び側が手前の区切りへ回す)', async () => {
    const { blob } = await prepare();
    const c = noWorker(null);
    const s = await c.scan(blob, 1550, 3050);
    expect(s.ok && s.precise).toBe('needs-codec');
  });

  it('🔴 メインの作り直しが環境の失敗で落ちたら preciseFailed(environmentBroken)。以後の走査は確認つきの道(needs-codec)', async () => {
    const { blob } = await prepare();
    // 検出の 1 枚(符号化 0 回目)は通り、作り直し(1 回目以降)と再検出が落ちる
    const { api } = fakeCodecApi({ brokenFromEncode: 1 });
    const c = noWorker(api);
    const s = await c.scan(blob, 1550, 3050);
    expect(s.ok && s.precise).toBe('ready');
    if (!s.ok) return;
    const r = await c.cut(blob, s.scan, 1550, 3050, 'precise');
    expect(r).toEqual({ ok: false, preciseFailed: true, environmentBroken: true });
    const again = await c.scan(blob, 1550, 3050);
    expect(again.ok && again.precise, '落ちた環境で、また確認なしの道に入っている').toBe('needs-codec');
  });

  it('🔴 メインの作り直しがこの録画だけの失敗で落ちたら、次の録画は押した所ぴったりのまま(確認つきへ倒さない)', async () => {
    const { blob } = await prepare();
    const { api } = fakeCodecApi({ errorAtEncode: 1 });
    const c = noWorker(api);
    const s = await c.scan(blob, 1550, 3050);
    if (!s.ok) throw new Error('走査できなかった');
    const r = await c.cut(blob, s.scan, 1550, 3050, 'precise');
    expect(r).toEqual({ ok: false, preciseFailed: true, environmentBroken: false });
    const s2 = await c.scan(blob, 1550, 3050);
    expect(s2.ok && s2.precise, '1 本の失敗で、以後ずっと確認つきの道になっている').toBe('ready');
    if (!s2.ok) return;
    const r2 = await c.cut(blob, s2.scan, 1550, 3050, 'precise');
    expect(r2.ok && r2.precise).toBe(true);
  });

  it('🔴 手前の区切りの道は、メインの WebCodecs を使わない', async () => {
    const { blob } = await prepare();
    const { api, stats } = fakeCodecApi();
    const c = noWorker(api);
    const s = await c.scan(blob, 1550, 3050);
    if (!s.ok) throw new Error('走査できなかった');
    const before = stats.encoders + stats.decoders;
    const r = await c.cut(blob, s.scan, 1550, 3050, 'snap');
    expect(r.ok && r.precise).toBe(false);
    expect(stats.encoders + stats.decoders).toBe(before);
  });
});

class FakeWorker {
  static live: FakeWorker[] = [];
  onmessage: ((ev: MessageEvent<unknown>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly seen: Array<{ id: number; payload: { op: string } }> = [];
  constructor() {
    FakeWorker.live.push(this);
  }
  postMessage(msg: { id: number; payload: { op: string } }): void {
    this.seen.push(msg);
  }
  respond(id: number, result: unknown): void {
    this.onmessage?.({ data: { id, ok: true, result } } as MessageEvent<unknown>);
  }
  terminate(): void {}
}

describe('VideoClient ── ワーカーの作り直しが落ちたあと', () => {
  const mk = (main: ReturnType<typeof fakeCodecApi>, idleMs?: number) =>
    new VideoClient({
      spawn: () => new FakeWorker() as unknown as Worker,
      monitor: new JobMonitor(),
      mainApi: main.api,
      ...(idleMs === undefined ? {} : { idleMs }),
    });
  const w = (): FakeWorker => FakeWorker.live[FakeWorker.live.length - 1]!;
  const readyScan = (scan: unknown) => ({ ok: true, scan, snappedStartMs: 1000, snapBackMs: 550, precise: 'ready' });
  const needsCodec = (scan: unknown) => ({ ok: true, scan, snappedStartMs: 1000, snapBackMs: 550, precise: 'needs-codec' });

  it('🔴 ワーカーの環境が壊れたと分かったら、メインの WebCodecs へ回さない(同じエンジンで同じ失敗をする)', async () => {
    FakeWorker.live = [];
    const { blob, scan } = await prepare();
    const main = fakeCodecApi();
    const c = mk(main);
    const p1 = c.scan(blob, 1550, 3050);
    w().respond(w().seen[0]!.id, readyScan(scan));
    expect((await p1).ok).toBe(true);
    const p2 = c.cut(blob, scan, 1550, 3050, 'precise');
    expect(w().seen[1]!.payload).toMatchObject({ op: 'cut', mode: 'precise' });
    w().respond(w().seen[1]!.id, { ok: false, preciseFailed: true, environmentBroken: true });
    expect(await p2).toEqual({ ok: false, preciseFailed: true, environmentBroken: true });
    const p3 = c.scan(blob, 1550, 3050);
    w().respond(w().seen[2]!.id, needsCodec(scan));
    const r3 = await p3;
    expect(r3.ok && r3.precise, '壊れた直後なのに、メインで作り直す道へ入っている').toBe('needs-codec');
    expect(main.stats.probeFrames, 'メインで検出を走らせている').toBe(0);
    c.dispose();
  });

  it('🔴 この録画だけの失敗なら、次の走査のあとも(ワーカーが使えない環境では)メインの検出へ回れる / ワーカーが使えるなら ready のまま', async () => {
    FakeWorker.live = [];
    const { blob, scan } = await prepare();
    const main = fakeCodecApi();
    const c = mk(main);
    const p1 = c.scan(blob, 1550, 3050);
    w().respond(w().seen[0]!.id, readyScan(scan));
    await p1;
    const p2 = c.cut(blob, scan, 1550, 3050, 'precise');
    w().respond(w().seen[1]!.id, { ok: false, preciseFailed: true, environmentBroken: false });
    await p2;
    // ワーカーは次も「切れる」と答える(その録画だけの失敗なので、環境は閉じていない)
    const p3 = c.scan(blob, 1550, 3050);
    expect(w().seen[2]!.payload, '走査の依頼に「測ってある」などの覚えを載せている').toEqual({
      op: 'scan',
      blob,
      startMs: 1550,
      endMs: 3050,
    });
    w().respond(w().seen[2]!.id, readyScan(scan));
    const r3 = await p3;
    expect(r3.ok && r3.precise).toBe('ready');
    // ワーカーが「使えない」と答える環境なら、メインの検出へ回れる(壊れた印は立っていない)
    const p4 = c.scan(blob, 1550, 3050);
    w().respond(w().seen[3]!.id, needsCodec(scan));
    const r4 = await p4;
    expect(r4.ok && r4.precise, '環境が壊れていないのにメインの道を閉じている').toBe('ready');
    expect(main.stats.probeFrames).toBe(1);
    c.dispose();
  });

  it('🔴 ワーカーが畳まれて作り直されたら、壊れた印も忘れて測り直す(ワーカーの覚えと同じ寿命)', async () => {
    FakeWorker.live = [];
    const { blob, scan } = await prepare();
    const main = fakeCodecApi();
    const c = mk(main, 30);
    const p1 = c.scan(blob, 1550, 3050);
    w().respond(w().seen[0]!.id, readyScan(scan));
    await p1;
    const p2 = c.cut(blob, scan, 1550, 3050, 'precise');
    w().respond(w().seen[1]!.id, { ok: false, preciseFailed: true, environmentBroken: true });
    await p2;
    // アイドルで畳まれるまで待つ(30ms)
    await new Promise((r) => setTimeout(r, 120));
    expect(c.alive, 'ワーカーが畳まれていない(前提が崩れている)').toBe(false);
    const before = FakeWorker.live.length;
    const p3 = c.scan(blob, 1550, 3050);
    expect(FakeWorker.live.length, '新しいワーカーが起きていない').toBe(before + 1);
    w().respond(w().seen[0]!.id, needsCodec(scan));
    const r3 = await p3;
    // 忘れて測り直す:メインの検出が走り、通れば ready
    expect(r3.ok && r3.precise).toBe('ready');
    expect(main.stats.probeFrames, '畳まれた後も壊れた印が残っている').toBe(1);
    c.dispose();
  });

  it('対照群:落ちていなければ、ワーカーが使えないときメインの検出へ回る', async () => {
    FakeWorker.live = [];
    const { blob, scan } = await prepare();
    const main = fakeCodecApi();
    const c = mk(main);
    const p = c.scan(blob, 1550, 3050);
    w().respond(w().seen[0]!.id, needsCodec(scan));
    const r = await p;
    expect(r.ok && r.precise).toBe('ready');
    expect(main.stats.probeFrames).toBe(1);
    c.dispose();
  });
});
